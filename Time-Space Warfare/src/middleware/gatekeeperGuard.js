// 管理端的第二層權限：adminAuth 只負責「這是不是一張管理端的 token」，
// 這一層才負責「這個人是管理員還是關主、能不能做這個操作」。
//
// 這個系統的關主目前只有唯讀權限——交摺點掃碼答題那條主線（routes/checkpoints.js）
// 還是 501 stub，schema 裡也沒有「某支隊伍在某個交摺點的進度」這種東西，
// 所以還沒有「幫隊伍標記關卡完成」可以做；等交摺點玩法做出來之後，再比照
// RPG System 的做法在下面開白名單。
//
// 政策刻意寫成「預設擋下、明確列出可以做的」：之後新增任何寫入型 API，
// 關主預設就是不能碰，要開放得回來這裡加一筆（fail-closed）。
const GATEKEEPER_ALLOWED_WRITES = [];

function gatekeeperGuard(req, res, next) {
  // adminRole 沒帶＝這張 token 是加上權限分級之前簽出來的，當成管理員處理，
  // 維持跟以前完全一樣的行為，避免部署當下還拿著舊 token 的人突然被降權。
  const adminRole = req.admin.adminRole || 'admin';
  if (adminRole !== 'gatekeeper') return next();

  if (req.method === 'GET') return next();
  if (GATEKEEPER_ALLOWED_WRITES.some(pattern => pattern.test(req.path))) return next();

  return res.status(403).json({ error: '關主權限不足，這個操作只有管理員可以做' });
}

// 只有管理員能碰的東西（例如帳號權限管理本身）額外再擋一層，
// 不依賴上面那份清單有沒有漏列。
function requireFullAdmin(req, res, next) {
  const adminRole = req.admin.adminRole || 'admin';
  if (adminRole !== 'admin') {
    return res.status(403).json({ error: '這個操作只有管理員可以做' });
  }
  next();
}

module.exports = { gatekeeperGuard, requireFullAdmin };
