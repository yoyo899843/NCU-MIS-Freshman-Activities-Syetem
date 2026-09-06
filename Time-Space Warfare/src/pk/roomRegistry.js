// 記憶體內的 roomCode -> duelId 對照表。房號是玩家輸入的短碼，
// duelId(UUID) 才是 DB 裡真正的識別碼。
//
// 開了房沒人加入的話，逾時會做兩件事：從這張表移除，並且把 pk_duels 那一列
// 標記成 cancelled。兩件都要做——只清記憶體的話，用 qr_token 加入的路徑
// （不看這張表、直接查 DB）還是找得到那場廢棄的對戰。
const db = require('../db');

// 逾時長度與它跟開賽逾時的先後關係，統一定義在 ./timeouts.js
const { ROOM_TIMEOUT_MS } = require('./timeouts');

const rooms = new Map(); // roomCode -> { duelId, timeout }

async function cancelDuel(duelId) {
  try {
    // 條件帶 status='waiting'：萬一逾時的瞬間剛好有人加入成功（已經變 active），
    // 這句就不會生效，不會把進行中的對戰誤殺。
    await db.query(
      `UPDATE pk_duels SET status = 'cancelled' WHERE id = $1 AND status = 'waiting'`,
      [duelId]
    );
  } catch (err) {
    console.error('cancel expired PK duel failed:', err);
  }
}

function register(roomCode, duelId) {
  const timeout = setTimeout(() => {
    console.log(`[pk ${String(duelId).slice(0, 8)}] 房間逾時，沒有人加入 roomCode=${roomCode}`);
    rooms.delete(roomCode);
    cancelDuel(duelId);
  }, ROOM_TIMEOUT_MS);
  // 逾時計時器不該擋住 process 結束
  if (typeof timeout.unref === 'function') timeout.unref();
  rooms.set(roomCode, { duelId, timeout });
}

function lookup(roomCode) {
  const entry = rooms.get(roomCode);
  return entry ? entry.duelId : null;
}

function remove(roomCode) {
  const entry = rooms.get(roomCode);
  if (entry) {
    clearTimeout(entry.timeout);
    rooms.delete(roomCode);
  }
}

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

module.exports = { register, lookup, remove, generateRoomCode, ROOM_TIMEOUT_MS };
