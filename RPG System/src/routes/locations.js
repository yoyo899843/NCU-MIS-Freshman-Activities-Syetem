const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');
const { setLocation } = require('../schoolLocations');
const { isPlausibleCampusCoord, MAX_LOCATION_ACCURACY_METERS } = require('../campusBounds');

const router = express.Router();
router.use(schoolAuth);

// 學派端每 2 秒呼叫一次上傳自己目前的座標（不是每次 GPS 更新就打一次，見
// public/map.html），伺服器只更新記憶體內的一筆資料，不寫進 DB。
router.post('/', (req, res) => {
  const { lat, lng, accuracy, deviceId: rawDeviceId } = req.body || {};
  // 裝置編號由前端產生（public/map.html）。更新前就已經開著地圖的舊版頁面不會送，
  // 先當成同一台「legacy」裝置，重新整理頁面後就會帶自己的編號。
  const deviceId = rawDeviceId === undefined ? 'legacy' : rawDeviceId;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9-]{6,64}$/.test(deviceId)) {
    return res.status(400).json({ error: 'deviceId 格式錯誤' });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng must be finite numbers' });
  }
  // 緊急部署時，已開著地圖的舊版頁面還不會送 accuracy。讓它們維持上傳至使用者
  // 重整頁面為止；新版頁面則一律送出 accuracy，並由下面的規則嚴格驗證。
  if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy <= 0)) {
    return res.status(400).json({ error: 'accuracy must be a positive finite number' });
  }
  if (accuracy !== undefined && accuracy > MAX_LOCATION_ACCURACY_METERS) {
    return res.status(422).json({
      error: `定位精準度不足（目前 ±${Math.round(accuracy)} 公尺，需要 ±${MAX_LOCATION_ACCURACY_METERS} 公尺內）`
    });
  }
  // 伺服器端只做合理性檢查，不重複前端的精確圍籬（見 src/campusBounds.js 的說明）：
  // 邊界附近的 GPS 飄移一律照收，但整個縣市等級的離譜座標不收，
  // 免得地圖上出現「隊伍在 75 公里外」這種明顯錯誤的標記。
  if (!isPlausibleCampusCoord(lat, lng)) {
    return res.status(400).json({ error: '座標超出活動區域範圍太多，已忽略這次上傳' });
  }
  if (!setLocation(req.school.sub, deviceId, { displayName: req.school.displayName, lat, lng })) {
    return res.status(429).json({ error: '這個學派同時定位的裝置太多了' });
  }
  res.status(204).end();
});

// 探索導覽地圖顯示每個學派「最後已知」的位置，不分學派敵我——關掉瀏覽器/斷線
// 也不會從清單消失，只是每一筆會多帶 live（是否仍在連線中）跟 updatedAt
// （最後上傳時間），前端據此顯示「現在」或「X 分鐘前」（見 public/map.html）。
// 學派端每 2 秒 poll 一次，不用 Socket.IO 推播（這個系統本來就沒有用 Socket.IO）。
// 刻意沒有讀取所有位置的 GET：玩家地圖只顯示自己，其他人的位置不該讓玩家拿得到
// （就算畫面不畫，只要 API 還在，打開開發者工具就看得到）。
// 全場各裝置的位置只給後台，走 /admin/api/map。

module.exports = router;
