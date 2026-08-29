const jwt = require('jsonwebtoken');

// 保護學派端 API：驗證 JWT 是否有效、角色是否為 school，無效一律回 401。
// 跟 adminAuth 共用同一組 JWT_SECRET，但用 role 區分，避免拿學派 token 冒充 admin token（反之亦然）。
function schoolAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'school') {
      return res.status(401).json({ error: 'not a school token' });
    }
    req.school = decoded; // { sub: schoolId, username, displayName }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = schoolAuth;
