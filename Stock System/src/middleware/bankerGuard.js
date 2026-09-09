// 管理端的第二層權限。銀行關主（banker）只負責一件事：核准/駁回存款申報。
// 政策是「預設擋下、明確列出可以做的」，之後新增任何寫入型 API，
// banker 預設就碰不到（fail-closed）。
const BANKER_ALLOWED_WRITES = [
  /^\/deposits\/\d+\/(approve|reject)$/
];

function bankerGuard(req, res, next) {
  const role = req.admin.adminRole || 'admin';
  if (role !== 'banker') return next();
  if (req.method === 'GET') return next();
  if (BANKER_ALLOWED_WRITES.some(p => p.test(req.path))) return next();
  return res.status(403).json({ error: '銀行關主只能審核存款，其餘操作要管理員權限' });
}

function requireAdmin(req, res, next) {
  if ((req.admin.adminRole || 'admin') !== 'admin') {
    return res.status(403).json({ error: '這個操作只有管理員可以做' });
  }
  next();
}

module.exports = { bankerGuard, requireAdmin };
