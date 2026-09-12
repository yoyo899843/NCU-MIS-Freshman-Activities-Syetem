const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { parse } = require('csv-parse');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { bankerGuard, requireAdmin } = require('../middleware/bankerGuard');
const asyncHandler = require('../middleware/asyncHandler');
const { createLoginThrottle } = require('../loginThrottle');
const { leaderboard, effectivePrices, portfolio } = require('../portfolio');

const router = express.Router();
const loginThrottle = createLoginThrottle();
// 記憶體儲存：新聞 CSV 最多幾十列，不需要落地成暫存檔。2MB 上限純粹是防手滑
// 上傳錯檔（例如整份簡報）把記憶體吃掉。
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const PHASES = ['news', 'gambling', 'deposit', 'trading', 'closed'];

async function audit(adminId, type, targetType, targetId, before, after) {
  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [adminId, type, targetType, targetId == null ? null : String(targetId),
     before == null ? null : JSON.stringify(before),
     after == null ? null : JSON.stringify(after)]
  );
}

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email 與密碼都要填' });
  if (loginThrottle.isLocked(email)) {
    return res.status(429).json({ error: '嘗試太多次，請稍後再試' });
  }

  const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  const user = rows[0];
  const fail = () => {
    loginThrottle.recordFailure(email);
    return res.status(401).json({ error: 'email 或密碼不正確' });
  };
  if (!user) return fail();
  if (!(await bcrypt.compare(password, user.password_hash))) return fail();
  loginThrottle.clear(email);

  // role: 'admin' 代表「這是一張管理端 token」（跟隊伍端的 'team' 區分），
  // adminRole 才是權限層級（管理員/銀行關主），兩個不要混在同一個欄位。
  const token = jwt.sign(
    { sub: user.id, email: user.email, displayName: user.display_name,
      role: 'admin', adminRole: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  res.json({ token, adminRole: user.role });
}));

router.use(adminAuth);
router.use(bankerGuard);

router.get('/me', (req, res) => {
  res.json({
    id: req.admin.sub, email: req.admin.email,
    displayName: req.admin.displayName, adminRole: req.admin.adminRole || 'admin'
  });
});

// 稽核帳的檢視入口。交易、存款與持股本身各有不可竄改的明細表；這裡記的是
// 工作人員做的審核、覆寫與市場設定操作，格式與時空戰爭一致。
router.get('/audit-logs', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT aa.id, aa.action_type, aa.target_type, aa.target_id,
           aa.before_value, aa.after_value, aa.created_at,
           au.email AS operator_email, au.display_name AS operator_name, au.role AS operator_role
    FROM admin_actions aa
    LEFT JOIN admin_users au ON au.id = aa.admin_user_id
    ORDER BY aa.created_at DESC, aa.id DESC
    LIMIT 500
  `);
  res.json(rows);
}));

/* ---------------- 遊戲進程 ---------------- */

router.get('/state', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT wave, total_waves, phase FROM game_state WHERE id = 1');
  res.json(rows[0]);
}));

// 切換階段/波次。四階段的順序是企劃定死的，這裡不強制照順序推進——
// 現場常常要倒回上一階段（例如新聞打錯字要重發），寫死順序反而卡住主辦。
router.patch('/state', requireAdmin, asyncHandler(async (req, res) => {
  const { wave, phase } = req.body || {};
  const { rows: before } = await db.query('SELECT wave, total_waves, phase FROM game_state WHERE id = 1');

  const nextWave = wave === undefined ? before[0].wave : Number(wave);
  const nextPhase = phase === undefined ? before[0].phase : phase;

  if (!Number.isInteger(nextWave) || nextWave < 1 || nextWave > before[0].total_waves) {
    return res.status(400).json({ error: `波次必須是 1 到 ${before[0].total_waves}` });
  }
  if (!PHASES.includes(nextPhase)) {
    return res.status(400).json({ error: '階段不正確' });
  }

  const { rows } = await db.query(
    'UPDATE game_state SET wave = $1, phase = $2 WHERE id = 1 RETURNING wave, total_waves, phase',
    [nextWave, nextPhase]
  );
  await audit(req.admin.sub, 'update_state', 'game_state', 1, before[0], rows[0]);
  res.json(rows[0]);
}));

// 遊戲重置只清掉「本局資料」，帳號本身（隊名／PIN、主辦與銀行關主）必須保留，
// 才不用在下一場重新建帳。確認字串也在伺服器再次驗證，不能只靠前端按鈕防呆。
router.post('/reset', requireAdmin, asyncHandler(async (req, res) => {
  if ((req.body || {}).confirmation !== 'RESET') {
    return res.status(400).json({ error: '請輸入 RESET 以確認重置遊戲' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const [{ rows: stateRows }, { rows: countRows }] = await Promise.all([
      client.query('SELECT wave, total_waves, phase FROM game_state WHERE id = 1'),
      client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM news) AS news,
           (SELECT COUNT(*)::int FROM deposits) AS deposits,
           (SELECT COUNT(*)::int FROM trades) AS trades,
           (SELECT COUNT(*)::int FROM holdings WHERE shares > 0) AS holdings,
           (SELECT COUNT(*)::int FROM stock_prices) AS prices,
           (SELECT COUNT(*)::int FROM teams) AS teams,
           (SELECT COUNT(*)::int FROM admin_users) AS admins`
      )
    ]);

    // 不刪 teams 或 admin_users：隊伍 PIN 與工作人員帳號是跨局設定。
    await client.query('TRUNCATE TABLE trades, deposits, holdings, news, stock_prices, admin_actions RESTART IDENTITY');
    await client.query('UPDATE teams SET cash = 0');
    await client.query('UPDATE stocks SET initial_price = 100');
    const { rows: afterState } = await client.query(
      "UPDATE game_state SET wave = 1, phase = 'news' WHERE id = 1 RETURNING wave, total_waves, phase"
    );

    // 稽核表剛被清空，因此這會成為新一局保留下來的第一筆管理紀錄。
    await client.query(
      `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, before_value, after_value)
       VALUES ($1, 'reset_game', 'game_state', '1', $2, $3)`,
      [req.admin.sub,
       JSON.stringify({ state: stateRows[0], cleared: countRows[0] }),
       JSON.stringify({ state: afterState[0], initialPrice: 100, preserved: { teams: countRows[0].teams, admins: countRows[0].admins } })]
    );
    await client.query('COMMIT');
    res.json({ ok: true, state: afterState[0], preserved: { teams: countRows[0].teams, admins: countRows[0].admins } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ---------------- 新聞 ---------------- */

router.get('/news', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, wave, title, body, published_at FROM news ORDER BY wave DESC, id DESC'
  );
  res.json(rows);
}));

router.post('/news', requireAdmin, asyncHandler(async (req, res) => {
  const { wave, title, body } = req.body || {};
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) return res.status(400).json({ error: '請填寫新聞標題' });

  const { rows: st } = await db.query('SELECT wave, total_waves FROM game_state WHERE id = 1');
  const w = wave === undefined ? st[0].wave : Number(wave);
  if (!Number.isInteger(w) || w < 1 || w > st[0].total_waves) {
    return res.status(400).json({ error: `波次必須是 1 到 ${st[0].total_waves}` });
  }

  const { rows } = await db.query(
    'INSERT INTO news (wave, title, body) VALUES ($1,$2,$3) RETURNING id, wave, title, body, published_at',
    [w, t, typeof body === 'string' ? body.trim() : '']
  );
  await audit(req.admin.sub, 'create_news', 'news', rows[0].id, null, { wave: w, title: t });
  res.status(201).json(rows[0]);
}));

router.delete('/news/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM news WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: '找不到這則新聞' });
  await audit(req.admin.sub, 'delete_news', 'news', req.params.id, null, null);
  res.status(204).end();
}));

/* ---------------- 新聞匯入／匯出 ---------------- */

// 新聞是活動前就寫好的稿：三波 × 四間公司的利多利空，大多在 Excel 裡排版、校稿、
// 給企劃確認。之前只能一則一則在後台貼上去，改一個錯字要重新找到那一列。
// 匯出／匯入把那份 Excel 直接當成資料來源，順便也是一份可以帶走的備份。
//
// 欄位順序與名稱兩邊共用同一份定義，匯出的檔案必然能再匯回來。
const NEWS_CSV_COLUMNS = ['波次', '標題', '內文', '發布時間'];
const NEWS_CSV_REQUIRED_COLUMNS = ['標題'];

// 時間一律以台北時間呈現與解讀。
//
// 容器沒有設 TZ，所以伺服器的本地時間是 UTC，但後台表格是用瀏覽器的
// toLocaleString() 畫的（現場的機器都在台灣）。如果匯出直接吐 UTC，同一則新聞
// 在畫面上和在 Excel 裡會差八小時，校稿的人會以為資料錯了。
const NEWS_CSV_TZ = 'Asia/Taipei';

// 匯出用的極簡 CSV 組字器。只有這裡要用，不值得為它再拉一個 csv-stringify 進來。
// 三件事必須做對：含逗號／雙引號／換行的欄位整欄用雙引號包起來、內容裡的雙引號
// 寫成兩個、行尾用 CRLF（Excel 對只有 LF 的檔案相容性較差）。
function toCsvRow(values) {
  return values.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

// 匯出。順序用「波次由小到大」而不是後台列表的由大到小：在 Excel 裡讀的人是
// 照活動流程從第 1 波看下來的。
router.get('/news/export', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT wave, title, body,
            to_char(published_at AT TIME ZONE $1::text, 'YYYY-MM-DD HH24:MI:SS') AS published_local
     FROM news ORDER BY wave, id`,
    [NEWS_CSV_TZ]
  );
  // 檔名的時間戳也交給資料庫算，理由同上（伺服器本地時間是 UTC），而且
  // node:alpine 的 ICU 資料不保證完整，不能倚賴 Node 這邊的時區轉換。
  const { rows: stampRows } = await db.query(
    `SELECT to_char(now() AT TIME ZONE $1::text, 'YYYYMMDD-HH24MI') AS stamp`, [NEWS_CSV_TZ]
  );

  const lines = [toCsvRow(NEWS_CSV_COLUMNS)];
  for (const r of rows) lines.push(toCsvRow([r.wave, r.title, r.body, r.published_local]));

  const filename = `news-${stampRows[0].stamp}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent('新聞-' + stampRows[0].stamp + '.csv')}`);
  // 開頭的 BOM 不能省。少了它，繁中版 Excel 會把 UTF-8 當成 Big5 讀，
  // 打開來整份都是亂碼——而使用者第一個念頭會是「系統匯出壞了」。
  res.send('\uFEFF' + lines.join('\r\n') + (lines.length > 1 ? '\r\n' : ''));
}));

// 「發布時間」欄接受 2026-09-13 09:30:00，也接受 Excel 常見的 2026/9/13 9:30。
// 時間可省略（當天 00:00:00），整欄留空就用匯入當下的時間。
const NEWS_DATETIME_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

// 回傳 'YYYY-MM-DD HH:MI:SS' 字串（台北時間，由 SQL 端轉成 timestamptz）。
//
// 這裡自己驗一次日期真偽（2026-02-30、25 點這種），不是多餘的防禦：交給 Postgres
// 擋的話會在 INSERT 時丟例外，而寫入是每 20 筆一個交易，一格打錯會讓那一整批
// 20 則新聞全部進不去。錯在哪一列要在驗證階段就講清楚。
function parseNewsDateTime(raw) {
  const m = NEWS_DATETIME_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)];
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d
      || probe.getUTCHours() !== h || probe.getUTCMinutes() !== mi || probe.getUTCSeconds() !== s) {
    return null;
  }
  const p2 = n => String(n).padStart(2, '0');
  return `${y}-${p2(mo)}-${p2(d)} ${p2(h)}:${p2(mi)}:${p2(s)}`;
}

function validateNewsCsvRow(record, rowNumber, currentWave, totalWaves) {
  const title = (record['標題'] || '').trim();
  if (!title) return { error: `第 ${rowNumber} 列：標題為空` };

  const waveRaw = (record['波次'] || '').trim();
  const wave = waveRaw ? Number(waveRaw) : currentWave;
  if (!Number.isInteger(wave) || wave < 1 || wave > totalWaves) {
    return { error: `第 ${rowNumber} 列：波次「${waveRaw}」不正確，必須是 1 到 ${totalWaves} 的整數（留空代表目前第 ${currentWave} 波）` };
  }

  const publishedAtRaw = (record['發布時間'] || '').trim();
  let publishedAt = null;
  if (publishedAtRaw) {
    publishedAt = parseNewsDateTime(publishedAtRaw);
    if (!publishedAt) {
      return { error: `第 ${rowNumber} 列：發布時間「${publishedAtRaw}」看不懂，格式請用 2026-09-13 09:30:00（時間可省略），或整欄留空` };
    }
  }

  return { data: { wave, title, body: (record['內文'] || '').trim(), publishedAt } };
}

// multer 自己的錯誤（最常見的是超過 2MB）預設會一路往上拋，最後被 app.js 的錯誤
// 處理器吞成 500，使用者只看到 internal server error，猜不到問題在自己的檔案。
function uploadNewsCsv(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        error: err.code === 'LIMIT_FILE_SIZE'
          ? '檔案太大（上限 2MB）。新聞 CSV 不會有這個大小，請確認是不是選錯檔案。'
          : `檔案上傳失敗：${err.message}`,
        hint: '請上傳單一個 .csv 檔（表單欄位名稱為 file）。'
      });
    }
    next(err);
  });
}

// 匯入是「附加」，不會清掉或覆蓋既有新聞——同一份檔案上傳兩次就會有兩份。
// 這是刻意的：覆蓋式匯入一旦誤按就把校稿好的稿子全刪了，而重複的那幾則在列表上
// 一眼看得到、單筆刪掉就好。
router.post('/news/import', requireAdmin, uploadNewsCsv, asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇要上傳的 CSV 檔案（表單欄位名稱：file）' });

  // 先只讀第一行確認欄位對不對。不先擋的話，格式完全不同的檔案會一路跑到逐列
  // 驗證，然後每一列都回報「標題為空」——訊息是對的但毫無幫助，使用者只會覺得
  // 「我標題明明有填」。真正的問題是整份檔案的欄位不對，要在這裡就講清楚。
  let header;
  try {
    const headerParser = parse(req.file.buffer, { to_line: 1, trim: true, bom: true, relax_column_count: true });
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
      hint: '第一行必須是欄位名稱，可以直接下載頁面上的範例 CSV 對照。'
    });
  }

  // Excel 繁中版另存 CSV 很容易存成 Big5，那份檔案用 UTF-8 讀進來每個中文字都會
  // 變成 U+FFFD。這種情況若只回「缺少必要欄位」，訊息裡還會附上一串亂碼，
  // 使用者完全猜不到真正該做的是換一種編碼另存。
  if (header.some(h => typeof h === 'string' && h.includes('\uFFFD'))) {
    return res.status(400).json({
      error: '檔案格式有誤：檔案的文字編碼不是 UTF-8（中文變成亂碼）。',
      hint: 'Excel 請用「另存新檔 → CSV UTF-8（逗號分隔）」，不要用一般的「CSV（逗號分隔）」，' +
            '後者在繁體中文版存出來是 Big5，中文會全部讀不出來。'
    });
  }

  // csv-parse 5.x 的 columns 路徑有一個原型汙染的已知問題（GHSA-8cw4-87c7-c6xx），
  // 觸發條件是欄名叫 __proto__ 這類名字。修掉它要升到 7.x（跨大版本，另外兩個
  // 系統也都還在 5.x），所以在這裡先把那幾個欄名擋掉——正常的新聞檔不會有這種欄位。
  const UNSAFE_COLUMNS = ['__proto__', 'constructor', 'prototype'];
  if (header.some(h => UNSAFE_COLUMNS.includes(h))) {
    return res.status(400).json({ error: '檔案格式有誤：標題列含有不允許的欄位名稱。' });
  }

  const missing = NEWS_CSV_REQUIRED_COLUMNS.filter(c => !header.includes(c));
  if (missing.length > 0) {
    return res.status(400).json({
      error: `檔案格式有誤：缺少必要欄位「${missing.join('」「')}」。`,
      hint: `這份檔案的第一行讀到的欄位是：${header.map(h => h || '(空白)').join('、')}。` +
            `必要欄位為「${NEWS_CSV_REQUIRED_COLUMNS.join('」「')}」，另可選填「波次」「內文」「發布時間」。` +
            '可以直接下載頁面上的範例 CSV 對照。'
    });
  }

  const { rows: st } = await db.query('SELECT wave, total_waves FROM game_state WHERE id = 1');
  const currentWave = st[0].wave;
  const totalWaves = st[0].total_waves;

  const result = { inserted: 0, failed: [] };

  // relax_column_count：某一列欄位數跟標題不一樣時不要整份中止。沒有這個選項，
  // csv-parse 會丟 CSV_RECORD_INCONSISTENT_COLUMNS 穿出這支 handler，前端只看到
  // 500。而這是最常見的匯入失敗原因：標題或內文裡打了逗號卻沒有用雙引號括起來。
  // info: true 讓每列附帶 info.error 與 info.lines，改成跟其他驗證錯誤一樣逐列列出。
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
          `INSERT INTO news (wave, title, body, published_at)
           VALUES ($1, $2, $3, COALESCE($4::timestamp AT TIME ZONE $5::text, now()))`,
          [row.wave, row.title, row.body, row.publishedAt, NEWS_CSV_TZ]
        );
      }
      await client.query('COMMIT');
      result.inserted += batch.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      result.failed.push({ row: null, reason: '資料庫寫入失敗（這一批全數略過）：' + err.message });
    } finally {
      client.release();
      batch = [];
    }
  };

  // 基準是「這份檔案自己的標題列有幾欄」，不是寫死的 4。寫死的話，只填了
  // 「標題」一欄的檔案一旦有列出錯，會回報「應該 4 欄」——那個數字跟使用者
  // 手上的檔案對不起來，只會更混亂。
  const EXPECTED_COLUMNS = header.length;

  try {
    for await (const { record, info } of parser) {
      // 列號用 info.lines，不要自己累加：欄位裡若有被雙引號包住的換行（新聞內文
      // 很常換行），自己數的號碼會跟使用者在 Excel 裡看到的列號對不上。
      const rowNumber = info.lines;

      if (info.error && info.error.code === 'CSV_RECORD_INCONSISTENT_COLUMNS') {
        // 欄位數要數 info.error.record 這個原始陣列。columns:true 會把多出來的值
        // 直接丟掉，數 Object.keys(record) 會得到「應該 4 欄，這一列是 4 欄」。
        const got = Array.isArray(info.error.record) ? info.error.record.length : Object.keys(record).length;
        result.failed.push({
          row: rowNumber,
          reason: `第 ${rowNumber} 列：欄位數不對（應該 ${EXPECTED_COLUMNS} 欄，這一列是 ${got} 欄）。` +
            (got > EXPECTED_COLUMNS
              ? '最常見的原因是標題或內文裡有逗號卻沒有用雙引號「"」括起來。'
              : '這一列的欄位少了，請對照範例檔補齊。')
        });
        continue;
      }

      const validated = validateNewsCsvRow(record, rowNumber, currentWave, totalWaves);
      if (validated.error) {
        result.failed.push({ row: rowNumber, reason: validated.error });
        continue;
      }
      batch.push(validated.data);

      if (batch.length >= 20) {
        await flushBatch();
        await new Promise(resolve => setImmediate(resolve)); // 讓出 event loop：玩家端還在輪詢新聞
      }
    }
  } catch (err) {
    // 走到這裡代表整份檔案在這個位置就解析不下去了（例如雙引號沒有成對關好，
    // 剖析器判斷不出這個欄位到哪裡結束），不是某一列的資料問題。這種情況一定要
    // 回 4xx：錯在使用者上傳的檔案，訊息要講得出第幾行、什麼問題。
    if (err && typeof err.code === 'string' && err.code.startsWith('CSV_')) {
      await flushBatch(); // 出錯之前已經驗過的照樣寫進去，不要一起丟掉
      if (result.inserted > 0) {
        await audit(req.admin.sub, 'import_news', 'news', null, null,
          { inserted: result.inserted, failed: result.failed.length, aborted: true });
      }
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

  // 一次匯入只留一筆稽核紀錄。逐則記的話，匯入 60 則新聞會把稽核頁（只顯示最近
  // 500 筆）洗掉一大半，反而看不到真正需要追的人為操作。
  await audit(req.admin.sub, 'import_news', 'news', null, null,
    { inserted: result.inserted, failed: result.failed.length });
  res.json(result);
}));

/* ---------------- 股價 ---------------- */

router.get('/prices', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.stock_id, s.name, p.wave, p.price,
            COALESCE(
              LAG(p.price) OVER (PARTITION BY p.stock_id ORDER BY p.wave),
              s.initial_price
            ) AS previous_price
     FROM stock_prices p JOIN stocks s ON s.id = p.stock_id
     ORDER BY p.wave, s.display_order`
  );
  res.json(rows.map(r => ({
    stockId: r.stock_id, name: r.name, wave: r.wave,
    price: Number(r.price),
    previousPrice: r.previous_price === null ? null : Number(r.previous_price),
    changePct: r.previous_price === null ? null
      : Number((((Number(r.price) - Number(r.previous_price)) / Number(r.previous_price)) * 100).toFixed(2))
  })));
}));

// 第 1 波開始前的原始開盤價。它和第 1 波結算價是兩筆不同資料。
router.get('/initial-prices', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id AS stock_id, name, initial_price FROM stocks ORDER BY display_order, id'
  );
  res.json(rows.map(r => ({ stockId: r.stock_id, name: r.name, price: Number(r.initial_price) })));
}));

router.put('/initial-prices', requireAdmin, asyncHandler(async (req, res) => {
  const entries = (req.body || {}).prices;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'prices 必須是陣列' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const e of entries) {
      const stockId = Number(e.stockId);
      const price = Number(e.price);
      if (!Number.isInteger(stockId)) throw Object.assign(new Error('股票編號不正確'), { bad: true });
      if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('初始價格必須大於 0'), { bad: true });
      const { rows } = await client.query(
        'UPDATE stocks SET initial_price = $1 WHERE id = $2 RETURNING id, name, initial_price',
        [price, stockId]
      );
      if (rows.length === 0) throw Object.assign(new Error('找不到股票'), { bad: true });
      out.push({ stockId: rows[0].id, name: rows[0].name, price: Number(rows[0].initial_price) });
    }
    await client.query('COMMIT');
    await audit(req.admin.sub, 'set_initial_prices', 'stocks', null, null, out);
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.bad) return res.status(400).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
}));

// 設定某一波的股價。可以直接給價格，也可以給漲跌百分比（以前一波為基準換算）。
// 現場兩種都會用到：新聞寫「大跌 20%」時給百分比最快，臨時要喬數字時給價格最直接。
router.put('/prices/:wave', requireAdmin, asyncHandler(async (req, res) => {
  const wave = Number(req.params.wave);
  const { rows: st } = await db.query('SELECT total_waves FROM game_state WHERE id = 1');
  if (!Number.isInteger(wave) || wave < 1 || wave > st[0].total_waves) {
    return res.status(400).json({ error: `波次必須是 1 到 ${st[0].total_waves}` });
  }

  const entries = (req.body || {}).prices;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'prices 必須是陣列' });
  }

  // 第 1 波以初始價格為基準；第 2 波起以前一波結算價為基準。
  const prev = await effectivePrices(wave);
  const prevPrice = Object.fromEntries(prev.map(s => [s.id, s.price]));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const e of entries) {
      const stockId = Number(e.stockId);
      if (!Number.isInteger(stockId)) throw Object.assign(new Error('股票編號不正確'), { bad: true });
      const base = prevPrice[stockId];

      let price, changePct;
      if (e.price !== undefined && e.price !== null && e.price !== '') {
        price = Number(e.price);
        if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('價格必須大於 0'), { bad: true });
        changePct = base ? Number((((price - base) / base) * 100).toFixed(2)) : null;
      } else if (e.changePct !== undefined && e.changePct !== null && e.changePct !== '') {
        changePct = Number(e.changePct);
        if (!Number.isFinite(changePct)) throw Object.assign(new Error('漲跌幅不正確'), { bad: true });
        if (!base) throw Object.assign(new Error('找不到此波的計算基準價格'), { bad: true });
        price = Number((base * (1 + changePct / 100)).toFixed(2));
        if (price <= 0) throw Object.assign(new Error('換算後的價格必須大於 0'), { bad: true });
      } else {
        continue; // 這一檔沒填，跳過
      }

      const { rows } = await client.query(
        `INSERT INTO stock_prices (stock_id, wave, price, change_pct) VALUES ($1,$2,$3,$4)
         ON CONFLICT (stock_id, wave) DO UPDATE SET price = EXCLUDED.price, change_pct = EXCLUDED.change_pct
         RETURNING stock_id, wave, price, change_pct`,
        [stockId, wave, price, changePct]
      );
      out.push({
        stockId: rows[0].stock_id, wave: rows[0].wave,
        price: Number(rows[0].price),
        changePct: rows[0].change_pct === null ? null : Number(rows[0].change_pct)
      });
    }
    await client.query('COMMIT');
    await audit(req.admin.sub, 'set_prices', 'stock_prices', wave, null, out);
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.bad) return res.status(400).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
}));

/* ---------------- 實體銀行對帳 ---------------- */

// 本波所有隊伍的申報狀況。銀行關主看的就是這張表。
router.get('/deposits', asyncHandler(async (req, res) => {
  const wave = req.query.wave ? Number(req.query.wave)
    : (await db.query('SELECT wave FROM game_state WHERE id = 1')).rows[0].wave;

  const { rows } = await db.query(
    `SELECT d.id, d.team_id, t.display_name, d.wave, d.amount, d.status,
            d.created_at, d.reviewed_at, t.cash
     FROM deposits d JOIN teams t ON t.id = d.team_id
     WHERE d.wave = $1 ORDER BY d.created_at`,
    [wave]
  );
  res.json({ wave, deposits: rows.map(r => ({ ...r, amount: Number(r.amount), cash: Number(r.cash) })) });
}));

// 核准入帳：金額計入該隊可用餘額。
router.post('/deposits/:id/approve', asyncHandler(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 狀態條件放進 UPDATE 的 WHERE：先查再改的話，兩位關主同時按核准會入帳兩次。
    const { rows } = await client.query(
      `UPDATE deposits SET status = 'approved', reviewed_by = $1, reviewed_at = now()
       WHERE id = $2 AND status = 'pending'
       RETURNING team_id, amount, wave`,
      [req.admin.sub, req.params.id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '這筆申報不存在，或已經審核過了' });
    }
    await client.query('UPDATE teams SET cash = cash + $1 WHERE id = $2',
      [rows[0].amount, rows[0].team_id]);
    await client.query('COMMIT');

    await audit(req.admin.sub, 'approve_deposit', 'deposit', req.params.id, null,
      { teamId: rows[0].team_id, amount: Number(rows[0].amount), wave: rows[0].wave });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// 駁回作廢：不入帳，而且該隊本波不能交易（下單時會檢查這個狀態）。
router.post('/deposits/:id/reject', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE deposits SET status = 'rejected', reviewed_by = $1, reviewed_at = now()
     WHERE id = $2 AND status = 'pending'
     RETURNING team_id, amount, wave`,
    [req.admin.sub, req.params.id]
  );
  if (rows.length === 0) {
    return res.status(409).json({ error: '這筆申報不存在，或已經審核過了' });
  }
  await audit(req.admin.sub, 'reject_deposit', 'deposit', req.params.id, null,
    { teamId: rows[0].team_id, amount: Number(rows[0].amount), wave: rows[0].wave });
  res.json({ ok: true });
}));

/* ---------------- 隊伍 ---------------- */

router.get('/teams', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, display_name, pin, cash, created_at FROM teams ORDER BY id'
  );
  res.json(rows.map(r => ({ ...r, cash: Number(r.cash) })));
}));

router.post('/teams', requireAdmin, asyncHandler(async (req, res) => {
  const { displayName, pin } = req.body || {};
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) return res.status(400).json({ error: '請填寫隊伍名稱' });
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN 要剛好 4 碼數字' });
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO teams (display_name, pin) VALUES ($1,$2) RETURNING id, display_name, pin, cash',
      [name, pin]
    );
    await audit(req.admin.sub, 'create_team', 'team', rows[0].id, null, { displayName: name });
    res.status(201).json({ ...rows[0], cash: Number(rows[0].cash) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '這個隊伍名稱已經存在' });
    throw err;
  }
}));

// 手動覆寫可用餘額（企劃：處理突發狀況或補償）。
router.patch('/teams/:id/cash', requireAdmin, asyncHandler(async (req, res) => {
  const cash = Number((req.body || {}).cash);
  if (!Number.isFinite(cash) || cash < 0) {
    return res.status(400).json({ error: '餘額必須是 0 或正數' });
  }
  const { rows: before } = await db.query('SELECT cash FROM teams WHERE id = $1', [req.params.id]);
  if (before.length === 0) return res.status(404).json({ error: '找不到這支隊伍' });

  const { rows } = await db.query(
    'UPDATE teams SET cash = $1 WHERE id = $2 RETURNING id, display_name, cash',
    [cash, req.params.id]
  );
  await audit(req.admin.sub, 'override_cash', 'team', req.params.id,
    { cash: Number(before[0].cash) }, { cash, note: (req.body || {}).note || null });
  res.json({ ...rows[0], cash: Number(rows[0].cash) });
}));

// 直接修正一支隊伍的整份資產：現金與各檔持股都以「設定後的值」為準。
// 現場帳務補正不能只改現金，否則總資產與持股庫存仍會對不起來；這支與下單相同
// 先鎖住隊伍，再鎖住持股，避免兩台工作人員或玩家下單同時操作造成覆寫。
router.patch('/teams/:id/assets', requireAdmin, asyncHandler(async (req, res) => {
  const cash = Number((req.body || {}).cash);
  const holdings = (req.body || {}).holdings;
  const note = typeof (req.body || {}).note === 'string' ? (req.body || {}).note.trim() : '';
  if (!Number.isFinite(cash) || cash < 0) {
    return res.status(400).json({ error: '現金必須是 0 或正數' });
  }
  if (!Array.isArray(holdings) || holdings.length === 0) {
    return res.status(400).json({ error: 'holdings 必須是至少一檔股票的陣列' });
  }

  const parsed = holdings.map(h => ({ stockId: Number(h.stockId), shares: Number(h.shares) }));
  if (parsed.some(h => !Number.isInteger(h.stockId) || !Number.isInteger(h.shares) || h.shares < 0)) {
    return res.status(400).json({ error: '股票編號與持有張數必須是非負整數' });
  }
  if (new Set(parsed.map(h => h.stockId)).size !== parsed.length) {
    return res.status(400).json({ error: '同一檔股票只能設定一次' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: teamRows } = await client.query(
      'SELECT id, display_name, cash FROM teams WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (teamRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到這支隊伍' });
    }

    const { rows: stocks } = await client.query('SELECT id, name FROM stocks ORDER BY display_order, id');
    const stockName = Object.fromEntries(stocks.map(s => [s.id, s.name]));
    if (parsed.some(h => !stockName[h.stockId])) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '包含不存在的股票' });
    }

    const { rows: beforeRows } = await client.query(
      'SELECT stock_id, shares FROM holdings WHERE team_id = $1 FOR UPDATE', [req.params.id]
    );
    const beforeShares = Object.fromEntries(beforeRows.map(h => [h.stock_id, h.shares]));
    const before = {
      cash: Number(teamRows[0].cash),
      holdings: stocks.map(s => ({ stockId: s.id, name: s.name, shares: beforeShares[s.id] || 0 }))
    };

    await client.query('UPDATE teams SET cash = $1 WHERE id = $2', [cash, req.params.id]);
    for (const h of parsed) {
      await client.query(
        `INSERT INTO holdings (team_id, stock_id, shares) VALUES ($1,$2,$3)
         ON CONFLICT (team_id, stock_id) DO UPDATE SET shares = EXCLUDED.shares`,
        [req.params.id, h.stockId, h.shares]
      );
    }

    const after = {
      cash,
      holdings: stocks.map(s => {
        const entry = parsed.find(h => h.stockId === s.id);
        return { stockId: s.id, name: s.name, shares: entry ? entry.shares : (beforeShares[s.id] || 0) };
      }),
      note: note || null
    };
    await client.query('COMMIT');
    await audit(req.admin.sub, 'override_assets', 'team', req.params.id, before, after);
    res.json({ id: teamRows[0].id, displayName: teamRows[0].display_name, ...after });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// 重設隊伍 PIN。現場一定會有隊伍把 PIN 忘掉或打錯記錯，沒有這支就只能請人
// 去翻資料庫。PIN 本來就是明碼存的（主辦看得到是刻意的設計），這裡只是把
// 「要用 psql 改」搬到後台頁面上。
router.patch('/teams/:id/pin', requireAdmin, asyncHandler(async (req, res) => {
  const { pin } = req.body || {};
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN 要剛好 4 碼數字' });
  }
  const { rows: before } = await db.query('SELECT pin FROM teams WHERE id = $1', [req.params.id]);
  if (before.length === 0) return res.status(404).json({ error: '找不到這支隊伍' });

  const { rows } = await db.query(
    'UPDATE teams SET pin = $1 WHERE id = $2 RETURNING id, display_name, pin, cash',
    [pin, req.params.id]
  );
  await audit(req.admin.sub, 'reset_team_pin', 'team', req.params.id, { pin: before[0].pin }, { pin });
  res.json({ ...rows[0], cash: Number(rows[0].cash) });
}));

// 刪除隊伍。
//
// 已經有存款申報或成交紀錄的隊伍預設擋下來——刪掉會讓總資產排行榜的分母無聲
// 改變，銀行那邊也對不上帳。要真的刪就帶 ?force=1，連同持股、成交、申報一起
// 走（deposits/holdings/trades 都是 ON DELETE CASCADE，所以只要一句 DELETE）。
router.delete('/teams/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows: existing } = await db.query(
    'SELECT id, display_name FROM teams WHERE id = $1', [req.params.id]
  );
  if (existing.length === 0) return res.status(404).json({ error: '找不到這支隊伍' });

  const { rows: used } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM trades WHERE team_id = $1) AS trades,
            (SELECT COUNT(*)::int FROM deposits WHERE team_id = $1) AS deposits`,
    [req.params.id]
  );
  const u = used[0];
  const force = req.query.force === '1';
  if ((u.trades > 0 || u.deposits > 0) && !force) {
    return res.status(409).json({
      error: `這支隊伍已經有 ${u.trades} 筆成交、${u.deposits} 筆存款申報，刪除會連同這些紀錄一起消失。`,
      needsForce: true,
      records: u
    });
  }

  await db.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
  await audit(req.admin.sub, 'delete_team', 'team', req.params.id,
    { displayName: existing[0].display_name, forced: force, records: u }, null);
  res.status(204).end();
}));

/* ---------------- 管理端帳號 ---------------- */

// 之前新增管理端帳號只有 scripts/create-admin.js 這條路，等於現場要開一個銀行
// 關主帳號就得有人 SSH 進伺服器。銀行攤位臨時多開一個、關主換人，都是活動當天
// 會發生的事，所以補上後台入口。
//
// 全部掛 requireAdmin：banker 不能開帳號，也不能把自己升成 admin。
router.get('/admins', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, email, display_name, role, created_at FROM admin_users ORDER BY id'
  );
  res.json(rows);
}));

router.post('/admins', requireAdmin, asyncHandler(async (req, res) => {
  const { email, password, displayName, role } = req.body || {};
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!mail || !mail.includes('@')) return res.status(400).json({ error: '請填寫有效的 email' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '密碼至少 8 個字元' });
  }
  if (role !== undefined && !['admin', 'banker'].includes(role)) {
    return res.status(400).json({ error: "role 只能是 'admin' 或 'banker'" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await db.query(
      `INSERT INTO admin_users (email, password_hash, display_name, role)
       VALUES ($1,$2,$3,$4) RETURNING id, email, display_name, role, created_at`,
      [mail, passwordHash, (displayName || '').trim() || null, role || 'banker']
    );
    await audit(req.admin.sub, 'create_admin', 'admin_user', rows[0].id, null,
      { email: mail, role: rows[0].role });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '這個 email 已經有帳號了' });
    throw err;
  }
}));

router.patch('/admins/:id/password', requireAdmin, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '密碼至少 8 個字元' });
  }
  const { rows } = await db.query(
    'UPDATE admin_users SET password_hash = $1 WHERE id = $2 RETURNING id, email, role',
    [await bcrypt.hash(password, 12), req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '找不到這個帳號' });
  await audit(req.admin.sub, 'reset_admin_password', 'admin_user', req.params.id, null, null);
  res.json(rows[0]);
}));

router.delete('/admins/:id', requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  // 不能刪自己：刪完就沒有人能登入後台了（而且刪的人當下也會被自己的 token 卡住）。
  if (id === req.admin.sub) {
    return res.status(400).json({ error: '不能刪除自己正在使用的帳號' });
  }

  const { rows: target } = await db.query(
    'SELECT id, email, role FROM admin_users WHERE id = $1', [id]
  );
  if (target.length === 0) return res.status(404).json({ error: '找不到這個帳號' });

  // 最後一個 admin 不能刪。banker 開不了帳號也改不了股價，全刪光等於整個後台鎖死，
  // 只能重新 SSH 進去跑 create-admin.js——活動進行到一半沒有人有空做這件事。
  if (target[0].role === 'admin') {
    const { rows: cnt } = await db.query(
      `SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'admin'`
    );
    if (cnt[0].n <= 1) {
      return res.status(409).json({ error: '這是最後一個管理員帳號，刪掉就沒有人能管理後台了' });
    }
  }

  // 比照時空戰爭：一旦帳號留下過稽核紀錄，就不能刪除，否則 log 只會剩下
  // 「已刪除帳號」而失去最重要的責任歸屬。需要停用時改用重設密碼即可。
  const { rows: actionRows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM admin_actions WHERE admin_user_id = $1', [id]
  );
  if (actionRows[0].count > 0) {
    return res.status(409).json({ error: '這個帳號已經有操作紀錄，不能刪除（可改用重設密碼停用）' });
  }

  await db.query('DELETE FROM admin_users WHERE id = $1', [id]);
  await audit(req.admin.sub, 'delete_admin', 'admin_user', id,
    { email: target[0].email, role: target[0].role }, null);
  res.status(204).end();
}));

/* ---------------- 交易監控與總覽 ---------------- */

router.get('/trades', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT tr.id, tr.wave, tr.side, tr.shares, tr.price, tr.total, tr.created_at,
            t.display_name AS team_name, s.name AS stock_name
     FROM trades tr JOIN teams t ON t.id = tr.team_id JOIN stocks s ON s.id = tr.stock_id
     ORDER BY tr.id DESC LIMIT 200`
  );
  res.json(rows.map(r => ({ ...r, price: Number(r.price), total: Number(r.total) })));
}));

// 全場總資產排行榜（現金 + 股票現值），最後公布名次用。
//
// 跟公開那支（/api/market/leaderboard）的差別是這裡會帶 positions：每一隊在
// 四檔各持有幾張、市值多少。企劃寫的是「即時監控各隊伍的所有買賣明細與庫存
// 持股」——買賣明細看成交紀錄就有了，庫存持股要的是「現在手上有什麼」，
// 那不是把成交紀錄一筆一筆加回去就能一眼看出來的東西。
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const { rows: st } = await db.query('SELECT wave, phase FROM game_state WHERE id = 1');
  const valuationWave = st[0].phase === 'closed' ? st[0].wave + 1 : st[0].wave;
  const board = await leaderboard(valuationWave);
  res.json({ wave: st[0].wave, ...board });
}));

// 單一隊伍的完整持股明細（現場有爭議時查帳用）。
router.get('/teams/:id/portfolio', asyncHandler(async (req, res) => {
  const { rows: st } = await db.query('SELECT wave, phase FROM game_state WHERE id = 1');
  const valuationWave = st[0].phase === 'closed' ? st[0].wave + 1 : st[0].wave;
  const p = await portfolio(Number(req.params.id), valuationWave);
  if (!p) return res.status(404).json({ error: '找不到這支隊伍' });
  res.json(p);
}));

module.exports = router;
