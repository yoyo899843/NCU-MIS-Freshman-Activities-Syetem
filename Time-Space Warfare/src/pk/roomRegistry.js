// 記憶體內的 roomCode -> duelId 對照表。房號是玩家輸入的短碼，
// duelId(UUID) 才是 DB 裡真正的識別碼。
//
// 開了房沒人加入的話，逾時會做兩件事：從這張表移除，並且把 pk_duels 那一列
// 標記成 cancelled。兩件都要做——只清記憶體的話，服務重啟後殘留的房間
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
  roomCode = String(roomCode).trim();
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
  const entry = rooms.get(String(roomCode).trim());
  return entry ? entry.duelId : null;
}

// 記憶體那張表只活在這個 process 裡：服務一重啟就全空了，但 pk_duels 裡那些
// 還在 waiting 的房間並不會消失。只查記憶體的話，房主明明剛開好房，對手輸入
// 房號卻會得到「房間不存在」——重啟前開的房全部作廢，而且錯誤訊息完全誤導。
//
// 所以查不到就回 DB 找。room_code 沒有 UNIQUE（六碼數字會重複用），所以限定
// status='waiting' 並取最新的一筆；逾時與否交給呼叫端用 created_at 判斷，
// 這裡只負責「這個房號現在對應到哪一場」。
async function lookupInDb(roomCode) {
  const { rows } = await db.query(
    `SELECT id FROM pk_duels
     WHERE room_code = $1 AND status = 'waiting'
     ORDER BY created_at DESC LIMIT 1`,
    [String(roomCode).trim()]
  );
  return rows[0] ? rows[0].id : null;
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

module.exports = { register, lookup, lookupInDb, remove, generateRoomCode, ROOM_TIMEOUT_MS };
