const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');
const { setLocation, getAllLocations } = require('../schoolLocations');

const router = express.Router();
router.use(schoolAuth);

// 學派端每 2 秒呼叫一次上傳自己目前的座標（不是每次 GPS 更新就打一次，見
// public/map.html），伺服器只更新記憶體內的一筆資料，不寫進 DB。
router.post('/', (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }
  setLocation(req.school.sub, { displayName: req.school.displayName, lat, lng });
  res.status(204).end();
});

// 探索導覽地圖顯示每個學派「最後已知」的位置，不分學派敵我——關掉瀏覽器/斷線
// 也不會從清單消失，只是每一筆會多帶 live（是否仍在連線中）跟 updatedAt
// （最後上傳時間），前端據此顯示「現在」或「X 分鐘前」（見 public/map.html）。
// 學派端每 2 秒 poll 一次，不用 Socket.IO 推播（這個系統本來就沒有用 Socket.IO）。
router.get('/', (req, res) => {
  res.json(getAllLocations());
});

module.exports = router;
