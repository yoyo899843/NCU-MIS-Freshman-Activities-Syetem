const jwt = require('jsonwebtoken');
const db = require('../db');

// 保護學派端 API：驗證 JWT 是否有效、角色是否為 school，無效一律回 401。
// 跟 adminAuth 共用同一組 JWT_SECRET，但用 role 區分，避免拿學派 token 冒充 admin token（反之亦然）。
//
// 簽章對了還要回資料庫確認帳號還在：主辦可以在後台刪除學派帳號，只看 token
// 的話，被刪掉的隊伍手上那張 token 在過期前（12 小時）都還能繼續打 API。
// 帳號、顯示名稱也以資料庫為準，後台改名之後不用重新登入就會生效
// （例如地圖上即時位置顯示的名字）。
async function schoolAuth(req, res, next) {
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
  if (decoded.role !== 'school') {
    return res.status(401).json({ error: 'not a school token' });
  }

  try {
    const { rows } = await db.query('SELECT id, username, display_name FROM schools WHERE id = $1', [decoded.sub]);
    if (rows.length === 0) return res.status(401).json({ error: 'this school account no longer exists' });
    // { sub: schoolId, username, displayName }
    req.school = { ...decoded, username: rows[0].username, displayName: rows[0].display_name };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = schoolAuth;
