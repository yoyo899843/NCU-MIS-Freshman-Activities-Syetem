require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./db');
const attachSockets = require('./sockets');

const authRoutes = require('./routes/auth');
const mapRoutes = require('./routes/map');
const checkpointRoutes = require('./routes/checkpoints');
const pkRoutes = require('./routes/pk');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json());

// 地圖圖磚是活動前就下載好、永遠不會變的靜態檔案，設長效快取（30 天 + immutable），
// 讓玩家每次重開頁面都直接用瀏覽器本地快取，不會反覆跟伺服器要，省頻寬。
app.use('/tiles', express.static(path.join(__dirname, '..', 'public', 'tiles'), {
  maxAge: '30d',
  immutable: true
}));

// 其餘靜態檔案（HTML/CSS/JS）活動期間可能還會調整，快取時間短一點，
// 但至少 1 小時內重複載入不用整包重抓。
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

// 公開的唯讀遊戲狀態，給玩家頁面/大會 Dashboard 用，不需要登入
// （管理後台改變狀態走的是另一支有 JWT 保護的 /admin/api/game/*）。
app.get('/api/game/state', async (req, res) => {
  const { rows } = await db.query('SELECT status, started_at, ended_at FROM game_state WHERE id = 1');
  res.json(rows[0]);
});

app.use('/api/auth', authRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/checkpoints', checkpointRoutes);
app.use('/api/pk', pkRoutes);
app.use('/admin/api', adminRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

const server = http.createServer(app);
const io = new Server(server);
require('./io').setIO(io);
attachSockets(io);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`time-space-warfare listening on ${port}`);
});
