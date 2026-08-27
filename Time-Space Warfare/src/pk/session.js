// PK 對戰的記憶體內即時對戰狀態機。DB 只在對戰「結束」那一刻寫入最終結果，
// 逐題進度/計時全部只存在這裡（process 重啟會遺失進行中的對戰，屬於已知取捨，見 PLAN.md）。

const db = require('../db');

const QUESTIONS_PER_DUEL = 5;
const ANSWER_GRACE_MS = 1000; // 題目時限到了之後，多留一點緩衝時間才強制進下一題
const DISCONNECT_FORFEIT_MS = 20 * 1000; // 斷線超過這麼久還沒重連，直接判對手獲勝、結束對戰

const sessions = new Map(); // duelId -> session

// 資料庫裡 A/B/C/D 只是儲存用的固定欄位，不代表玩家畫面上看到的順序。
// 每次抽到一題，當場重新洗牌決定這一次要顯示的順序，並記住「洗牌後真正正確的按鈕是哪一個」，
// 之後這一題不管送幾次（含斷線重連補送）都用同一份洗牌結果，順序不會變來變去。
function shuffleOptions(q) {
  const originalLabels = ['A', 'B', 'C', 'D'];
  const optionTextByLabel = { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d };

  for (let i = originalLabels.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [originalLabels[i], originalLabels[j]] = [originalLabels[j], originalLabels[i]];
  }

  const displayLabels = ['A', 'B', 'C', 'D'];
  const displayOptions = {};
  let correctDisplayLabel = null;
  originalLabels.forEach((origLabel, i) => {
    const displayLabel = displayLabels[i];
    displayOptions[displayLabel] = optionTextByLabel[origLabel];
    if (origLabel === q.correct_option) correctDisplayLabel = displayLabel;
  });

  return { displayOptions, correctDisplayLabel };
}

async function createSession(duelId, hostPlayerId, guestPlayerId) {
  const { rows: rawQuestions } = await db.query(
    `SELECT id, content, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
     FROM questions WHERE scope_type = 'pk' ORDER BY random() LIMIT $1`,
    [QUESTIONS_PER_DUEL]
  );

  if (rawQuestions.length === 0) {
    throw new Error('no PK questions available');
  }

  const questions = rawQuestions.map(q => ({ ...q, ...shuffleOptions(q) }));

  sessions.set(duelId, {
    duelId,
    hostPlayerId,
    guestPlayerId,
    questions,
    currentIndex: -1,
    answers: { [hostPlayerId]: [], [guestPlayerId]: [] },
    connected: new Set(),
    questionStartedAt: null,
    timer: null,
    disconnectTimers: {}, // playerId -> setTimeout handle
    finished: false
  });

  return questions.length;
}

function getSession(duelId) {
  return sessions.get(duelId);
}

// socket 是這次呼叫 pk:enter 的那個連線本身：對戰已經在進行中時，
// 用來只回補給「這個剛連上/剛重連的玩家」目前的進度，不打擾對手、也不用整個房間重播。
function playerEntered(io, socket, duelId, playerId) {
  const session = sessions.get(duelId);
  if (!session) return { ok: false, error: 'duel session not found' };
  if (playerId !== session.hostPlayerId && playerId !== session.guestPlayerId) {
    return { ok: false, error: 'player not part of this duel' };
  }

  // 不管是第一次連上還是斷線後重連，只要人回來了，取消原本排定的斷線判負倒數。
  if (session.disconnectTimers[playerId]) {
    clearTimeout(session.disconnectTimers[playerId]);
    delete session.disconnectTimers[playerId];
  }

  session.connected.add(playerId);

  if (session.connected.size === 2 && session.currentIndex === -1) {
    // 雙方第一次都到齊：走原本的房間廣播送出第一題。
    startNextQuestion(io, duelId);
    return { ok: true };
  }

  if (session.currentIndex >= 0 && !session.finished) {
    // 對戰已經在進行中了：這是重連（或稍晚才連上的一方），不會等到下一次自然推題，
    // 直接補送「目前這一題＋剩餘時間」給這個 socket，讓畫面跟對戰進度對齊。
    const q = session.questions[session.currentIndex];
    const alreadyAnswered = session.answers[playerId].some(a => a.questionIndex === session.currentIndex);

    if (alreadyAnswered) {
      socket.emit('pk:waiting', { questionIndex: session.currentIndex });
    } else {
      const elapsedMs = Date.now() - session.questionStartedAt;
      const remainingSeconds = Math.max(
        Math.ceil((q.time_limit_seconds * 1000 - elapsedMs) / 1000),
        1
      );
      socket.emit('pk:question', publicQuestion(q, session.currentIndex, session.questions.length, remainingSeconds));
    }
  }

  return { ok: true };
}

// socket 斷線時呼叫（見 src/sockets/index.js 的 disconnect 事件）。排一個 20 秒的倒數，
// 這段時間內只要這個玩家有重新 pk:enter（playerEntered 會清掉這個 timer），就當作沒事發生；
// 20 秒內都沒回來，直接判對手獲勝、結束整場對戰，不會讓對戰無限期卡著等一個不會再回來的人。
function playerDisconnected(io, duelId, playerId) {
  const session = sessions.get(duelId);
  if (!session || session.finished) return;
  if (playerId !== session.hostPlayerId && playerId !== session.guestPlayerId) return;

  if (session.disconnectTimers[playerId]) {
    clearTimeout(session.disconnectTimers[playerId]);
  }

  session.disconnectTimers[playerId] = setTimeout(() => {
    forfeitDuel(io, duelId, playerId).catch(err => console.error('forfeitDuel error:', err));
  }, DISCONNECT_FORFEIT_MS);
}

function publicQuestion(q, index, total, timeLimitSeconds) {
  return {
    questionIndex: index,
    totalQuestions: total,
    content: q.content,
    options: q.displayOptions, // 洗牌後的順序（見 shuffleOptions），不是資料庫原始的 A/B/C/D
    timeLimitSeconds
  };
}

function startNextQuestion(io, duelId) {
  const session = sessions.get(duelId);
  if (!session || session.finished) return;

  session.currentIndex += 1;
  if (session.currentIndex >= session.questions.length) {
    finishDuel(io, duelId).catch(err => console.error('finishDuel error:', err));
    return;
  }

  const q = session.questions[session.currentIndex];
  session.questionStartedAt = Date.now();

  io.to(`duel:${duelId}`).emit(
    'pk:question',
    publicQuestion(q, session.currentIndex, session.questions.length, q.time_limit_seconds)
  );

  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    forceAnswerTimeouts(session);
    startNextQuestion(io, duelId);
  }, q.time_limit_seconds * 1000 + ANSWER_GRACE_MS);
}

function forceAnswerTimeouts(session) {
  const q = session.questions[session.currentIndex];
  [session.hostPlayerId, session.guestPlayerId].forEach(playerId => {
    const already = session.answers[playerId].find(a => a.questionIndex === session.currentIndex);
    if (!already) {
      session.answers[playerId].push({
        questionIndex: session.currentIndex,
        correct: false,
        elapsedMs: q.time_limit_seconds * 1000
      });
    }
  });
}

function submitAnswer(io, duelId, playerId, questionIndex, selectedOption) {
  const session = sessions.get(duelId);
  if (!session || session.finished) return { ok: false, error: 'duel session not found' };
  if (questionIndex !== session.currentIndex) {
    return { ok: false, error: 'not the current question' };
  }
  if (session.answers[playerId].some(a => a.questionIndex === questionIndex)) {
    return { ok: false, error: 'already answered' };
  }

  const q = session.questions[session.currentIndex];
  const elapsedMs = Math.min(Date.now() - session.questionStartedAt, q.time_limit_seconds * 1000);
  const correct = selectedOption === q.correctDisplayLabel;

  session.answers[playerId].push({ questionIndex, correct, elapsedMs });

  const bothAnswered =
    session.answers[session.hostPlayerId].some(a => a.questionIndex === questionIndex) &&
    session.answers[session.guestPlayerId].some(a => a.questionIndex === questionIndex);

  if (bothAnswered) {
    if (session.timer) clearTimeout(session.timer);
    startNextQuestion(io, duelId);
  }

  return { ok: true };
}

function summarize(session, playerId) {
  const answers = session.answers[playerId];
  const correctCount = answers.filter(a => a.correct).length;
  const totalTimeMs = answers.reduce((sum, a) => sum + a.elapsedMs, 0);
  return { correctCount, totalTimeMs };
}

async function finishDuel(io, duelId) {
  const session = sessions.get(duelId);
  if (!session || session.finished) return;

  const hostSummary = summarize(session, session.hostPlayerId);
  const guestSummary = summarize(session, session.guestPlayerId);

  // 答對題數多的贏；平手比作答總耗時（快的贏）；完全平手時 host 視為贏方（極端邊界情況）。
  let winnerId = session.hostPlayerId;
  let loserId = session.guestPlayerId;
  if (
    guestSummary.correctCount > hostSummary.correctCount ||
    (guestSummary.correctCount === hostSummary.correctCount &&
      guestSummary.totalTimeMs < hostSummary.totalTimeMs)
  ) {
    winnerId = session.guestPlayerId;
    loserId = session.hostPlayerId;
  }

  await persistResult(io, duelId, session, winnerId, loserId, { hostSummary, guestSummary });
}

// 對手斷線超過 20 秒未重連：直接判還在場上的人獲勝，結束對戰。
// 沿用跟正常結算一樣的扣分/保護期/廣播邏輯，只是勝負不是用答題結果算出來的。
async function forfeitDuel(io, duelId, disconnectedPlayerId) {
  const session = sessions.get(duelId);
  if (!session || session.finished) return;

  const winnerId = disconnectedPlayerId === session.hostPlayerId
    ? session.guestPlayerId
    : session.hostPlayerId;
  const loserId = disconnectedPlayerId;

  const hostSummary = summarize(session, session.hostPlayerId);
  const guestSummary = summarize(session, session.guestPlayerId);

  await persistResult(io, duelId, session, winnerId, loserId, {
    hostSummary,
    guestSummary,
    reason: 'opponent_disconnected'
  });
}

async function persistResult(io, duelId, session, winnerId, loserId, { hostSummary, guestSummary, reason }) {
  session.finished = true;
  if (session.timer) clearTimeout(session.timer);
  Object.values(session.disconnectTimers).forEach(clearTimeout);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO pk_duel_answers (pk_duel_id, player_id, correct_count, total_time_ms) VALUES ($1, $2, $3, $4)`,
      [duelId, session.hostPlayerId, hostSummary.correctCount, hostSummary.totalTimeMs]
    );
    await client.query(
      `INSERT INTO pk_duel_answers (pk_duel_id, player_id, correct_count, total_time_ms) VALUES ($1, $2, $3, $4)`,
      [duelId, session.guestPlayerId, guestSummary.correctCount, guestSummary.totalTimeMs]
    );

    // 找出敗方小隊「最近一次得分的交摺點」，全數歸零扣除。
    const { rows: loserPlayerRows } = await client.query(
      'SELECT team_id FROM players WHERE id = $1', [loserId]
    );
    const loserTeamId = loserPlayerRows[0].team_id;

    const { rows: teamRows } = await client.query(
      'SELECT last_checkpoint_attempt_id FROM teams WHERE id = $1 FOR UPDATE',
      [loserTeamId]
    );
    const lastAttemptId = teamRows[0].last_checkpoint_attempt_id;

    let penaltyAttemptId = null;
    let penaltyAmount = 0;
    let affectedCheckpointId = null;

    if (lastAttemptId) {
      const { rows: attemptRows } = await client.query(
        'SELECT checkpoint_id, faction, total_score FROM checkpoint_attempts WHERE id = $1',
        [lastAttemptId]
      );
      if (attemptRows.length > 0) {
        const attempt = attemptRows[0];
        const column = attempt.faction === 'repair' ? 'repair_value' : 'disrupt_value';
        await client.query(
          `UPDATE checkpoints SET ${column} = GREATEST(${column} - $1, 0), updated_at = now() WHERE id = $2`,
          [attempt.total_score, attempt.checkpoint_id]
        );
        penaltyAttemptId = lastAttemptId;
        penaltyAmount = attempt.total_score;
        affectedCheckpointId = attempt.checkpoint_id;
      }
    }

    await client.query(
      `UPDATE teams SET pk_protected_until = now() + interval '3 minutes' WHERE id = $1`,
      [loserTeamId]
    );

    await client.query(
      `UPDATE pk_duels
       SET status = 'completed', winner_player_id = $1, loser_player_id = $2,
           penalty_checkpoint_attempt_id = $3, penalty_amount = $4, completed_at = now()
       WHERE id = $5`,
      [winnerId, loserId, penaltyAttemptId, penaltyAmount, duelId]
    );

    await client.query('COMMIT');

    io.to(`duel:${duelId}`).emit('pk:result', {
      winnerPlayerId: winnerId,
      loserPlayerId: loserId,
      hostSummary,
      guestSummary,
      reason: reason || 'answers',
      penalty: { checkpointId: affectedCheckpointId, amount: penaltyAmount }
    });

    if (affectedCheckpointId) {
      const { rows: cp } = await db.query(
        'SELECT id, name, repair_value, disrupt_value FROM checkpoints WHERE id = $1',
        [affectedCheckpointId]
      );
      io.emit('checkpoint:update', cp[0]);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    sessions.delete(duelId);
  }
}

module.exports = { createSession, getSession, playerEntered, playerDisconnected, submitAnswer };
