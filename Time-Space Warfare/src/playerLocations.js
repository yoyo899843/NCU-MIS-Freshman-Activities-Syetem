// 玩家即時位置——刻意不落地到 DB（見 PLAN.md「刻意不建的表」，高頻寫入會拖垮
// 資料庫），單純存記憶體。process 重啟後全部清空是可接受的：下一輪玩家端 2 秒
// 週期上傳就會自動補回來，不需要任何復原機制。
//
// 全域共用單一 instance（跟 db.js 的 pool 同一個道理），不要在其他檔案裡各自
// new 一份，不然不同路由看到的資料會對不起來。

const locations = new Map(); // playerId -> { displayName, faction, lat, lng, updatedAt }

// 超過這麼久沒收到更新的位置，視為玩家已經離開/斷線，GET 的時候直接濾掉、
// 順便清掉這筆記憶體，不會讓別人的地圖上留著一個永遠不動的殭屍標記。
// 玩家端是每 2 秒上傳一次，這裡抓 3 倍緩衝，容忍一兩次上傳漏掉不會立刻消失。
const STALE_MS = 6000;

function setLocation(playerId, data) {
  locations.set(playerId, { ...data, updatedAt: Date.now() });
}

function getAllLocations() {
  const now = Date.now();
  const result = [];
  for (const [playerId, data] of locations) {
    if (now - data.updatedAt > STALE_MS) {
      locations.delete(playerId);
      continue;
    }
    result.push({ playerId, displayName: data.displayName, faction: data.faction, lat: data.lat, lng: data.lng });
  }
  return result;
}

module.exports = { setLocation, getAllLocations };
