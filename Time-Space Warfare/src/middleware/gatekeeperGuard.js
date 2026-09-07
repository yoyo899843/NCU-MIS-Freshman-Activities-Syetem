// 管理端的第二層權限：adminAuth 只負責「這是不是一張管理端的 token」，
// 這一層才負責「這個人是管理員還是關主、能不能做這個操作」。
//
// 政策刻意寫成「預設擋下、明確列出可以做的」：之後新增任何寫入型 API，
// 關主預設就是不能碰，要開放得回來這裡加一筆（fail-closed）。
const GATEKEEPER_ALLOWED_WRITES = [
  // 關主駐守據點、在隊伍過關後輸入結果（哪一隊、修復還是破壞）。這就是關主
  // 在現場的本職工作，見 溫馨周企劃.pdf「人員編制與角色」。
  // 只開這一條：據點的新增/刪除/改座標、手動覆寫進度都仍然只有管理員能做。
  /^\/checkpoints\/\d+\/action$/
];

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
