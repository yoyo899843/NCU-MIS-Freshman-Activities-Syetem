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

module.exports = { CAMPUS_BOUNDS, MARGIN_DEG, isPlausibleCampusCoord };
