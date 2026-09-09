// PK 對戰的記憶體內即時對戰狀態機。DB 只在對戰「結束」那一刻寫入最終結果，
// 逐題進度/計時全部只存在這裡（process 重啟會遺失進行中的對戰，屬於已知取捨，見 PLAN.md）。

const db = require('../db');
const { shuffleOptions } = require('../quiz/shuffle');
const { getIO } = require('../io');

// 題數與每題秒數改成從 game_state 讀（後台可調，見 migrations/008_pk_settings.sql）。
// 這裡留一組後備值，只有在設定讀不到的時候才會用到（例如 migration 還沒跑）。
const FALLBACK_QUESTIONS_PER_DUEL = 5;
const FALLBACK_ANSWER_SECONDS = 10;

async function loadPkSettings() {
  try {
    const { rows } = await db.query(
      'SELECT pk_questions_per_duel, pk_answer_seconds FROM game_state WHERE id = 1'
    );
    if (rows.length > 0) {
      return {
        questionsPerDuel: rows[0].pk_questions_per_duel,
        answerSeconds: rows[0].pk_answer_seconds
      };
    }
  } catch (err) {
    console.error('讀取 PK 設定失敗，改用預設值:', err.message);
  }
  return { questionsPerDuel: FALLBACK_QUESTIONS_PER_DUEL, answerSeconds: FALLBACK_ANSWER_SECONDS };
}
const ANSWER_GRACE_MS = 1000; // 題目時限到了之後，多留一點緩衝時間才強制進下一題
const DISCONNECT_FORFEIT_MS = 20 * 1000; // 斷線超過這麼久還沒重連，直接判對手獲勝、結束對戰

// 開賽逾時：session 建立之後，雙方都得透過 socket 的 pk:enter 到齊，第一題才會送出
// （見 playerEntered 的 connected.size === 2）。只有一方到齊的話，原本沒有任何計時器
// 會推進這場對戰——host 那邊會永遠停在房號畫面、guest 永遠停在「等待對戰開始」。
// 這裡補一個保底：時間到還沒開賽就直接取消，不留卡死的 session 跟 active 的 DB 列。
// PK 全程的關鍵節點都留一行 log。這條路徑的問題（誰沒進場、第一題有沒有送出、
// 為什麼被取消）從 DB 事後看不出來，沒有 log 就只能用猜的。
// duelId 是 UUID，只取前 8 碼夠辨識又不會把整行擠爆。
function pkLog(duelId, msg, extra) {
  const short = String(duelId).slice(0, 8);
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`[pk ${short}] ${msg}${tail}`);
}

const { MATCH_START_TIMEOUT_MS } = require('./timeouts');

const sessions = new Map(); // duelId -> session

async function createSession(duelId, hostPlayerId, guestPlayerId) {
  const settings = await loadPkSettings();

  const { rows: rawQuestions } = await db.query(
    `SELECT id, content, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds
     FROM questions WHERE scope_type = 'pk' ORDER BY random() LIMIT $1`,
    [settings.questionsPerDuel]
  );

  if (rawQuestions.length === 0) {
    throw new Error('no PK questions available');
  }

  // 每題的作答時間一律用後台設定的值蓋過題目自己的 time_limit_seconds。
  // PK 是兩個人同步比快慢，每題長度必須一致才公平——如果照各題自己的秒數跑，
  // 抽到哪幾題會直接影響總時長，對兩邊也不對等（他們答的是同一批題，但整場
  // 長度會因為抽題而浮動）。交摺點那邊是單人挑戰，就維持各題自己的秒數。
  const questions = rawQuestions.map(q => ({
    ...q,
    time_limit_seconds: settings.answerSeconds,
    ...shuffleOptions(q)
  }));

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
    matchStartTimer: null,
    disconnectTimers: {}, // playerId -> setTimeout handle
    finished: false
  });

  pkLog(duelId, 'session 建立', {
    host: hostPlayerId, guest: guestPlayerId,
    questions: questions.length, answerSeconds: settings.answerSeconds,
    matchStartTimeoutMs: MATCH_START_TIMEOUT_MS
  });

  const matchStartTimer = setTimeout(() => {
    cancelUnstartedDuel(duelId).catch(err => console.error('cancelUnstartedDuel error:', err));
  }, MATCH_START_TIMEOUT_MS);
  if (typeof matchStartTimer.unref === 'function') matchStartTimer.unref();
  sessions.get(duelId).matchStartTimer = matchStartTimer;

  return questions.length;
}

// 開賽逾時還沒有雙方到齊：取消這場對戰。
// 刻意不判任何一方輸——沒有人真的答過題，判誰輸都不合理，也不該給保護期或扣分。
async function cancelUnstartedDuel(duelId) {
  const session = sessions.get(duelId);
  if (!session || session.finished || session.currentIndex >= 0) return;

  // 這行是這次事故最關鍵的線索：到底是誰沒進場
  const connected = [...session.connected];
  const missing = [session.hostPlayerId, session.guestPlayerId].filter(id => !session.connected.has(id));
  pkLog(duelId, '開賽逾時，取消對戰', {
    connected, missing,
    host: session.hostPlayerId, guest: session.guestPlayerId
  });

  session.finished = true;
  clearMatchStartTimer(session);
  Object.values(session.disconnectTimers).forEach(clearTimeout);
  sessions.delete(duelId);

  // createSession 是從 REST 路由呼叫的，手上沒有 io，改用共用的 getIO()
  getIO().to(`duel:${duelId}`).emit('pk:cancelled', {
    reason: 'match_start_timeout',
    message: '對手一直沒有進入對戰，這場已取消（沒有計分也沒有扣分）'
  });

  try {
    await db.query(
      `UPDATE pk_duels SET status = 'cancelled', completed_at = now()
       WHERE id = $1 AND status = 'active'`,
      [duelId]
    );
  } catch (err) {
    console.error('mark duel cancelled failed:', err);
  }
}

// 重啟遊戲時把所有進行中的對戰都收掉。
//
// session 全部在記憶體裡，而重啟會把 pk_duels 整張表刪光。不清的話，正在打的
// 那幾場會繼續跑計時器，然後在結算時 UPDATE 一列已經不存在的 pk_duels——不會
// 報錯（rowCount 0），但兩邊的畫面會一直卡在答題中等一個永遠不會來的結果。
function clearAll() {
  const n = sessions.size;
  sessions.forEach((session, duelId) => {
    session.finished = true;
    if (session.timer) clearTimeout(session.timer);
    clearMatchStartTimer(session);
    Object.values(session.disconnectTimers).forEach(clearTimeout);
    getIO().to(`duel:${duelId}`).emit('pk:cancelled', {
      reason: 'game_reset',
      message: '主辦已重啟遊戲，這場對戰取消'
    });
  });
  sessions.clear();
  return n;
}

function clearMatchStartTimer(session) {
  if (session?.matchStartTimer) {
    clearTimeout(session.matchStartTimer);
    session.matchStartTimer = null;
  }
}

function getSession(duelId) {
  return sessions.get(duelId);
}

// socket 是這次呼叫 pk:enter 的那個連線本身：對戰已經在進行中時，
// 用來只回補給「這個剛連上/剛重連的玩家」目前的進度，不打擾對手、也不用整個房間重播。
function playerEntered(io, socket, duelId, playerId) {
  const session = sessions.get(duelId);
  if (!session) {
    // 房主開房之後、對手還沒加入的這段期間，房主每次重試都會走到這裡，屬於預期內。
    pkLog(duelId, 'pk:enter 被拒：session 尚未建立', { playerId });
    return { ok: false, error: 'duel session not found' };
  }
  if (playerId !== session.hostPlayerId && playerId !== session.guestPlayerId) {
    pkLog(duelId, 'pk:enter 被拒：不是這場的玩家', {
      playerId, host: session.hostPlayerId, guest: session.guestPlayerId
    });
    return { ok: false, error: 'player not part of this duel' };
  }

  // 一定要在下面觸發 startNextQuestion 之前就加入房間。
  // 第二個人進場的當下就會送出第一題（io.to(room).emit），這時候他自己如果還沒在
  // 房間裡就會漏掉第一題——原本 socket.join 寫在呼叫端、playerEntered 回傳之後才執行，
  // 剛好就是漏掉的順序。
  socket.join(`duel:${duelId}`);

  // 不管是第一次連上還是斷線後重連，只要人回來了，取消原本排定的斷線判負倒數。
  if (session.disconnectTimers[playerId]) {
    clearTimeout(session.disconnectTimers[playerId]);
    delete session.disconnectTimers[playerId];
  }

  session.connected.add(playerId);
  pkLog(duelId, 'pk:enter 成功', {
    playerId,
    connectedSize: session.connected.size,
    connected: [...session.connected],
    currentIndex: session.currentIndex
  });

  if (session.connected.size === 2 && session.currentIndex === -1) {
    // 雙方第一次都到齊：走原本的房間廣播送出第一題。
    startNextQuestion(io, duelId);
    return { ok: true };
  }

  if (session.currentIndex >= 0 && !session.finished) {
    // 對戰已經在進行中了：這是重連（或稍晚才連上的一方），不會等到下一次自然推題，
    // 直接補送「目前這一題＋剩餘時間」給這個 socket，讓畫面跟對戰進度對齊。
    //
    // 比分也一起補送，否則重連的人要等到這一題結束（最多十幾秒）才看得到分數。
    socket.emit('pk:score', {
      questionIndex: session.currentIndex - 1,
      totalQuestions: session.questions.length,
      host: { playerId: session.hostPlayerId, ...summarize(session, session.hostPlayerId) },
      guest: { playerId: session.guestPlayerId, ...summarize(session, session.guestPlayerId) }
    });

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

  pkLog(duelId, `玩家斷線，${DISCONNECT_FORFEIT_MS / 1000} 秒後判負`, { playerId });
  session.disconnectTimers[playerId] = setTimeout(() => {
    pkLog(duelId, '斷線逾時未重連，判對手獲勝', { playerId });
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

// 每一題結束（雙方都答完，或時間到強制帶過）就把雙方目前的累計比分播給兩邊。
// 帶 playerId 而不是 host/guest 這種角色名，前端拿自己的 playerInfo.player.id 比對
// 就知道哪一邊是「你」——這樣即使玩家中途重新整理（myRole 這種前端狀態會不見）
// 也還是分得出來。
function emitScore(io, duelId, session, finishedIndex) {
  const host = summarize(session, session.hostPlayerId);
  const guest = summarize(session, session.guestPlayerId);

  pkLog(duelId, `第 ${finishedIndex + 1} 題結束，目前比分`, {
    host: `${host.correctCount}對`, guest: `${guest.correctCount}對`
  });

  io.to(`duel:${duelId}`).emit('pk:score', {
    questionIndex: finishedIndex,
    totalQuestions: session.questions.length,
    host: { playerId: session.hostPlayerId, ...host },
    guest: { playerId: session.guestPlayerId, ...guest }
  });
}

function startNextQuestion(io, duelId) {
  const session = sessions.get(duelId);
  if (!session || session.finished) return;

  // 進到下一題之前，currentIndex 還指著剛結束的那一題（-1 代表還沒開賽，
  // 那是第一題要送出的情況，沒有「剛結束的題目」可以結算）。
  if (session.currentIndex >= 0) {
    emitScore(io, duelId, session, session.currentIndex);
  }

  session.currentIndex += 1;
  if (session.currentIndex >= session.questions.length) {
    finishDuel(io, duelId).catch(err => console.error('finishDuel error:', err));
    return;
  }

  clearMatchStartTimer(session);   // 已經開賽，開賽逾時不用再守著

  pkLog(duelId, `送出第 ${session.currentIndex + 1}/${session.questions.length} 題`, {
    connected: [...session.connected]
  });

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

  // 帶回這一題對不對，玩家端才有東西可以顯示——原本這裡只回 {ok:true}，
  // 玩家從頭到尾都不知道自己有沒有答對任何一題，只有最後贏/輸兩個字。
  return { ok: true, correct };
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

    // PK 不動據點進度，只影響第六權重的 PK 積分庫。
    //
    // 企劃：「勝者可直接奪取敗者擁有的第六權重（PK 積分）」。所以這裡是把敗方
    // 手上的積分整包轉給勝方，再加一分給這場勝利本身——如果只有轉移沒有新增，
    // 大家都從 0 開始，搶來搶去永遠是 0，這個權重形同不存在。
    //
    // 因為是「轉移」，這個數字沒辦法事後從對戰紀錄重算（同一批對戰，依結算順序
    // 不同會得出不同的持有量），所以存在 teams.pk_points。
    //
    // 落敗方的三分鐘保護期保留：它擋的是「同一支隊伍被反覆挑戰洗積分」，在會
    // 轉移積分的規則下更重要——沒有它，贏家可以連續挑同一支把分數刷到滿。
    const { rows: loserPlayerRows } = await client.query(
      'SELECT team_id FROM players WHERE id = $1', [loserId]
    );
    const { rows: winnerPlayerRows } = await client.query(
      'SELECT team_id FROM players WHERE id = $1', [winnerId]
    );
    const loserTeamId = loserPlayerRows[0].team_id;
    const winnerTeamId = winnerPlayerRows[0].team_id;

    // 先鎖住敗方那一列再讀，否則兩場同時結算、敗方剛好是同一隊時會重複轉移。
    const { rows: loserTeamRows } = await client.query(
      'SELECT pk_points FROM teams WHERE id = $1 FOR UPDATE', [loserTeamId]
    );
    const stolen = loserTeamRows[0].pk_points;

    await client.query(
      `UPDATE teams SET pk_points = 0, pk_protected_until = now() + interval '3 minutes'
       WHERE id = $1`,
      [loserTeamId]
    );
    await client.query(
      'UPDATE teams SET pk_points = pk_points + $1 WHERE id = $2',
      [stolen + 1, winnerTeamId]
    );
    pkLog(duelId, 'PK 積分結算', { winnerTeamId, loserTeamId, 奪取: stolen, 本場: 1 });

    await client.query(
      `UPDATE pk_duels
       SET status = 'completed', winner_player_id = $1, loser_player_id = $2, completed_at = now()
       WHERE id = $3`,
      [winnerId, loserId, duelId]
    );

    await client.query('COMMIT');

    pkLog(duelId, '對戰結算', {
      winner: winnerId, loser: loserId, reason: reason || 'answers',
      host: `${hostSummary.correctCount}對/${hostSummary.totalTimeMs}ms`,
      guest: `${guestSummary.correctCount}對/${guestSummary.totalTimeMs}ms`
    });

    io.to(`duel:${duelId}`).emit('pk:result', {
      winnerPlayerId: winnerId,
      loserPlayerId: loserId,
      hostSummary,
      guestSummary,
      reason: reason || 'answers'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    sessions.delete(duelId);
  }
}

module.exports = { createSession, getSession, playerEntered, playerDisconnected, submitAnswer, clearAll };
