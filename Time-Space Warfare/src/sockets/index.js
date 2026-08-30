const jwt = require('jsonwebtoken');
const pkSession = require('../pk/session');

// Socket.IO room 策略：
//   - 'team:<teamId>'  同隊私密頻道（地圖定位、隊友座標）— 本輪已接上
//   - 'duel:<duelId>'  PK 對戰雙方私密頻道 — 本輪已接上
//   - 不指定 room 的 io.emit(...) 為全域廣播（checkpoint:update、game:state）

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

    // 玩家帶著自己的 player JWT 進場地圖頁，驗證後加入 'team:<teamId>' room。
    // teamId/playerId/displayName 直接從 token 解出來，不用另外查 DB。
    socket.on('team:enter', ({ token }, callback) => {
      const player = verifyPlayerToken(token);
      if (!player) {
        return callback?.({ ok: false, error: 'invalid token' });
      }

      socket.data.playerId = player.sub;
      socket.data.teamId = player.teamId;
      socket.data.displayName = player.displayName;
      socket.join(`team:${player.teamId}`);
      callback?.({ ok: true });
    });

    // 玩家端 geofence.js 的 onUpdate 每次收到「校園範圍內」的定位就會呼叫這個事件，
    // 伺服器原樣轉發給同隊其他連線（不指定的人看不到，因為只 emit 到自己的 team room）。
    // 刻意不落地到 DB（見 PLAN.md「刻意不建的表」），process 重啟或斷線後就沒有歷史座標，
    // 只反映當下正在連線的隊友位置。
    socket.on('team:location', ({ lat, lng }) => {
      if (!socket.data.teamId || !socket.data.playerId) return;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      socket.to(`team:${socket.data.teamId}`).emit('team:location', {
        playerId: socket.data.playerId,
        displayName: socket.data.displayName,
        lat,
        lng
      });
    });

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.id}`);
      // 這個連線如果正在某場 PK 對戰裡，排一個 20 秒判負倒數（見 pk/session.js）；
      // 玩家在 20 秒內重新 pk:enter 的話，這個倒數會被取消，不會誤判。
      if (socket.data.duelId && socket.data.playerId) {
        pkSession.playerDisconnected(io, socket.data.duelId, socket.data.playerId);
      }
      // 隊友定位是即時的，斷線的人就不該再留在別人地圖上——通知同隊其他連線把這個
      // 玩家的標記移除。玩家重新連線後 map.html 會自動重新 team:enter，之後的位置
      // 更新會讓標記重新出現。
      if (socket.data.teamId && socket.data.playerId) {
        io.to(`team:${socket.data.teamId}`).emit('team:left', { playerId: socket.data.playerId });
      }
    });
  });
}

module.exports = attachSockets;
