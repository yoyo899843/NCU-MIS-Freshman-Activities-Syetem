const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// 失敗次數限制（記憶體內，process 重啟會重置，這裡只是防暴力破解的基本防線）。
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // username -> { count, lockedUntil }

// 學派登入：帳號是主辦事先用 scripts/create-school.js 建立好的固定帳密，
// 不開放活動當天自行註冊。
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const record = failedAttempts.get(username);
  if (record && record.lockedUntil && record.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'too many failed attempts, try again later' });
  }

  const { rows } = await db.query('SELECT * FROM schools WHERE username = $1', [username]);
  const school = rows[0];

  const genericError = () => {
    const count = (record?.count || 0) + 1;
    failedAttempts.set(username, {
      count,
      lockedUntil: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : null
    });
    return res.status(401).json({ error: 'invalid username or password' });
  };

  if (!school) return genericError();

  const valid = await bcrypt.compare(password, school.password_hash);
  if (!valid) return genericError();

  failedAttempts.delete(username);

  const token = jwt.sign(
    { sub: school.id, username: school.username, displayName: school.display_name, role: 'school' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    school: { id: school.id, username: school.username, displayName: school.display_name }
  });
}));

router.get('/me', schoolAuth, (req, res) => {
  res.json({
    schoolId: req.school.sub,
    username: req.school.username,
    displayName: req.school.displayName
  });
});

module.exports = router;
