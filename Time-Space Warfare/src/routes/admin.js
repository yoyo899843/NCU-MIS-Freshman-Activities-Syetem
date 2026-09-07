const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { parse } = require('csv-parse');
const crypto = require('crypto');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { gatekeeperGuard, requireFullAdmin } = require('../middleware/gatekeeperGuard');
const asyncHandler = require('../middleware/asyncHandler');
const { createLoginThrottle } = require('../loginThrottle');
const { getIO } = require('../io');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// --- 簡單的登入失敗鎖定（見 src/loginThrottle.js：記憶體內、會定期清掉過期項目） ---
const loginThrottle = createLoginThrottle();

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  if (loginThrottle.isLocked(email)) {
    return res.status(429).json({ error: 'too many failed attempts, try again later' });
  }

  const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  const user = rows[0];

  // 不透露「帳號不存在」或「密碼錯誤」的差異，一律回同樣的訊息。
  const genericError = () => {
    loginThrottle.recordFailure(email);
    return res.status(401).json({ error: 'invalid email or password' });
  };

  if (!user) return genericError();

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return genericError();

  loginThrottle.clear(email);

  // role: 'admin' 是「這是一張管理端的 token」（跟玩家端的 role: 'player' 區分），
  // adminRole 才是權限層級（管理員/關主），兩個是不同意思、不要混在同一個欄位。
  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      displayName: user.display_name,
      role: 'admin',
      adminRole: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ token, adminRole: user.role });
}));

// 以下全部需要登入（adminAuth），而且要通過權限層級檢查（gatekeeperGuard）
router.use(adminAuth);
router.use(gatekeeperGuard);

// 管理端帳號管理：只有管理員能看、能操作。
//
// 「管理員」這一級是固定的：只能在伺服器上用 scripts/create-admin.js 建立或
// 調整，沒有任何 HTTP 端點可以新增管理員、也不能把誰升成管理員（呼應
// PLAN.md 的安全決策）。後台這裡能管的只有「關主」帳號。
router.get('/admins', requireFullAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, email, display_name, role, created_at FROM admin_users ORDER BY id ASC'
  );
  res.json(rows);
}));

// 新增關主帳號。role 寫死成 gatekeeper，就算 request body 送 role 進來也不理，
// 避免這支 API 變成「從網頁新增管理員」的後門。
router.post('/admins', requireFullAdmin, asyncHandler(async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '密碼長度至少需要 8 個字元' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const { rows } = await db.query(
      `INSERT INTO admin_users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, 'gatekeeper')
       RETURNING id, email, display_name, role, created_at`,
      [email.trim(), passwordHash, (displayName || '').trim() || null]
    );

    await db.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
       VALUES ($1, 'create_gatekeeper', 'admin_user', $2, NULL, $3)`,
      [req.admin.sub, String(rows[0].id), JSON.stringify({ email: rows[0].email, role: 'gatekeeper' })]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '這個 email 已經有帳號了' });
    throw err;
  }
}));

// 重設關主密碼。管理員的密碼不能從這裡改——管理員一律走 CLI。
router.patch('/admins/:id/password', requireFullAdmin, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '密碼長度至少需要 8 個字元' });
  }

  const { rows: existingRows } = await db.query(
    'SELECT id, role FROM admin_users WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'admin user not found' });
  if (existingRows[0].role !== 'gatekeeper') {
    return res.status(403).json({ error: '管理員帳號只能在伺服器上用 CLI 調整' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [passwordHash, req.params.id]);

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'reset_gatekeeper_password', 'admin_user', $2, NULL, NULL)`,
    [req.admin.sub, String(req.params.id)]
  );

  res.json({ id: Number(req.params.id), passwordReset: true });
}));

// 刪除關主帳號。同樣不能刪管理員。
router.delete('/admins/:id', requireFullAdmin, asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, email, role FROM admin_users WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'admin user not found' });
  if (existingRows[0].role !== 'gatekeeper') {
    return res.status(403).json({ error: '管理員帳號只能在伺服器上用 CLI 調整' });
  }

  try {
    await db.query('DELETE FROM admin_users WHERE id = $1', [req.params.id]);
  } catch (err) {
    // 這個關主已經留下操作紀錄（admin_actions 有 FK 指過來），刪掉的話稽核就
    // 斷了，所以擋下來。真的要移除請改成重設密碼讓他登不進來。
    if (err.code === '23503') {
      return res.status(409).json({ error: '這個關主已經有操作紀錄，不能刪除（可以改成重設密碼讓他無法登入）' });
    }
    throw err;
  }

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'delete_gatekeeper', 'admin_user', $2, $3, NULL)`,
    [req.admin.sub, String(req.params.id), JSON.stringify({ email: existingRows[0].email })]
  );

  res.status(204).end();
}));

// 目前登入者自己的身分（前端用來決定要不要顯示管理員限定的功能入口）。
router.get('/me', (req, res) => {
  res.json({
    id: req.admin.sub,
    email: req.admin.email,
    displayName: req.admin.displayName,
    adminRole: req.admin.adminRole || 'admin'
  });
});

// --- 交摺點 CRUD ---
// 清單同時給交摺點管理頁、以及題目管理畫面的「這題屬於哪個交摺點」下拉選單用。
router.get('/checkpoints', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, map_lat, map_lng, qr_token, progress, updated_at
     FROM checkpoints ORDER BY id`
  );
  res.json(rows.map(numericCheckpoint));
}));

// progress 是 INT，pg 直接回數字，不用再轉。留這個函式當統一出口，
// 之後如果又加了 NUMERIC 欄位才有地方接。
function numericCheckpoint(row) {
  return row;
}

// qr_token 是印在現場實體 QR Code 上的字串，玩家掃了就能開始挑戰，
// 所以一定要不可猜——用亂數產生，不讓主辦自己填。
function generateQrToken() {
  return 'CP-' + crypto.randomBytes(12).toString('hex').toUpperCase();
}

// 回傳 { ok, value } 或 { ok: false, error }——刻意不用 throw，因為目前的
// 錯誤處理中介層一律把例外回成 500（見 problem.md B1），驗證錯誤要自己回 400。
function parseCoord(value, min, max, label) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { ok: false, error: `${label} must be a number between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

router.post('/checkpoints', asyncHandler(async (req, res) => {
  const { name, mapLat, mapLng } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const lat = parseCoord(mapLat, -90, 90, 'mapLat');
  if (!lat.ok) return res.status(400).json({ error: lat.error });
  const lng = parseCoord(mapLng, -180, 180, 'mapLng');
  if (!lng.ok) return res.status(400).json({ error: lng.error });

  const { rows } = await db.query(
    `INSERT INTO checkpoints (name, map_lat, map_lng, qr_token)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, map_lat, map_lng, qr_token, progress`,
    [name.trim(), lat.value, lng.value, generateQrToken()]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'create_checkpoint', 'checkpoint', $2, NULL, $3)`,
    [req.admin.sub, String(rows[0].id), JSON.stringify({ name: rows[0].name })]
  );

  res.status(201).json(numericCheckpoint(rows[0]));
}));

router.patch('/checkpoints/:id', asyncHandler(async (req, res) => {
  const { name, mapLat, mapLng } = req.body || {};
  const lat = parseCoord(mapLat, -90, 90, 'mapLat');
  if (!lat.ok) return res.status(400).json({ error: lat.error });
  const lng = parseCoord(mapLng, -180, 180, 'mapLng');
  if (!lng.ok) return res.status(400).json({ error: lng.error });

  const { rows } = await db.query(
    `UPDATE checkpoints
       SET name = COALESCE($1, name),
           map_lat = COALESCE($2, map_lat),
           map_lng = COALESCE($3, map_lng),
           updated_at = now()
     WHERE id = $4
     RETURNING id, name, map_lat, map_lng, qr_token, progress`,
    [name?.trim() || null, lat.value, lng.value, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'checkpoint not found' });
  res.json(numericCheckpoint(rows[0]));
}));

router.delete('/checkpoints/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM checkpoints WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'checkpoint not found' });
  } catch (err) {
    // 已經有人挑戰過、或有題目掛在這個交摺點底下，刪掉會讓紀錄斷掉。
    if (err.code === '23503') {
      return res.status(409).json({
        error: '這個交摺點已經有挑戰紀錄或題目，不能刪除（可以改用「歸零重置」）'
      });
    }
    throw err;
  }
  res.status(204).end();
}));

// 手動歸零：把某個據點的修復進度打回 0%。
// 通關紀錄（checkpoint_attempts）刻意保留不動，稽核才追得回來。
router.post('/checkpoints/:id/reset', asyncHandler(async (req, res) => {
  const { rows: beforeRows } = await db.query(
    'SELECT progress FROM checkpoints WHERE id = $1', [req.params.id]
  );
  if (beforeRows.length === 0) return res.status(404).json({ error: 'checkpoint not found' });

  const { rows } = await db.query(
    `UPDATE checkpoints SET progress = 0, updated_at = now()
     WHERE id = $1
     RETURNING id, name, map_lat, map_lng, qr_token, progress`,
    [req.params.id]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'reset_checkpoint', 'checkpoint', $2, $3, $4)`,
    [req.admin.sub, String(req.params.id),
     JSON.stringify({ progress: beforeRows[0].progress }),
     JSON.stringify({ progress: 0 })]
  );

  getIO().emit('checkpoint:update', rows[0]);
  res.json(numericCheckpoint(rows[0]));
}));

// 交摺點的 QR 內容。回傳 qr_token 本身，QR 圖形由前端畫（不用多裝後端套件）。
router.get('/checkpoints/:id/qrcode', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, qr_token FROM checkpoints WHERE id = $1', [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'checkpoint not found' });
  res.json(rows[0]);
}));

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
// forceScope：從 PK 對戰管理那一頁上傳時會帶 'pk'，代表整份 CSV 都是 PK 題目，
// 「關卡ID/PK」欄直接忽略（那一頁的範例 CSV 根本沒有這一欄）。題庫管理頁不帶這個
// 參數，維持原本「一份 CSV 混著三種歸屬」的行為。
function validateCsvRow(record, rowNumber, checkpointIds, forceScope) {
  const scopeRaw = forceScope === 'pk' ? 'PK' : (record['關卡ID/PK'] || '').trim();
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

  const forceScope = (req.body && req.body.forceScope) || null;
  if (forceScope !== null && forceScope !== 'pk') {
    return res.status(400).json({ error: 'forceScope 目前只支援 pk' });
  }

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
    const validated = validateCsvRow(record, rowNumber, checkpointIds, forceScope);
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
  const { rows } = await db.query(
    `SELECT status, started_at, ended_at, duration_minutes, max_teams, progress_step,
            pk_questions_per_duel, pk_answer_seconds
     FROM game_state WHERE id = 1`
  );
  res.json(rows[0]);
}));

// PK 對戰設定：一場抽幾題、每題幾秒。
// 只影響「之後才開始」的對戰——已經在進行中的 session 是開場時就把題目與秒數
// 決定好放在記憶體裡的（見 src/pk/session.js 的 createSession），改設定不會、
// 也不該把正在打的那場中途換掉。
router.patch('/game/pk-settings', asyncHandler(async (req, res) => {
  const { questionsPerDuel, answerSeconds } = req.body || {};

  const qpd = Number(questionsPerDuel);
  const secs = Number(answerSeconds);
  if (!Number.isInteger(qpd) || qpd < 1 || qpd > 20) {
    return res.status(400).json({ error: '題目數量必須是 1 到 20 之間的整數' });
  }
  if (!Number.isInteger(secs) || secs < 3 || secs > 120) {
    return res.status(400).json({ error: '每題作答時間必須是 3 到 120 秒之間的整數' });
  }

  const { rows: beforeRows } = await db.query(
    'SELECT pk_questions_per_duel, pk_answer_seconds FROM game_state WHERE id = 1'
  );

  const { rows } = await db.query(
    `UPDATE game_state SET pk_questions_per_duel = $1, pk_answer_seconds = $2
     WHERE id = 1
     RETURNING status, started_at, ended_at, duration_minutes, max_teams, progress_step,
               pk_questions_per_duel, pk_answer_seconds`,
    [qpd, secs]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'update_pk_settings', 'game_state', '1', $2, $3)`,
    [req.admin.sub, JSON.stringify(beforeRows[0] || {}),
     JSON.stringify({ pk_questions_per_duel: qpd, pk_answer_seconds: secs })]
  );

  res.json(rows[0]);
}));

// 遊戲時長：大螢幕倒數用的。倒數是「started_at 起算 duration_minutes」，時間到
// 只會在畫面上顯示「時間到」，不會自動結束遊戲——真正要收還是主辦按「強制結束
// 遊戲」（現場常常要多留幾分鐘等還在路上的隊伍）。
//
// 遊戲進行中也可以改：倒數是每次都用「started_at + 時長 - 現在」重算的，不是
// 開場算一次就固定，所以改完大螢幕下一秒就跟著變（臨時要延長或縮短都行）。
router.patch('/game/duration', asyncHandler(async (req, res) => {
  const minutes = Number((req.body || {}).durationMinutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) {
    return res.status(400).json({ error: '遊戲時長必須是 5 到 600 分鐘之間的整數' });
  }

  const { rows: beforeRows } = await db.query('SELECT duration_minutes FROM game_state WHERE id = 1');

  const { rows } = await db.query(
    `UPDATE game_state SET duration_minutes = $1 WHERE id = 1
     RETURNING status, started_at, ended_at, duration_minutes, max_teams, progress_step,
               pk_questions_per_duel, pk_answer_seconds`,
    [minutes]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'update_game_duration', 'game_state', '1', $2, $3)`,
    [req.admin.sub, JSON.stringify(beforeRows[0] || {}), JSON.stringify({ duration_minutes: minutes })]
  );

  // 廣播出去，大螢幕不用等下一次輪詢就會換成新的倒數。
  getIO().emit('game:state', rows[0]);
  res.json(rows[0]);
}));

// 場次規模設定：隊伍數上限、每次修復/破壞推動的進度幅度。
// 企劃書寫 10 隊、±25%，但這兩個是會臨場調整的東西（報名隊數變動、想讓進度
// 跑快一點），不該寫死在程式裡要改版重新部署。
//
// 隊伍上限只在「新隊伍登入」時檢查，調小不會把已經在場上的隊伍踢掉。
router.patch('/game/scale', asyncHandler(async (req, res) => {
  const { maxTeams, progressStep } = req.body || {};
  const teams = Number(maxTeams);
  const step = Number(progressStep);
  if (!Number.isInteger(teams) || teams < 2 || teams > 100) {
    return res.status(400).json({ error: '隊伍數上限必須是 2 到 100 之間的整數' });
  }
  if (!Number.isInteger(step) || step < 1 || step > 100) {
    return res.status(400).json({ error: '每次進度幅度必須是 1 到 100 之間的整數' });
  }

  const { rows: beforeRows } = await db.query(
    'SELECT max_teams, progress_step FROM game_state WHERE id = 1'
  );

  const { rows } = await db.query(
    `UPDATE game_state SET max_teams = $1, progress_step = $2 WHERE id = 1
     RETURNING status, started_at, ended_at, duration_minutes, max_teams, progress_step,
               pk_questions_per_duel, pk_answer_seconds`,
    [teams, step]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'update_game_scale', 'game_state', '1', $2, $3)`,
    [req.admin.sub, JSON.stringify(beforeRows[0] || {}),
     JSON.stringify({ max_teams: teams, progress_step: step })]
  );

  res.json(rows[0]);
}));

router.post('/game/start', asyncHandler(async (req, res) => {
  const { rows: current } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (current[0].status === 'in_progress') {
    return res.status(409).json({ error: 'game is already in progress' });
  }

  const { rows } = await db.query(
    `UPDATE game_state SET status = 'in_progress', started_at = now(), ended_at = NULL
     WHERE id = 1 RETURNING status, started_at, ended_at, duration_minutes, max_teams, progress_step`
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
     WHERE id = 1 RETURNING status, started_at, ended_at, duration_minutes, max_teams, progress_step`
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
      hp.display_name AS host_name, ht.faction AS host_faction,
      gp.display_name AS guest_name, gt.faction AS guest_faction
    FROM pk_duels d
    JOIN players hp ON hp.id = d.host_player_id
    JOIN teams ht ON ht.id = hp.team_id
    LEFT JOIN players gp ON gp.id = d.guest_player_id
    LEFT JOIN teams gt ON gt.id = gp.team_id
    ORDER BY d.created_at DESC
    LIMIT 100
  `);
  res.json(rows);
}));

// 玩家帳號管理：列出所有隊伍/玩家，含 PIN（明碼，見 migrations/005_player_pin_plaintext.sql
// 的說明——主辦/隊輔本來就看得到，這裡只是把原本要用 PgAdmin 查的資料搬到後台頁面）。
router.get('/players', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT p.id, p.display_name, p.is_captain, p.pin, p.created_at,
           t.id AS team_id, t.faction, t.team_number
    FROM players p
    JOIN teams t ON t.id = p.team_id
    ORDER BY t.faction, t.team_number, p.is_captain DESC, p.id
  `);
  res.json(rows);
}));

// 用新 PIN 直接覆蓋掉舊 PIN——給隊輔忘記/打錯 PIN 卡住登入時，管理員在後台直接
// 幫忙重設，不用再請他們去翻 PgAdmin。留稽核紀錄。
router.patch('/players/:id/pin', asyncHandler(async (req, res) => {
  const { pin } = req.body || {};
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }

  const { rows: existingRows } = await db.query('SELECT id, pin FROM players WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'player not found' });
  const before = existingRows[0];

  const { rows } = await db.query(
    `UPDATE players SET pin = $1 WHERE id = $2
     RETURNING id, display_name, is_captain, pin, created_at, team_id`,
    [pin, req.params.id]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'reset_player_pin', 'player', $2, $3, $4)`,
    [req.admin.sub, req.params.id, JSON.stringify({ pin: before.pin }), JSON.stringify({ pin })]
  );

  res.json(rows[0]);
}));

// 人工調整隊伍陣營（修復者/破壞者）——陣營原本是登入時自動平均分配的，但主辦
// 可能因為現場人數不均、活動節奏等理由想手動調整某支隊伍。改的是 teams.faction，
// 不是 player 本身的欄位，但入口沿用 /players/:id 這支（跟 PIN 重設一致，前端
// players.html 本來就是以玩家列為單位在操作），內部用玩家的 team_id 找到對應隊伍。
// 已經打過的關卡分數（checkpoint_attempts.faction）是當下的快照，不會被這裡的
// 變更追溯改掉——那是歷史紀錄，不是「這支隊伍現在是哪一隊」的當前狀態。
router.patch('/players/:id/faction', asyncHandler(async (req, res) => {
  const { faction } = req.body || {};
  if (!['repair', 'disrupt'].includes(faction)) {
    return res.status(400).json({ error: 'faction must be repair or disrupt' });
  }

  const { rows: existingRows } = await db.query(
    `SELECT p.id, p.team_id, t.faction FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1`,
    [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'player not found' });
  const before = existingRows[0];

  await db.query('UPDATE teams SET faction = $1 WHERE id = $2', [faction, before.team_id]);

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'change_team_faction', 'team', $2, $3, $4)`,
    [req.admin.sub, before.team_id, JSON.stringify({ faction: before.faction }), JSON.stringify({ faction })]
  );

  const { rows } = await db.query(
    `SELECT p.id, p.display_name, p.is_captain, p.pin, p.created_at,
            t.id AS team_id, t.faction, t.team_number
     FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1`,
    [req.params.id]
  );
  res.json(rows[0]);
}));

// 手動增減某個交摺點的修復值/破壞值。掃碼答題以外的補救手段
// （例如現場判定爭議、或關主代為記分）。delta 可正可負，扣到負數會夾在 0。
router.post('/overrides/progress', asyncHandler(async (req, res) => {
  const { checkpointId, progress, note } = req.body || {};
  if (!checkpointId) return res.status(400).json({ error: 'checkpointId is required' });
  const value = Number(progress);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return res.status(400).json({ error: 'progress 必須是 0 到 100 之間的整數' });
  }

  const { rows: beforeRows } = await db.query(
    'SELECT progress FROM checkpoints WHERE id = $1', [checkpointId]
  );
  if (beforeRows.length === 0) return res.status(404).json({ error: 'checkpoint not found' });

  const { rows } = await db.query(
    `UPDATE checkpoints SET progress = $1, updated_at = now()
     WHERE id = $2
     RETURNING id, name, map_lat, map_lng, qr_token, progress`,
    [value, checkpointId]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'override_checkpoint_progress', 'checkpoint', $2, $3, $4)`,
    [req.admin.sub, String(checkpointId),
     JSON.stringify({ progress: beforeRows[0].progress }),
     JSON.stringify({ progress: value, note: note || null })]
  );

  getIO().emit('checkpoint:update', rows[0]);
  res.json(numericCheckpoint(rows[0]));
}));

module.exports = router;
