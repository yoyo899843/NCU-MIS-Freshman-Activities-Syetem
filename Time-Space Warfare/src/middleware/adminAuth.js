const jwt = require('jsonwebtoken');
const db = require('../db');

// 保護 /admin/api/* 底下的 API：驗證 JWT 是否有效，無效一律回 401。
// 不驗證頁面路由（純靜態 HTML 由前端 JS 自行檢查 localStorage 內的 token 決定要不要導去登入頁）。
//
// 除了驗簽章，還會回資料庫確認這個帳號「現在」還在、以及它「現在」的權限層級。
// 多一次查詢是值得的，管理端的請求量本來就很小，而不查會有兩個實際的問題：
//
//  1. 被刪掉的帳號還能用。JWT 是無狀態的，簽出去就有效到過期為止（12 小時）。
//     後台把某個關主刪掉之後，他手上那張 token 照樣打得進來——「刪除」變成
//     只是從清單上消失，實際權限一點都沒收回。
//  2. 權限改了要等到 token 過期才生效。adminRole 是登入當下簽進去的快照，
//     把某人從管理員降成關主之後，他這 12 小時內還是管理員。
//
// 這跟玩家端 /api/auth/me 現查陣營、votes.js 現查隊伍陣營是同一個原則：
// 會變的東西不要從 token 讀。
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
    const { rows } = await db.query(
      'SELECT id, email, display_name, role FROM admin_users WHERE id = $1',
      [decoded.sub]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: '這個帳號已經不存在了，請重新登入' });
    }
    // 以資料庫為準，不是 token 裡的快照。
    // role 可能是 NULL（加上權限分級之前建立的舊帳號），沿用 gatekeeperGuard
    // 原本的處理方式當成管理員。
    req.admin = {
      ...decoded,
      email: rows[0].email,
      displayName: rows[0].display_name,
      adminRole: rows[0].role || 'admin'
    };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = adminAuth;
