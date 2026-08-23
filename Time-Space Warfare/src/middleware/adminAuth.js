const jwt = require('jsonwebtoken');

// 保護 /admin/api/* 底下的 API：驗證 JWT 是否有效，無效一律回 401。
// 不驗證頁面路由（純靜態 HTML 由前端 JS 自行檢查 localStorage 內的 token 決定要不要導去登入頁）。
function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing token' });
  }

  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = adminAuth;
