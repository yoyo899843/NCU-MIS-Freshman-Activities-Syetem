const jwt = require('jsonwebtoken');
const pkSession = require('../pk/session');

// Socket.IO room 策略：
//   - 'duel:<duelId>'  PK 對戰雙方私密頻道 — 本輪已接上
//   - 不指定 room 的 io.emit(...) 為全域廣播（checkpoint:update、game:state）
//
// 玩家即時定位原本走這裡的 'team:<teamId>' room，但規格改成大地圖直接顯示
// 所有人的位置（不分隊伍），且改成固定 2 秒週期上傳/輪詢，不需要即時推播，
// 已經整個換成 REST（見 routes/locations.js + playerLocations.js），
// 這裡不再處理定位相關事件。

function verifyPlayerToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'player') return null;
    return decoded;
  } catch (err) {
    return null;
  }
}

function attachSockets(io) {
  io.on('connection', socket => {
    console.log(`socket connected: ${socket.id}`);

    // 玩家帶著 PK 對戰的 duelId + 自己的 player JWT 進場，驗證身份後加入 'duel:<duelId>' room。
    // 兩人都第一次到齊後由 pk/session.js 觸發送出第一題；如果對戰已經在進行中
    // （這次是重連，而不是第一次進場），playerEntered 會直接補送目前進度給這個 socket。
    socket.on('pk:enter', ({ duelId, token }, callback) => {
      const player = verifyPlayerToken(token);
      if (!player) {
        return callback?.({ ok: false, error: 'invalid token' });
      }

      const result = pkSession.playerEntered(io, socket, duelId, player.sub);
      if (result.ok) {
        // 只有真的驗證通過、屬於這場對戰的玩家才加入房間，避免驗證失敗的連線
        // 還是被塞進房間、收到不屬於他的對戰廣播。
        socket.data.playerId = player.sub;
        socket.data.duelId = duelId;
        socket.join(`duel:${duelId}`);
      }
      callback?.(result);
    });

    socket.on('pk:answer', ({ duelId, questionIndex, selectedOption }, callback) => {
      if (!socket.data.playerId || socket.data.duelId !== duelId) {
        return callback?.({ ok: false, error: 'not entered into this duel' });
      }
      const result = pkSession.submitAnswer(io, duelId, socket.data.playerId, questionIndex, selectedOption);
      callback?.(result);
    });

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.id}`);
      // 這個連線如果正在某場 PK 對戰裡，排一個 20 秒判負倒數（見 pk/session.js）；
      // 玩家在 20 秒內重新 pk:enter 的話，這個倒數會被取消，不會誤判。
      if (socket.data.duelId && socket.data.playerId) {
        pkSession.playerDisconnected(io, socket.data.duelId, socket.data.playerId);
      }
    });
  });
}

module.exports = attachSockets;
