const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const teamAuth = require('../middleware/teamAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { createLoginThrottle } = require('../loginThrottle');
const { portfolio, placeOrder } = require('../portfolio');

const router = express.Router();
const pinThrottle = createLoginThrottle();

async function state() {
  const { rows } = await db.query('SELECT wave, total_waves, phase FROM game_state WHERE id = 1');
  return rows[0];
}

/* ---------------- 登入 ---------------- */

// 隊伍帳號由主辦事先在後台建立（跟隊名一起），玩家用隊名 + 4 碼 PIN 登入。
// 不開放自行註冊：現場的隊伍是報名時就固定的。
router.post('/login', asyncHandler(async (req, res) => {
  const { displayName, pin } = req.body || {};
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) return res.status(400).json({ error: '請輸入隊伍名稱' });
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN 要剛好 4 碼數字' });
  }

  if (pinThrottle.isLocked(name)) {
    return res.status(429).json({ error: '嘗試太多次，請稍後再試' });
  }

  const { rows } = await db.query(
    'SELECT id, display_name, pin FROM teams WHERE display_name = $1', [name]
  );
  const team = rows[0];
  // 不分別回報「隊伍不存在」與「PIN 錯」——分開講等於讓人可以枚舉出隊名。
  if (!team || team.pin !== pin) {
    pinThrottle.recordFailure(name);
    return res.status(401).json({ error: '隊伍名稱或 PIN 不正確' });
  }
  pinThrottle.clear(name);

  const token = jwt.sign(
    { sub: team.id, displayName: team.display_name, role: 'team' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  res.json({ token, team: { id: team.id, displayName: team.display_name } });
}));

router.get('/me', teamAuth, asyncHandler(async (req, res) => {
  const s = await state();
  res.json({ teamId: req.team.sub, displayName: req.team.displayName, ...s });
}));

/* ---------------- 以下需要登入 ---------------- */
router.use(teamAuth);

// 資產總覽：可用現金、各檔持股與現值。
router.get('/portfolio', asyncHandler(async (req, res) => {
  const s = await state();
  const p = await portfolio(req.team.sub, s.wave);
  if (!p) return res.status(404).json({ error: '找不到這支隊伍' });
  res.json({ ...p, wave: s.wave, phase: s.phase });
}));

// 本波的存款申報狀態（審核中／已通過／異常遭拒）。
router.get('/deposit', asyncHandler(async (req, res) => {
  const s = await state();
  const { rows } = await db.query(
    'SELECT id, wave, amount, status, created_at, reviewed_at FROM deposits WHERE team_id = $1 AND wave = $2',
    [req.team.sub, s.wave]
  );
  res.json({ wave: s.wave, phase: s.phase, deposit: rows[0] || null });
}));

// 申報本波要存入的金額，送出後由實體銀行攤位數鈔核對。
router.post('/deposit', asyncHandler(async (req, res) => {
  const s = await state();
  if (s.phase !== 'deposit') {
    return res.status(403).json({ error: '現在不是資產申報階段', phase: s.phase });
  }

  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: '金額必須是 0 或正數' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO deposits (team_id, wave, amount) VALUES ($1,$2,$3)
       RETURNING id, wave, amount, status, created_at`,
      [req.team.sub, s.wave, amount]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    // UNIQUE(team_id, wave)：一波只能申報一次。可以重送的話，被駁回的隊伍
    // 就能一直改金額重試，實體數鈔那一關等於白做。
    if (err.code === '23505') {
      return res.status(409).json({ error: '本波已經申報過了，請找銀行關主處理' });
    }
    throw err;
  }
}));

// 下單。
router.post('/orders', asyncHandler(async (req, res) => {
  const s = await state();
  if (s.phase !== 'trading') {
    return res.status(403).json({ error: '現在不是交易階段', phase: s.phase });
  }

  // 企劃的防呆三：本波存款沒通過審核，交易功能直接鎖定。
  const { rows: dep } = await db.query(
    'SELECT status FROM deposits WHERE team_id = $1 AND wave = $2',
    [req.team.sub, s.wave]
  );
  if (!dep[0] || dep[0].status !== 'approved') {
    return res.status(403).json({
      error: dep[0] && dep[0].status === 'rejected'
        ? '本波申報金額與實際不符遭駁回，這一波不能交易'
        : '本波的存款申報還沒通過銀行審核，不能交易'
    });
  }

  const { stockId, side, shares } = req.body || {};
  const result = await placeOrder({
    teamId: req.team.sub,
    stockId: Number(stockId),
    side,
    shares: Number(shares),
    wave: s.wave
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.trade);
}));

// 自己隊伍的成交紀錄。
router.get('/trades', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.wave, t.side, t.shares, t.price, t.total, t.created_at, s.name AS stock_name
     FROM trades t JOIN stocks s ON s.id = t.stock_id
     WHERE t.team_id = $1 ORDER BY t.id DESC LIMIT 100`,
    [req.team.sub]
  );
  res.json(rows);
}));

module.exports = router;
