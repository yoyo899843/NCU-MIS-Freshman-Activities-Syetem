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
    return res.status(403).json({ error: 'your team is currently PK-protected', protectedUntil });
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

  res.json({ duelId, roomCode, qrToken });
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
    return res.status(403).json({ error: 'your team is currently PK-protected', protectedUntil });
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
  if (duel.status !== 'waiting') {
    return res.status(409).json({ error: 'duel is not open for joining' });
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

  res.json({ duelId, questionCount });
}));

module.exports = router;
