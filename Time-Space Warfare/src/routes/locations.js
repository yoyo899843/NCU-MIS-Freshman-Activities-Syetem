const express = require('express');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');
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
  // 只存座標。代號跟陣營刻意不存進來——地圖是匿名的，存了就遲早會從某個
  // 回應漏出去（見 src/playerLocations.js 的說明）。
  setLocation(req.player.sub, { teamId: req.player.teamId, lat, lng });
  res.status(204).end();
});

// 大地圖顯示每支隊伍「最後已知」的位置，一律是匿名圓點：沒有代號、沒有陣營，
// 只有一組看不出身分的 id（用來把同一顆圓點跨輪詢對起來，軌跡才連得起來）。
// 關掉瀏覽器/斷線也不會從清單消失——每一筆多帶 live（是否仍在連線中）跟
// updatedAt（最後上傳時間），前端據此顯示「現在」或「X 分鐘前」。
// 玩家端每 2 秒 poll 一次，不用 Socket.IO 推播。
router.get('/', asyncHandler(async (req, res) => {
  // getAllLocations 內部帶著 teamId，僅供這裡把「自己隊寫給該隊的筆記」接上；
  // 回 JSON 前一定拆掉，地圖仍然只有匿名 id，沒有隊名、陣營或真實隊伍編號。
  const locations = getAllLocations(req.player.sub);
  const teamIds = [...new Set(locations.map(p => p.teamId).filter(Number.isInteger))];
  const notesByTeam = {};
  if (teamIds.length) {
    const { rows } = await db.query(
      `SELECT target_team_id, note FROM team_notes
       WHERE owner_team_id = $1 AND target_team_id = ANY($2::int[])`,
      [req.player.teamId, teamIds]
    );
    rows.forEach(r => { notesByTeam[r.target_team_id] = r.note; });
  }

  res.json(locations.map(({ teamId, ...location }) => ({
    ...location,
    note: notesByTeam[teamId] || null
  })));
}));

module.exports = router;
