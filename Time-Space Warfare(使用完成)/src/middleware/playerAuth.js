const jwt = require('jsonwebtoken');

// 保護玩家端 API：驗證玩家 JWT（role: 'player'），無效一律回 401。
// 跟 adminAuth 共用同一組 JWT_SECRET，但用 role 區分，避免拿玩家 token 冒充 admin token（反之亦然）。
function playerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'missing token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'player') {
      return res.status(401).json({ error: 'not a player token' });
    }
    req.player = decoded; // { sub: playerId, teamId, faction, displayName }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = playerAuth;
