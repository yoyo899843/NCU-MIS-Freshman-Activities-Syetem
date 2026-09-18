// 玩家即時位置——刻意不落地到 DB（見 PLAN.md「刻意不建的表」，高頻寫入會拖垮
// 資料庫），單純存記憶體。process 重啟後全部清空是可接受的：下一輪玩家端 2 秒
// 週期上傳就會自動補回來，不需要任何復原機制。
//
// 全域共用單一 instance（跟 db.js 的 pool 同一個道理），不要在其他檔案裡各自
// new 一份，不然不同路由看到的資料會對不起來。
//
// 位置「不會消失」：關掉瀏覽器/斷線之後，這個玩家最後一次回報的座標會一直留著、
// 一直顯示在別人的地圖上，只是標記狀態會從「連線中」變成「離線」。是否還在
// 連線是用 live 這個欄位標出來（見 getAllLocations），前端據此決定要顯示「現在」
// 還是「X 分鐘前」，不是由伺服器端刪資料來表示。

const crypto = require('crypto');

const locations = new Map(); // playerId -> { teamId, lat, lng, updatedAt }

// 地圖上的圓點是「匿名」的（見 溫馨周企劃.pdf：玩家要靠「某據點進度驟降」＋
// 「當時停留在那裡的匿名圓點」自己推理內鬼身分）。所以對外一律不給代號、不給
// 陣營，只給一個看不出身分的代號用來讓前端把同一個圓點跨輪詢對起來——沒有它
// 的話每次輪詢都是新標記，軌跡就斷了，推理也就無從做起。
//
// 不直接用 playerId：玩家自己的登入畫面看得到「隊伍 #N」，playerId 跟 team id
// 是同時建立的連號，等於把「幾號圓點是幾隊」送到對方手上。這裡改發一組隨機
// 代號，process 重啟就重編（重啟本來就會清空所有座標，行為一致）。
const aliases = new Map(); // playerId -> 匿名代號

function aliasOf(playerId) {
  if (!aliases.has(playerId)) {
    aliases.set(playerId, crypto.randomBytes(6).toString('hex'));
  }
  return aliases.get(playerId);
}

// 玩家端是每 2 秒上傳一次，超過這麼久沒收到新的更新，就視為目前斷線中
// （只影響 live 這個欄位怎麼標，不會把資料刪掉）。
const LIVE_MS = 6000;

function setLocation(playerId, data) {
  locations.set(playerId, { ...data, updatedAt: Date.now() });
}

// excludePlayerId：呼叫者自己。自己的位置前端直接用 GPS 畫（不必等伺服器繞一圈），
// 而且從清單裡拿掉之後，玩家連「哪一顆是我」都無從對照起，更不可能反推別人。
function getAllLocations(excludePlayerId) {
  const now = Date.now();
  const result = [];
  for (const [playerId, data] of locations) {
    if (playerId === excludePlayerId) continue;
    result.push({
      id: aliasOf(playerId),
      // teamId 只供 locations route 在伺服器端查詢該隊的筆記；絕不能直接回給玩家。
      teamId: data.teamId,
      lat: data.lat,
      lng: data.lng,
      updatedAt: data.updatedAt,
      live: now - data.updatedAt < LIVE_MS
    });
  }
  return result;
}

// 玩家端寫筆記時只會帶匿名 id。這裡在伺服器記憶體中還原為隊伍 id，前端從頭到尾
// 都拿不到真實 teamId，避免筆記功能意外破壞地圖的匿名推理機制。
function teamIdForAlias(alias) {
  for (const [playerId, candidate] of aliases) {
    if (candidate !== alias) continue;
    return locations.get(playerId)?.teamId || null;
  }
  return null;
}

module.exports = { setLocation, getAllLocations, teamIdForAlias };
