const express = require('express');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(schoolAuth);

// 權限碼兌換：關卡解鎖碼 / 隱藏線索碼。同一組碼可以發給很多隊伍各自兌換一次
// （access_codes 本身沒有兌換次數上限），但同一支隊伍對同一組碼只能兌換一次
// ——靠 school_code_redemptions 的複合主鍵 (school_id, access_code_id) 擋重複。
//
// 用 SELECT ... FOR UPDATE 鎖住這筆 access_codes，讓同一支隊伍對同一組碼的
// 併發重複請求會照順序排隊處理，而不是兩個請求都通過「還沒兌換過」的檢查、
// 最後兩筆都想 INSERT 造成 race。
router.post('/redeem', asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'code is required' });
  }
  const schoolId = req.school.sub;
  const normalized = code.trim();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: codeRows } = await client.query(
      'SELECT * FROM access_codes WHERE code = $1 FOR UPDATE',
      [normalized]
    );
    if (codeRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'access code not found' });
    }
    const accessCode = codeRows[0];

    const { rows: existing } = await client.query(
      'SELECT 1 FROM school_code_redemptions WHERE school_id = $1 AND access_code_id = $2',
      [schoolId, accessCode.id]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'your school has already redeemed this code' });
    }

    let result;
    if (accessCode.type === 'checkpoint_unlock') {
      if (!accessCode.target_checkpoint_id) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'this code is misconfigured (no target checkpoint)' });
      }

      // 如果這個關卡對這支隊伍來說本來就已經解鎖過（例如之前用別的方式解鎖），
      // 保留原本的 unlocked_at，不要覆寫掉；沒解鎖過才真的寫入現在的時間。
      await client.query(
        `INSERT INTO school_checkpoint_progress (school_id, checkpoint_id, unlocked_at)
         VALUES ($1, $2, now())
         ON CONFLICT (school_id, checkpoint_id) DO UPDATE
           SET unlocked_at = COALESCE(school_checkpoint_progress.unlocked_at, EXCLUDED.unlocked_at)`,
        [schoolId, accessCode.target_checkpoint_id]
      );
      const { rows: cpRows } = await client.query(
        'SELECT id, name, description FROM checkpoints WHERE id = $1',
        [accessCode.target_checkpoint_id]
      );
      result = { type: 'checkpoint_unlock', checkpoint: cpRows[0] };
    } else if (accessCode.type === 'hidden_clue') {
      if (!accessCode.target_clue_id) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'this code is misconfigured (no target clue)' });
      }

      // 這支隊伍可能已經靠掃碼拿過同一個線索了，ON CONFLICT DO NOTHING 避免撞
      // school_clues 的主鍵重複——兌換記錄還是照樣寫入（擋同碼重複兌換），
      // 只是不會有第二筆一樣的線索。
      await client.query(
        `INSERT INTO school_clues (school_id, clue_id, acquired_via)
         VALUES ($1, $2, 'code')
         ON CONFLICT (school_id, clue_id) DO NOTHING`,
        [schoolId, accessCode.target_clue_id]
      );
      const { rows: clueRows } = await client.query(
        'SELECT id, name, description, image_url, checkpoint_id FROM clues WHERE id = $1',
        [accessCode.target_clue_id]
      );
      result = { type: 'hidden_clue', clue: clueRows[0] };
    } else {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'unknown access code type' });
    }

    await client.query(
      'INSERT INTO school_code_redemptions (school_id, access_code_id) VALUES ($1, $2)',
      [schoolId, accessCode.id]
    );

    await client.query('COMMIT');
    res.json({ redeemed: true, ...result });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
