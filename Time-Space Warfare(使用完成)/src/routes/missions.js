const express = require('express');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(playerAuth);

// 玩家端的任務信箱：只看得到自己隊伍的任務。
//
// 刻意不回傳 unlock_code。解鎖碼是「關主確認任務完成」的唯一憑證，玩家看得到
// 就等於可以不做任務自己結案。前端沒有欄位顯示它是不夠的——打 API 就看到了。
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id, m.content, m.status, m.created_at, m.completed_at,
            m.checkpoint_id, c.name AS checkpoint_name
     FROM missions m
     LEFT JOIN checkpoints c ON c.id = m.checkpoint_id
     WHERE m.team_id = $1
     ORDER BY m.status = 'open' DESC, m.created_at DESC`,
    [req.player.teamId]
  );
  res.json(rows);
}));

// 輸入解鎖碼結案。
router.post('/:id/complete', asyncHandler(async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '請輸入解鎖碼' });

  // 條件全部塞進 UPDATE 的 WHERE：先查再改的話，同一支隊伍連按兩次送出，
  // 兩次都會通過檢查、結案兩次（積分就多算一次）。
  const { rows } = await db.query(
    `UPDATE missions SET status = 'completed', completed_at = now()
     WHERE id = $1 AND team_id = $2 AND status = 'open' AND upper(unlock_code) = $3
     RETURNING id, content, completed_at`,
    [req.params.id, req.player.teamId, code]
  );

  if (rows.length === 0) {
    // 不分別回報「任務不存在」「不是你的任務」「已經結案」「碼錯了」——
    // 分開講等於讓人可以用錯誤訊息試出別隊任務的解鎖碼。
    return res.status(400).json({ error: '解鎖碼不正確，或這個任務已經結案了' });
  }

  res.json({ ok: true, mission: rows[0] });
}));

module.exports = router;
