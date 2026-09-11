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

// 四檔股票的即時行情：最新股價、本波漲跌幅、以及歷史價格（畫 K 線/趨勢圖用）。
router.get('/stocks', asyncHandler(async (req, res) => {
  const { rows: st } = await db.query('SELECT wave FROM game_state WHERE id = 1');
  const wave = st[0].wave;

  const current = await effectivePrices(wave);
  const { rows: history } = await db.query(
    `SELECT stock_id, wave, price, change_pct FROM stock_prices
     WHERE wave <= $1 ORDER BY stock_id, wave`,
    [wave]
  );

  const byStock = {};
  history.forEach(h => {
    (byStock[h.stock_id] = byStock[h.stock_id] || []).push({
      wave: h.wave, price: Number(h.price),
      changePct: h.change_pct === null ? null : Number(h.change_pct)
    });
  });

  res.json({
    wave,
    stocks: current.map(s => ({ ...s, history: byStock[s.id] || [] }))
  });
}));

// 新聞。預設回目前這一波，帶 ?all=1 回全部（玩家想回顧前幾波的情報）。
router.get('/news', asyncHandler(async (req, res) => {
  const { rows: st } = await db.query('SELECT wave FROM game_state WHERE id = 1');
  const all = req.query.all === '1';
  const { rows } = await db.query(
    all
      ? `SELECT id, wave, title, body, published_at FROM news ORDER BY wave DESC, id DESC`
      : `SELECT id, wave, title, body, published_at FROM news WHERE wave = $1 ORDER BY id DESC`,
    all ? [] : [st[0].wave]
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
  const board = await leaderboard(rows[0].wave);

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
      stockId: s.id, name: s.name, price: s.price,
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
