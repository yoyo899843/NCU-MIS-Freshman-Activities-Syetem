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

// 全場總資產排行榜（現金 ＋ 股票現值）。
//
// 這支不用登入，跟行情和新聞同一個理由：企劃要的是投影在大螢幕上「以便最後
// 公布名次」，而大螢幕那台電腦沒有隊伍帳號。管理端也有一支同名的
// （/admin/api/leaderboard），差別在這裡不回任何隊伍的私有資訊——只有名次、
// 隊名、現金、股票現值、總資產，跟現場投影出來的東西一模一樣。
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT wave, total_waves, phase FROM game_state WHERE id = 1');
  const board = await leaderboard(rows[0].wave);

  // positions（每隊各檔持有幾張）刻意在這裡拿掉。
  //
  // 這一頁是投影出去給全場看的，而持股是還沒實現的部位——公開之後，最後一波
  // 交易時間大家只要盯著螢幕就知道領先的那隊押在哪一檔，變成互相跟單/狙擊，
  // 「依據新聞自己判斷」那一段就沒意義了。後台的 /admin/api/leaderboard 才回
  // 明細，那是給工作人員結算與查帳用的。
  res.json({
    ...rows[0],
    teams: board.teams.map(({ positions, ...rest }) => rest)
  });
}));

module.exports = router;
