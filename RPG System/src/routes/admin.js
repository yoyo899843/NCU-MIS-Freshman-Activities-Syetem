const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// --- 簡單的登入失敗鎖定（記憶體內，process 重啟會重置，這裡只是防暴力破解的基本防線） ---
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // email -> { count, lockedUntil }

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const record = failedAttempts.get(email);
  if (record && record.lockedUntil && record.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'too many failed attempts, try again later' });
  }

  const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  const user = rows[0];

  // 不透露「帳號不存在」或「密碼錯誤」的差異，一律回同樣的訊息。
  const genericError = () => {
    const count = (record?.count || 0) + 1;
    failedAttempts.set(email, {
      count,
      lockedUntil: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : null
    });
    return res.status(401).json({ error: 'invalid email or password' });
  };

  if (!user) return genericError();

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return genericError();

  failedAttempts.delete(email);

  const token = jwt.sign(
    { sub: user.id, email: user.email, displayName: user.display_name, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ token });
}));

// 以下全部需要登入
router.use(adminAuth);

router.get('/checkpoints', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/checkpoints', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.patch('/checkpoints/:id', (req, res) => res.status(501).json({ error: 'not implemented' }));

router.get('/clues', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/clues', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.patch('/clues/:id', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.delete('/clues/:id', (req, res) => res.status(501).json({ error: 'not implemented' }));

// 權限碼管理：清單附兌換次數（方便看某組碼被幾隊兌換過）、新增、刪除。
// 目的地（關卡/線索）本身的 CRUD 還沒做，這裡建立時只驗證目的地 id 真的存在。
router.get('/access-codes', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ac.id, ac.code, ac.type, ac.target_checkpoint_id, ac.target_clue_id, ac.created_at,
       cp.name AS target_checkpoint_name,
       cl.name AS target_clue_name,
       (SELECT COUNT(*)::int FROM school_code_redemptions r WHERE r.access_code_id = ac.id) AS redemption_count
     FROM access_codes ac
     LEFT JOIN checkpoints cp ON cp.id = ac.target_checkpoint_id
     LEFT JOIN clues cl ON cl.id = ac.target_clue_id
     ORDER BY ac.created_at DESC`
  );
  res.json(rows);
}));

router.post('/access-codes', asyncHandler(async (req, res) => {
  const { code, type, targetCheckpointId, targetClueId } = req.body || {};
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (!['checkpoint_unlock', 'hidden_clue'].includes(type)) {
    return res.status(400).json({ error: 'type must be checkpoint_unlock or hidden_clue' });
  }
  if (type === 'checkpoint_unlock' && !targetCheckpointId) {
    return res.status(400).json({ error: 'targetCheckpointId is required for checkpoint_unlock codes' });
  }
  if (type === 'hidden_clue' && !targetClueId) {
    return res.status(400).json({ error: 'targetClueId is required for hidden_clue codes' });
  }

  if (type === 'checkpoint_unlock') {
    const { rows } = await db.query('SELECT id FROM checkpoints WHERE id = $1', [targetCheckpointId]);
    if (rows.length === 0) return res.status(400).json({ error: 'target checkpoint does not exist' });
  }
  if (type === 'hidden_clue') {
    const { rows } = await db.query('SELECT id FROM clues WHERE id = $1', [targetClueId]);
    if (rows.length === 0) return res.status(400).json({ error: 'target clue does not exist' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO access_codes (code, type, target_checkpoint_id, target_clue_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        code.trim(),
        type,
        type === 'checkpoint_unlock' ? targetCheckpointId : null,
        type === 'hidden_clue' ? targetClueId : null
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'code already exists' });
    throw err;
  }
}));

router.delete('/access-codes/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM access_codes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    // 已經被兌換過的碼，school_code_redemptions 還留著兌換記錄（FK 擋刪除），
    // 不能直接刪掉，避免破壞稽核歷史。
    if (err.code === '23503') {
      return res.status(409).json({ error: 'cannot delete a code that has already been redeemed' });
    }
    throw err;
  }
}));

router.get('/tech-tree/branches', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/tech-tree/branches', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.patch('/tech-tree/branches/:id', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/tech-tree/slots', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.patch('/tech-tree/slots/:id', (req, res) => res.status(501).json({ error: 'not implemented' }));

router.get('/elders', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/elders', (req, res) => res.status(501).json({ error: 'not implemented' }));

router.post('/game/start', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/game/end', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/game/open-voting', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.get('/game/state', (req, res) => res.status(501).json({ error: 'not implemented' }));

router.get('/scoreboard', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
