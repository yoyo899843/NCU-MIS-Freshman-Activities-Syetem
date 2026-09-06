const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');
const roomRegistry = require('../pk/roomRegistry');
const session = require('../pk/session');

const router = express.Router();

router.use(playerAuth);

// PK 對戰只在遊戲「進行中」才開放，呼應 admin 的遊戲進程控制
// （未開始/已結束時不能發起或加入新的 PK 對戰）。
const requireGameInProgress = asyncHandler(async (req, res, next) => {
  const { rows } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (rows[0].status !== 'in_progress') {
    return res.status(403).json({ error: 'game is not in progress', status: rows[0].status });
  }
  next();
});

// 發起 PK：開房，產生 6 碼房號 + qr_token。
router.post('/create', requireGameInProgress, asyncHandler(async (req, res) => {
  const hostPlayerId = req.player.sub;

  const { rows: teamRows } = await db.query(
    'SELECT pk_protected_until FROM teams WHERE id = $1', [req.player.teamId]
  );
  const protectedUntil = teamRows[0]?.pk_protected_until;
  if (protectedUntil && new Date(protectedUntil) > new Date()) {
    // 保護期是「PK 落敗後 3 分鐘不會再被打」，不是系統壞掉。原本只回英文字串，
    // 玩家看到 your team is currently PK-protected 完全不知道發生什麼事、
    // 也不知道要等多久，所以這裡回中文並附上剩餘秒數。
    const secondsLeft = Math.ceil((new Date(protectedUntil) - Date.now()) / 1000);
    return res.status(403).json({
      error: `你們剛輸掉一場 PK，還在 ${secondsLeft} 秒的保護期內，這段時間不能發起或加入 PK`,
      protectedUntil,
      secondsLeft
    });
  }

  const roomCode = roomRegistry.generateRoomCode();
  const qrToken = crypto.randomBytes(16).toString('hex');

  const { rows } = await db.query(
    `INSERT INTO pk_duels (room_code, qr_token, host_player_id, status)
     VALUES ($1, $2, $3, 'waiting') RETURNING id`,
    [roomCode, qrToken, hostPlayerId]
  );
  const duelId = rows[0].id;

  roomRegistry.register(roomCode, duelId);
  console.log(`[pk ${duelId.slice(0, 8)}] 開房 roomCode=${roomCode} host=${hostPlayerId} 房間逾時=${roomRegistry.ROOM_TIMEOUT_MS}ms`);

  // 一併回傳房間有效秒數，前端顯示倒數用（見 public/pk.html）
  res.json({ duelId, roomCode, qrToken, expiresInMs: roomRegistry.ROOM_TIMEOUT_MS });
}));

// 加入 PK：用房號或 qr_token 找到對應的 duel，配對成功後兩人開始同步作答。
router.post('/join', requireGameInProgress, asyncHandler(async (req, res) => {
  const guestPlayerId = req.player.sub;
  const { roomCode, qrToken } = req.body || {};

  if (!roomCode && !qrToken) {
    return res.status(400).json({ error: 'roomCode or qrToken is required' });
  }

  const { rows: teamRows } = await db.query(
    'SELECT pk_protected_until FROM teams WHERE id = $1', [req.player.teamId]
  );
  const protectedUntil = teamRows[0]?.pk_protected_until;
  if (protectedUntil && new Date(protectedUntil) > new Date()) {
    // 保護期是「PK 落敗後 3 分鐘不會再被打」，不是系統壞掉。原本只回英文字串，
    // 玩家看到 your team is currently PK-protected 完全不知道發生什麼事、
    // 也不知道要等多久，所以這裡回中文並附上剩餘秒數。
    const secondsLeft = Math.ceil((new Date(protectedUntil) - Date.now()) / 1000);
    return res.status(403).json({
      error: `你們剛輸掉一場 PK，還在 ${secondsLeft} 秒的保護期內，這段時間不能發起或加入 PK`,
      protectedUntil,
      secondsLeft
    });
  }

  let duelId = roomCode ? roomRegistry.lookup(roomCode) : null;

  let duel;
  if (duelId) {
    const { rows } = await db.query('SELECT * FROM pk_duels WHERE id = $1', [duelId]);
    duel = rows[0];
  } else if (qrToken) {
    const { rows } = await db.query('SELECT * FROM pk_duels WHERE qr_token = $1', [qrToken]);
    duel = rows[0];
    duelId = duel?.id;
  }

  if (!duel) {
    return res.status(404).json({ error: 'duel not found' });
  }
  if (duel.status === 'cancelled') {
    return res.status(410).json({ error: '這個房間已經逾時取消了，請對方重新開房' });
  }
  if (duel.status !== 'waiting') {
    return res.status(409).json({ error: 'duel is not open for joining' });
  }

  // 還停在 waiting、但已經超過有效期限的：可能是服務重啟後殘留的（記憶體裡的
  // 逾時計時器跟著沒了），也可能是用 qr_token 繞過房號表找到的舊房間。
  // 這裡補一次判定，順手標記成 cancelled，避免它一直被加入。
  if (Date.now() - new Date(duel.created_at).getTime() > roomRegistry.ROOM_TIMEOUT_MS) {
    await db.query(
      `UPDATE pk_duels SET status = 'cancelled' WHERE id = $1 AND status = 'waiting'`,
      [duelId]
    );
    return res.status(410).json({ error: '這個房間已經逾時取消了，請對方重新開房' });
  }
  if (duel.host_player_id === guestPlayerId) {
    return res.status(400).json({ error: 'cannot join your own duel' });
  }

  const { rows: hostRows } = await db.query(
    `SELECT p.id, t.faction FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1`,
    [duel.host_player_id]
  );
  const hostFaction = hostRows[0].faction;
  if (hostFaction === req.player.faction) {
    return res.status(400).json({ error: 'PK duels are only between opposing factions' });
  }

  await db.query(
    `UPDATE pk_duels SET guest_player_id = $1, status = 'active' WHERE id = $2`,
    [guestPlayerId, duelId]
  );

  if (duel.room_code) roomRegistry.remove(duel.room_code);

  let questionCount;
  try {
    questionCount = await session.createSession(duelId, duel.host_player_id, guestPlayerId);
  } catch (err) {
    await db.query(`UPDATE pk_duels SET status = 'waiting', guest_player_id = NULL WHERE id = $1`, [duelId]);
    return res.status(503).json({ error: 'no PK questions available yet, try again later' });
  }

  console.log(`[pk ${String(duelId).slice(0, 8)}] /join 成功 guest=${guestPlayerId} host=${duel.host_player_id} 題數=${questionCount}`);
  res.json({ duelId, questionCount });
}));

module.exports = router;
