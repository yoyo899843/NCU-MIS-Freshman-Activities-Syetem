// 資產計算與下單。玩家端與管理端都走這裡，計價方式只有一份。
const db = require('./db');

// 某一波的股價表（stockId -> { price, changePct, name }）。
// 價格是在每波結束時才公布下一筆，波中不變動。
async function pricesAt(wave, client = db) {
  const { rows } = await client.query(
    `SELECT s.id, s.name, s.display_order, p.price, p.change_pct
     FROM stocks s
     LEFT JOIN stock_prices p ON p.stock_id = s.id AND p.wave = $1
     ORDER BY s.display_order, s.id`,
    [wave]
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    // 這一波還沒設價格就沿用上一波（管理端可能還沒輸入），沒有的話回 null，
    // 由呼叫端決定要不要擋下交易。
    price: r.price === null ? null : Number(r.price),
    changePct: r.change_pct === null ? null : Number(r.change_pct)
  }));
}

// 某一波尚未設定新價格時，改用最近一波已公布的收盤價；同時帶回該筆價格的
// 前一筆價格。漲跌幅一律由兩個實際價格即時計算，不依賴管理端曾經手動填的百分比，
// 讓「前價 → 現價」與畫面上的百分比永遠對得起來。
async function effectivePrices(wave, client = db) {
  const { rows } = await client.query(
    `SELECT s.id, s.name, s.display_order,
            current_price.price, current_price.wave AS price_wave,
            previous_price.price AS previous_price
     FROM stocks s
     LEFT JOIN LATERAL (
       SELECT price, wave FROM stock_prices
       WHERE stock_id = s.id AND wave <= $1
       ORDER BY wave DESC LIMIT 1
     ) current_price ON true
     LEFT JOIN LATERAL (
       SELECT price FROM stock_prices
       WHERE stock_id = s.id AND wave < current_price.wave
       ORDER BY wave DESC LIMIT 1
     ) previous_price ON true
     ORDER BY s.display_order, s.id`,
    [wave]
  );
  return rows.map(r => {
    const price = r.price === null ? null : Number(r.price);
    const previousPrice = r.previous_price === null ? null : Number(r.previous_price);
    return {
      id: r.id,
      name: r.name,
      price,
      previousPrice,
      priceWave: r.price_wave === null ? null : Number(r.price_wave),
      changePct: price !== null && previousPrice !== null
        ? Number((((price - previousPrice) / previousPrice) * 100).toFixed(2))
        : null
    };
  });
}

// 一支隊伍目前的資產總覽：現金 + 各檔持股（含現值）。
async function portfolio(teamId, wave, client = db) {
  const [{ rows: teamRows }, { rows: holdRows }, prices] = await Promise.all([
    client.query('SELECT id, display_name, cash FROM teams WHERE id = $1', [teamId]),
    client.query('SELECT stock_id, shares FROM holdings WHERE team_id = $1 AND shares > 0', [teamId]),
    effectivePrices(wave, client)
  ]);
  if (teamRows.length === 0) return null;

  const held = Object.fromEntries(holdRows.map(r => [r.stock_id, r.shares]));
  const positions = prices.map(s => {
    const shares = held[s.id] || 0;
    const value = s.price === null ? 0 : shares * s.price;
    return { stockId: s.id, name: s.name, price: s.price, previousPrice: s.previousPrice, changePct: s.changePct, shares, value };
  });

  const cash = Number(teamRows[0].cash);
  const stockValue = positions.reduce((n, p) => n + p.value, 0);
  return {
    teamId,
    name: teamRows[0].display_name,
    cash,
    stockValue,
    total: cash + stockValue,
    positions
  };
}

// 下單。回傳 { ok:true, trade } 或 { error }。
//
// 整筆包在一個交易裡並且鎖住 teams 那一列：同一支隊伍如果兩台裝置同時送單，
// 沒有鎖的話兩邊都會讀到同一個餘額、各自判斷「錢夠」，結果買超。
async function placeOrder({ teamId, stockId, side, shares, wave }) {
  if (!['buy', 'sell'].includes(side)) return { error: "side 必須是 'buy' 或 'sell'" };
  if (!Number.isInteger(shares) || shares <= 0) return { error: '張數必須是正整數' };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: teamRows } = await client.query(
      'SELECT id, cash FROM teams WHERE id = $1 FOR UPDATE', [teamId]
    );
    if (teamRows.length === 0) { await client.query('ROLLBACK'); return { error: '找不到這支隊伍' }; }

    const prices = await effectivePrices(wave, client);
    const stock = prices.find(s => s.id === stockId);
    if (!stock) { await client.query('ROLLBACK'); return { error: '找不到這檔股票' }; }
    if (stock.price === null) {
      await client.query('ROLLBACK');
      return { error: '這檔股票還沒有本波價格，暫時無法交易' };
    }

    const cash = Number(teamRows[0].cash);
    const total = Number((stock.price * shares).toFixed(2));

    const { rows: holdRows } = await client.query(
      'SELECT shares FROM holdings WHERE team_id = $1 AND stock_id = $2 FOR UPDATE',
      [teamId, stockId]
    );
    const owned = holdRows[0] ? holdRows[0].shares : 0;

    if (side === 'buy') {
      // 企劃的防呆一：買入總額不可超過現有可用餘額
      if (total > cash) {
        await client.query('ROLLBACK');
        return { error: `可用餘額不足（需要 ${total}，目前 ${cash}）` };
      }
      await client.query('UPDATE teams SET cash = cash - $1 WHERE id = $2', [total, teamId]);
      await client.query(
        `INSERT INTO holdings (team_id, stock_id, shares) VALUES ($1,$2,$3)
         ON CONFLICT (team_id, stock_id) DO UPDATE SET shares = holdings.shares + EXCLUDED.shares`,
        [teamId, stockId, shares]
      );
    } else {
      // 企劃的防呆二：賣出數量不可超過庫存張數
      if (shares > owned) {
        await client.query('ROLLBACK');
        return { error: `庫存不足（要賣 ${shares} 張，目前只有 ${owned} 張）` };
      }
      await client.query('UPDATE teams SET cash = cash + $1 WHERE id = $2', [total, teamId]);
      await client.query(
        'UPDATE holdings SET shares = shares - $1 WHERE team_id = $2 AND stock_id = $3',
        [shares, teamId, stockId]
      );
    }

    const { rows: tradeRows } = await client.query(
      `INSERT INTO trades (team_id, stock_id, wave, side, shares, price, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, side, shares, price, total, created_at`,
      [teamId, stockId, wave, side, shares, stock.price, total]
    );

    await client.query('COMMIT');
    return { ok: true, trade: { ...tradeRows[0], stockName: stock.name } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 全場排行榜：各隊「現金 + 股票現值」，外加每一檔的持股明細。
//
// 回傳 { stocks, teams }。stocks 是這一波的四檔（含當下價格），teams 裡每一列的
// positions 一定涵蓋「全部四檔」，沒有持股的補 0 而不是省略——後台的總覽表是
// 一個隊伍 × 股票的矩陣，欄位必須固定對齊。只回有持股的那幾檔，前端就得自己
// 補洞，很容易把某一隊的張數對到別檔的欄位去。
async function leaderboard(wave) {
  const prices = await effectivePrices(wave);
  const priceOf = Object.fromEntries(prices.map(s => [s.id, s.price ?? 0]));

  const { rows } = await db.query(
    `SELECT t.id, t.display_name, t.cash,
            COALESCE(json_agg(json_build_object('stockId', h.stock_id, 'shares', h.shares))
                     FILTER (WHERE h.stock_id IS NOT NULL AND h.shares > 0), '[]') AS holdings
     FROM teams t LEFT JOIN holdings h ON h.team_id = t.id
     GROUP BY t.id ORDER BY t.id`
  );

  const teams = rows.map(r => {
    const held = Object.fromEntries(r.holdings.map(h => [h.stockId, h.shares]));
    const positions = prices.map(s => {
      const shares = held[s.id] || 0;
      return {
        stockId: s.id,
        name: s.name,
        price: s.price,
        shares,
        value: shares * (priceOf[s.id] || 0)
      };
    });
    const stockValue = positions.reduce((n, p) => n + p.value, 0);
    const cash = Number(r.cash);
    return {
      teamId: r.id, name: r.display_name,
      cash, stockValue, total: cash + stockValue, positions
    };
  });

  teams.sort((a, b) => b.total - a.total || a.teamId - b.teamId);
  // 同分並列，名次跳號（1,1,3）
  let rank = 0, prev = null;
  teams.forEach((r, i) => {
    if (r.total !== prev) { rank = i + 1; prev = r.total; }
    r.rank = rank;
  });

  return {
    stocks: prices.map(s => ({ id: s.id, name: s.name, price: s.price, previousPrice: s.previousPrice, changePct: s.changePct })),
    teams
  };
}

module.exports = { pricesAt, effectivePrices, portfolio, placeOrder, leaderboard };
