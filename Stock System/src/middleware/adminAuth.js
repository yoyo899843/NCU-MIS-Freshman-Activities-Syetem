const jwt = require('jsonwebtoken');

module.exports = function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(401).json({ error: 'not an admin token' });
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
};
