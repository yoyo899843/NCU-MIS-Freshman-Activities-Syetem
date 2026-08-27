const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// 現在一組（一支隊伍）只用一支手機登入，所以「登入」等於「開一支新隊伍」，不再有
// 「找一個還沒滿的隊伍塞進去」這件事——每次登入都是新隊伍，直到達到隊伍上限。
const MAX_TEAMS = 20;

// PIN 錯誤次數限制（記憶體內，process 重啟會重置，這裡只是防暴力破解的基本防線）。
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
const pinFailedAttempts = new Map(); // displayName -> { count, lockedUntil }

// 玩家登入：代號 + PIN 碼。
//   - 代號是新的 → 視為新隊伍加入（要檢查隊伍是否已達上限），把這組 PIN 記下來。
//   - 代號已經有人用過 → 視為原本那支隊伍的手機掉線/換手機回來，PIN 對了才能拿回身份，
//     PIN 錯誤不透露「代號被占用」還是「PIN 打錯」，一律同樣的錯誤訊息。
router.post('/join', asyncHandler(async (req, res) => {
  const { displayName, pin } = req.body || {};
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  if (!pin || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }
  // 限制 10 個字，不論中英——用 Array.from 而不是直接 slice()，
  // 避免萬一遇到 emoji 之類的字元被從中間切斷（中英文本身不會有這問題，但這樣寫比較保險）。
  const name = Array.from(displayName.trim()).slice(0, 10).join('');

  const { rows: existingRows } = await db.query(
    `SELECT p.id, p.pin, p.is_captain, p.team_id, t.faction
     FROM players p JOIN teams t ON t.id = p.team_id
     WHERE p.display_name = $1`,
    [name]
  );

  if (existingRows.length > 0) {
    const existing = existingRows[0];

    const record = pinFailedAttempts.get(name);
    if (record && record.lockedUntil && record.lockedUntil > Date.now()) {
      return res.status(429).json({ error: 'too many failed attempts, try again later' });
    }

    // PIN 明碼存放（不雜湊）——主辦/隊輔需要能直接從資料庫查得到某支隊伍的 PIN，
    // 這是活動現場的實際需求，見 PLAN.md。
    const valid = existing.pin && existing.pin === pin;
    if (!valid) {
      const count = (record?.count || 0) + 1;
      pinFailedAttempts.set(name, {
        count,
        lockedUntil: count >= PIN_MAX_ATTEMPTS ? Date.now() + PIN_LOCKOUT_MS : null
      });
      return res.status(401).json({ error: 'this name is taken, or the PIN is incorrect' });
    }

    pinFailedAttempts.delete(name);

    const token = jwt.sign(
      { sub: existing.id, teamId: existing.team_id, faction: existing.faction, displayName: name, role: 'player' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({
      token,
      player: { id: existing.id, displayName: name, isCaptain: existing.is_captain },
      team: { id: existing.team_id, faction: existing.faction },
      returning: true
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: countRows } = await client.query('SELECT COUNT(*)::int AS cnt FROM teams');
    if (countRows[0].cnt >= MAX_TEAMS) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `已達隊伍上限（${MAX_TEAMS} 隊），無法再加入` });
    }

    // 目前兩陣營各自的隊伍數，用來決定這支新隊伍該分去哪邊（人少的那邊，平手隨機）。
    const { rows: counts } = await client.query(
      'SELECT faction, COUNT(*)::int AS cnt FROM teams GROUP BY faction'
    );
    const countMap = { repair: 0, disrupt: 0 };
    counts.forEach(row => { countMap[row.faction] = row.cnt; });

    let faction;
    if (countMap.repair < countMap.disrupt) faction = 'repair';
    else if (countMap.disrupt < countMap.repair) faction = 'disrupt';
    else faction = Math.random() < 0.5 ? 'repair' : 'disrupt';

    const { rows: maxRows } = await client.query(
      'SELECT COALESCE(MAX(team_number), 0) + 1 AS next_number FROM teams WHERE faction = $1',
      [faction]
    );
    const teamNumber = maxRows[0].next_number;
    const { rows: newTeam } = await client.query(
      'INSERT INTO teams (faction, team_number) VALUES ($1, $2) RETURNING id',
      [faction, teamNumber]
    );
    const teamId = newTeam[0].id;

    // 一組一支手機，登入的人就是這支隊伍唯一的操作者。
    const { rows: playerRows } = await client.query(
      'INSERT INTO players (team_id, display_name, is_captain, pin) VALUES ($1, $2, true, $3) RETURNING id, display_name, is_captain',
      [teamId, name, pin]
    );
    const player = playerRows[0];

    await client.query('COMMIT');

    const token = jwt.sign(
      { sub: player.id, teamId, faction, displayName: player.display_name, role: 'player' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      player: { id: player.id, displayName: player.display_name, isCaptain: player.is_captain },
      team: { id: teamId, faction },
      returning: false
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/me', playerAuth, (req, res) => {
  res.json({
    playerId: req.player.sub,
    teamId: req.player.teamId,
    faction: req.player.faction,
    displayName: req.player.displayName
  });
});

module.exports = router;
