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

// 大地圖直接顯示所有還活著（最近更新過）的玩家位置，不分陣營、不分隊伍——
// 玩家端每 2 秒 poll 一次（見 public/map.html），不用 Socket.IO 推播。
router.get('/', (req, res) => {
  res.json(getAllLocations());
});

module.exports = router;
