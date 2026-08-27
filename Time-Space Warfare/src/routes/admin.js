const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { parse } = require('csv-parse');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { getIO } = require('../io');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// --- 簡單的登入失敗鎖定（記憶體內，process 重啟會重置，這裡只是防暴力破解的基本防線） ---
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // email -> { count, lockedUntil }

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const record = failedAttempts.get(email);
  if (record && record.lockedUntil && record.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'too many failed attempts, try again later' });
  }

  const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  const user = rows[0];

  // 不透露「帳號不存在」或「密碼錯誤」的差異，一律回同樣的訊息。
  const genericError = () => {
    const count = (record?.count || 0) + 1;
    failedAttempts.set(email, {
      count,
      lockedUntil: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : null
    });
    return res.status(401).json({ error: 'invalid email or password' });
  };

  if (!user) return genericError();

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return genericError();

  failedAttempts.delete(email);

  const token = jwt.sign(
    { sub: user.id, email: user.email, displayName: user.display_name, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ token });
}));

// 以下全部需要登入
router.use(adminAuth);

// 交摺點 CRUD 本身還沒做（見 PLAN.md），這裡先開一個唯讀清單，給題目管理畫面的
// 「這題屬於哪個交摺點」下拉選單用。
router.get('/checkpoints', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT id, name FROM checkpoints ORDER BY id');
  res.json(rows);
}));

router.post('/checkpoints', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.patch('/checkpoints/:id', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/checkpoints/:id/reset', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.get('/checkpoints/:id/qrcode', (req, res) => res.status(501).json({ error: 'not implemented' }));

const QUESTION_COLUMNS = `
  id, scope_type, checkpoint_id, content,
  option_a, option_b, option_c, option_d,
  correct_option, time_limit_seconds, created_at
`;

router.get('/questions', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${QUESTION_COLUMNS} FROM questions ORDER BY id DESC`
  );
  res.json(rows);
}));

// 新增/編輯共用的欄位驗證。回傳 { error } 或 { data }。
function validateQuestionBody(body, checkpointIds) {
  const content = (body.content || '').trim();
  const optionA = (body.optionA || '').trim();
  const optionB = (body.optionB || '').trim();
  const optionC = (body.optionC || '').trim();
  const optionD = (body.optionD || '').trim();
  const correctOption = (body.correctOption || '').trim().toUpperCase();
  const scopeType = body.scopeType;
  const timeLimitSeconds = Number.isInteger(body.timeLimitSeconds) ? body.timeLimitSeconds : parseInt(body.timeLimitSeconds, 10);

  if (!content) return { error: '題目內容不可為空' };
  if (!optionA || !optionB || !optionC || !optionD) return { error: '四個選項都要填' };
  if (!['A', 'B', 'C', 'D'].includes(correctOption)) return { error: '正確選項必須是 A/B/C/D' };
  if (!['checkpoint', 'pk', 'general'].includes(scopeType)) return { error: 'scopeType 必須是 checkpoint/pk/general' };
  if (!Number.isInteger(timeLimitSeconds) || timeLimitSeconds <= 0) return { error: '作答時限必須是正整數秒' };

  let checkpointId = null;
  if (scopeType === 'checkpoint') {
    checkpointId = Number.isInteger(body.checkpointId) ? body.checkpointId : parseInt(body.checkpointId, 10);
    if (!Number.isInteger(checkpointId) || !checkpointIds.has(checkpointId)) {
      return { error: '指定的交摺點不存在' };
    }
  }

  return {
    data: { scopeType, checkpointId, content, optionA, optionB, optionC, optionD, correctOption, timeLimitSeconds }
  };
}

router.post('/questions', asyncHandler(async (req, res) => {
  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));

  const validated = validateQuestionBody(req.body || {}, checkpointIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `INSERT INTO questions (scope_type, checkpoint_id, content, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${QUESTION_COLUMNS}`,
    [d.scopeType, d.checkpointId, d.content, d.optionA, d.optionB, d.optionC, d.optionD, d.correctOption, d.timeLimitSeconds]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/questions/:id', asyncHandler(async (req, res) => {
  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));

  const { rows: existingRows } = await db.query(
    `SELECT ${QUESTION_COLUMNS} FROM questions WHERE id = $1`, [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'question not found' });
  const existing = existingRows[0];

  // 支援部分更新：沒帶的欄位就沿用原本的值。
  const merged = {
    scopeType: req.body.scopeType ?? existing.scope_type,
    checkpointId: req.body.checkpointId ?? existing.checkpoint_id,
    content: req.body.content ?? existing.content,
    optionA: req.body.optionA ?? existing.option_a,
    optionB: req.body.optionB ?? existing.option_b,
    optionC: req.body.optionC ?? existing.option_c,
    optionD: req.body.optionD ?? existing.option_d,
    correctOption: req.body.correctOption ?? existing.correct_option,
    timeLimitSeconds: req.body.timeLimitSeconds ?? existing.time_limit_seconds
  };

  const validated = validateQuestionBody(merged, checkpointIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `UPDATE questions
     SET scope_type=$1, checkpoint_id=$2, content=$3, option_a=$4, option_b=$5,
         option_c=$6, option_d=$7, correct_option=$8, time_limit_seconds=$9
     WHERE id = $10 RETURNING ${QUESTION_COLUMNS}`,
    [d.scopeType, d.checkpointId, d.content, d.optionA, d.optionB, d.optionC, d.optionD, d.correctOption, d.timeLimitSeconds, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/questions/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM questions WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'question not found' });
  res.status(204).end();
}));

// CSV 欄位格式（配合 PLAN.md 規格）：關卡ID/PK, 題目, 選項A, 選項B, 選項C, 選項D, 正確選項, 秒數
// 「關卡ID/PK」欄：空白＝通用題庫；填 PK（不分大小寫）＝PK 專用；填數字＝該交摺點專屬。
// 用 csv-parse 的 stream/async-iterator 介面逐筆處理、每 20 筆一批寫入，
// 避免大檔案同步解析卡住 event loop（這台伺服器同時也在跑玩家的即時連線）。
function validateCsvRow(record, rowNumber, checkpointIds) {
  const scopeRaw = (record['關卡ID/PK'] || '').trim();
  const content = (record['題目'] || '').trim();
  const optionA = (record['選項A'] || '').trim();
  const optionB = (record['選項B'] || '').trim();
  const optionC = (record['選項C'] || '').trim();
  const optionD = (record['選項D'] || '').trim();
  const correctOption = (record['正確選項'] || '').trim().toUpperCase();
  const timeLimitRaw = (record['秒數'] || '').trim();

  if (!content) return { error: `第 ${rowNumber} 列：題目為空` };
  if (!optionA || !optionB || !optionC || !optionD) return { error: `第 ${rowNumber} 列：選項不完整` };
  if (!['A', 'B', 'C', 'D'].includes(correctOption)) return { error: `第 ${rowNumber} 列：正確選項必須是 A/B/C/D` };

  const timeLimitSeconds = timeLimitRaw ? parseInt(timeLimitRaw, 10) : 10;
  if (!Number.isInteger(timeLimitSeconds) || timeLimitSeconds <= 0) {
    return { error: `第 ${rowNumber} 列：秒數必須是正整數` };
  }

  let scopeType;
  let checkpointId = null;
  if (!scopeRaw) {
    scopeType = 'general';
  } else if (scopeRaw.toUpperCase() === 'PK') {
    scopeType = 'pk';
  } else {
    const id = parseInt(scopeRaw, 10);
    if (!Number.isInteger(id) || !checkpointIds.has(id)) {
      return { error: `第 ${rowNumber} 列：關卡ID「${scopeRaw}」不存在` };
    }
    scopeType = 'checkpoint';
    checkpointId = id;
  }

  return { data: { scopeType, checkpointId, content, optionA, optionB, optionC, optionD, correctOption, timeLimitSeconds } };
}

router.post('/questions/import', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart field name: file)' });

  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));

  const result = { inserted: 0, failed: [] };
  const parser = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });

  let rowNumber = 1; // 第 1 列是標題列，資料從第 2 列開始
  let batch = [];

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const row of batch) {
        await client.query(
          `INSERT INTO questions (scope_type, checkpoint_id, content, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [row.scopeType, row.checkpointId, row.content, row.optionA, row.optionB, row.optionC, row.optionD, row.correctOption, row.timeLimitSeconds]
        );
      }
      await client.query('COMMIT');
      result.inserted += batch.length;
    } catch (err) {
      await client.query('ROLLBACK');
      result.failed.push({ row: null, reason: '資料庫寫入失敗（這一批全數略過）：' + err.message });
    } finally {
      client.release();
      batch = [];
    }
  };

  for await (const record of parser) {
    rowNumber += 1;
    const validated = validateCsvRow(record, rowNumber, checkpointIds);
    if (validated.error) {
      result.failed.push({ row: rowNumber, reason: validated.error });
      continue;
    }
    batch.push(validated.data);

    if (batch.length >= 20) {
      await flushBatch();
      await new Promise(resolve => setImmediate(resolve)); // 明確讓出 event loop 給玩家端的即時連線
    }
  }
  await flushBatch();

  res.json(result);
}));

router.get('/game/state', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT status, started_at, ended_at FROM game_state WHERE id = 1');
  res.json(rows[0]);
}));

router.post('/game/start', asyncHandler(async (req, res) => {
  const { rows: current } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (current[0].status === 'in_progress') {
    return res.status(409).json({ error: 'game is already in progress' });
  }

  const { rows } = await db.query(
    `UPDATE game_state SET status = 'in_progress', started_at = now(), ended_at = NULL
     WHERE id = 1 RETURNING status, started_at, ended_at`
  );
  getIO().emit('game:state', rows[0]);
  res.json(rows[0]);
}));

router.post('/game/end', asyncHandler(async (req, res) => {
  const { rows: current } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (current[0].status !== 'in_progress') {
    return res.status(409).json({ error: 'game is not in progress' });
  }

  const { rows } = await db.query(
    `UPDATE game_state SET status = 'ended', ended_at = now()
     WHERE id = 1 RETURNING status, started_at, ended_at`
  );
  getIO().emit('game:state', rows[0]);
  res.json(rows[0]);
}));

// PK 對戰管理頁用的清單：帶出雙方顯示名稱、陣營，方便管理員一眼看懂誰打誰。
router.get('/pk-duels', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      d.id, d.room_code, d.status, d.created_at, d.completed_at,
      d.host_player_id, d.guest_player_id, d.winner_player_id, d.loser_player_id,
      d.penalty_amount, d.penalty_checkpoint_attempt_id, d.penalty_cancelled_at,
      hp.display_name AS host_name, ht.faction AS host_faction,
      gp.display_name AS guest_name, gt.faction AS guest_faction,
      cp.name AS checkpoint_name
    FROM pk_duels d
    JOIN players hp ON hp.id = d.host_player_id
    JOIN teams ht ON ht.id = hp.team_id
    LEFT JOIN players gp ON gp.id = d.guest_player_id
    LEFT JOIN teams gt ON gt.id = gp.team_id
    LEFT JOIN checkpoint_attempts ca ON ca.id = d.penalty_checkpoint_attempt_id
    LEFT JOIN checkpoints cp ON cp.id = ca.checkpoint_id
    ORDER BY d.created_at DESC
    LIMIT 100
  `);
  res.json(rows);
}));

router.post('/overrides/score', (req, res) => res.status(501).json({ error: 'not implemented' }));

// 取消某一場 PK 對戰的扣分懲罰：把當初扣掉的分數加回對應交摺點，並留下稽核紀錄。
// penalty_amount 本身不會被清掉（留著當「當初扣了多少」的歷史紀錄），
// 用 penalty_cancelled_at 是否有值來判斷這筆懲罰現在還算不算數。
router.post('/overrides/pk/:duelId/cancel-penalty', asyncHandler(async (req, res) => {
  const { duelId } = req.params;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: duelRows } = await client.query(
      'SELECT * FROM pk_duels WHERE id = $1 FOR UPDATE', [duelId]
    );
    if (duelRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'duel not found' });
    }
    const duel = duelRows[0];

    if (duel.status !== 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'duel has not completed yet' });
    }
    if (duel.penalty_cancelled_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'this penalty was already cancelled' });
    }
    if (!duel.penalty_checkpoint_attempt_id || Number(duel.penalty_amount) <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'this duel has no penalty to cancel' });
    }

    const { rows: attemptRows } = await client.query(
      'SELECT checkpoint_id, faction FROM checkpoint_attempts WHERE id = $1',
      [duel.penalty_checkpoint_attempt_id]
    );
    const attempt = attemptRows[0];
    const column = attempt.faction === 'repair' ? 'repair_value' : 'disrupt_value';

    const { rows: checkpointRows } = await client.query(
      `UPDATE checkpoints SET ${column} = ${column} + $1, updated_at = now()
       WHERE id = $2 RETURNING id, name, repair_value, disrupt_value`,
      [duel.penalty_amount, attempt.checkpoint_id]
    );

    await client.query(
      `UPDATE pk_duels SET penalty_cancelled_at = now() WHERE id = $1`,
      [duelId]
    );

    await client.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
       VALUES ($1, 'cancel_pk_penalty', 'pk_duel', $2, $3, $4)`,
      [
        req.admin.sub,
        duelId,
        JSON.stringify({ penaltyAmount: duel.penalty_amount, checkpointId: attempt.checkpoint_id }),
        JSON.stringify({ cancelled: true })
      ]
    );

    await client.query('COMMIT');

    getIO().emit('checkpoint:update', checkpointRows[0]);
    res.json({ ok: true, checkpoint: checkpointRows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
