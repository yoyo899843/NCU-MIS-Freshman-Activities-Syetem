const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { effectivePrices } = require('../portfolio');

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

module.exports = router;
