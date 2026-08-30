const express = require('express');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(schoolAuth);

// 10 個關卡點位 + 這支隊伍的解鎖/挑戰狀態 + 各點位線索取得進度，給探索導覽地圖用。
// is_locked_by_default = false 的關卡對所有隊伍一開始就是解鎖的；true 的關卡要看
// school_checkpoint_progress 這支隊伍是否已經解鎖過（例如靠權限碼兌換，見 access-codes.js）。
router.get('/', asyncHandler(async (req, res) => {
  const schoolId = req.school.sub;

  const { rows } = await db.query(
    `SELECT
       cp.id, cp.name, cp.description, cp.map_lat, cp.map_lng, cp.is_locked_by_default,
       scp.unlocked_at, scp.challenge_status,
       (SELECT COUNT(*)::int FROM clues c WHERE c.checkpoint_id = cp.id) AS clue_total,
       (SELECT COUNT(*)::int FROM school_clues sc
          JOIN clues c ON c.id = sc.clue_id
          WHERE sc.school_id = $1 AND c.checkpoint_id = cp.id) AS clue_collected
     FROM checkpoints cp
     LEFT JOIN school_checkpoint_progress scp ON scp.checkpoint_id = cp.id AND scp.school_id = $1
     ORDER BY cp.id ASC`,
    [schoolId]
  );

  const checkpoints = rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    mapLat: row.map_lat,
    mapLng: row.map_lng,
    unlocked: !row.is_locked_by_default || row.unlocked_at !== null,
    unlockedAt: row.unlocked_at,
    challengeStatus: row.challenge_status || 'not_started',
    clueCollected: row.clue_collected,
    clueTotal: row.clue_total
  }));

  res.json(checkpoints);
}));

module.exports = router;
