// 交摺點掃碼挑戰的記憶體內狀態機。
//
// 跟 PK 對戰（src/pk/session.js）不同的是這裡是「一個人自己答」，不需要即時同步兩端，
// 所以用單純的 REST（見 src/routes/checkpoints.js）而不是 Socket.IO。
// 逐題進度與計時只存在記憶體，只有整場答完的那一刻才把結果寫進資料庫——
// process 重啟會遺失進行中的挑戰，跟 PK 一樣是已知取捨。
const crypto = require('crypto');
const db = require('../db');
const { shuffleOptions } = require('../quiz/shuffle');
const { applyAction } = require('./progress');

// 規格：隨機抽 3~5 題，每題限時 10 秒（實際秒數以題目自己的 time_limit_seconds 為準）。
const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 5;

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

  if (correct) session.correctCount += 1;

  session.currentIndex += 1;
  session.questionStartedAt = Date.now();
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const done = session.currentIndex >= session.questions.length;
  if (done) session.finished = true;

  return {
    correct,
    timedOut,
    correctOption: q.correctDisplayLabel,
    finished: done,
    // 整場答完時一併回報有沒有通關；通關才輪得到選修復/破壞。
    passed: done ? passed(session) : undefined,
    correctCount: done ? session.correctCount : undefined,
    totalQuestions: done ? session.questions.length : undefined,
    nextQuestion: done ? null : publicQuestion(session)
  };
}

// 答完題之後不再直接結算——企劃書的規則是「任何隊伍通關後皆可自由選擇修復或
// 破壞」，所以這裡只判定有沒有通關，實際要做哪個動作交給下一步由隊伍自己選。
//
// 通關門檻：答對過半。企劃沒有明寫，但如果答對 0 題也能推動 25% 的進度，答題這
// 一關就完全沒有意義了。門檻集中在這個函式，之後要調整只有一個地方要改。
function passed(session) {
  return session.correctCount * 2 >= session.questions.length;
}

// 選定動作、實際推動據點進度。進度怎麼算、怎麼夾在 0~100、怎麼留紀錄都在
// src/checkpoints/progress.js，這裡只負責「這場挑戰有沒有資格做這件事」。
async function chooseAction(session, action) {
  if (!session.finished) {
    const err = new Error('challenge is not finished yet');
    err.code = 'NOT_FINISHED';
    throw err;
  }
  if (session.actionTaken) {
    // 一場挑戰只能推動一次進度，否則把同一個請求重送幾次就能一直推。
    const err = new Error('this challenge has already been settled');
    err.code = 'ALREADY_SETTLED';
    throw err;
  }
  if (!passed(session)) {
    const err = new Error('challenge not passed');
    err.code = 'NOT_PASSED';
    throw err;
  }

  const result = await applyAction({
    checkpointId: session.checkpointId,
    playerId: session.playerId,
    teamId: session.teamId,
    faction: session.faction,
    action,
    correctCount: session.correctCount
  });

  session.actionTaken = action;
  sessions.delete(session.challengeId);
  return result;
}

module.exports = {
  createChallenge,
  getForPlayer,
  submitAnswer,
  chooseAction,
  passed,
  _sweep: sweep,
  _size: () => sessions.size
};
