// Socket.IO 連線骨架。room 策略（下一輪接上實際事件邏輯時依此規則實作）：
//   - 'team:<teamId>'  同隊私密頻道（地圖定位、隊友座標）
//   - 'duel:<duelId>'  PK 對戰雙方私密頻道
//   - 不指定 room 的 io.emit(...) 為全域廣播（checkpoint:update、game:state），
//     Dashboard 端不 join 任何 room，天然只收得到全域事件。
function attachSockets(io) {
  io.on('connection', socket => {
    console.log(`socket connected: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.id}`);
    });
  });
}

module.exports = attachSockets;
