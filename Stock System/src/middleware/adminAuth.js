const jwt = require('jsonwebtoken');
const db = require('../db');

// 保護 /admin/api/* 的 API。
//
// 除了驗簽章，還會回資料庫確認這個帳號「現在」還在、以及它「現在」的權限是什麼。
// 多一次查詢是值得的，管理端的請求量本來就很小，而不查會有兩個實際的問題：
//
//  1. 刪掉的帳號還能用。JWT 是無狀態的，簽出去就有效到過期為止（12 小時）。
//     後台把某個銀行關主刪掉之後，他手上那張 token 照樣打得進來——「刪除」變成
//     只是從清單上消失。這是加了 DELETE /admins 之後才浮出來的：以前帳號只能
//     從 CLI 開、不能刪，所以碰不到。
//  2. 權限改了要等 12 小時才生效。role 是登入當下簽進 token 的快照。
//
// 查不到就回 401，讓前端的 api() 把人導回登入頁重新登入。
module.exports = async function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
  if (decoded.role !== 'admin') return res.status(401).json({ error: 'not an admin token' });

  try {
    const { rows } = await db.query(
      'SELECT id, email, display_name, role FROM admin_users WHERE id = $1', [decoded.sub]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: '這個帳號已經不存在了，請重新登入' });
    }
    // 以資料庫為準，不是 token 裡的快照
    req.admin = {
      ...decoded,
      email: rows[0].email,
      displayName: rows[0].display_name,
      adminRole: rows[0].role
    };
    next();
  } catch (err) {
    next(err);
  }
};
