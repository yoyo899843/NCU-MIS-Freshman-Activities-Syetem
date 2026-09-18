const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// 各據點目前的修復進度（0~100%）+ 座標。企劃書裡的「進度雷達」看的就是這個。
//
// 這支刻意不要求登入：據點進度是公開資訊（大會投影 Dashboard 也要用，而且玩家
// 本來就要靠「哪個據點進度突然掉」來推理內鬼）。玩家彼此的位置才是要登入才看得
// 到、而且是匿名的（見 src/routes/locations.js）。
router.get('/checkpoints', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, map_lat, map_lng, progress, updated_at
     FROM checkpoints
     ORDER BY id`
  );

  res.json(rows.map(c => ({
    id: c.id,
    name: c.name,
    lat: c.map_lat,
    lng: c.map_lng,
    progress: c.progress,
    // 「已修復完成」＝進度滿 100%。第一權重的陣營勝負就是比這個數量，
    // 所以直接標出來，前端和大螢幕不用各自再判斷一次。
    completed: c.progress >= 100,
    updatedAt: c.updated_at
  })));
}));

module.exports = router;
