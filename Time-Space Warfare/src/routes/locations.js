const express = require('express');
const playerAuth = require('../middleware/playerAuth');
const { setLocation, getAllLocations } = require('../playerLocations');

const router = express.Router();
router.use(playerAuth);

// 玩家端每 2 秒呼叫一次上傳自己目前的座標（不是每次 GPS 更新就打一次，見
// public/map.html），伺服器只更新記憶體內的一筆資料，不寫進 DB。
router.post('/', (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
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
