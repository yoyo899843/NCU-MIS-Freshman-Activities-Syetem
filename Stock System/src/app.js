require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');

const teamRoutes = require('./routes/team');
const marketRoutes = require('./routes/market');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db unreachable' });
  }
});

app.use('/api/market', marketRoutes);
app.use('/api/team', teamRoutes);
app.use('/admin/api', adminRoutes);

// API 路徑打錯時回 JSON，不要讓 Express 回它預設的 HTML 錯誤頁——
// 前端一律用 res.json() 解析，收到 HTML 只會得到看不懂的解析錯誤。
app.use(['/api', '/admin/api'], (req, res) => {
  res.status(404).json({ error: 'not found', path: req.originalUrl });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode;
  // 4xx 是使用者送錯東西，照實回報；只有真正的例外才吞成 500。
  if (status && status >= 400 && status < 500) {
    console.warn(`${status} ${req.method} ${req.originalUrl}: ${err.message}`);
    const message = err.type === 'entity.too.large' ? 'request body is too large'
      : err.type === 'entity.parse.failed' ? 'invalid JSON in request body'
      : err.message || 'bad request';
    return res.status(status).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`stock system listening on ${port}`));
