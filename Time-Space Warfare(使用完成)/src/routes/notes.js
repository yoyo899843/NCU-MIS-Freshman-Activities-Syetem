const express = require('express');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { teamIdForAlias } = require('../playerLocations');

const router = express.Router();
router.use(playerAuth);

const MAX_LEN = 10;

// 自己隊伍對「其他隊伍地圖點」的筆記。目標一律用地圖上的匿名 id 表示，只有在
// 伺服器端才還原成 teamId；因此筆記跟著隊伍走、不會跟某次 GPS 座標綁死，也不會
// 把真實隊號或陣營洩漏到前端。
// 寫入/更新一個筆記。送空字串等於刪除。
router.put('/:targetAlias', asyncHandler(async (req, res) => {
  const targetAlias = req.params.targetAlias;
  const targetTeamId = teamIdForAlias(targetAlias);
  if (!targetTeamId) {
    return res.status(404).json({ error: '找不到這個隊伍的位置，請重新整理地圖後再試' });
  }
  if (targetTeamId === req.player.teamId) {
    return res.status(400).json({ error: '不能對自己的隊伍寫筆記' });
  }

  const raw = (req.body || {}).note;
  const note = typeof raw === 'string' ? raw.trim() : '';

  if (!note) {
    await db.query(
      'DELETE FROM team_notes WHERE owner_team_id = $1 AND target_team_id = $2',
      [req.player.teamId, targetTeamId]
    );
    return res.json({ targetAlias, note: null });
  }

  // 用 Array.from 算長度，不是 .length：emoji 在 UTF-16 裡佔兩個以上 code unit，
  // 用 .length 會把一個 emoji 算成好幾個字（DB 的 char_length 也是算字元，
  // 兩邊要一致，不然這裡放行的東西會被 CHECK 擋成 500）。
  if (Array.from(note).length > MAX_LEN) {
    return res.status(400).json({ error: `筆記最多 ${MAX_LEN} 個字` });
  }

  const { rows } = await db.query(
    `INSERT INTO team_notes (owner_team_id, target_team_id, note)
     SELECT $1, id, $3 FROM teams WHERE id = $2
     ON CONFLICT (owner_team_id, target_team_id)
       DO UPDATE SET note = EXCLUDED.note, updated_at = now()
     RETURNING target_team_id, note`,
    [req.player.teamId, targetTeamId, note]
  );
  if (!rows[0]) return res.status(404).json({ error: '這支隊伍已離開，請重新整理地圖後再試' });
  res.json({ targetAlias, note: rows[0].note });
}));

module.exports = router;
