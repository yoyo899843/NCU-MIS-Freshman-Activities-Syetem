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

// 地圖圖磚是活動前用 scripts/download-tiles.js 預先下載、內容不會變的靜態檔案，
// 設長效快取（30 天 + immutable），避免多隊反覆開關探索導覽頁時重複下載同樣的圖磚，
// 比照 Time-Space Warfare 的做法（見 PLAN.md 的頻寬考量）。
app.use('/tiles', express.static(path.join(__dirname, '..', 'public', 'tiles'), {
  maxAge: '30d',
  immutable: true
}));

// 其餘靜態檔案（HTML/CSS/JS），活動期間可能還會調整，快取時間短一點，
// 至少 1 小時內重複載入不用整包重抓。
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
