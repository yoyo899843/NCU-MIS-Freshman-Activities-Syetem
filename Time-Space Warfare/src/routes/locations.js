const express = require('express');
const playerAuth = require('../middleware/playerAuth');
const { setLocation, getAllLocations } = require('../playerLocations');
const { isPlausibleCampusCoord } = require('../campusBounds');

const router = express.Router();
router.use(playerAuth);

// 玩家端每 2 秒呼叫一次上傳自己目前的座標（不是每次 GPS 更新就打一次，見
// public/map.html），伺服器只更新記憶體內的一筆資料，不寫進 DB。
router.post('/', (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }
  // 伺服器端只做合理性檢查，不重複前端的精確圍籬（見 src/campusBounds.js 的說明）：
  // 邊界附近的 GPS 飄移一律照收，但整個縣市等級的離譜座標不收，
  // 免得地圖上出現「隊伍在 75 公里外」這種明顯錯誤的標記。
  if (!isPlausibleCampusCoord(lat, lng)) {
    return res.status(400).json({ error: '座標超出活動區域範圍太多，已忽略這次上傳' });
  }
  setLocation(req.player.sub, {
    displayName: req.player.displayName,
    faction: req.player.faction,
    lat,
    lng
  });
  res.status(204).end();
});

// 大地圖顯示每個玩家「最後已知」的位置，不分陣營、不分隊伍，關掉瀏覽器/斷線
// 也不會從清單消失——只是每一筆會多帶 live（是否仍在連線中）跟 updatedAt
// （最後上傳時間），前端據此顯示「現在」或「X 分鐘前」（見 public/map.html）。
// 玩家端每 2 秒 poll 一次，不用 Socket.IO 推播。
router.get('/', (req, res) => {
  res.json(getAllLocations());
});

module.exports = router;
