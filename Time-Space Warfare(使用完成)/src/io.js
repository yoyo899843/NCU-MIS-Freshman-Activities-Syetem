// 讓其他模組（例如 admin 路由）不用一路把 io 當參數傳遞，也能廣播全域事件。
// app.js 建立 Socket.IO server 後呼叫一次 setIO，之後 getIO() 到處都能拿到同一個 instance。
let ioInstance = null;

function setIO(io) {
  ioInstance = io;
}

function getIO() {
  if (!ioInstance) throw new Error('io not initialized yet');
  return ioInstance;
}

module.exports = { setIO, getIO };
