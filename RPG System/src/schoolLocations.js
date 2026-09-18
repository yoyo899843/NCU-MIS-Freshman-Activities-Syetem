// 裝置即時位置——刻意不落地到 DB（跟 Time-Space Warfare 的 src/playerLocations.js
// 是同一套設計：高頻寫入會拖垮資料庫），單純存記憶體。process 重啟後全部清空是
// 可接受的：下一輪各裝置 2 秒週期上傳就會自動補回來，不需要任何復原機制。
//
// 全域共用單一 instance（跟 db.js 的 pool 同一個道理），不要在其他檔案裡各自
// new 一份，不然不同路由看到的資料會對不起來。
//
// 以「裝置」為單位，不是以學派帳號為單位：同一個學派好幾支手機在跑，地圖上就是
// 好幾個點（原本一個學派只有一筆，後上傳的手機會蓋掉前一支的位置，點會跳來跳去）。
// 裝置編號由瀏覽器第一次開地圖時產生、存在那支手機的 localStorage（見 public/map.html）。
//
// 裝置離線超過 EXPIRE_MS 就把紀錄刪掉，地圖上的點也跟著消失；在那之前仍保留
// 最後一次回報的座標，用 live 欄位區分「現在」還是「X 分鐘前」。

const locations = new Map(); // `${schoolId}:${deviceId}` -> { schoolId, deviceId, displayName, lat, lng, updatedAt }

// 裝置端每 2 秒上傳一次，超過這麼久沒收到新的更新，就視為目前斷線中
const LIVE_MS = 6000;
// 離線超過 20 分鐘就刪除紀錄
const EXPIRE_MS = 20 * 60 * 1000;
// 同一個學派同時定位的裝置上限：裝置編號是前端自己產生的，不設上限的話，
// 一個帳號換編號狂送就能把記憶體灌爆、把地圖洗滿假點
const MAX_DEVICES_PER_SCHOOL = 30;

function keyOf(schoolId, deviceId) {
  return `${schoolId}:${deviceId}`;
}

function pruneExpired(now = Date.now()) {
  for (const [key, data] of locations) {
    if (now - data.updatedAt > EXPIRE_MS) locations.delete(key);
  }
}

// 就算一直沒人讀地圖，過期的紀錄也會被清掉，不會在記憶體裡越積越多
setInterval(pruneExpired, 60 * 1000).unref();

// 回傳 false 代表這個學派的裝置數已達上限、這次沒有記錄
function setLocation(schoolId, deviceId, data) {
  const now = Date.now();
  pruneExpired(now);
  const key = keyOf(schoolId, deviceId);
  if (!locations.has(key)) {
    let count = 0;
    for (const v of locations.values()) if (v.schoolId === schoolId) count++;
    if (count >= MAX_DEVICES_PER_SCHOOL) return false;
  }
  locations.set(key, { ...data, schoolId, deviceId, updatedAt: now });
  return true;
}

// 後台刪除學派帳號時，這個學派所有裝置一起拿掉，不然地圖上會留著已經不存在的隊伍
function removeLocation(schoolId) {
  for (const [key, data] of locations) {
    if (data.schoolId === schoolId) locations.delete(key);
  }
}

// 後台重置遊戲時整個清空：重置後地圖上不該還看得到上一場各隊最後的位置
function clearLocations() {
  locations.clear();
}

function getAllLocations() {
  const now = Date.now();
  pruneExpired(now);
  const result = [];
  for (const data of locations.values()) {
    result.push({
      schoolId: data.schoolId,
      deviceId: data.deviceId,
      displayName: data.displayName,
      lat: data.lat,
      lng: data.lng,
      updatedAt: data.updatedAt,
      live: now - data.updatedAt < LIVE_MS
    });
  }
  return result;
}

module.exports = { setLocation, removeLocation, clearLocations, getAllLocations, EXPIRE_MS, MAX_DEVICES_PER_SCHOOL };
