// 交摺點掃碼挑戰的記憶體內狀態機。
//
// 跟 PK 對戰（src/pk/session.js）不同的是這裡是「一個人自己答」，不需要即時同步兩端，
// 所以用單純的 REST（見 src/routes/checkpoints.js）而不是 Socket.IO。
// 逐題進度與計時只存在記憶體，只有整場答完的那一刻才把結果寫進資料庫——
// process 重啟會遺失進行中的挑戰，跟 PK 一樣是已知取捨。
const crypto = require('crypto');
const db = require('../db');
const { shuffleOptions } = require('../quiz/shuffle');

// 規格：隨機抽 3~5 題，每題限時 10 秒（實際秒數以題目自己的 time_limit_seconds 為準）。
const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 5;

// 得分＝基礎分＋剩餘時間加權，答錯 0 分。
// 兩個常數擺在這裡方便主辦活動前調整難度/分數級距。
const BASE_SCORE = 10;
const TIME_BONUS_MAX = 10;

// 網路延遲的緩衝：時限剛過一點點還是算數，超過就一律當逾時 0 分。
const ANSWER_GRACE_MS = 1000;

// 沒答完就離開的挑戰不能永遠佔著記憶體（跟 src/loginThrottle.js 同樣的考量）。
const SESSION_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map(); // challengeId -> session

function sweep(now = Date.now()) {
  let removed = 0;
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

const sweepTimer = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

// 抽題：優先抽這個交摺點專屬的題目，不夠再用 general 補。
// 兩者都抽不到就回空陣列，由呼叫端決定要怎麼回應。
async function pickQuestions(checkpointId, count) {
  const { rows: specific } = await db.query(
    `SELECT id, content, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
     FROM questions
     WHERE scope_type = 'checkpoint' AND checkpoint_id = $1
     ORDER BY random() LIMIT $2`,
    [checkpointId, count]
  );
  if (specific.length >= count) return specific;

  const { rows: general } = await db.query(
    `SELECT id, content, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
     FROM questions
     WHERE scope_type = 'general'
     ORDER BY random() LIMIT $1`,
    [count - specific.length]
  );
  return specific.concat(general);
}

function publicQuestion(session) {
  const q = session.questions[session.currentIndex];
  return {
    questionIndex: session.currentIndex,
    totalQuestions: session.questions.length,
    content: q.content,
    options: q.displayOptions,          // 洗牌後的順序，不是資料庫原始的 A/B/C/D
    timeLimitSeconds: q.time_limit_seconds
  };
}

// 開始一場挑戰。回傳 { challengeId, question } 或在題庫不足時丟出 NoQuestionsError。
async function createChallenge({ checkpointId, playerId, teamId, faction }) {
  const count = MIN_QUESTIONS + Math.floor(Math.random() * (MAX_QUESTIONS - MIN_QUESTIONS + 1));
  const rawQuestions = await pickQuestions(checkpointId, count);

  if (rawQuestions.length === 0) {
    const err = new Error('no questions available for this checkpoint');
    err.code = 'NO_QUESTIONS';
    throw err;
  }

  const challengeId = crypto.randomUUID();
  const now = Date.now();
  const session = {
    challengeId,
    checkpointId,
    playerId,
    teamId,
    faction,
    questions: rawQuestions.map(q => ({ ...q, ...shuffleOptions(q) })),
    currentIndex: 0,
    correctCount: 0,
    totalScore: 0,
    finished: false,
    questionStartedAt: now,
    expiresAt: now + SESSION_TTL_MS
  };

  if (sessions.size >= 1000) sweep(now);
  sessions.set(challengeId, session);

  return { challengeId, question: publicQuestion(session) };
}

function getForPlayer(challengeId, playerId) {
  const session = sessions.get(challengeId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(challengeId);
    return null;
  }
  // 別人的挑戰一律當作不存在，不透露「這個 id 有效但不是你的」。
  if (session.playerId !== playerId) return null;
  return session;
}

// 這一題的得分：答錯或逾時都是 0 分，答對才有基礎分＋剩餘時間加權。
function scoreAnswer(question, correct, elapsedMs) {
  const limitMs = question.time_limit_seconds * 1000;
  if (!correct) return 0;
  if (elapsedMs > limitMs + ANSWER_GRACE_MS) return 0;

  const remainingRatio = Math.max(0, Math.min(1, (limitMs - elapsedMs) / limitMs));
  return BASE_SCORE + Math.round(TIME_BONUS_MAX * remainingRatio);
}

// 提交一題的答案。choice 傳 null 代表玩家沒作答（前端倒數歸零時送出）。
// 回傳這一題的結果，以及下一題（還有的話）。整場結束時 finished=true，
// 由呼叫端負責把結果寫進資料庫。
function submitAnswer(session, questionIndex, choice) {
  if (session.finished) {
    const err = new Error('this challenge is already finished');
    err.code = 'FINISHED';
    throw err;
  }
  // 只接受「目前這一題」，避免跳題或重複送同一題洗分數。
  if (questionIndex !== session.currentIndex) {
    const err = new Error('question index does not match the current question');
    err.code = 'INDEX_MISMATCH';
    throw err;
  }

  const q = session.questions[session.currentIndex];
  const elapsedMs = Date.now() - session.questionStartedAt;
  const timedOut = elapsedMs > q.time_limit_seconds * 1000 + ANSWER_GRACE_MS;
  const correct = !timedOut && choice === q.correctDisplayLabel;
  const score = scoreAnswer(q, correct, elapsedMs);

  if (correct) session.correctCount += 1;
  session.totalScore += score;

  session.currentIndex += 1;
  session.questionStartedAt = Date.now();
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const done = session.currentIndex >= session.questions.length;
  if (done) session.finished = true;

  return {
    correct,
    timedOut,
    score,
    correctOption: q.correctDisplayLabel,
    finished: done,
    nextQuestion: done ? null : publicQuestion(session)
  };
}

// 整場答完之後把結果寫進資料庫：
//   1. checkpoint_attempts 留一筆完整紀錄
//   2. 依陣營把總分累加到該交摺點的 repair_value / disrupt_value
//   3. 有得分才更新 teams.last_checkpoint_attempt_id
//      （規格是「最近一次**得分**的關卡」，PK 落敗時要歸零的就是這一筆；
//        0 分的挑戰不該覆蓋掉上一次真的有得分的紀錄）
async function persistResult(session) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: attemptRows } = await client.query(
      `INSERT INTO checkpoint_attempts
         (checkpoint_id, player_id, team_id, faction, correct_count, total_score)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [session.checkpointId, session.playerId, session.teamId,
       session.faction, session.correctCount, session.totalScore]
    );
    const attemptId = attemptRows[0].id;

    const column = session.faction === 'repair' ? 'repair_value' : 'disrupt_value';
    const { rows: cpRows } = await client.query(
      `UPDATE checkpoints SET ${column} = ${column} + $1, updated_at = now()
       WHERE id = $2
       RETURNING id, name, repair_value, disrupt_value`,
      [session.totalScore, session.checkpointId]
    );

    if (session.totalScore > 0) {
      await client.query(
        'UPDATE teams SET last_checkpoint_attempt_id = $1 WHERE id = $2',
        [attemptId, session.teamId]
      );
    }

    await client.query('COMMIT');
    sessions.delete(session.challengeId);

    return { attemptId, checkpoint: cpRows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createChallenge,
  getForPlayer,
  submitAnswer,
  persistResult,
  _sweep: sweep,
  _size: () => sessions.size,
  BASE_SCORE,
  TIME_BONUS_MAX
};
