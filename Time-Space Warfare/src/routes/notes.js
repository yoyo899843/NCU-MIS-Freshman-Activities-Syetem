const express = require('express');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(playerAuth);

const MAX_LEN = 10;

// 自己隊伍對各據點的筆記。只回自己隊的——這是隊伍私有的推理筆記，
// 別隊看得到的話就變成公共留言板，內鬼可以直接放假消息。
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT checkpoint_id, note FROM checkpoint_notes WHERE team_id = $1',
    [req.player.teamId]
  );
  res.json(Object.fromEntries(rows.map(r => [r.checkpoint_id, r.note])));
}));

// 寫入/更新一個據點的筆記。送空字串等於刪除。
router.put('/:checkpointId', asyncHandler(async (req, res) => {
  const checkpointId = Number(req.params.checkpointId);
  if (!Number.isInteger(checkpointId)) {
    return res.status(400).json({ error: 'checkpointId 不正確' });
  }

  const raw = (req.body || {}).note;
  const note = typeof raw === 'string' ? raw.trim() : '';

  if (!note) {
    await db.query(
      'DELETE FROM checkpoint_notes WHERE team_id = $1 AND checkpoint_id = $2',
      [req.player.teamId, checkpointId]
    );
    return res.json({ checkpointId, note: null });
  }

  // 用 Array.from 算長度，不是 .length：emoji 在 UTF-16 裡佔兩個以上 code unit，
  // 用 .length 會把一個 emoji 算成好幾個字（DB 的 char_length 也是算字元，
  // 兩邊要一致，不然這裡放行的東西會被 CHECK 擋成 500）。
  if (Array.from(note).length > MAX_LEN) {
    return res.status(400).json({ error: `筆記最多 ${MAX_LEN} 個字` });
  }

  const { rows: cp } = await db.query('SELECT id FROM checkpoints WHERE id = $1', [checkpointId]);
  if (cp.length === 0) return res.status(404).json({ error: '找不到這個據點' });

  const { rows } = await db.query(
    `INSERT INTO checkpoint_notes (team_id, checkpoint_id, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (team_id, checkpoint_id)
       DO UPDATE SET note = EXCLUDED.note, updated_at = now()
     RETURNING checkpoint_id, note`,
    [req.player.teamId, checkpointId, note]
  );
  res.json({ checkpointId: rows[0].checkpoint_id, note: rows[0].note });
}));

module.exports = router;
