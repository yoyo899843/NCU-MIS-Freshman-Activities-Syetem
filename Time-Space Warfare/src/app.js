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
const locationRoutes = require('./routes/locations');
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
  const { rows } = await db.query(
    'SELECT status, started_at, ended_at, duration_minutes FROM game_state WHERE id = 1'
  );
  // serverNow：投影用的那台電腦時鐘不一定準，差幾分鐘倒數就整個錯掉。回傳伺服器
  // 當下的時間，讓前端自己算出時鐘差再套用，倒數就跟伺服器一致（見 dashboard.html）。
  res.json({ ...rows[0], serverNow: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/checkpoints', checkpointRoutes);
app.use('/api/pk', pkRoutes);
app.use('/api/locations', locationRoutes);
app.use('/admin/api', adminRoutes);

// API 路徑打錯時回 JSON，不要讓 Express 回它預設的 HTML 錯誤頁——
// 前端一律用 res.json() 解析回應，收到 HTML 只會拋出看不懂的 parse error。
app.use(['/api', '/admin/api'], (req, res) => {
  res.status(404).json({ error: 'not found', path: req.originalUrl });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // express.json() 之類的中介層會丟出自帶狀態碼的錯誤（JSON 壞掉是 400、
  // body 太大是 413）。這些是「請求本身有問題」，不該一律當成伺服器爆掉回 500，
  // 不然前端分不出是自己送錯還是伺服器出事，log 也會被一堆假的 500 淹沒。
  const status = err.status || err.statusCode;
  if (status && status >= 400 && status < 500) {
    // 4xx 是預期內的用戶端錯誤，記一行就好，不用印整個 stack
    console.warn(`${status} ${req.method} ${req.originalUrl}: ${err.message}`);
    const message = err.type === 'entity.too.large' ? 'request body is too large'
      : err.type === 'entity.parse.failed' ? 'invalid JSON in request body'
      : err.message || 'bad request';
    return res.status(status).json({ error: message });
  }

  console.error(err);
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
