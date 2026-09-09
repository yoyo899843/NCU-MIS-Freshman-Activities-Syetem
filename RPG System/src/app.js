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
const locationRoutes = require('./routes/locations');
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

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`rpg-system listening on ${port}`);
});

// 收到 docker stop / Ctrl-C 時把伺服器關乾淨。
//
// 這段不是可有可無的：容器裡 app 是 PID 1，而 PID 1 拿不到預設的訊號處理——
// kernel 只在行程「自己裝了 handler」時才把訊號送過去，沒裝就直接忽略。結果是
// docker stop 每次都要等 10 秒逾時再 SIGKILL（實測過就是 10.4 秒），部署重啟
// 因此每個系統都白等十秒。
//
// 逾時保險：Socket.IO 的長連線不會因為 server.close() 就斷，等它自己收會一直
// 卡著，所以給 5 秒上限。unref 讓這個計時器不要反過來拖住 process。
function shutdown(signal) {
  console.log(`收到 ${signal}，關閉中...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
