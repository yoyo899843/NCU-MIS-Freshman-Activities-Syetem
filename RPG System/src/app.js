require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');

const db = require('./db');

const authRoutes = require('./routes/auth');
const checkpointRoutes = require('./routes/checkpoints');
const accessCodeRoutes = require('./routes/access-codes');
const clueRoutes = require('./routes/clues');
const techTreeRoutes = require('./routes/tech-tree');
const elderRoutes = require('./routes/elders');
const voteRoutes = require('./routes/votes');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json());

// 靜態檔案（HTML/CSS/JS），活動期間可能還會調整，快取時間短一點，
// 至少 1 小時內重複載入不用整包重抓。這個系統沒有自己 host 地圖圖磚，
// 不需要比照 Time-Space Warfare 另外設 /tiles 的長效快取。
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h'
}));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db unreachable' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/checkpoints', checkpointRoutes);
app.use('/api/access-codes', accessCodeRoutes);
app.use('/api/clues', clueRoutes);
app.use('/api/tech-tree', techTreeRoutes);
app.use('/api/elders', elderRoutes);
app.use('/api/votes', voteRoutes);
app.use('/admin/api', adminRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

const server = http.createServer(app);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`rpg-system listening on ${port}`);
});
