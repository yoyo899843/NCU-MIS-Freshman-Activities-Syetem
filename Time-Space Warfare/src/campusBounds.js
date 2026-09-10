// 伺服器端的座標合理性檢查。
//
// 這裡的角色跟 public/geofence.js **不一樣**，不要混為一談：
//   - public/geofence.js 是「遊戲規則」——精確的活動範圍，玩家走出去就提示他。
//   - 這裡是「防呆」——只擋掉明顯不可能的座標（例如把隊伍標到 75 公里外的台北車站）。
//
// 所以這裡刻意放寬 MARGIN_DEG，比前端範圍寬鬆很多：邊界附近的 GPS 飄移絕對不能
// 因為伺服器拒收而讓隊伍在地圖上不見，那比顯示得不夠精準嚴重得多。
// 前端範圍改了不一定要動這裡，除非活動整個換場地。
const CAMPUS_BOUNDS = {
  minLat: 24.964764,
  maxLat: 24.972425,
  minLng: 121.184735,
  maxLng: 121.197936
};

// 約 1 公里（緯度 1 度 ≈ 111 公里）。夠寬到不會誤擋真的在現場的人，
// 又足以擋掉整個縣市等級的離譜座標。
const MARGIN_DEG = 0.01;

function isPlausibleCampusCoord(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return (
    lat >= CAMPUS_BOUNDS.minLat - MARGIN_DEG && lat <= CAMPUS_BOUNDS.maxLat + MARGIN_DEG &&
    lng >= CAMPUS_BOUNDS.minLng - MARGIN_DEG && lng <= CAMPUS_BOUNDS.maxLng + MARGIN_DEG
  );
}

// 交摺點座標的有效範圍＝「我們手上有圖磚的那一塊」。
//
// 這跟上面玩家 GPS 的檢查是完全不同的標準，兩者不要互相套用：
//   - 玩家座標是裝置量出來的，會飄，寧可寬鬆也不能把人擋成在地圖上消失。
//   - 交摺點座標是主辦在電腦前「打」進去的，打錯就是打錯，而且錯了會很難發現——
//     API 照樣回 200、後台清單照樣顯示那組數字，只是玩家的地圖上永遠看不到那個點
//     （超出 maxBounds 根本拖不過去，就算拖得到也是一片沒有圖磚的灰）。
//     現場才發現「怎麼有個點不見了」，比當下擋下來麻煩太多。
//
// 數值取自圖磚實際覆蓋的範圍，比 CAMPUS_BOUNDS 略大一點點——圖磚是 256px 的整塊，
// 邊界一定會往外多蓋到一些。這組數字必須跟 public/map.html 的 TILE_BOUNDS 一致，
// 那邊拿它當 Leaflet 的 maxBounds。重新下載圖磚（改了 CAMPUS_BOUNDS）的話，
// 這裡和 map.html 都要跟著更新。
const CHECKPOINT_BOUNDS = {
  minLat: 24.964300,
  maxLat: 24.972960,
  minLng: 121.184722,
  maxLng: 121.198396
};

function isInsideMapArea(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return (
    lat >= CHECKPOINT_BOUNDS.minLat && lat <= CHECKPOINT_BOUNDS.maxLat &&
    lng >= CHECKPOINT_BOUNDS.minLng && lng <= CHECKPOINT_BOUNDS.maxLng
  );
}

// 經緯度打反是最常見的一種打錯：從 Google 地圖複製出來就是「緯度, 經度」，
// 但很多工具（包括 GeoJSON）用的是相反的順序，貼錯欄位的機會很高。
//
// 值得單獨判斷是因為這個錯誤有明確的補救方式——「你是不是把兩個欄位對調了」比
// 「座標超出範圍」有用得多，前者告訴人怎麼修，後者只說你錯了。
function looksSwapped(lat, lng) {
  return isInsideMapArea(lng, lat);
}

module.exports = {
  CAMPUS_BOUNDS, MARGIN_DEG, isPlausibleCampusCoord,
  CHECKPOINT_BOUNDS, isInsideMapArea, looksSwapped
};
