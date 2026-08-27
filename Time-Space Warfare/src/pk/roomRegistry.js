// 記憶體內的 roomCode -> duelId 對照表。房號是玩家輸入的短碼，
// duelId(UUID) 才是 DB 裡真正的識別碼。配對成功或逾時未配對就從表中移除，
// process 重啟後這份表會清空（進行中未配對的房間會失效，屬於已知取捨，見 PLAN.md）。

const ROOM_TIMEOUT_MS = 5 * 60 * 1000; // 5 分鐘沒人加入就自動失效

const rooms = new Map(); // roomCode -> { duelId, timeout }

function register(roomCode, duelId) {
  const timeout = setTimeout(() => {
    rooms.delete(roomCode);
  }, ROOM_TIMEOUT_MS);
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

module.exports = { register, lookup, remove, generateRoomCode };
