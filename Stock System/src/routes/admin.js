const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { bankerGuard, requireAdmin } = require('../middleware/bankerGuard');
const asyncHandler = require('../middleware/asyncHandler');
const { createLoginThrottle } = require('../loginThrottle');
const { leaderboard, effectivePrices, portfolio } = require('../portfolio');

const router = express.Router();
const loginThrottle = createLoginThrottle();

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
