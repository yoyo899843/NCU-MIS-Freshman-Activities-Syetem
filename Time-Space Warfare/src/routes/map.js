const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// 9 個交摺點的即時修復值/破壞值 + 座標 + 目前領先的陣營。
//
// 這支刻意不要求登入：大地圖上的交摺點戰況是公開資訊（大會投影 Dashboard 也要用），
// 玩家彼此的 GPS 位置才是要登入才看得到的（見 src/routes/locations.js）。
router.get('/checkpoints', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, map_lat, map_lng, repair_value, disrupt_value, updated_at
     FROM checkpoints
     ORDER BY id`
  );

  res.json(rows.map(c => {
    const repair = Number(c.repair_value);
    const disrupt = Number(c.disrupt_value);
    // 平手（含兩邊都還是 0）一律回 null，前端畫成中立色，
    // 不要讓「都沒人得分」看起來像某一方領先。
    let leading = null;
    if (repair > disrupt) leading = 'repair';
    else if (disrupt > repair) leading = 'disrupt';

    return {
      id: c.id,
      name: c.name,
      lat: c.map_lat,
      lng: c.map_lng,
      repairValue: repair,
      disruptValue: disrupt,
      leading,
      updatedAt: c.updated_at
    };
  }));
}));

module.exports = router;
