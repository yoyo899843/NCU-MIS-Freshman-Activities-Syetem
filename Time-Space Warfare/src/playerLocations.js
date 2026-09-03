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

const locations = new Map(); // playerId -> { displayName, faction, lat, lng, updatedAt }

// 玩家端是每 2 秒上傳一次，超過這麼久沒收到新的更新，就視為目前斷線中
// （只影響 live 這個欄位怎麼標，不會把資料刪掉）。
const LIVE_MS = 6000;

function setLocation(playerId, data) {
  locations.set(playerId, { ...data, updatedAt: Date.now() });
}

function getAllLocations() {
  const now = Date.now();
  const result = [];
  for (const [playerId, data] of locations) {
    result.push({
      playerId,
      displayName: data.displayName,
      faction: data.faction,
      lat: data.lat,
      lng: data.lng,
      updatedAt: data.updatedAt,
      live: now - data.updatedAt < LIVE_MS
    });
  }
  return result;
}

module.exports = { setLocation, getAllLocations };
