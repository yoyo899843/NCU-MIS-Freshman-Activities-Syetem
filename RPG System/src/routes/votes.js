const express = require('express');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(schoolAuth);

// 最終投票開放與否由 game_state.voting_unlocked_at 控制（獨立於整體遊戲 status，
// 呼應規格「由後台/計時器統一解鎖」，見 admin.js 的 POST /game/open-voting）。
async function isVotingOpen() {
  const { rows } = await db.query('SELECT voting_unlocked_at FROM game_state WHERE id = 1');
  return !!rows[0]?.voting_unlocked_at;
}

// 回傳目前投票是否開放，以及這支隊伍目前投給誰（還沒投就是 null）。
router.get('/', asyncHandler(async (req, res) => {
  const votingOpen = await isVotingOpen();
  const { rows } = await db.query(
    `SELECT sv.elder_id, sv.submitted_at, e.name AS elder_name
     FROM school_votes sv JOIN elders e ON e.id = sv.elder_id
     WHERE sv.school_id = $1`,
    [req.school.sub]
  );
  res.json({
    votingOpen,
    vote: rows[0] ? { elderId: rows[0].elder_id, elderName: rows[0].elder_name, submittedAt: rows[0].submitted_at } : null
  });
}));

// 投票／改投：voting_unlocked_at 沒設定就整個擋掉。school_votes 用 school_id 當
// PRIMARY KEY（不是投票紀錄表），所以允許在投票開放期間隨時改投——UPSERT 蓋掉
// 前一次的選擇，不是每次都新增一筆。
router.post('/', asyncHandler(async (req, res) => {
  if (!(await isVotingOpen())) {
    return res.status(403).json({ error: 'voting is not open yet' });
  }

  const { elderId } = req.body || {};
  const id = Number.isInteger(elderId) ? elderId : parseInt(elderId, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'elderId is required' });
  }

  const { rows: elderRows } = await db.query('SELECT id, name FROM elders WHERE id = $1', [id]);
  if (elderRows.length === 0) {
    return res.status(400).json({ error: 'elder not found' });
  }

  const { rows: existing } = await db.query(
    'SELECT elder_id FROM school_votes WHERE school_id = $1', [req.school.sub]
  );
  const changed = existing.length === 0 || existing[0].elder_id !== id;

  await db.query(
    `INSERT INTO school_votes (school_id, elder_id, submitted_at)
     VALUES ($1, $2, now())
     ON CONFLICT (school_id) DO UPDATE SET elder_id = EXCLUDED.elder_id, submitted_at = now()`,
    [req.school.sub, id]
  );

  res.json({ voted: true, changed, elder: elderRows[0] });
}));

module.exports = router;
