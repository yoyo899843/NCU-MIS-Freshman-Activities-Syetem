const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const { parse } = require('csv-parse');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const asyncHandler = require('../middleware/asyncHandler');

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

// 學派管理：帳號密碼明碼儲存（不雜湊）——這是主辦控制的固定帳號，不是玩家自己設的
// 密碼，主辦需要能直接在後台查到/管理每組學派目前的帳密（例如忘記密碼時直接看，
// 不用重設），理由跟 Time-Space Warfare 玩家 PIN 明碼儲存一樣。
// 見 migrations/003_school_password_plaintext.sql、src/routes/auth.js 的登入比對。
router.get('/schools', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, username, password, display_name, created_at FROM schools ORDER BY id ASC'
  );
  res.json(rows);
}));

router.post('/schools', asyncHandler(async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'username is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO schools (username, password, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, username, password, display_name, created_at`,
      [username.trim(), password, displayName.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username already exists' });
    throw err;
  }
}));

// 部分更新：改密碼、改顯示名稱，或兩個一起改。至少要帶一個欄位。
router.patch('/schools/:id', asyncHandler(async (req, res) => {
  const { password, displayName } = req.body || {};
  if (password === undefined && displayName === undefined) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (displayName !== undefined && (typeof displayName !== 'string' || !displayName.trim())) {
    return res.status(400).json({ error: 'displayName cannot be empty' });
  }

  const { rows: existingRows } = await db.query('SELECT * FROM schools WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'not found' });
  const existing = existingRows[0];

  const { rows } = await db.query(
    `UPDATE schools SET password = $1, display_name = $2 WHERE id = $3
     RETURNING id, username, password, display_name, created_at`,
    [
      password !== undefined ? password : existing.password,
      displayName !== undefined ? displayName.trim() : existing.display_name,
      req.params.id
    ]
  );
  res.json(rows[0]);
}));

router.delete('/schools/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM schools WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    // 這支隊伍已經留下遊戲進度（解鎖記錄、線索、兌換記錄等），FK 擋刪除，
    // 避免刪帳號的同時默默把玩過的紀錄弄不見。
    if (err.code === '23503') {
      return res.status(409).json({ error: 'cannot delete a school that already has game progress' });
    }
    throw err;
  }
}));

// 關卡管理：清單同時給這頁的管理表格、以及線索/科技樹管理畫面的下拉選單用
// （下拉選單只用得到 id/name，多回傳其他欄位對它們無害）。
router.get('/checkpoints', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, description, map_lat, map_lng, is_locked_by_default, created_at FROM checkpoints ORDER BY id'
  );
  res.json(rows);
}));

// 新增/編輯共用的欄位驗證。回傳 { error } 或 { data }。
function validateCheckpointBody(body) {
  const name = (body.name || '').trim();
  if (!name) return { error: '名稱不可為空' };

  const description = (body.description || '').trim() || null;

  const parseCoord = value => (value === '' || value === null || value === undefined ? null : Number(value));
  const mapLat = parseCoord(body.mapLat);
  const mapLng = parseCoord(body.mapLng);
  if (mapLat !== null && !Number.isFinite(mapLat)) return { error: '座標緯度格式錯誤' };
  if (mapLng !== null && !Number.isFinite(mapLng)) return { error: '座標經度格式錯誤' };

  return { data: { name, description, mapLat, mapLng, isLockedByDefault: !!body.isLockedByDefault } };
}

router.post('/checkpoints', asyncHandler(async (req, res) => {
  const validated = validateCheckpointBody(req.body || {});
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `INSERT INTO checkpoints (name, description, map_lat, map_lng, is_locked_by_default)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, description, map_lat, map_lng, is_locked_by_default, created_at`,
    [d.name, d.description, d.mapLat, d.mapLng, d.isLockedByDefault]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/checkpoints/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query('SELECT * FROM checkpoints WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'checkpoint not found' });
  const existing = existingRows[0];

  // 支援部分更新：沒帶的欄位就沿用原本的值。
  const merged = {
    name: req.body.name ?? existing.name,
    description: req.body.description !== undefined ? req.body.description : existing.description,
    mapLat: req.body.mapLat !== undefined ? req.body.mapLat : existing.map_lat,
    mapLng: req.body.mapLng !== undefined ? req.body.mapLng : existing.map_lng,
    isLockedByDefault: req.body.isLockedByDefault !== undefined ? req.body.isLockedByDefault : existing.is_locked_by_default
  };

  const validated = validateCheckpointBody(merged);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `UPDATE checkpoints SET name=$1, description=$2, map_lat=$3, map_lng=$4, is_locked_by_default=$5
     WHERE id = $6
     RETURNING id, name, description, map_lat, map_lng, is_locked_by_default, created_at`,
    [d.name, d.description, d.mapLat, d.mapLng, d.isLockedByDefault, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/checkpoints/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM checkpoints WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'checkpoint not found' });
    res.status(204).end();
  } catch (err) {
    // 已經有隊伍的解鎖/挑戰進度、掛著線索、或被權限碼指定為目標的關卡不能直接刪掉，
    // FK 擋下來，避免默默弄壞既有進度/設定。
    if (err.code === '23503') {
      return res.status(409).json({ error: '這個關卡已經有隊伍進度或被其他功能使用中，無法刪除' });
    }
    throw err;
  }
}));

const CLUE_COLUMNS = 'id, checkpoint_id, name, description, image_url, qr_token, created_at';

router.get('/clues', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.checkpoint_id, c.name, c.description, c.image_url, c.qr_token, c.created_at,
            cp.name AS checkpoint_name
     FROM clues c
     LEFT JOIN checkpoints cp ON cp.id = c.checkpoint_id
     ORDER BY c.id DESC`
  );
  res.json(rows);
}));

// 新增/編輯共用的欄位驗證。回傳 { error } 或 { data }。
// qrToken 留空就自動產生一組（CLUE- 開頭 + 12 碼隨機字元），管理員不用自己想一堆不會重複的代碼。
function validateClueBody(body, checkpointIds) {
  const name = (body.name || '').trim();
  if (!name) return { error: '名稱不可為空' };

  let checkpointId = null;
  if (body.checkpointId !== null && body.checkpointId !== undefined && body.checkpointId !== '') {
    checkpointId = Number.isInteger(body.checkpointId) ? body.checkpointId : parseInt(body.checkpointId, 10);
    if (!Number.isInteger(checkpointId) || !checkpointIds.has(checkpointId)) {
      return { error: '指定的關卡不存在' };
    }
  }

  const description = (body.description || '').trim() || null;
  const imageUrl = (body.imageUrl || '').trim() || null;
  const qrToken = (body.qrToken || '').trim() || `CLUE-${crypto.randomBytes(6).toString('hex')}`;

  return { data: { checkpointId, name, description, imageUrl, qrToken } };
}

router.post('/clues', asyncHandler(async (req, res) => {
  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));

  const validated = validateClueBody(req.body || {}, checkpointIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  try {
    const { rows } = await db.query(
      `INSERT INTO clues (checkpoint_id, name, description, image_url, qr_token)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${CLUE_COLUMNS}`,
      [d.checkpointId, d.name, d.description, d.imageUrl, d.qrToken]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'QR 代碼已經被使用過了' });
    throw err;
  }
}));

router.patch('/clues/:id', asyncHandler(async (req, res) => {
  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));

  const { rows: existingRows } = await db.query(`SELECT * FROM clues WHERE id = $1`, [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'clue not found' });
  const existing = existingRows[0];

  // 支援部分更新：沒帶的欄位就沿用原本的值。qrToken 沒帶就沿用（不會被自動產生的新值覆蓋）。
  const merged = {
    checkpointId: req.body.checkpointId !== undefined ? req.body.checkpointId : existing.checkpoint_id,
    name: req.body.name ?? existing.name,
    description: req.body.description ?? existing.description,
    imageUrl: req.body.imageUrl ?? existing.image_url,
    qrToken: req.body.qrToken || existing.qr_token
  };

  const validated = validateClueBody(merged, checkpointIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  try {
    const { rows } = await db.query(
      `UPDATE clues SET checkpoint_id=$1, name=$2, description=$3, image_url=$4, qr_token=$5
       WHERE id = $6 RETURNING ${CLUE_COLUMNS}`,
      [d.checkpointId, d.name, d.description, d.imageUrl, d.qrToken, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'QR 代碼已經被使用過了' });
    throw err;
  }
}));

router.delete('/clues/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM clues WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'clue not found' });
    res.status(204).end();
  } catch (err) {
    // 已經被隊伍拿過（school_clues）、被用在權限碼（access_codes）或科技樹插槽正確答案
    // （tech_tree_slots）的線索不能直接刪掉，FK 擋下來，避免默默弄壞既有進度/設定。
    if (err.code === '23503') {
      return res.status(409).json({ error: '這個線索已經被隊伍取得或被其他功能使用中，無法刪除' });
    }
    throw err;
  }
}));

// CSV 欄位格式：關卡ID, 名稱, 描述, 圖片網址, QR代碼。
// 「關卡ID」留空＝不屬於特定關卡（通用/隱藏線索）；「QR代碼」留空＝自動產生。
// 比照 Time-Space Warfare 題庫匯入的做法：用 csv-parse 的 stream/async-iterator 介面
// 逐筆處理、每 20 筆一批寫入、批次間讓出 event loop，避免大檔案同步解析卡住玩家端連線
// （這個系統雖然沒有 Socket.IO，但同一個原則還是適用——不要用同步阻塞迴圈處理上傳檔案）。
function validateCsvRow(record, rowNumber, checkpointIds) {
  const name = (record['名稱'] || '').trim();
  if (!name) return { error: `第 ${rowNumber} 列：名稱為空` };

  const checkpointRaw = (record['關卡ID'] || '').trim();
  let checkpointId = null;
  if (checkpointRaw) {
    checkpointId = parseInt(checkpointRaw, 10);
    if (!Number.isInteger(checkpointId) || !checkpointIds.has(checkpointId)) {
      return { error: `第 ${rowNumber} 列：關卡ID「${checkpointRaw}」不存在` };
    }
  }

  const description = (record['描述'] || '').trim() || null;
  const imageUrl = (record['圖片網址'] || '').trim() || null;
  const qrToken = (record['QR代碼'] || '').trim() || `CLUE-${crypto.randomBytes(6).toString('hex')}`;

  return { data: { checkpointId, name, description, imageUrl, qrToken } };
}

router.post('/clues/import', upload.single('file'), asyncHandler(async (req, res) => {
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
          `INSERT INTO clues (checkpoint_id, name, description, image_url, qr_token) VALUES ($1,$2,$3,$4,$5)`,
          [row.checkpointId, row.name, row.description, row.imageUrl, row.qrToken]
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
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  await flushBatch();

  res.json(result);
}));

// 權限碼管理：清單附兌換次數（方便看某組碼被幾隊兌換過）、新增、刪除。
// 目的地（關卡/線索）本身的 CRUD 還沒做，這裡建立時只驗證目的地 id 真的存在。
router.get('/access-codes', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ac.id, ac.code, ac.type, ac.target_checkpoint_id, ac.target_clue_id, ac.created_at,
       cp.name AS target_checkpoint_name,
       cl.name AS target_clue_name,
       (SELECT COUNT(*)::int FROM school_code_redemptions r WHERE r.access_code_id = ac.id) AS redemption_count
     FROM access_codes ac
     LEFT JOIN checkpoints cp ON cp.id = ac.target_checkpoint_id
     LEFT JOIN clues cl ON cl.id = ac.target_clue_id
     ORDER BY ac.created_at DESC`
  );
  res.json(rows);
}));

router.post('/access-codes', asyncHandler(async (req, res) => {
  const { code, type, targetCheckpointId, targetClueId } = req.body || {};
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (!['checkpoint_unlock', 'hidden_clue'].includes(type)) {
    return res.status(400).json({ error: 'type must be checkpoint_unlock or hidden_clue' });
  }
  if (type === 'checkpoint_unlock' && !targetCheckpointId) {
    return res.status(400).json({ error: 'targetCheckpointId is required for checkpoint_unlock codes' });
  }
  if (type === 'hidden_clue' && !targetClueId) {
    return res.status(400).json({ error: 'targetClueId is required for hidden_clue codes' });
  }

  if (type === 'checkpoint_unlock') {
    const { rows } = await db.query('SELECT id FROM checkpoints WHERE id = $1', [targetCheckpointId]);
    if (rows.length === 0) return res.status(400).json({ error: 'target checkpoint does not exist' });
  }
  if (type === 'hidden_clue') {
    const { rows } = await db.query('SELECT id FROM clues WHERE id = $1', [targetClueId]);
    if (rows.length === 0) return res.status(400).json({ error: 'target clue does not exist' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO access_codes (code, type, target_checkpoint_id, target_clue_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        code.trim(),
        type,
        type === 'checkpoint_unlock' ? targetCheckpointId : null,
        type === 'hidden_clue' ? targetClueId : null
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'code already exists' });
    throw err;
  }
}));

router.delete('/access-codes/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM access_codes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    // 已經被兌換過的碼，school_code_redemptions 還留著兌換記錄（FK 擋刪除），
    // 不能直接刪掉，避免破壞稽核歷史。
    if (err.code === '23503') {
      return res.status(409).json({ error: 'cannot delete a code that has already been redeemed' });
    }
    throw err;
  }
}));

// CSV 欄位格式：代碼, 類型, 目標ID。
// 「類型」接受中文「關卡解鎖」/「隱藏線索」，也接受英文原始值 checkpoint_unlock/hidden_clue，
// 不分大小寫、前後空白會被 trim 掉，方便直接在 Excel 填中文比較好懂。
// 「目標ID」依類型分別對照關卡 ID 或線索 ID。比照題庫/線索匯入的做法：
// stream/async-iterator 逐筆處理、每 20 筆一批寫入、批次間讓出 event loop。
const ACCESS_CODE_TYPE_ALIASES = {
  '關卡解鎖': 'checkpoint_unlock',
  'checkpoint_unlock': 'checkpoint_unlock',
  'checkpoint': 'checkpoint_unlock',
  '隱藏線索': 'hidden_clue',
  'hidden_clue': 'hidden_clue',
  'clue': 'hidden_clue'
};

function validateAccessCodeCsvRow(record, rowNumber, checkpointIds, clueIds) {
  const code = (record['代碼'] || '').trim();
  if (!code) return { error: `第 ${rowNumber} 列：代碼為空` };

  // toLowerCase() 對中文字元是無害的 no-op，所以中英文兩種鍵值可以共用同一次查表。
  const typeRaw = (record['類型'] || '').trim().toLowerCase();
  const type = ACCESS_CODE_TYPE_ALIASES[typeRaw];
  if (!type) return { error: `第 ${rowNumber} 列：類型必須是「關卡解鎖」或「隱藏線索」` };

  const targetRaw = (record['目標ID'] || '').trim();
  const targetId = parseInt(targetRaw, 10);
  if (!Number.isInteger(targetId)) return { error: `第 ${rowNumber} 列：目標ID必須是數字` };

  if (type === 'checkpoint_unlock') {
    if (!checkpointIds.has(targetId)) return { error: `第 ${rowNumber} 列：關卡ID「${targetRaw}」不存在` };
    return { data: { code, type, targetCheckpointId: targetId, targetClueId: null } };
  }
  if (!clueIds.has(targetId)) return { error: `第 ${rowNumber} 列：線索ID「${targetRaw}」不存在` };
  return { data: { code, type, targetCheckpointId: null, targetClueId: targetId } };
}

router.post('/access-codes/import', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart field name: file)' });

  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));
  const { rows: clues } = await db.query('SELECT id FROM clues');
  const clueIds = new Set(clues.map(c => c.id));

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
          `INSERT INTO access_codes (code, type, target_checkpoint_id, target_clue_id) VALUES ($1,$2,$3,$4)`,
          [row.code, row.type, row.targetCheckpointId, row.targetClueId]
        );
      }
      await client.query('COMMIT');
      result.inserted += batch.length;
    } catch (err) {
      await client.query('ROLLBACK');
      result.failed.push({ row: null, reason: '資料庫寫入失敗（這一批全數略過，常見原因是代碼重複）：' + err.message });
    } finally {
      client.release();
      batch = [];
    }
  };

  for await (const record of parser) {
    rowNumber += 1;
    const validated = validateAccessCodeCsvRow(record, rowNumber, checkpointIds, clueIds);
    if (validated.error) {
      result.failed.push({ row: rowNumber, reason: validated.error });
      continue;
    }
    batch.push(validated.data);

    if (batch.length >= 20) {
      await flushBatch();
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  await flushBatch();

  res.json(result);
}));

// 科技樹管理：分支（連同各自的槽位）+ 槽位的正確答案設定。正確答案（correct_clue_id）
// 只有這裡（管理端）看得到——玩家端 /api/tech-tree 絕對不會回傳這個欄位，不然就等於
// 直接洩題（見 src/routes/tech-tree.js 的說明）。
router.get('/tech-tree/branches', asyncHandler(async (req, res) => {
  const { rows: branches } = await db.query(
    'SELECT id, name, story_content, display_order FROM tech_tree_branches ORDER BY display_order, id'
  );
  const { rows: slots } = await db.query(
    `SELECT s.id, s.branch_id, s.slot_order, s.correct_clue_id, c.name AS correct_clue_name
     FROM tech_tree_slots s
     JOIN clues c ON c.id = s.correct_clue_id
     ORDER BY s.branch_id, s.slot_order`
  );
  res.json(branches.map(b => ({ ...b, slots: slots.filter(s => s.branch_id === b.id) })));
}));

function validateBranchBody(body) {
  const name = (body.name || '').trim();
  if (!name) return { error: '名稱不可為空' };
  const storyContent = (body.storyContent || '').trim() || null;

  const displayOrder = body.displayOrder === undefined || body.displayOrder === null || body.displayOrder === ''
    ? 0
    : parseInt(body.displayOrder, 10);
  if (!Number.isInteger(displayOrder)) return { error: '顯示順序必須是整數' };

  return { data: { name, storyContent, displayOrder } };
}

router.post('/tech-tree/branches', asyncHandler(async (req, res) => {
  const validated = validateBranchBody(req.body || {});
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `INSERT INTO tech_tree_branches (name, story_content, display_order)
     VALUES ($1,$2,$3) RETURNING id, name, story_content, display_order`,
    [d.name, d.storyContent, d.displayOrder]
  );
  res.status(201).json({ ...rows[0], slots: [] });
}));

router.patch('/tech-tree/branches/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query('SELECT * FROM tech_tree_branches WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'branch not found' });
  const existing = existingRows[0];

  const merged = {
    name: req.body.name ?? existing.name,
    storyContent: req.body.storyContent !== undefined ? req.body.storyContent : existing.story_content,
    displayOrder: req.body.displayOrder !== undefined ? req.body.displayOrder : existing.display_order
  };

  const validated = validateBranchBody(merged);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `UPDATE tech_tree_branches SET name=$1, story_content=$2, display_order=$3
     WHERE id = $4 RETURNING id, name, story_content, display_order`,
    [d.name, d.storyContent, d.displayOrder, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/tech-tree/branches/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM tech_tree_branches WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'branch not found' });
    res.status(204).end();
  } catch (err) {
    // 底下還掛著槽位、或已經有隊伍解鎖過這個分支，FK 擋下來——先刪掉底下的槽位
    // （或等隊伍進度另外處理）才能刪分支，避免默默弄丟劇情解鎖記錄。
    if (err.code === '23503') {
      return res.status(409).json({ error: '這個分支底下還有槽位或已有隊伍進度，無法刪除' });
    }
    throw err;
  }
}));

function validateSlotBody(body, branchIds, clueIds) {
  const branchId = Number.isInteger(body.branchId) ? body.branchId : parseInt(body.branchId, 10);
  if (!Number.isInteger(branchId) || !branchIds.has(branchId)) return { error: '指定的分支不存在' };

  const correctClueId = Number.isInteger(body.correctClueId) ? body.correctClueId : parseInt(body.correctClueId, 10);
  if (!Number.isInteger(correctClueId) || !clueIds.has(correctClueId)) return { error: '指定的正確答案線索不存在' };

  const slotOrder = body.slotOrder === undefined || body.slotOrder === null || body.slotOrder === ''
    ? 0
    : parseInt(body.slotOrder, 10);
  if (!Number.isInteger(slotOrder)) return { error: '槽位順序必須是整數' };

  return { data: { branchId, correctClueId, slotOrder } };
}

router.post('/tech-tree/slots', asyncHandler(async (req, res) => {
  const { rows: branches } = await db.query('SELECT id FROM tech_tree_branches');
  const branchIds = new Set(branches.map(b => b.id));
  const { rows: clues } = await db.query('SELECT id FROM clues');
  const clueIds = new Set(clues.map(c => c.id));

  const validated = validateSlotBody(req.body || {}, branchIds, clueIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `INSERT INTO tech_tree_slots (branch_id, slot_order, correct_clue_id)
     VALUES ($1,$2,$3) RETURNING id, branch_id, slot_order, correct_clue_id`,
    [d.branchId, d.slotOrder, d.correctClueId]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/tech-tree/slots/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query('SELECT * FROM tech_tree_slots WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'slot not found' });
  const existing = existingRows[0];

  const { rows: branches } = await db.query('SELECT id FROM tech_tree_branches');
  const branchIds = new Set(branches.map(b => b.id));
  const { rows: clues } = await db.query('SELECT id FROM clues');
  const clueIds = new Set(clues.map(c => c.id));

  const merged = {
    branchId: req.body.branchId !== undefined ? req.body.branchId : existing.branch_id,
    correctClueId: req.body.correctClueId !== undefined ? req.body.correctClueId : existing.correct_clue_id,
    slotOrder: req.body.slotOrder !== undefined ? req.body.slotOrder : existing.slot_order
  };

  const validated = validateSlotBody(merged, branchIds, clueIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const { rows } = await db.query(
    `UPDATE tech_tree_slots SET branch_id=$1, slot_order=$2, correct_clue_id=$3
     WHERE id = $4 RETURNING id, branch_id, slot_order, correct_clue_id`,
    [d.branchId, d.slotOrder, d.correctClueId, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/tech-tree/slots/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM tech_tree_slots WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'slot not found' });
    res.status(204).end();
  } catch (err) {
    // 已經有隊伍放過線索/檢查過這一格，FK 擋下來，避免默默把玩過的進度弄不見。
    if (err.code === '23503') {
      return res.status(409).json({ error: '這個槽位已經有隊伍互動過，無法刪除' });
    }
    throw err;
  }
}));

// 長老候選人管理：清單附得票數（方便主辦看目前投票結果），新增、編輯、刪除。
router.get('/elders', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT e.id, e.name, e.description,
       (SELECT COUNT(*)::int FROM school_votes sv WHERE sv.elder_id = e.id) AS vote_count
     FROM elders e
     ORDER BY e.id ASC`
  );
  res.json(rows);
}));

router.post('/elders', asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const { rows } = await db.query(
    'INSERT INTO elders (name, description) VALUES ($1, $2) RETURNING id, name, description',
    [name.trim(), (description || '').trim() || null]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/elders/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query('SELECT * FROM elders WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'elder not found' });
  const existing = existingRows[0];

  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  const description = req.body.description !== undefined ? (String(req.body.description).trim() || null) : existing.description;

  const { rows } = await db.query(
    'UPDATE elders SET name = $1, description = $2 WHERE id = $3 RETURNING id, name, description',
    [name, description, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/elders/:id', asyncHandler(async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM elders WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'elder not found' });
    res.status(204).end();
  } catch (err) {
    // 已經有隊伍投給這位候選人，FK 擋刪除，避免默默把已經投出去的票變成指向不存在的人。
    if (err.code === '23503') {
      return res.status(409).json({ error: 'cannot delete an elder that already has votes' });
    }
    throw err;
  }
}));

// 投票結果：每位候選人的得票數 + 目前已投票／總學派數，給主辦即時看戰況用。
router.get('/votes/results', asyncHandler(async (req, res) => {
  const { rows: elders } = await db.query(
    `SELECT e.id, e.name, e.description,
       (SELECT COUNT(*)::int FROM school_votes sv WHERE sv.elder_id = e.id) AS vote_count
     FROM elders e
     ORDER BY vote_count DESC, e.id ASC`
  );
  const { rows: countRows } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM schools) AS total_schools,
            (SELECT COUNT(*)::int FROM school_votes) AS voted_schools`
  );
  res.json({ elders, ...countRows[0] });
}));

// 遊戲進程控制。這個系統沒有 Socket.IO，前端頁面靠自己重新呼叫 /game/state 拿到
// 最新狀態（比照 Time-Space Warfare 的 game/start、/end，只是沒有即時推播那一段）。
router.post('/game/start', asyncHandler(async (req, res) => {
  const { rows: current } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (current[0].status === 'in_progress') {
    return res.status(409).json({ error: 'game is already in progress' });
  }
  const { rows } = await db.query(
    `UPDATE game_state SET status = 'in_progress', started_at = now(), ended_at = NULL
     WHERE id = 1 RETURNING status, started_at, ended_at, voting_unlocked_at, voting_closed_at`
  );
  res.json(rows[0]);
}));

router.post('/game/end', asyncHandler(async (req, res) => {
  const { rows: current } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (current[0].status !== 'in_progress') {
    return res.status(409).json({ error: 'game is not in progress' });
  }
  const { rows } = await db.query(
    `UPDATE game_state SET status = 'ended', ended_at = now()
     WHERE id = 1 RETURNING status, started_at, ended_at, voting_unlocked_at, voting_closed_at`
  );
  res.json(rows[0]);
}));

// 投票開關獨立於整體遊戲 status（見 game_state.voting_unlocked_at / voting_closed_at），
// 由主辦手動開放，通常在遊戲快結束、準備進入「最終決策」階段時按下。
// voting_unlocked_at 只記「最初開放的時間」，不會被之後的呼叫往後推遲；
// 開放時順便把 voting_closed_at 清空，所以「關閉後再開放」也是走這支 API，
// 效果等於重新開放投票（votes.js 判斷開放與否是看 unlocked 有值且 closed 沒值）。
router.post('/game/open-voting', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE game_state
     SET voting_unlocked_at = COALESCE(voting_unlocked_at, now()), voting_closed_at = NULL
     WHERE id = 1 RETURNING voting_unlocked_at, voting_closed_at`
  );
  res.json({ votingUnlockedAt: rows[0].voting_unlocked_at, votingClosedAt: rows[0].voting_closed_at });
}));

// 手動關閉投票：投完票不代表遊戲結束，主辦可能想在收齊各隊意見後把投票關掉，
// 避免有隊伍事後反悔亂改。重複呼叫是安全的（COALESCE 保留第一次關閉的時間）。
router.post('/game/close-voting', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE game_state SET voting_closed_at = COALESCE(voting_closed_at, now())
     WHERE id = 1 RETURNING voting_unlocked_at, voting_closed_at`
  );
  res.json({ votingUnlockedAt: rows[0].voting_unlocked_at, votingClosedAt: rows[0].voting_closed_at });
}));

router.get('/game/state', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT status, started_at, ended_at, voting_unlocked_at, voting_closed_at FROM game_state WHERE id = 1'
  );
  res.json(rows[0]);
}));

// 計分：正確安裝且已鎖定的科技樹槽位每格 +10 分、答錯的檢查嘗試每次 -2 分（見 PLAN.md
// 規格「計分：線索正確度總分－驗證扣分」）。不額外存一個累計分數欄位，每次都是即時從
// school_slot_placements/school_check_attempts 算出來，避免跟實際資料兜不起來
// （schema 設計就是這樣，見 migrations/001_init.sql 的說明）。分數可能是負的
// （亂猜扣分的代價），主辦頒獎時要不要特別處理負分自行決定。
const POINTS_PER_CORRECT_SLOT = 10;
const PENALTY_PER_WRONG_ATTEMPT = 2;

router.get('/scoreboard', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      s.id AS school_id, s.display_name,
      COALESCE(placements.correct_count, 0) AS correct_slots,
      COALESCE(attempts.wrong_count, 0) AS wrong_attempts,
      COALESCE(clues.clue_count, 0) AS clues_collected,
      COALESCE(branches.branch_count, 0) AS branches_unlocked
    FROM schools s
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS correct_count
      FROM school_slot_placements WHERE is_locked = true GROUP BY school_id
    ) placements ON placements.school_id = s.id
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS wrong_count
      FROM school_check_attempts WHERE is_correct = false GROUP BY school_id
    ) attempts ON attempts.school_id = s.id
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS clue_count FROM school_clues GROUP BY school_id
    ) clues ON clues.school_id = s.id
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS branch_count FROM school_branch_unlocks GROUP BY school_id
    ) branches ON branches.school_id = s.id
    ORDER BY s.id
  `);

  const scoreboard = rows.map(r => ({
    schoolId: r.school_id,
    displayName: r.display_name,
    correctSlots: r.correct_slots,
    wrongAttempts: r.wrong_attempts,
    cluesCollected: r.clues_collected,
    branchesUnlocked: r.branches_unlocked,
    score: r.correct_slots * POINTS_PER_CORRECT_SLOT - r.wrong_attempts * PENALTY_PER_WRONG_ATTEMPT
  })).sort((a, b) => b.score - a.score);

  res.json(scoreboard);
}));

module.exports = router;
