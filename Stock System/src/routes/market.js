const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { effectivePrices, leaderboard } = require('../portfolio');

const router = express.Router();

// 行情與新聞都不需要登入：這是全場公開的市場情報，大螢幕也要用。
// 隊伍自己的餘額與持股才要登入（見 routes/team.js）。

router.get('/state', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT wave, total_waves, phase FROM game_state WHERE id = 1');
  res.json(rows[0]);
}));

// 四檔股票的即時行情：目前可交易價格、前一個公布價格、漲跌幅，以及歷史價格。
// 初始價格與每一波結算價分開，避免第 1 波結算價被誤當成開盤價。
router.get('/stocks', asyncHandler(async (req, res) => {
  const { rows: st } = await db.query('SELECT wave, phase FROM game_state WHERE id = 1');
  const wave = st[0].wave;
  // 收盤後立即公布本波結算價；在下一波開始前，交易已關閉，所以只影響行情／估值顯示。
  const visiblePriceWave = st[0].phase === 'closed' ? wave + 1 : wave;

  const current = await effectivePrices(visiblePriceWave);
  const { rows: history } = await db.query(
    `SELECT s.id AS stock_id, 0 AS wave, s.initial_price AS price, NULL::NUMERIC AS previous_price
     FROM stocks s
     UNION ALL
     SELECT p.stock_id, p.wave, p.price,
            COALESCE(
              LAG(p.price) OVER (PARTITION BY p.stock_id ORDER BY p.wave),
              s.initial_price
            ) AS previous_price
     FROM stock_prices p JOIN stocks s ON s.id = p.stock_id
     WHERE p.wave < $1
     ORDER BY stock_id, wave`,
    [visiblePriceWave]
  );

  const byStock = {};
  history.forEach(h => {
    (byStock[h.stock_id] = byStock[h.stock_id] || []).push({
      wave: h.wave,
      price: Number(h.price),
      previousPrice: h.previous_price === null ? null : Number(h.previous_price),
      changePct: h.previous_price === null ? null
        : Number((((Number(h.price) - Number(h.previous_price)) / Number(h.previous_price)) * 100).toFixed(2))
    });
  });

  res.json({
    wave,
    stocks: current.map(s => ({ ...s, history: byStock[s.id] || [] }))
  });
}));

// 新聞只回目前波次，避免玩家在交易前先看到後續波次的情報；完整清單僅由後台
// /admin/api/news 提供給主辦管理。
router.get('/news', asyncHandler(async (req, res) => {
  const { rows: st } = await db.query('SELECT wave FROM game_state WHERE id = 1');
  const { rows } = await db.query(
    `SELECT id, wave, title, body, published_at FROM news
     WHERE wave = $1 ORDER BY id DESC`,
    [st[0].wave]
  );
  res.json(rows);
}));

// 排行榜：全場總資產排行，加上四間公司各自的持股排行（誰是最大股東）。
//
// 這支不用登入，跟行情和新聞同一個理由：企劃要的是投影在大螢幕上「以便最後
// 公布名次」，而大螢幕那台電腦沒有隊伍帳號。
//
// 各公司持股排行會公開每隊在各檔持有幾張——這是主辦要的玩法，代價是交易時間
// 大家看得到領先的隊伍押在哪一檔。現金、成交明細仍然只在後台
// （/admin/api/leaderboard）看得到。
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT wave, total_waves, phase FROM game_state WHERE id = 1');
  const visiblePriceWave = rows[0].phase === 'closed' ? rows[0].wave + 1 : rows[0].wave;
  const board = await leaderboard(visiblePriceWave);

  // 每間公司一張榜：只列有持股的隊伍，依張數排，同張數並列、名次跳號（1,1,3），
  // 跟總資產榜的並列規則一樣。
  const holdings = board.stocks.map(s => {
    const holders = board.teams
      .map(t => {
        const p = t.positions.find(x => x.stockId === s.id);
        return { teamId: t.teamId, name: t.name, shares: p.shares, value: p.value };
      })
      .filter(h => h.shares > 0)
      .sort((a, b) => b.shares - a.shares || a.teamId - b.teamId);
    let rank = 0, prev = null;
    holders.forEach((h, i) => {
      if (h.shares !== prev) { rank = i + 1; prev = h.shares; }
      h.rank = rank;
    });
    return {
      stockId: s.id, name: s.name, price: s.price, previousPrice: s.previousPrice, changePct: s.changePct,
      teams: holders.map(h => ({ rank: h.rank, name: h.name, shares: h.shares, value: h.value }))
    };
  });

  res.json({
    ...rows[0],
    teams: board.teams.map(({ positions, ...rest }) => rest),
    holdings
  });
}));

module.exports = router;
