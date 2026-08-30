const express = require('express');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(schoolAuth);

// QR 掃描取得線索：跟權限碼兌換是兩條不同的取得路徑，各自寫進 school_clues 的
// acquired_via 不同（這裡固定是 'scan'）。掃到已經拿過的線索（不論當初是掃碼還是
// 兌換碼拿到的）不會報錯、也不會重複寫入，只會在回應裡標記 alreadyAcquired，
// 讓前端可以顯示「你已經有這個線索了」而不是當成失敗處理。
router.post('/scan', asyncHandler(async (req, res) => {
  const { qrToken } = req.body || {};
  if (!qrToken || typeof qrToken !== 'string' || !qrToken.trim()) {
    return res.status(400).json({ error: 'qrToken is required' });
  }
  const schoolId = req.school.sub;

  const { rows: clueRows } = await db.query(
    'SELECT id, name, description, image_url, checkpoint_id FROM clues WHERE qr_token = $1',
    [qrToken.trim()]
  );
  if (clueRows.length === 0) {
    return res.status(404).json({ error: 'invalid QR code' });
  }
  const clue = clueRows[0];

  const { rows: inserted } = await db.query(
    `INSERT INTO school_clues (school_id, clue_id, acquired_via)
     VALUES ($1, $2, 'scan')
     ON CONFLICT (school_id, clue_id) DO NOTHING
     RETURNING acquired_at`,
    [schoolId, clue.id]
  );

  let acquiredAt = inserted[0]?.acquired_at;
  const alreadyAcquired = inserted.length === 0;
  if (alreadyAcquired) {
    const { rows: existingRows } = await db.query(
      'SELECT acquired_at FROM school_clues WHERE school_id = $1 AND clue_id = $2',
      [schoolId, clue.id]
    );
    acquiredAt = existingRows[0]?.acquired_at;
  }

  res.json({ scanned: true, alreadyAcquired, acquiredAt, clue });
}));

// 線索庫：依取得時間序列出這支隊伍已經拿到的所有線索（不論是掃碼還是兌換權限碼拿到的）。
router.get('/vault', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.description, c.image_url, c.checkpoint_id, sc.acquired_at, sc.acquired_via
     FROM school_clues sc
     JOIN clues c ON c.id = sc.clue_id
     WHERE sc.school_id = $1
     ORDER BY sc.acquired_at ASC`,
    [req.school.sub]
  );
  res.json(rows);
}));

module.exports = router;
