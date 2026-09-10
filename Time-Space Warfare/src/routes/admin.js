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
const { applyAction } = require('../checkpoints/progress');
const { computeScores } = require('../scoring');
const { getAllLocations } = require('../playerLocations');
const { validateName } = require('../displayName');
const { CHECKPOINT_BOUNDS, isInsideMapArea, looksSwapped } = require('../campusBounds');
const roomRegistry = require('../pk/roomRegistry');
const pkSession = require('../pk/session');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// --- 簡單的登入失敗鎖定（見 src/loginThrottle.js：記憶體內、會定期清掉過期項目） ---
const loginThrottle = createLoginThrottle();

// game_state 的完整欄位清單。
//
// 每一支會改動遊戲狀態的 API 都要把整份狀態回給前端（renderState 是拿整包去
// 重畫的），原本是十個地方各抄一份 RETURNING，加欄位就得記得十個都改。實際上
// 也真的漏掉過：/game/start 和 /game/end 少了 pk_questions_per_duel 與
// pk_answer_seconds，按下「開始遊戲」之後 PK 設定的兩個輸入框會被填成
// undefined 而變空白——不會報錯，只是看起來設定不見了。
const GAME_STATE_COLUMNS = `status, started_at, ended_at, duration_minutes, max_teams, progress_step,
       pk_questions_per_duel, pk_answer_seconds,
       voting_unlocked_at, voting_closed_at, spy_vote_count, spy_team_count, faction_drawn_at`;

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
    `SELECT id, name, map_lat, map_lng, progress, updated_at
     FROM checkpoints ORDER BY id`
  );
  res.json(rows.map(numericCheckpoint));
}));

// progress 是 INT，pg 直接回數字，不用再轉。留這個函式當統一出口，
// 之後如果又加了 NUMERIC 欄位才有地方接。
function numericCheckpoint(row) {
  return row;
}

// 回傳 { ok, value } 或 { ok: false, error }——刻意不用 throw，因為目前的
// 錯誤處理中介層一律把例外回成 500（見 problem.md B1），驗證錯誤要自己回 400。
function parseCoord(value, min, max, label) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { ok: false, error: `${label} 必須是 ${min} 到 ${max} 之間的數字` };
  }
  return { ok: true, value: n };
}

const B = CHECKPOINT_BOUNDS;
const f = n => n.toFixed(6);

// 經緯度打反要在「-90~90」那層之前先判斷。
//
// 本來寫在後面，結果那段提示永遠不會出現：這個場地的經度是 121，打反之後
// 121 被當成緯度，parseCoord 的 -90~90 直接就擋掉了，回的是「mapLat 必須是
// -90 到 90 之間的數字」。技術上沒錯，但對「我只是把兩欄貼反」的人完全沒幫助，
// 而那是最常見的一種打錯（Google 地圖複製出來是「緯度, 經度」，GeoJSON 之類
// 的工具卻是相反的順序）。
//
// 所以先拿原始數字問一次「對調之後是不是就對了」，是的話直接講。
function swapHint(mapLat, mapLng) {
  const a = Number(mapLat), b = Number(mapLng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (isInsideMapArea(a, b)) return null;           // 本來就對，不用管
  if (!looksSwapped(a, b)) return null;
  return `緯度和經度好像對調了。你填的是 緯度 ${a}、經度 ${b}，` +
         `對調之後（緯度 ${b}、經度 ${a}）剛好落在校園範圍內。`;
}

// 交摺點座標必須落在有圖磚的那一塊範圍內。
//
// -90~90 / -180~180 那層只擋得掉「整個世界以外」的值，擋不掉真正會發生的錯：
// 少打一位數、小數點位置跑掉、經緯度貼反。這些都是合法的地球座標，存進去也不會
// 報錯，但那個點在玩家的地圖上永遠不會出現——超出 Leaflet 的 maxBounds 拖都拖
// 不過去。等到活動當天有人說「怎麼少一個點」才發現，就來不及了。
//
// 回傳 { ok } 或 { ok:false, error }；跟 parseCoord 一樣不用 throw，
// 因為錯誤處理中介層會把例外一律當成 500。
function checkInsideMap(lat, lng) {
  if (lat === null || lng === null) return { ok: true };   // 兩個都沒填＝還沒定位，允許
  if (isInsideMapArea(lat, lng)) return { ok: true };

  // 打反的情況已經在更前面用 swapHint 擋掉了（要趕在 -90~90 那層之前），
  // 走到這裡的就是單純超出範圍。
  const outLat = lat < B.minLat || lat > B.maxLat;
  const outLng = lng < B.minLng || lng > B.maxLng;
  const which = outLat && outLng ? '緯度和經度都' : outLat ? '緯度' : '經度';
  return {
    ok: false,
    error: `${which}超出地圖範圍，這個點在玩家的地圖上會看不到。` +
           `有效範圍：緯度 ${f(B.minLat)}～${f(B.maxLat)}、經度 ${f(B.minLng)}～${f(B.maxLng)}。` +
           `（你填的是 緯度 ${lat}、經度 ${lng}）`
  };
}

// 給後台的表單顯示有效範圍用。寫死在 HTML 裡的話，之後換場地重抓圖磚就會變成
// 一個沒人記得要改、而且看起來很像真的的錯誤提示。
router.get('/checkpoint-bounds', asyncHandler(async (req, res) => {
  res.json(CHECKPOINT_BOUNDS);
}));

router.post('/checkpoints', asyncHandler(async (req, res) => {
  const { name, mapLat, mapLng } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const swapped = swapHint(mapLat, mapLng);
  if (swapped) return res.status(400).json({ error: swapped });

  const lat = parseCoord(mapLat, -90, 90, 'mapLat');
  if (!lat.ok) return res.status(400).json({ error: lat.error });
  const lng = parseCoord(mapLng, -180, 180, 'mapLng');
  if (!lng.ok) return res.status(400).json({ error: lng.error });

  // 只填一個座標等於一組沒有意義的位置：地圖需要成對的經緯度才畫得出點，
  // 存進去只會變成一個永遠不顯示、但後台看起來「有填」的交摺點。
  if ((lat.value === null) !== (lng.value === null)) {
    return res.status(400).json({ error: '經度和緯度要一起填（或都留空）' });
  }
  const inside = checkInsideMap(lat.value, lng.value);
  if (!inside.ok) return res.status(400).json({ error: inside.error });

  const { rows } = await db.query(
    `INSERT INTO checkpoints (name, map_lat, map_lng)
     VALUES ($1, $2, $3)
     RETURNING id, name, map_lat, map_lng, progress`,
    [name.trim(), lat.value, lng.value]
  );

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'create_checkpoint', 'checkpoint', $2, NULL, $3)`,
    [req.admin.sub, String(rows[0].id), JSON.stringify({ name: rows[0].name })]
  );

  res.status(201).json(numericCheckpoint(rows[0]));
}));

router.patch('/checkpoints/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { name, mapLat, mapLng } = body;

  // 同 POST：打反要趕在 -90~90 的範圍檢查之前判斷，否則會回一句沒有幫助的
  // 「mapLat 必須是 -90 到 90 之間的數字」。只有兩個都送來才問得出對調。
  if ('mapLat' in body && 'mapLng' in body) {
    const swapped = swapHint(mapLat, mapLng);
    if (swapped) return res.status(400).json({ error: swapped });
  }

  const lat = parseCoord(mapLat, -90, 90, 'mapLat');
  if (!lat.ok) return res.status(400).json({ error: lat.error });
  const lng = parseCoord(mapLng, -180, 180, 'mapLng');
  if (!lng.ok) return res.status(400).json({ error: lng.error });

  // 「有送這個欄位」和「這個欄位是空的」是兩件事。
  //
  // 原本三個欄位一律 COALESCE(新值, 舊值)，而 parseCoord 把空字串也算成 null，
  // 結果是座標永遠清不掉：後台把經緯度欄位清空按儲存，回應 200、畫面重載，
  // 座標還在原地——看起來像沒存到，其實是被 COALESCE 擋回舊值了。
  //
  // 改成看 key 在不在 body 裡：沒送就不動（PATCH 的語意），送了空字串就是
  // 明確要清成 NULL（那個點會從地圖上消失，這是主辦真的會做的事——點還沒定位）。
  const sets = [];
  const params = [];
  const put = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };

  if (name !== undefined) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return res.status(400).json({ error: 'name 不能是空字串' });
    put('name', trimmed);
  }
  if ('mapLat' in body) put('map_lat', lat.value);
  if ('mapLng' in body) put('map_lng', lng.value);

  if (sets.length === 0) return res.status(400).json({ error: '沒有要更新的欄位' });

  // 驗的是「改完之後」的那組座標，不是這次送來的那半邊。
  //
  // PATCH 可以只送 mapLat，這時最終座標是「新緯度 ＋ 資料庫裡原本的經度」。
  // 只檢查送來的那一個的話，單獨把緯度改成離譜的值會整個檢查不到——而那正是
  // 後台「編輯」最常見的用法（只想微調一個數字）。
  if ('mapLat' in body || 'mapLng' in body) {
    const { rows: cur } = await db.query(
      'SELECT map_lat, map_lng FROM checkpoints WHERE id = $1', [req.params.id]
    );
    if (cur.length === 0) return res.status(404).json({ error: 'checkpoint not found' });

    const finalLat = 'mapLat' in body ? lat.value : (cur[0].map_lat === null ? null : Number(cur[0].map_lat));
    const finalLng = 'mapLng' in body ? lng.value : (cur[0].map_lng === null ? null : Number(cur[0].map_lng));

    if ((finalLat === null) !== (finalLng === null)) {
      return res.status(400).json({ error: '經度和緯度要一起填（或都留空）' });
    }
    const inside = checkInsideMap(finalLat, finalLng);
    if (!inside.ok) return res.status(400).json({ error: inside.error });
  }

  params.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE checkpoints SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length}
     RETURNING id, name, map_lat, map_lng, progress`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: 'checkpoint not found' });

  // 座標變了，地圖上的點就要跟著動。之前只有進度變動會廣播，改座標得靠玩家自己
  // 重整頁面才看得到。
  getIO().emit('checkpoint:update', rows[0]);
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
     RETURNING id, name, map_lat, map_lng, progress`,
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

// 關主現場操作：隊伍在據點通關之後，由駐守的關主在系統輸入結果。
//
// 企劃書寫的就是這個流程（「關卡關主…並在隊伍過關後於系統輸入結果，確認完成
// 組別與選擇之修復或破壞的行動」）——關卡是現場實體活動，不是 app 裡的答題，
// 所以沒有掃碼、沒有題目，只有「哪一隊、做了什麼」。
//
// 關主也能操作（不是只有管理員）：這本來就是關主的工作。
router.post('/checkpoints/:id/action', asyncHandler(async (req, res) => {
  const { teamId, action } = req.body || {};
  if (!['repair', 'disrupt'].includes(action)) {
    return res.status(400).json({ error: "action 必須是 'repair' 或 'disrupt'" });
  }
  const tid = Number(teamId);
  if (!Number.isInteger(tid)) return res.status(400).json({ error: 'teamId is required' });

  const { rows: stateRows } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (stateRows[0]?.status !== 'in_progress') {
    return res.status(403).json({ error: '遊戲不在進行中，現在不能記錄關卡結果', status: stateRows[0]?.status });
  }

  // 一支隊伍一支手機，取這支隊伍的那位玩家當紀錄上的操作者。
  const { rows: teamRows } = await db.query(
    `SELECT t.id, t.faction, t.team_number,
            (SELECT p.id FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS player_id
     FROM teams t WHERE t.id = $1`, [tid]
  );
  if (teamRows.length === 0) return res.status(404).json({ error: '找不到這支隊伍' });
  const team = teamRows[0];
  if (!team.player_id) return res.status(409).json({ error: '這支隊伍還沒有人登入' });

  let result;
  try {
    result = await applyAction({
      checkpointId: Number(req.params.id),
      playerId: team.player_id,
      teamId: team.id,
      faction: team.faction,
      action
    });
  } catch (err) {
    if (err.code === 'CHECKPOINT_NOT_FOUND') return res.status(404).json({ error: '找不到這個據點' });
    throw err;
  }

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'checkpoint_action', 'checkpoint', $2, $3, $4)`,
    [req.admin.sub, String(req.params.id),
     JSON.stringify({ progress: result.progressBefore }),
     JSON.stringify({ progress: result.progressAfter, teamId: team.id, action, aligned: result.aligned })]
  );

  res.json({
    checkpoint: result.checkpoint,
    team: { id: team.id, teamNumber: team.team_number },
    action,
    aligned: result.aligned,
    progressBefore: result.progressBefore,
    progressAfter: result.progressAfter
  });
}));

// 目前所有隊伍（關主操作頁的下拉選單、以及積分板要用）。
// --- 突發任務 ---
//
// 企劃原本寫「系統隨機派發」，改成主辦手動派發：選對象小隊、選接受點位、填內容。
// 系統配一組解鎖碼，關主在現場確認完成後把碼給那一隊，該隊輸入碼才結案並計分。
//
// 解鎖碼刻意做成人唸得出來的短碼（現場是口頭或紙條傳遞），但排除 0/O/1/I 這種
// 唸起來會搞混的字元。
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateUnlockCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// 管理端的任務信箱：看得到所有隊伍的任務，含解鎖碼（關主要照著唸給隊伍）。
router.get('/missions', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id, m.team_id, m.content, m.unlock_code, m.status,
            m.created_at, m.completed_at, m.checkpoint_id,
            c.name AS checkpoint_name,
            t.team_number,
            (SELECT p.display_name FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS team_name
     FROM missions m
     JOIN teams t ON t.id = m.team_id
     LEFT JOIN checkpoints c ON c.id = m.checkpoint_id
     ORDER BY m.status = 'open' DESC, m.created_at DESC`
  );
  res.json(rows);
}));

router.post('/missions', asyncHandler(async (req, res) => {
  const { teamId, checkpointId, content } = req.body || {};
  const tid = Number(teamId);
  if (!Number.isInteger(tid)) return res.status(400).json({ error: '請選擇派發對象' });

  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return res.status(400).json({ error: '請填寫任務內容' });
  if (Array.from(text).length > 200) return res.status(400).json({ error: '任務內容最多 200 個字' });

  const { rows: teamRows } = await db.query('SELECT id FROM teams WHERE id = $1', [tid]);
  if (teamRows.length === 0) return res.status(404).json({ error: '找不到這支隊伍' });

  let cid = null;
  if (checkpointId !== undefined && checkpointId !== null && checkpointId !== '') {
    cid = Number(checkpointId);
    if (!Number.isInteger(cid)) return res.status(400).json({ error: '接受點位不正確' });
    const { rows: cpRows } = await db.query('SELECT id FROM checkpoints WHERE id = $1', [cid]);
    if (cpRows.length === 0) return res.status(404).json({ error: '找不到這個據點' });
  }

  // 未結案的任務之間解鎖碼不能重複（DB 有 partial unique index 擋著）。
  // 六碼 32 進位撞號機率極低，但真的撞到就重抽，不要把錯誤丟給使用者。
  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    try {
      const { rows } = await db.query(
        `INSERT INTO missions (team_id, checkpoint_id, content, unlock_code, created_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, team_id, checkpoint_id, content, unlock_code, status, created_at`,
        [tid, cid, text, generateUnlockCode(), req.admin.sub]
      );
      row = rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  if (!row) return res.status(500).json({ error: '解鎖碼產生失敗，請再試一次' });

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'create_mission', 'mission', $2, NULL, $3)`,
    [req.admin.sub, String(row.id), JSON.stringify({ teamId: tid, checkpointId: cid })]
  );

  res.status(201).json(row);
}));

// 取消任務（派錯對象、內容打錯）。已結案的不能取消，那會讓積分憑空消失。
router.post('/missions/:id/cancel', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE missions SET status = 'cancelled'
     WHERE id = $1 AND status = 'open' RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(409).json({ error: '這個任務不存在，或已經結案/取消了' });
  }
  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'cancel_mission', 'mission', $2, NULL, NULL)`,
    [req.admin.sub, String(req.params.id)]
  );
  res.json({ ok: true });
}));

// 各隊積分（六級權重明細＋名次）。大螢幕與後台都用這一支。
// 不需要登入的版本另外掛在 app.js 上（大螢幕沒有帳號）。
router.get('/scores', asyncHandler(async (req, res) => {
  res.json(await computeScores());
}));

// 管理員專用地圖位置。玩家端的地圖刻意匿名；主辦查現場狀況時才需要隊名與陣營，
// 因此這支只開給完整管理員，且不共用玩家的公開／匿名 API。
router.get('/map/locations', requireFullAdmin, asyncHandler(async (req, res) => {
  const locations = getAllLocations();
  const teamIds = [...new Set(locations.map(p => p.teamId).filter(Number.isInteger))];
  if (!teamIds.length) return res.json([]);

  const { rows } = await db.query(
    `SELECT t.id, t.team_number, t.faction,
            (SELECT p.display_name FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS name
     FROM teams t WHERE t.id = ANY($1::int[])`,
    [teamIds]
  );
  const teamsById = new Map(rows.map(t => [t.id, t]));
  res.json(locations.flatMap(location => {
    const team = teamsById.get(location.teamId);
    return team ? [{
      teamId: team.id,
      teamNumber: team.team_number,
      name: team.name,
      faction: team.faction,
      lat: location.lat,
      lng: location.lng,
      updatedAt: location.updatedAt,
      live: location.live
    }] : [];
  }));
}));

// 現場人工補分／扣分。只能由完整管理員操作，且必須留下理由與稽核紀錄；分數不是
// 直接覆寫，而是寫入流水帳，避免下一次排行榜重算時補分消失。
router.post('/scores/:teamId/adjustments', requireFullAdmin, asyncHandler(async (req, res) => {
  const teamId = Number(req.params.teamId);
  const { delta, reason } = req.body || {};
  const amount = Number(delta);
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (!Number.isInteger(teamId) || teamId <= 0) {
    return res.status(400).json({ error: '隊伍編號不正確' });
  }
  if (!Number.isInteger(amount) || amount === 0 || amount < -1000 || amount > 1000) {
    return res.status(400).json({ error: '調整分數必須是 -1000 到 1000 之間、且不可為 0 的整數' });
  }
  if (Array.from(note).length < 1 || Array.from(note).length > 100) {
    return res.status(400).json({ error: '請填寫 1 到 100 個字的調整原因' });
  }

  const client = await db.connect();
  let adjustment;
  try {
    await client.query('BEGIN');
    const { rows: teamRows } = await client.query(
      `SELECT t.id, t.team_number,
              (SELECT p.display_name FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS name
       FROM teams t WHERE t.id = $1 FOR UPDATE`,
      [teamId]
    );
    if (teamRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到這支隊伍' });
    }
    const { rows } = await client.query(
      `INSERT INTO score_adjustments (team_id, delta, reason, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, team_id, delta, reason, created_at`,
      [teamId, amount, note, req.admin.sub]
    );
    adjustment = { ...rows[0], teamNumber: teamRows[0].team_number, name: teamRows[0].name };
    await client.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
       VALUES ($1, 'manual_score_adjustment', 'team', $2, NULL, $3)`,
      [req.admin.sub, String(teamId), JSON.stringify({ delta: amount, reason: note })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  getIO().emit('scores:update');
  res.status(201).json({ adjustment, scores: await computeScores() });
}));

router.get('/teams', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.faction, t.team_number, t.pk_points,
            (SELECT p.display_name FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS name
     FROM teams t ORDER BY t.id`
  );
  res.json(rows);
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

  // 先只讀第一行，確認這份檔案的欄位對不對。
  //
  // 不先擋的話，格式完全不同的檔案（拿錯檔、Excel 直接存成 .csv 但欄名不一樣、
  // 甚至不是 CSV）會一路跑到逐列驗證，然後每一列都回報「題目為空」——那個訊息
  // 是對的但完全沒有幫助，使用者只會覺得「我的題目明明有填」。真正的問題是
  // 整份檔案的格式不對，要在這裡就講清楚。
  let header;
  try {
    const headerParser = parse(req.file.buffer, {
      to_line: 1, trim: true, bom: true, relax_column_count: true
    });
    header = [];
    for await (const row of headerParser) header = row;
  } catch (err) {
    return res.status(400).json({
      error: '檔案格式有誤：這份檔案無法當成 CSV 讀取。',
      hint: '請確認上傳的是 UTF-8 編碼的 .csv 檔（Excel 請用「另存新檔 → CSV UTF-8」），不是 .xlsx 或其他格式。'
    });
  }

  if (header.length === 0) {
    return res.status(400).json({
      error: '檔案格式有誤：檔案是空的，讀不到標題列。',
      hint: '請確認上傳的檔案內容沒有被清空，第一行必須是欄位名稱。'
    });
  }

  // 編碼不對要單獨講。
  //
  // Excel 繁中版另存 CSV 時很容易存成 Big5，那份檔案用 UTF-8 讀進來，每個中文字
  // 都會變成 U+FFFD（替換字元）。這種情況下欄名當然對不上，但如果只回「缺少必要
  // 欄位」，訊息裡還會附上一串亂碼給使用者看——他看到的是「我欄位明明就有啊」，
  // 完全猜不到真正要做的是換一種編碼另存。
  if (header.some(h => typeof h === 'string' && h.includes('\uFFFD'))) {
    return res.status(400).json({
      error: '檔案格式有誤：檔案的文字編碼不是 UTF-8（中文變成亂碼）。',
      hint: 'Excel 請用「另存新檔 → CSV UTF-8（逗號分隔）」，不要用一般的「CSV（逗號分隔）」，' +
            '後者在繁體中文版存出來是 Big5，中文會全部讀不出來。'
    });
  }

  // 這六欄一定要有。關卡ID/PK 和 秒數 是選填（不填分別代表「通用題」和「10 秒」），
  // 所以 PK 專用的範例檔只有六欄也能匯入。
  const REQUIRED_COLUMNS = ['題目', '選項A', '選項B', '選項C', '選項D', '正確選項'];
  const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c));
  if (missing.length > 0) {
    return res.status(400).json({
      error: `檔案格式有誤：缺少必要欄位「${missing.join('」「')}」。`,
      hint: `這份檔案的第一行讀到的欄位是：${header.map(h => h || '(空白)').join('、')}。` +
            `必要欄位為「${REQUIRED_COLUMNS.join('」「')}」，另可選填「關卡ID/PK」與「秒數」。` +
            '可以直接下載頁面上的範例 CSV 對照。'
    });
  }

  const { rows: checkpoints } = await db.query('SELECT id FROM checkpoints');
  const checkpointIds = new Set(checkpoints.map(c => c.id));

  const result = { inserted: 0, failed: [] };

  // relax_column_count：某一列的欄位數跟標題不一樣時，不要整份中止。
  //
  // 沒有這個選項的話，csv-parse 會直接丟 CSV_RECORD_INCONSISTENT_COLUMNS，例外
  // 一路穿出這支 handler，前端只看到「500 internal server error」——完全看不出
  // 是自己的檔案第幾列有問題。而這是最常見的匯入失敗原因：題目或選項裡打了逗號
  // 卻沒有用雙引號括起來，那一列就會多出一欄。
  //
  // info: true 讓每一列附帶 info.error，這樣「哪一列格式不對」還是報得出來，
  // 只是變成跟其他驗證錯誤一樣逐列列出，其餘正常的列照樣匯入。
  const parser = parse(req.file.buffer, {
    columns: true, skip_empty_lines: true, trim: true, bom: true,
    relax_column_count: true, info: true
  });

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

  // 基準是「這份檔案自己的標題列有幾欄」，不是寫死的 8。
  // 寫死的話，只有六欄的 PK 範例檔一旦有某列出錯，會回報「應該 8 欄」——
  // 那個數字跟使用者手上的檔案對不起來，只會更混亂。
  const EXPECTED_COLUMNS = header.length;

  try {
    for await (const entry of parser) {
      // info: true 之後每一項是 { record, info }，不再是 record 本身。
      // 用 info.lines 當列號，不要自己數——欄位裡若有被雙引號包住的換行，
      // 自己累加的計數會跟使用者在 Excel 裡看到的列號對不上。
      const { record, info } = entry;
      const rowNumber = info.lines;

      if (info.error && info.error.code === 'CSV_RECORD_INCONSISTENT_COLUMNS') {
        // 欄位數要從 info.error.record 這個原始陣列數，不能數 record 的 key：
        // columns:true 會把多出來的值直接丟掉，所以多一欄的時候 Object.keys()
        // 仍然是 8，訊息會變成沒有意義的「應該 8 欄，這一列是 8 欄」。
        const got = Array.isArray(info.error.record)
          ? info.error.record.length : Object.keys(record).length;
        const extra = got > EXPECTED_COLUMNS
          ? '最常見的原因是題目或選項裡有逗號卻沒有用雙引號「"」括起來。'
          : '這一列的欄位少了，請對照範例檔補齊。';
        result.failed.push({
          row: rowNumber,
          reason: `第 ${rowNumber} 列：欄位數不對（應該 ${EXPECTED_COLUMNS} 欄，這一列是 ${got} 欄）。${extra}`
        });
        continue;
      }

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
  } catch (err) {
    // 走到這裡代表整份檔案在這個位置就解析不下去了（例如雙引號沒有成對關好，
    // 剖析器無法判斷這個欄位到哪裡結束），不是某一列的資料問題。
    //
    // 這種情況一定要回 4xx 而不是讓它變成 500：檔案是使用者上傳的，錯在檔案，
    // 訊息要講得出「第幾行、什麼問題」，不然對方只會拿到一句 internal server
    // error，完全無從修起。
    if (err && typeof err.code === 'string' && err.code.startsWith('CSV_')) {
      await flushBatch(); // 出錯之前已經驗過的那些照樣寫進去，不要一起丟掉
      return res.status(400).json({
        error: `CSV 檔案解析失敗（第 ${err.lines || '?'} 行附近）：${err.message}`,
        hint: err.code === 'CSV_QUOTE_NOT_CLOSED'
          ? '有一個雙引號沒有成對關好。欄位內容若含逗號、換行或雙引號，整個欄位要用雙引號括起來，內容裡的雙引號則要寫成兩個（""）。'
          : '請確認檔案是 UTF-8 編碼的標準 CSV，欄位順序與範例檔一致。',
        inserted: result.inserted,
        failed: result.failed
      });
    }
    throw err; // 不是 CSV 的問題（例如資料庫掛了）就照原本的方式往上拋
  }

  await flushBatch();

  res.json(result);
}));

router.get('/game/state', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${GAME_STATE_COLUMNS} FROM game_state WHERE id = 1`
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
     RETURNING ${GAME_STATE_COLUMNS}`,
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
     RETURNING ${GAME_STATE_COLUMNS}`,
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
     RETURNING ${GAME_STATE_COLUMNS}`,
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

// 最終審判階段：開放/關閉內鬼指認投票。
//
// 跟「遊戲結束」是分開的兩件事——企劃寫「遊戲結束前進入最終審判階段」，
// 所以投票是在遊戲還沒收掉之前開的，主辦要能各自控制。
router.post('/game/open-voting', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE game_state
     SET voting_unlocked_at = COALESCE(voting_unlocked_at, now()), voting_closed_at = NULL
     WHERE id = 1
     RETURNING ${GAME_STATE_COLUMNS}`
  );
  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'open_voting', 'game_state', '1', NULL, NULL)`, [req.admin.sub]
  );
  getIO().emit('game:state', rows[0]);
  res.json(rows[0]);
}));

router.post('/game/close-voting', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE game_state SET voting_closed_at = now() WHERE id = 1
     RETURNING ${GAME_STATE_COLUMNS}`
  );
  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'close_voting', 'game_state', '1', NULL, NULL)`, [req.admin.sub]
  );
  getIO().emit('game:state', rows[0]);
  res.json(rows[0]);
}));

// 要指認幾支。企劃是 3，但隊伍數本來就可調，這個也跟著可調。
router.patch('/game/spy-vote-count', asyncHandler(async (req, res) => {
  const n = Number((req.body || {}).spyVoteCount);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    return res.status(400).json({ error: '指認數量必須是 1 到 20 之間的整數' });
  }
  const { rows } = await db.query(
    `UPDATE game_state SET spy_vote_count = $1 WHERE id = 1
     RETURNING ${GAME_STATE_COLUMNS}`,
    [n]
  );
  res.json(rows[0]);
}));

// 投票結果：誰投了誰、猜中幾支、還有哪幾隊沒投。
// 這支只有管理端看得到——投票還開著的時候公開票數等於互相通風報信。
router.get('/votes', asyncHandler(async (req, res) => {
  const { rows: teams } = await db.query(
    `SELECT t.id, t.faction, t.team_number,
            (SELECT p.display_name FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS name
     FROM teams t ORDER BY t.id`
  );
  const { rows: votes } = await db.query(
    `SELECT v.voter_team_id, v.suspect_team_id, s.faction AS suspect_faction
     FROM spy_votes v JOIN teams s ON s.id = v.suspect_team_id`
  );
  const nameOf = Object.fromEntries(teams.map(t => [t.id, t.name || ('#' + t.team_number)]));

  const byVoter = {};
  votes.forEach(v => {
    (byVoter[v.voter_team_id] = byVoter[v.voter_team_id] || []).push({
      teamId: v.suspect_team_id, name: nameOf[v.suspect_team_id], correct: v.suspect_faction === 'disrupt'
    });
  });

  const suspicion = {};
  votes.forEach(v => { suspicion[v.suspect_team_id] = (suspicion[v.suspect_team_id] || 0) + 1; });

  res.json({
    // 這裡回傳真實陣營：投票結束後主辦要據此公布內鬼身分。
    teams: teams.map(t => ({
      teamId: t.id, name: nameOf[t.id], faction: t.faction,
      isSpy: t.faction === 'disrupt',
      votesReceived: suspicion[t.id] || 0,
      voted: (byVoter[t.id] || []).length > 0,
      picks: byVoter[t.id] || [],
      correctCount: (byVoter[t.id] || []).filter(p => p.correct).length
    }))
  });
}));

// 幾支破壞者（內鬼）。企劃是 3 支，但隊伍數可調，這個也跟著可調。
router.patch('/game/spy-team-count', asyncHandler(async (req, res) => {
  const n = Number((req.body || {}).spyTeamCount);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    return res.status(400).json({ error: '破壞者隊伍數必須是 1 到 20 之間的整數' });
  }
  const { rows } = await db.query(
    `UPDATE game_state SET spy_team_count = $1 WHERE id = 1 RETURNING ${GAME_STATE_COLUMNS}`,
    [n]
  );
  res.json(rows[0]);
}));

// 開始遊戲，同時抽陣營。
//
// 抽籤放在這裡而不是登入時：登入時分配等於「報到順序決定身分」，而且新隊伍一支
// 一支進來時只能各分一半，做不出「固定 3 支內鬼」。企劃要的是開賽當下一次決定。
//
// 每次開始都重抽（不是只有第一次）——主辦重跑一場、或是重啟遊戲之後再開始，
// 身分就該重新洗牌，不然玩家上一場已經知道誰是內鬼了。
router.post('/game/start', asyncHandler(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE：兩個主辦同時按「開始遊戲」的話，沒有鎖會抽兩次，第二次的
    // 結果覆蓋第一次，已經看過彈窗的隊伍身分會無聲換掉。
    const { rows: current } = await client.query(
      'SELECT status, spy_team_count FROM game_state WHERE id = 1 FOR UPDATE'
    );
    if (current[0].status === 'in_progress') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '遊戲已經在進行中了' });
    }

    const spyCount = current[0].spy_team_count;
    const { rows: teamRows } = await client.query('SELECT id FROM teams ORDER BY id');

    // 至少要留一支好人：全部都是內鬼的話沒有人能投票，第三權重直接算不出來，
    // 遊戲本身也不成立。擋在這裡並把數字講清楚，不要抽完才發現。
    if (teamRows.length < spyCount + 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `目前只有 ${teamRows.length} 支隊伍，要抽 ${spyCount} 支破壞者至少需要 ${spyCount + 1} 支` +
               '（要留下至少一支時空保衛隊）。請先讓隊伍登入，或調低破壞者隊伍數。'
      });
    }

    // Fisher-Yates 洗牌後取前 N 支。用 crypto 而不是 Math.random：這是決定
    // 玩家身分的抽籤，沒必要用一個可預測的 PRNG。
    const ids = teamRows.map(r => r.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const spies = ids.slice(0, spyCount);

    // 先全部歸位成好人再指定內鬼，這樣重抽時上一場的內鬼一定會被清掉。
    await client.query(`UPDATE teams SET faction = 'repair'`);
    await client.query(
      `UPDATE teams SET faction = 'disrupt' WHERE id = ANY($1::int[])`, [spies]
    );

    const { rows } = await client.query(
      `UPDATE game_state
       SET status = 'in_progress', started_at = now(), ended_at = NULL, faction_drawn_at = now()
       WHERE id = 1 RETURNING ${GAME_STATE_COLUMNS}`
    );

    await client.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
       VALUES ($1, 'draw_factions', 'game_state', '1', NULL, $2)`,
      [req.admin.sub, JSON.stringify({ spyTeamIds: spies, teamCount: ids.length })]
    );

    await client.query('COMMIT');

    // 已經登入著的玩家不會自己知道抽籤發生了。廣播一個不帶身分的通知，讓每一台
    // 去打自己的 /api/auth/me 拿「自己的」陣營——這裡絕對不能直接把名單廣播出去。
    getIO().emit('game:state', rows[0]);
    getIO().emit('faction:drawn', { drawnAt: rows[0].faction_drawn_at });

    res.json({ ...rows[0], spyTeamCount: spyCount, teamCount: ids.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/game/end', asyncHandler(async (req, res) => {
  const { rows: current } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (current[0].status !== 'in_progress') {
    return res.status(409).json({ error: 'game is not in progress' });
  }

  const { rows } = await db.query(
    `UPDATE game_state SET status = 'ended', ended_at = now()
     WHERE id = 1 RETURNING ${GAME_STATE_COLUMNS}`
  );
  getIO().emit('game:state', rows[0]);
  res.json(rows[0]);
}));

// 一鍵重啟遊戲：把整場打回開賽前的狀態。
//
// 刪掉的是「這一場產生的東西」——隊伍、玩家、關卡紀錄、PK、任務、筆記、投票，
// 據點進度歸零。留下的是「設定」——據點本身、題庫、管理員/關主帳號，以及
// admin_actions 稽核紀錄（那是誰在什麼時候做了什麼的帳，重啟不該把它抹掉，
// 這次重啟本身也會記一筆進去）。
//
// 要求在 body 帶 confirm: 'RESET'：這是不可復原的操作，而且「重啟遊戲」按鈕
// 就在「開始遊戲」旁邊，光靠瀏覽器的 confirm 對話框不夠——誤按一次就是整場資料沒了。
router.post('/game/reset', requireFullAdmin, asyncHandler(async (req, res) => {
  if ((req.body || {}).confirm !== 'RESET') {
    return res.status(400).json({ error: '重啟遊戲需要確認，請在請求中帶 confirm: "RESET"' });
  }

  const client = await db.connect();
  let stats;
  try {
    await client.query('BEGIN');

    // 刪除順序＝外鍵的相反方向：先刪指向別人的，再刪被指的。
    // 目前的外鍵是 spy_votes/checkpoint_notes/team_notes/missions/checkpoint_attempts -> teams、
    // pk_duel_answers -> pk_duels -> players -> teams。
    const counts = {};
    for (const [key, sql] of [
      ['spy_votes', 'DELETE FROM spy_votes'],
      ['score_adjustments', 'DELETE FROM score_adjustments'],
      ['checkpoint_notes', 'DELETE FROM checkpoint_notes'],
      ['team_notes', 'DELETE FROM team_notes'],
      ['missions', 'DELETE FROM missions'],
      ['pk_duel_answers', 'DELETE FROM pk_duel_answers'],
      ['pk_duels', 'DELETE FROM pk_duels'],
      ['checkpoint_attempts', 'DELETE FROM checkpoint_attempts'],
      ['players', 'DELETE FROM players'],
      ['teams', 'DELETE FROM teams']
    ]) {
      const { rowCount } = await client.query(sql);
      counts[key] = rowCount;
    }

    // 刻意「不」重設 teams_id_seq / players_id_seq。
    //
    // 一開始有加，想讓重啟後的 id 也從 1 開始好看。實測發現那會開一個洞：舊的
    // JWT 裡帶著 teamId=1 / sub=1，重啟後新登入的第一支隊伍剛好又拿到 id 1，
    // 那張本該失效的 token 就直接變成新隊伍的有效憑證——測出來 /api/auth/me
    // 回 200，顯示的是舊隊名配新隊伍的資料。兩支不同的隊伍會共用同一個身分。
    //
    // 不重設的話，被刪掉的 id 不會再被發出去，舊 token 查不到隊伍就會拿到 401
    // 被踢回登入頁（見 routes/auth.js 的 /me）。
    //
    // 玩家看到的「隊伍 #N」用的是 team_number 不是 id，而 team_number 是
    // MAX(team_number)+1 算出來的——表清空之後本來就會從 1 開始，不靠 sequence。
    const { rowCount: cpCount } = await client.query(
      'UPDATE checkpoints SET progress = 0, updated_at = now() WHERE progress <> 0'
    );
    counts.checkpoints_reset = cpCount;

    const { rows } = await client.query(
      `UPDATE game_state
       SET status = 'not_started', started_at = NULL, ended_at = NULL,
           voting_unlocked_at = NULL, voting_closed_at = NULL,
           faction_drawn_at = NULL
       WHERE id = 1 RETURNING ${GAME_STATE_COLUMNS}`
    );

    await client.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
       VALUES ($1, 'reset_game', 'game_state', '1', $2, NULL)`,
      [req.admin.sub, JSON.stringify(counts)]
    );

    await client.query('COMMIT');
    stats = { counts, state: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // DB 清乾淨了，記憶體裡的 PK 狀態也要跟著清——那些 session 和房號還活著的話，
  // 會繼續指向已經被刪掉的隊伍與對戰。放在交易外面：交易一旦 rollback，這裡就
  // 不該把還有效的對戰砍掉。
  const cancelledSessions = pkSession.clearAll();
  const clearedRooms = roomRegistry.clearAll();

  console.log(`[reset] 重啟遊戲 by admin=${req.admin.sub}`,
    JSON.stringify({ ...stats.counts, cancelledSessions, clearedRooms }));

  // 各端的畫面都要跟著回到開賽前：據點進度、積分、玩家的登入狀態。
  getIO().emit('game:state', stats.state);
  getIO().emit('game:reset', {});

  res.json({ ...stats.state, deleted: { ...stats.counts, cancelledSessions, clearedRooms } });
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

// 各隊已完成 PK 的勝場數。從 teams 起算，讓還沒贏過（或還沒參加）的隊伍也會
// 出現在榜上；PK 的計分仍由對戰結算流程處理，這個端點只做統計展示。
router.get('/pk-wins', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      t.id AS team_id,
      t.team_number,
      t.faction,
      p.display_name,
      COUNT(d.id)::int AS wins
    FROM teams t
    LEFT JOIN players p ON p.team_id = t.id
    LEFT JOIN pk_duels d ON d.winner_player_id = p.id
                         AND d.status = 'completed'
    GROUP BY t.id, t.team_number, t.faction, p.id, p.display_name
    ORDER BY wins DESC, t.team_number ASC, p.display_name ASC
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

// 後台直接開一支隊伍。玩家端的 /api/auth/join 是「自己登入就開隊」，但現場常
// 需要先建好（報名名單先鍵入、或某隊手機壞掉要重開一支），所以這裡補一個入口。
//
// 一支隊伍就是一位玩家（一組一支手機），所以 teams 和 players 一起建，包在同一
// 個交易裡——只建到一半的隊伍會變成登入時查得到隊伍卻沒有玩家的孤兒資料。
router.post('/players', asyncHandler(async (req, res) => {
  const { displayName, pin, faction } = req.body || {};
  const validated = validateName(typeof displayName === 'string' ? displayName : '');
  if (validated.error) return res.status(400).json({ error: validated.error });
  if (Array.from(validated.name).length > 10) {
    return res.status(400).json({ error: '代號最多 10 個字' });
  }
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN 必須是 4 位數字' });
  }
  if (faction !== undefined && faction !== null && !['repair', 'disrupt'].includes(faction)) {
    return res.status(400).json({ error: 'faction must be repair or disrupt' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 隊伍上限跟玩家自己登入時是同一個限制，不能從後台繞過去——否則後台建的
    // 隊伍會讓場上隊數超過設定，積分與陣營分配都會失衡。
    const { rows: limitRows } = await client.query('SELECT max_teams FROM game_state WHERE id = 1');
    const maxTeams = limitRows[0]?.max_teams ?? 10;
    const { rows: countRows } = await client.query('SELECT COUNT(*)::int AS cnt FROM teams');
    if (countRows[0].cnt >= maxTeams) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `已達隊伍上限（${maxTeams} 隊），請先調高上限或刪除隊伍` });
    }

    // 沒指定陣營就先掛 repair 佔位，等主辦按「開始遊戲」時一起抽（見 /game/start）。
    // 這裡還是留 faction 參數：遊戲已經開始之後才補建的隊伍不會被抽到，主辦得能
    // 直接指定他是哪一邊。
    const side = faction || 'repair';

    // 編號全場唯一（見 migrations/015）
    const { rows: maxRows } = await client.query(
      'SELECT COALESCE(MAX(team_number), 0) + 1 AS next_number FROM teams'
    );
    const { rows: teamRows } = await client.query(
      'INSERT INTO teams (faction, team_number) VALUES ($1, $2) RETURNING id',
      [side, maxRows[0].next_number]
    );
    const { rows: playerRows } = await client.query(
      `INSERT INTO players (team_id, display_name, is_captain, pin) VALUES ($1, $2, true, $3)
       RETURNING id, display_name, is_captain, pin, created_at, team_id`,
      [teamRows[0].id, validated.name, pin]
    );

    await client.query('COMMIT');

    await db.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
       VALUES ($1, 'create_player', 'player', $2, NULL, $3)`,
      [req.admin.sub, String(playerRows[0].id),
       JSON.stringify({ displayName: validated.name, faction: side })]
    );

    res.status(201).json({ ...playerRows[0], faction: side, team_number: maxRows[0].next_number });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // display_name 有 UNIQUE：重複的代號就是重複，不要建出兩支同名隊伍。
    if (err.code === '23505') return res.status(409).json({ error: '這個代號已經有人用了' });
    throw err;
  } finally {
    client.release();
  }
}));

// 刪除一支隊伍（連同它唯一的那位玩家）。
//
// 刻意不做成 ON DELETE CASCADE：這支隊伍可能已經打過關卡、打過 PK，那些是別隊
// 的積分與名次依據（例如「PK 勝場最多」要數對戰紀錄）。連鎖刪掉會讓別隊的分數
// 無聲改變，事後也查不出為什麼。所以有留下紀錄的隊伍一律擋下來，只允許刪掉還
// 沒動作過的——現場真正會用到刪除的情境，就是「報名名單鍵錯」「多開了一支」。
router.delete('/players/:id', asyncHandler(async (req, res) => {
  const { rows: existing } = await db.query(
    `SELECT p.id, p.display_name, p.team_id, t.faction
     FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = $1`,
    [req.params.id]
  );
  if (existing.length === 0) return res.status(404).json({ error: 'player not found' });
  const player = existing[0];

  const { rows: used } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM checkpoint_attempts WHERE team_id = $1) AS attempts,
       (SELECT COUNT(*)::int FROM pk_duels WHERE host_player_id = $2 OR guest_player_id = $2) AS duels,
       (SELECT COUNT(*)::int FROM missions WHERE team_id = $1) AS missions`,
    [player.team_id, player.id]
  );
  const u = used[0];
  const hasRecords = u.attempts > 0 || u.duels > 0 || u.missions > 0;

  // 有紀錄的隊伍預設擋下來，但擋不是終點——主辦要真的刪得掉。
  //
  // 帶 ?force=1 就連紀錄一起刪。這是有代價的：這支隊伍打過的 PK 也是「對手的
  // 勝場」，刪掉會讓對手的第四權重積分往下掉。所以預設不做，錯誤訊息把數字
  // 講清楚，讓主辦自己決定要不要按下去（前端會再確認一次）。
  //
  // 正常流程其實不必用到 force：重啟遊戲會把所有紀錄清空，之後任何帳號都刪得掉。
  const force = req.query.force === '1' || (req.body || {}).force === true;
  if (hasRecords && !force) {
    return res.status(409).json({
      error: `這支隊伍已經有紀錄（關卡 ${u.attempts} 筆、PK ${u.duels} 場、任務 ${u.missions} 則），` +
             '直接刪除會讓對手的 PK 勝場跟著減少。確定要連紀錄一起刪，請再確認一次；' +
             '如果只是要讓他們登不進來，改 PIN 就好。',
      needsForce: true,
      records: { attempts: u.attempts, duels: u.duels, missions: u.missions }
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (hasRecords) {
      // 順序＝外鍵的相反方向，跟 /game/reset 同一套。
      // spy_votes 兩個方向都要清：這支隊伍投出去的票，以及別人指認它的票。
      await client.query('DELETE FROM spy_votes WHERE voter_team_id = $1 OR suspect_team_id = $1', [player.team_id]);
      await client.query('DELETE FROM missions WHERE team_id = $1', [player.team_id]);
      await client.query(
        `DELETE FROM pk_duel_answers WHERE pk_duel_id IN (
           SELECT id FROM pk_duels WHERE host_player_id = $1 OR guest_player_id = $1)`,
        [player.id]
      );
      await client.query(
        'DELETE FROM pk_duels WHERE host_player_id = $1 OR guest_player_id = $1', [player.id]
      );
      await client.query('DELETE FROM checkpoint_attempts WHERE team_id = $1', [player.team_id]);
    }

    // 筆記沒有計分意義，跟著隊伍一起走（自己的筆記與別隊對它的筆記都清掉）。
    await client.query('DELETE FROM checkpoint_notes WHERE team_id = $1', [player.team_id]);
    await client.query('DELETE FROM team_notes WHERE owner_team_id = $1 OR target_team_id = $1', [player.team_id]);
    // 用 team_id 而不是 player.id 刪玩家：一組一支手機，正常情況下這支隊伍就
    // 只有這一位玩家。萬一有第二位（舊資料），只刪一位會讓下面刪隊伍時被外鍵擋下。
    await client.query('DELETE FROM players WHERE team_id = $1', [player.team_id]);
    await client.query('DELETE FROM teams WHERE id = $1', [player.team_id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1, 'delete_player', 'player', $2, $3, NULL)`,
    [req.admin.sub, String(player.id),
     JSON.stringify({
       displayName: player.display_name, faction: player.faction,
       // 連紀錄一起刪的話一定要留下刪了什麼——事後對不上帳時，這是唯一的線索
       forced: hasRecords,
       deletedRecords: hasRecords ? { attempts: u.attempts, duels: u.duels, missions: u.missions } : null
     })]
  );

  res.status(204).end();
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
     RETURNING id, name, map_lat, map_lng, progress`,
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
