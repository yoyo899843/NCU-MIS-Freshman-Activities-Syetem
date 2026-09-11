const jwt = require('jsonwebtoken');
const db = require('../db');

// 保護 /admin/api/* 底下的 API：驗證 JWT 是否有效、角色是否為 admin，無效一律回 401。
//
// 簽章對了還要回資料庫確認帳號還在：關主帳號可以在後台刪除，只看 token 的話，
// 被刪掉的關主在 token 過期前（12 小時）都還能繼續操作。權限層級也以資料庫
// 為準，不用 token 裡簽進去的那份，之後在伺服器上用 CLI 調整權限會立刻生效。
async function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
  if (decoded.role !== 'admin') {
    return res.status(401).json({ error: 'not an admin token' });
  }

  try {
    const { rows } = await db.query('SELECT id, email, display_name, role FROM admin_users WHERE id = $1', [decoded.sub]);
    if (rows.length === 0) return res.status(401).json({ error: 'this admin account no longer exists' });
    req.admin = { ...decoded, email: rows[0].email, displayName: rows[0].display_name, adminRole: rows[0].role };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = adminAuth;
