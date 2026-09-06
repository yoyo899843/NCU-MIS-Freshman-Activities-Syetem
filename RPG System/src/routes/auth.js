const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { createLoginThrottle } = require('../loginThrottle');

const router = express.Router();

// 失敗次數限制（見 src/loginThrottle.js：記憶體內、會定期清掉過期項目）。
const loginThrottle = createLoginThrottle();

// 學派登入：帳號是主辦事先用 scripts/create-school.js 建立好的固定帳密，
// 不開放活動當天自行註冊。
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  if (loginThrottle.isLocked(username)) {
    return res.status(429).json({ error: 'too many failed attempts, try again later' });
  }

  const { rows } = await db.query('SELECT * FROM schools WHERE username = $1', [username]);
  const school = rows[0];

  const genericError = () => {
    loginThrottle.recordFailure(username);
    return res.status(401).json({ error: 'invalid username or password' });
  };

  if (!school) return genericError();

  // 明碼比對（不雜湊）——主辦需要能透過「學派管理」後台直接查看/管理每組固定帳密，
  // 雜湊過就永遠查不回來了。見 migrations/003_school_password_plaintext.sql。
  const valid = school.password && school.password === password;
  if (!valid) return genericError();

  loginThrottle.clear(username);

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
