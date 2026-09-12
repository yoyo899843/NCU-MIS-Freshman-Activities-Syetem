const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const { parse } = require('csv-parse');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { gatekeeperGuard, requireFullAdmin } = require('../middleware/gatekeeperGuard');
const asyncHandler = require('../middleware/asyncHandler');
const { createLoginThrottle } = require('../loginThrottle');
const { validateName } = require('../displayName');
const { techTreeScore } = require('../scoring');
const { logAction } = require('../activityLog');
const { removeLocation, clearLocations } = require('../schoolLocations');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// --- 簡單的登入失敗鎖定（見 src/loginThrottle.js：記憶體內、會定期清掉過期項目） ---
const loginThrottle = createLoginThrottle();

// 後台操作一律寫進 log 檔（src/activityLog.js）：誰、做了什麼、對誰，不存資料庫。

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

  // role: 'admin' 是「這是一張管理端的 token」（跟學派端的 role: 'school' 區分），
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

    logAction(req.admin, '新增關主帳號', rows[0].display_name || rows[0].email);

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
    'SELECT id, email, display_name, role FROM admin_users WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'admin user not found' });
  if (existingRows[0].role !== 'gatekeeper') {
    return res.status(403).json({ error: '管理員帳號只能在伺服器上用 CLI 調整' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [passwordHash, req.params.id]);

  logAction(req.admin, '重設關主密碼', existingRows[0].display_name || existingRows[0].email);

  res.json({ id: Number(req.params.id), passwordReset: true });
}));

// 刪除關主帳號。同樣不能刪管理員。他之前的操作都已經寫在 log 檔裡，不受影響。
router.delete('/admins/:id', requireFullAdmin, asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, email, display_name, role FROM admin_users WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'admin user not found' });
  if (existingRows[0].role !== 'gatekeeper') {
    return res.status(403).json({ error: '管理員帳號只能在伺服器上用 CLI 調整' });
  }

  await db.query('DELETE FROM admin_users WHERE id = $1', [req.params.id]);

  logAction(req.admin, '刪除關主帳號', existingRows[0].display_name || existingRows[0].email);

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

// --- 關主也能做的現場操作（見 middleware/gatekeeperGuard.js 的白名單） ---

// 幫某支隊伍把某個關卡標記成已解鎖（原本要靠關卡解鎖碼兌換）。
router.post('/schools/:schoolId/checkpoints/:checkpointId/unlock', asyncHandler(async (req, res) => {
  const { schoolId, checkpointId } = req.params;

  // 順便把名稱查出來寫 log；查不到名稱＝不存在
  const { rows: names } = await db.query(
    `SELECT (SELECT display_name FROM schools WHERE id = $1) AS school_name,
            (SELECT name FROM checkpoints WHERE id = $2) AS checkpoint_name`,
    [schoolId, checkpointId]
  );
  if (names[0].school_name === null) return res.status(404).json({ error: 'school not found' });
  if (names[0].checkpoint_name === null) return res.status(404).json({ error: 'checkpoint not found' });

  // 已經解鎖過就保留原本的解鎖時間，不要被覆寫成現在。
  const { rows } = await db.query(
    `INSERT INTO school_checkpoint_progress (school_id, checkpoint_id, unlocked_at)
     VALUES ($1, $2, now())
     ON CONFLICT (school_id, checkpoint_id) DO UPDATE
       SET unlocked_at = COALESCE(school_checkpoint_progress.unlocked_at, EXCLUDED.unlocked_at)
     RETURNING school_id, checkpoint_id, unlocked_at, challenge_status`,
    [schoolId, checkpointId]
  );

  logAction(req.admin, `標記解鎖「${names[0].checkpoint_name}」`, names[0].school_name);

  res.json(rows[0]);
}));

// 幫某支隊伍把某個關卡標記成挑戰完成（現場關主確認過關之後按的）。
// 順便確保這個關卡對這支隊伍是解鎖狀態——不會出現「挑戰完成但沒解鎖」的怪狀態。
router.post('/schools/:schoolId/checkpoints/:checkpointId/complete', asyncHandler(async (req, res) => {
  const { schoolId, checkpointId } = req.params;

  // 順便把名稱查出來寫 log；查不到名稱＝不存在
  const { rows: names } = await db.query(
    `SELECT (SELECT display_name FROM schools WHERE id = $1) AS school_name,
            (SELECT name FROM checkpoints WHERE id = $2) AS checkpoint_name`,
    [schoolId, checkpointId]
  );
  if (names[0].school_name === null) return res.status(404).json({ error: 'school not found' });
  if (names[0].checkpoint_name === null) return res.status(404).json({ error: 'checkpoint not found' });

  const { rows } = await db.query(
    `INSERT INTO school_checkpoint_progress
       (school_id, checkpoint_id, unlocked_at, challenge_status, challenge_completed_at)
     VALUES ($1, $2, now(), 'completed', now())
     ON CONFLICT (school_id, checkpoint_id) DO UPDATE
       SET unlocked_at = COALESCE(school_checkpoint_progress.unlocked_at, EXCLUDED.unlocked_at),
           challenge_status = 'completed',
           challenge_completed_at = COALESCE(school_checkpoint_progress.challenge_completed_at, EXCLUDED.challenge_completed_at)
     RETURNING school_id, checkpoint_id, unlocked_at, challenge_status, challenge_completed_at`,
    [schoolId, checkpointId]
  );

  logAction(req.admin, `標記完成「${names[0].checkpoint_name}」`, names[0].school_name);

  res.json(rows[0]);
}));

// 單一隊伍目前的詳細進度（哪些關卡解鎖/完成、拿到哪些線索），給關主現場操作頁
// 用來顯示「這支隊伍現在到哪了」。戰況板那支 /scoreboard 只有加總數字，
// 沒有逐筆 id，所以另外開這一支。
router.get('/schools/:schoolId/progress', asyncHandler(async (req, res) => {
  const { schoolId } = req.params;

  const { rows: schoolRows } = await db.query('SELECT id FROM schools WHERE id = $1', [schoolId]);
  if (schoolRows.length === 0) return res.status(404).json({ error: 'school not found' });

  const { rows: progressRows } = await db.query(
    `SELECT checkpoint_id, unlocked_at, challenge_status
     FROM school_checkpoint_progress WHERE school_id = $1`,
    [schoolId]
  );
  const { rows: clueRows } = await db.query(
    'SELECT clue_id FROM school_clues WHERE school_id = $1',
    [schoolId]
  );

  res.json({
    schoolId: Number(schoolId),
    unlockedCheckpointIds: progressRows.filter(r => r.unlocked_at).map(r => r.checkpoint_id),
    completedCheckpointIds: progressRows.filter(r => r.challenge_status === 'completed').map(r => r.checkpoint_id),
    ownedClueIds: clueRows.map(r => r.clue_id)
  });
}));

// 派發關卡線索給某支隊伍。只有在線索管理中標示為「可由關主派發」且關聯此關卡
// 的線索能走這條路；其他線索仍只能靠 QR 掃描或權限碼取得。
// acquired_via 記成 'staff'，跟自己掃到的 'scan'、自己兌換的 'code' 分開。
router.post('/schools/:schoolId/clues/:clueId', asyncHandler(async (req, res) => {
  const { schoolId, clueId } = req.params;

  const { rows: schoolRows } = await db.query('SELECT id, display_name FROM schools WHERE id = $1', [schoolId]);
  if (schoolRows.length === 0) return res.status(404).json({ error: 'school not found' });
  const { rows: clueRows } = await db.query(
    `SELECT id, checkpoint_id, name FROM clues
     WHERE id = $1 AND staff_grant_enabled = true AND checkpoint_id IS NOT NULL`,
    [clueId]
  );
  if (clueRows.length === 0) {
    return res.status(403).json({ error: '這個線索不是可由關主派發的關卡線索' });
  }
  const clue = clueRows[0];

  // 已經有這個線索就當作成功（不重複發、也不報錯），回傳 alreadyOwned 讓前端可以提示。
  const { rows: inserted } = await db.query(
    `INSERT INTO school_clues (school_id, clue_id, acquired_via)
     VALUES ($1, $2, 'staff')
     ON CONFLICT (school_id, clue_id) DO NOTHING
     RETURNING acquired_at`,
    [schoolId, clueId]
  );
  const alreadyOwned = inserted.length === 0;

  if (!alreadyOwned) logAction(req.admin, `派發線索「${clue.name}」`, schoolRows[0].display_name);

  res.json({ schoolId: Number(schoolId), clueId: Number(clueId), alreadyOwned });
}));

// 學派（玩家帳號）管理：帳號密碼明碼儲存（不雜湊）——這是主辦控制的固定帳號，不是玩家自己設的
// 密碼，主辦需要能直接在後台查到/管理每組學派目前的帳密（例如忘記密碼時直接看，
// 不用重設），理由跟 Time-Space Warfare 玩家 PIN 明碼儲存一樣。
// 見 migrations/003_school_password_plaintext.sql、src/routes/auth.js 的登入比對。
//
// 關主也打得到這支 GET（關主現場操作頁要列出隊伍），但密碼只回給管理員。
router.get('/schools', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, username, password, display_name, created_at FROM schools ORDER BY id ASC'
  );
  const isAdmin = (req.admin.adminRole || 'admin') === 'admin';
  res.json(isAdmin ? rows : rows.map(({ password, ...rest }) => rest));
}));

// 登入帳號：不能有空白（登入時會 trim，中間有空白的帳號打不進去），長度 1–40。
function validateUsername(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: '帳號不可為空' };
  const username = raw.trim();
  if (/\s/.test(username)) return { error: '帳號不能有空白' };
  if (username.length > 40) return { error: '帳號最多 40 個字元' };
  return { username };
}

// validateName 的訊息開頭是「名稱…」，這一頁有帳號和顯示名稱兩種名字，講清楚是哪個
function displayNameError(message) {
  return message.startsWith('名稱') ? '顯示' + message : '顯示名稱' + message;
}

function validatePassword(raw) {
  if (typeof raw !== 'string' || raw.length < 8) return { error: '密碼至少要 8 個字元' };
  return { password: raw };
}

router.post('/schools', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const u = validateUsername(body.username);
  if (u.error) return res.status(400).json({ error: u.error });
  const p = validatePassword(body.password);
  if (p.error) return res.status(400).json({ error: p.error });
  // 學派名稱會出現在地圖 tooltip、戰況板、後台表格等地方，字元規則見
  // src/displayName.js（只准文字、數字、emoji，把標點與角括號擋在輸入端）。
  const n = validateName(body.displayName);
  if (n.error) return res.status(400).json({ error: displayNameError(n.error) });

  try {
    const { rows } = await db.query(
      `INSERT INTO schools (username, password, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, username, password, display_name, created_at`,
      [u.username, p.password, n.name]
    );
    logAction(req.admin, '新增學派帳號', rows[0].display_name);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '這個帳號已經有人用了' });
    throw err;
  }
}));

// 部分更新：帳號、密碼、顯示名稱，帶哪個改哪個，至少要帶一個。
// 已經登入的裝置不用重新登入：schoolAuth 每次都從資料庫讀最新的帳號與名稱。
router.patch('/schools/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (body.username === undefined && body.password === undefined && body.displayName === undefined) {
    return res.status(400).json({ error: '沒有要更新的欄位' });
  }
  const changes = {};
  if (body.username !== undefined) {
    const u = validateUsername(body.username);
    if (u.error) return res.status(400).json({ error: u.error });
    changes.username = u.username;
  }
  if (body.password !== undefined) {
    const p = validatePassword(body.password);
    if (p.error) return res.status(400).json({ error: p.error });
    changes.password = p.password;
  }
  if (body.displayName !== undefined) {
    const n = validateName(body.displayName);
    if (n.error) return res.status(400).json({ error: displayNameError(n.error) });
    changes.displayName = n.name;
  }

  const { rows: existingRows } = await db.query('SELECT * FROM schools WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: '找不到這個學派帳號' });
  const existing = existingRows[0];

  try {
    const { rows } = await db.query(
      `UPDATE schools SET username = $1, password = $2, display_name = $3 WHERE id = $4
       RETURNING id, username, password, display_name, created_at`,
      [
        changes.username ?? existing.username,
        changes.password ?? existing.password,
        changes.displayName ?? existing.display_name,
        req.params.id
      ]
    );
    // 只記改了哪幾個欄位，不記內容（密碼尤其不能進 log）；改名的話把新舊名字都留下
    const changedFields = [['username', '帳號'], ['password', '密碼'], ['displayName', '名稱']]
      .filter(([key]) => changes[key] !== undefined).map(([, label]) => label).join('、');
    logAction(req.admin, `修改學派帳號（${changedFields}）`,
      existing.display_name === rows[0].display_name ? rows[0].display_name : `${existing.display_name} → ${rows[0].display_name}`);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '這個帳號已經有人用了' });
    throw err;
  }
}));

// 一支隊伍的所有遊戲紀錄。刪學派帳號時由資料庫一起刪（migrations/012 的 ON DELETE CASCADE），
// 重置遊戲（/game/reset）則是整張表清空、帳號留著。
const SCHOOL_PROGRESS_TABLES = [
  ['school_checkpoint_progress', '關卡進度'],
  ['school_clues', '線索'],
  ['school_code_redemptions', '權限碼兌換'],
  ['school_slot_placements', '科技樹放置'],
  ['school_check_attempts', '科技樹驗證紀錄'],
  ['school_branch_unlocks', '已解鎖分支'],
  ['school_votes', '長老投票']
];

// 刪除學派帳號，連同這一隊所有遊戲紀錄（包含長老投票，投票結果會跟著變）。
router.delete('/schools/:id', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM schools WHERE id = $1 RETURNING id, display_name', [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '找不到這個學派帳號' });
  removeLocation(rows[0].id);
  logAction(req.admin, '刪除學派帳號', rows[0].display_name);
  res.status(204).end();
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
  logAction(req.admin, '新增關卡', rows[0].name);
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
  logAction(req.admin, '修改關卡', rows[0].name);
  res.json(rows[0]);
}));

// 刪除關卡：各隊在這一關的進度、以這一關為目標的權限碼（含兌換紀錄）一起刪掉；
// 關聯到這一關的線索保留，只是變成沒有關聯關卡（也就不能再由關主派發）。
router.delete('/checkpoints/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, name, description, map_lat, map_lng, is_locked_by_default FROM checkpoints WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'checkpoint not found' });
  const { rowCount } = await db.query('DELETE FROM checkpoints WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'checkpoint not found' });
  logAction(req.admin, '刪除關卡', existingRows[0].name);
  res.status(204).end();
}));

// 權限碼與線索 QR 代碼一律正規化成「去頭尾空白＋全大寫」再存。
//
// 為什麼要全大寫：活動當天玩家是在手機上打字，自動大寫、注音切換、或直接打小寫
// 都很常見，分大小寫的話會得到「查無此碼」這種看不出原因的錯誤。存進去就先統一，
// 查詢時同樣把輸入轉大寫，就能直接吃現有的 UNIQUE 索引，不用做全表掃描。
//
// 自動產生的代碼是十六進位（0-9a-f），轉大寫是一對一對應、不會減少隨機性。
function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

const CLUE_COLUMNS = 'id, checkpoint_id, name, description, acquisition_location, staff_grant_enabled, image_url, qr_token, created_at';

router.get('/clues', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.checkpoint_id, c.name, c.description, c.acquisition_location, c.staff_grant_enabled, c.image_url, c.qr_token, c.created_at,
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
  const acquisitionLocation = (body.acquisitionLocation || '').trim() || null;
  if (acquisitionLocation && acquisitionLocation.length > 120) {
    return { error: '獲得地點不可超過 120 個字元' };
  }
  const staffGrantEnabled = body.staffGrantEnabled === true;
  if (staffGrantEnabled && checkpointId === null) {
    return { error: '可由關主派發的線索必須關聯一個關卡' };
  }
  const imageUrl = (body.imageUrl || '').trim() || null;
  const qrToken = normalizeCode(body.qrToken) || `CLUE-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  return { data: { checkpointId, name, description, acquisitionLocation, staffGrantEnabled, imageUrl, qrToken } };
}

router.post('/clues', asyncHandler(async (req, res) => {
  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));

  const validated = validateClueBody(req.body || {}, checkpointIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  try {
    const { rows } = await db.query(
      `INSERT INTO clues (checkpoint_id, name, description, acquisition_location, staff_grant_enabled, image_url, qr_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${CLUE_COLUMNS}`,
      [d.checkpointId, d.name, d.description, d.acquisitionLocation, d.staffGrantEnabled, d.imageUrl, d.qrToken]
    );
    logAction(req.admin, '新增線索', rows[0].name);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'QR 代碼已經被使用過了' });
    if (err.code === 'P0001') return res.status(400).json({ error: err.message });
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
    acquisitionLocation: req.body.acquisitionLocation ?? existing.acquisition_location,
    staffGrantEnabled: req.body.staffGrantEnabled ?? existing.staff_grant_enabled,
    imageUrl: req.body.imageUrl ?? existing.image_url,
    qrToken: req.body.qrToken !== undefined ? normalizeCode(req.body.qrToken) : existing.qr_token
  };

  const validated = validateClueBody(merged, checkpointIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  try {
    const { rows } = await db.query(
      `UPDATE clues SET checkpoint_id=$1, name=$2, description=$3, acquisition_location=$4, staff_grant_enabled=$5, image_url=$6, qr_token=$7
       WHERE id = $8 RETURNING ${CLUE_COLUMNS}`,
      [d.checkpointId, d.name, d.description, d.acquisitionLocation, d.staffGrantEnabled, d.imageUrl, d.qrToken, req.params.id]
    );
    logAction(req.admin, '修改線索', rows[0].name);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'QR 代碼已經被使用過了' });
    if (err.code === 'P0001') return res.status(400).json({ error: err.message });
    throw err;
  }
}));

// 刪除線索：各隊取得的這張線索、以它為答案的科技樹槽位、放著它的格子、相關驗證紀錄、
// 指向它的權限碼（含兌換紀錄）一起刪掉。
router.delete('/clues/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, checkpoint_id, name, description, acquisition_location, staff_grant_enabled, qr_token FROM clues WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'clue not found' });
  const { rowCount } = await db.query('DELETE FROM clues WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'clue not found' });
  logAction(req.admin, '刪除線索', existingRows[0].name);
  res.status(204).end();
}));

// CSV 欄位格式：名稱, 描述, 獲得地點（關卡）, 圖片網址, QR代碼。
// CSV 不使用系統內部 ID；「獲得地點（關卡）」是顯示給玩家看的文字；「QR代碼」留空＝自動產生。
// 比照 Time-Space Warfare 題庫匯入的做法：用 csv-parse 的 stream/async-iterator 介面
// 逐筆處理、每 20 筆一批寫入、批次間讓出 event loop，避免大檔案同步解析卡住玩家端連線
// （這個系統雖然沒有 Socket.IO，但同一個原則還是適用——不要用同步阻塞迴圈處理上傳檔案）。
function validateCsvRow(record, rowNumber) {
  const name = (record['名稱'] || '').trim();
  if (!name) return { error: `第 ${rowNumber} 列：名稱為空` };

  const acquisitionLocation = (record['獲得地點（關卡）'] || '').trim() || null;
  if (acquisitionLocation && acquisitionLocation.length > 120) {
    return { error: `第 ${rowNumber} 列：獲得地點不可超過 120 個字元` };
  }

  const description = (record['描述'] || '').trim() || null;
  const imageUrl = (record['圖片網址'] || '').trim() || null;
  const qrToken = normalizeCode(record['QR代碼']) || `CLUE-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  return { data: { checkpointId: null, name, description, acquisitionLocation, imageUrl, qrToken } };
}

router.post('/clues/import', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart field name: file)' });

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
          `INSERT INTO clues (checkpoint_id, name, description, acquisition_location, image_url, qr_token) VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.checkpointId, row.name, row.description, row.acquisitionLocation, row.imageUrl, row.qrToken]
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
    const validated = validateCsvRow(record, rowNumber);
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

  logAction(req.admin, '匯入線索 CSV', `成功 ${result.inserted} 筆`);
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
        normalizeCode(code),
        type,
        type === 'checkpoint_unlock' ? targetCheckpointId : null,
        type === 'hidden_clue' ? targetClueId : null
      ]
    );
    logAction(req.admin, '新增權限碼', rows[0].code);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'code already exists' });
    throw err;
  }
}));

// 刪除權限碼：各隊的兌換紀錄一起刪掉（已經因為兌換拿到的線索／解鎖的關卡不受影響）。
router.delete('/access-codes/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, code, type, target_checkpoint_id, target_clue_id FROM access_codes WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'not found' });
  const { rowCount } = await db.query('DELETE FROM access_codes WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'not found' });
  logAction(req.admin, '刪除權限碼', existingRows[0].code);
  res.status(204).end();
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
  const code = normalizeCode(record['代碼']);
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

  logAction(req.admin, '匯入權限碼 CSV', `成功 ${result.inserted} 筆`);
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
     ORDER BY s.branch_id, s.slot_order, s.id`
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
  logAction(req.admin, '新增科技樹分支', rows[0].name);
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
  logAction(req.admin, '修改科技樹分支', rows[0].name);
  res.json(rows[0]);
}));

// 刪除分支：底下的槽位、各隊在這些槽位的放置與驗證紀錄、分支解鎖紀錄一起刪掉。
router.delete('/tech-tree/branches/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, name, story_content, display_order FROM tech_tree_branches WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'branch not found' });
  const { rowCount } = await db.query('DELETE FROM tech_tree_branches WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'branch not found' });
  logAction(req.admin, '刪除科技樹分支', existingRows[0].name);
  res.status(204).end();
}));

function validateSlotBody(body, branchIds, clueIds) {
  const branchId = Number.isInteger(body.branchId) ? body.branchId : parseInt(body.branchId, 10);
  if (!Number.isInteger(branchId) || !branchIds.has(branchId)) return { error: '指定的分支不存在' };

  const correctClueId = Number.isInteger(body.correctClueId) ? body.correctClueId : parseInt(body.correctClueId, 10);
  if (!Number.isInteger(correctClueId) || !clueIds.has(correctClueId)) return { error: '指定的正確答案線索不存在' };

  return { data: { branchId, correctClueId } };
}

// log 用的槽位名稱：「分支名：答案線索名」
async function slotLabel(branchId, clueId) {
  const { rows } = await db.query(
    `SELECT (SELECT name FROM tech_tree_branches WHERE id = $1) AS branch,
            (SELECT name FROM clues WHERE id = $2) AS clue`,
    [branchId, clueId]
  );
  return `${rows[0].branch ?? '?'}：${rows[0].clue ?? '?'}`;
}

// 槽位不分順序（線索放在所屬分支任一格都算對），主辦不用填順序。slot_order 只拿來
// 讓格子排列穩定：新增或搬到別的分支時排在那個分支的最後面。

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
     VALUES ($1, (SELECT COALESCE(MAX(slot_order), 0) + 1 FROM tech_tree_slots WHERE branch_id = $1), $2)
     RETURNING id, branch_id, slot_order, correct_clue_id`,
    [d.branchId, d.correctClueId]
  );
  logAction(req.admin, '新增科技樹槽位', await slotLabel(rows[0].branch_id, rows[0].correct_clue_id));
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
    correctClueId: req.body.correctClueId !== undefined ? req.body.correctClueId : existing.correct_clue_id
  };

  const validated = validateSlotBody(merged, branchIds, clueIds);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const d = validated.data;
  const movedBranch = d.branchId !== existing.branch_id;
  const { rows } = await db.query(
    `UPDATE tech_tree_slots
     SET branch_id = $1, correct_clue_id = $2,
         slot_order = CASE WHEN $4 THEN (SELECT COALESCE(MAX(slot_order), 0) + 1 FROM tech_tree_slots WHERE branch_id = $1)
                           ELSE slot_order END
     WHERE id = $3 RETURNING id, branch_id, slot_order, correct_clue_id`,
    [d.branchId, d.correctClueId, req.params.id, movedBranch]
  );
  logAction(req.admin, '修改科技樹槽位', await slotLabel(rows[0].branch_id, rows[0].correct_clue_id));
  res.json(rows[0]);
}));

// 刪除槽位：各隊在這一格的放置與驗證紀錄一起刪掉。
router.delete('/tech-tree/slots/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, branch_id, slot_order, correct_clue_id FROM tech_tree_slots WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'slot not found' });
  const { rowCount } = await db.query('DELETE FROM tech_tree_slots WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'slot not found' });
  logAction(req.admin, '刪除科技樹槽位', await slotLabel(existingRows[0].branch_id, existingRows[0].correct_clue_id));
  res.status(204).end();
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
  logAction(req.admin, '新增長老候選人', rows[0].name);
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
  logAction(req.admin, '修改長老候選人', rows[0].name);
  res.json(rows[0]);
}));

// 刪除長老候選人：投給他的票一起刪掉，那些隊伍可以重新投票。
router.delete('/elders/:id', asyncHandler(async (req, res) => {
  const { rows: existingRows } = await db.query(
    'SELECT id, name, description FROM elders WHERE id = $1', [req.params.id]
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'elder not found' });
  const { rowCount } = await db.query('DELETE FROM elders WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'elder not found' });
  logAction(req.admin, '刪除長老候選人', existingRows[0].name);
  res.status(204).end();
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
  logAction(req.admin, '開始遊戲');
  res.json(rows[0]);
}));

// 結束遊戲只凍結狀態，不清任何資料——結束之後主辦還要看戰況板的最終分數和投票結果。
// 要清空進度重新開始一場，用下面的 /game/reset。
router.post('/game/end', asyncHandler(async (req, res) => {
  const { rows: current } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (current[0].status !== 'in_progress') {
    return res.status(409).json({ error: 'game is not in progress' });
  }
  const { rows } = await db.query(
    `UPDATE game_state SET status = 'ended', ended_at = now()
     WHERE id = 1 RETURNING status, started_at, ended_at, voting_unlocked_at, voting_closed_at`
  );
  logAction(req.admin, '結束遊戲');
  res.json(rows[0]);
}));

// 投票開關獨立於整體遊戲 status（見 game_state.voting_unlocked_at / voting_closed_at），
// 由主辦手動開放，通常在遊戲快結束、準備進入「最終決策」階段時按下。
// voting_unlocked_at 只記「最初開放的時間」，不會被之後的呼叫往後推遲；
// 開放時順便把 voting_closed_at 清空，所以「關閉後再開放」也是走這支 API，
// 效果等於重新開放投票（votes.js 判斷開放與否是看 unlocked 有值且 closed 沒值）。
router.post('/game/open-voting', asyncHandler(async (req, res) => {
  const { rows: before } = await db.query(
    'SELECT voting_unlocked_at, voting_closed_at FROM game_state WHERE id = 1'
  );
  const { rows } = await db.query(
    `UPDATE game_state
     SET voting_unlocked_at = COALESCE(voting_unlocked_at, now()), voting_closed_at = NULL
     WHERE id = 1 RETURNING voting_unlocked_at, voting_closed_at`
  );
  logAction(req.admin, '開放投票');
  res.json({ votingUnlockedAt: rows[0].voting_unlocked_at, votingClosedAt: rows[0].voting_closed_at });
}));

// 手動關閉投票：投完票不代表遊戲結束，主辦可能想在收齊各隊意見後把投票關掉，
// 避免有隊伍事後反悔亂改。重複呼叫是安全的（COALESCE 保留第一次關閉的時間）。
router.post('/game/close-voting', asyncHandler(async (req, res) => {
  const { rows: before } = await db.query(
    'SELECT voting_unlocked_at, voting_closed_at FROM game_state WHERE id = 1'
  );
  const { rows } = await db.query(
    `UPDATE game_state SET voting_closed_at = COALESCE(voting_closed_at, now())
     WHERE id = 1 RETURNING voting_unlocked_at, voting_closed_at`
  );
  logAction(req.admin, '關閉投票');
  res.json({ votingUnlockedAt: rows[0].voting_unlocked_at, votingClosedAt: rows[0].voting_closed_at });
}));

// 重置遊戲：清掉所有隊伍的遊戲進度，帳號與遊戲設定都保留，遊戲狀態回到「未開始」。
//
// 清掉的：SCHOOL_PROGRESS_TABLES 那七張表（關卡進度、線索、權限碼兌換、科技樹放置與
//   驗證、分支解鎖、長老投票），加上地圖即時位置、投票開關與遊戲開始／結束時間。
// 保留的：學派帳號（含密碼）、關卡、線索、權限碼、科技樹、長老、工作人員帳號、操作紀錄檔。
//
// 分數是從進度即時算的（src/scoring.js），進度清掉後戰況板自然歸零，不用另外處理。
// body 要帶 { confirm: '重置遊戲' }：這個操作收不回來，後台頁面會要主辦手打這四個字，
// 伺服器端也檢查一次，避免被誤觸或其他頁面誤呼叫。
router.post('/game/reset', requireFullAdmin, asyncHandler(async (req, res) => {
  if ((req.body || {}).confirm !== '重置遊戲') {
    return res.status(400).json({ error: '請輸入「重置遊戲」確認' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 鎖住遊戲狀態那一列，兩個主辦同時按也只會一個一個來
    await client.query('SELECT 1 FROM game_state WHERE id = 1 FOR UPDATE');

    const cleared = {};
    for (const [table, label] of SCHOOL_PROGRESS_TABLES) {
      const { rowCount } = await client.query(`DELETE FROM ${table}`);
      if (rowCount > 0) cleared[label] = rowCount;
    }

    const { rows } = await client.query(
      `UPDATE game_state
       SET status = 'not_started', started_at = NULL, ended_at = NULL,
           voting_unlocked_at = NULL, voting_closed_at = NULL
       WHERE id = 1 RETURNING status, started_at, ended_at, voting_unlocked_at, voting_closed_at`
    );
    await client.query('COMMIT');
    clearLocations();
    logAction(req.admin, '重置遊戲', '所有隊伍');
    res.json({ state: rows[0], cleared });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/game/state', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT status, started_at, ended_at, voting_unlocked_at, voting_closed_at FROM game_state WHERE id = 1'
  );
  res.json(rows[0]);
}));

// 計分規則見 src/scoring.js：得分（放對分支的格數 × 5）與推理失誤分（放錯次數 × 2）
// 分開列，總分＝得分 − 推理失誤分，依總分排名。不額外存累計分數欄位，每次都是即時從
// school_slot_placements/school_check_attempts 算出來，避免跟實際資料兜不起來
// （schema 設計就是這樣，見 migrations/001_init.sql 的說明）。總分可能是負的
// （亂猜的代價），主辦頒獎時要不要特別處理負分自行決定。
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
    ...techTreeScore(r.correct_slots, r.wrong_attempts)
  })).sort((a, b) => b.totalScore - a.totalScore);

  res.json(scoreboard);
}));

module.exports = router;
