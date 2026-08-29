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

router.get('/access-codes', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/access-codes', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.delete('/access-codes/:id', (req, res) => res.status(501).json({ error: 'not implemented' }));

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
