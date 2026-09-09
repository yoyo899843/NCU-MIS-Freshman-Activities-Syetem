const jwt = require('jsonwebtoken');

// 玩家端（隊伍）的 token。role 一定要是 'team'——只驗簽章不驗角色的話，
// 管理端的 token 也能拿來打玩家 API。
module.exports = function teamAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'team') return res.status(401).json({ error: 'not a team token' });
    req.team = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
};
