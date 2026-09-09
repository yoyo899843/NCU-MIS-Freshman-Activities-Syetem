// 三個頁面共用的小工具。刻意不做樣式，功能先跑起來為主。
const PHASE_LABEL = {
  news: '階段一 · 新聞發布',
  gambling: '階段二 · 賭博賺錢（實體）',
  deposit: '階段三 · 資產申報與銀行審核',
  trading: '階段四 · 股票交易',
  closed: '已收盤'
};
const DEPOSIT_LABEL = { pending: '審核中', approved: '已通過', rejected: '異常遭拒' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n).toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function teamToken() { return localStorage.getItem('teamToken'); }

// 玩家端的 API 呼叫。401 一律導回登入頁——token 過期不會讓 localStorage 自動
// 清空，不處理的話畫面會停在已登入狀態、每個操作都默默失敗。
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(teamToken() ? { Authorization: 'Bearer ' + teamToken() } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 401 && teamToken()) {
    localStorage.removeItem('teamToken');
    localStorage.removeItem('teamInfo');
    location.href = 'login.html';
    throw new Error('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function requireLogin() {
  if (!teamToken()) { location.href = 'login.html'; return false; }
  return true;
}

// 漲跌幅顯示：紅漲綠跌是台股習慣，但顏色只是輔助，數字本身一定帶正負號。
function pctText(p) {
  if (p === null || p === undefined) return '—';
  const sign = p > 0 ? '+' : '';
  return `${sign}${p}%`;
}

/* ---------------- 走勢圖 ----------------
 *
 * 企劃寫的是「歷史 K 線與趨勢走勢圖」。真正的 K 棒畫不出來——K 棒要開高低收
 * 四個價，而這個遊戲一波只有一個收盤價（後台設定的那個數字），沒有盤中交易
 * 產生的高低點。硬畫出來的「K 棒」會是假的資訊。
 *
 * 所以畫的是折線走勢圖＋每一波的漲跌幅長條，這是這份資料真正能表達的東西，
 * 也是玩家實際要看的：從哪一波開始漲、這一波漲跌多少。
 *
 * 用手寫 SVG 不引圖表函式庫：現場網路不一定通得到 CDN，而且整份資料就三、四
 * 個點，拉一個幾百 KB 的函式庫進來不划算。
 */
const CHART_COLORS = ['#c0392b', '#1f6feb', '#0d7550', '#a15c00'];

function svgEl(tag, attrs, children) {
  const a = Object.entries(attrs || {})
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
  return `<${tag} ${a}>${children || ''}</${tag}>`;
}

// 多檔股票疊在同一張圖上比較。history 是 [{wave, price}]。
function trendChart(series, opts) {
  const o = { w: 640, h: 240, pad: 34, ...(opts || {}) };
  const points = series.flatMap(s => s.history);
  if (points.length === 0) return '<p>尚無資料</p>';

  const waves = [...new Set(points.map(p => p.wave))].sort((a, b) => a - b);
  const prices = points.map(p => p.price);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  // 全部同價（例如第一波大家都 100）時 hi === lo，直接拿來當分母會變成除以 0，
  // 線會整條跑到 NaN。給一個上下留白讓它畫在中間。
  if (hi === lo) { hi = lo + 1; lo = lo - 1; }
  const span = hi - lo;

  const x = w => o.pad + (waves.length === 1 ? (o.w - o.pad * 2) / 2
    : (waves.indexOf(w) / (waves.length - 1)) * (o.w - o.pad * 2));
  const y = p => o.h - o.pad - ((p - lo) / span) * (o.h - o.pad * 2);

  // 水平格線＋價格刻度
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (span * i) / 4;
    const yy = y(v);
    grid += svgEl('line', { x1: o.pad, y1: yy, x2: o.w - o.pad, y2: yy, stroke: '#ddd', 'stroke-width': 1 });
    grid += svgEl('text', { x: 4, y: yy + 4, 'font-size': 11, fill: '#666' }, money(Math.round(v)));
  }
  // 波次刻度
  waves.forEach(w => {
    grid += svgEl('text',
      { x: x(w), y: o.h - 8, 'font-size': 11, fill: '#666', 'text-anchor': 'middle' }, `第${w}波`);
  });

  const lines = series.map((s, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const hist = s.history.slice().sort((a, b) => a.wave - b.wave);
    const d = hist.map((p, n) => `${n === 0 ? 'M' : 'L'}${x(p.wave)},${y(p.price)}`).join(' ');
    const dots = hist.map(p =>
      svgEl('circle', { cx: x(p.wave), cy: y(p.price), r: 3.5, fill: color })).join('');
    return svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2 }) + dots;
  }).join('');

  const legend = series.map((s, i) =>
    `<span style="margin-right:12px;white-space:nowrap">
       <span style="display:inline-block;width:11px;height:11px;background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
       ${esc(s.name)}</span>`).join('');

  // 圖比容器寬的時候要能橫向捲動，不要把整頁撐爆（手機上一定會遇到）
  return `<div style="overflow-x:auto">
      ${svgEl('svg', { viewBox: `0 0 ${o.w} ${o.h}`, width: o.w, height: o.h,
                       role: 'img', 'aria-label': '各股價格走勢圖' }, grid + lines)}
    </div>
    <p style="font-size:0.9em">${legend}</p>`;
}

// 單一檔股票的每波漲跌幅長條圖。零軸畫在中間，往上是漲往下是跌。
function changeBars(history, opts) {
  // pad 要留得夠：下跌的長條是往下畫的，百分比標在長條末端下方，波次標在最底下。
  // 高度不夠的話這兩行字會疊在一起（h:110/pad:18 就是這樣，只差 4px）。
  const o = { w: 320, h: 132, pad: 26, ...(opts || {}) };
  const hist = history.filter(h => h.changePct !== null && h.changePct !== undefined);
  if (hist.length === 0) return '<p style="font-size:0.9em;color:#666">還沒有漲跌資料（第一波沒有前一波可比）。</p>';

  const max = Math.max(10, ...hist.map(h => Math.abs(h.changePct)));
  const mid = o.h / 2;
  const bw = Math.min(36, (o.w - o.pad * 2) / hist.length - 8);

  const bars = hist.map((h, i) => {
    const cx = o.pad + (i + 0.5) * ((o.w - o.pad * 2) / hist.length);
    const len = (Math.abs(h.changePct) / max) * (mid - o.pad);
    const up = h.changePct >= 0;
    return svgEl('rect', {
      x: cx - bw / 2, y: up ? mid - len : mid, width: bw, height: Math.max(len, 1),
      fill: up ? '#c0392b' : '#0d7550'
    }) + svgEl('text', {
      x: cx, y: up ? mid - len - 4 : mid + len + 12,
      'font-size': 11, 'text-anchor': 'middle', fill: '#333'
    }, pctText(h.changePct)) + svgEl('text', {
      x: cx, y: o.h - 2, 'font-size': 10, 'text-anchor': 'middle', fill: '#666'
    }, `第${h.wave}波`);
  }).join('');

  const axis = svgEl('line', { x1: o.pad, y1: mid, x2: o.w - o.pad, y2: mid, stroke: '#999', 'stroke-width': 1 });
  return `<div style="overflow-x:auto">${svgEl('svg',
    { viewBox: `0 0 ${o.w} ${o.h}`, width: o.w, height: o.h, role: 'img', 'aria-label': '各波漲跌幅' },
    axis + bars)}</div>`;
}
