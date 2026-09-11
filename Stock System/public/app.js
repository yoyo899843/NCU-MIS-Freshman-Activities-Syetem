// 玩家端各頁共用的小工具。外觀在 style.css，圖示與漲跌膠囊在 ui.js（要先載入）。
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

/* ---------------- 存款三步驟 ----------------
 *
 * 首頁和交易頁都要顯示「我現在卡在哪一步」：申報金額 → 銀行審核 → 可以交易。
 * 企劃寫「若該波存款未通過審核，交易功能將直接反灰鎖定」——玩家看不懂自己卡在
 * 哪，就會一直跑去問關主，所以把狀態講成三步，並附一句「下一步要做什麼」。
 */
function depositSteps(phase, dep) {
  const step = (cls, label, mark) =>
    `<li class="${cls}"${cls === 'now' ? ' aria-current="step"' : ''}><span class="dot">${mark}</span>${label}</li>`;
  const ok = icon('check', 'ic-sm'), no = icon('x', 'ic-sm');

  let s1, s2, s3, note;
  if (!dep) {
    s1 = step(phase === 'deposit' ? 'now' : '', '申報金額', '1');
    s2 = step('', '銀行審核', '2');
    s3 = step('', '可以交易', '3');
    note = phase === 'deposit' ? '現在是申報時間，請在「交易」頁填寫要存入的金額。'
         : phase === 'trading' ? '本波沒有申報，這一波不能交易。'
         : '還沒到申報時間，等主持人宣布進入階段三。';
  } else if (dep.status === 'pending') {
    s1 = step('done', '申報金額', ok);
    s2 = step('now', '銀行審核', '2');
    s3 = step('', '可以交易', '3');
    note = `已申報 ${money(dep.amount)}，請帶籌碼到銀行攤位給關主核對。`;
  } else if (dep.status === 'approved') {
    s1 = step('done', '申報金額', ok);
    s2 = step('done', '銀行審核', ok);
    s3 = step(phase === 'trading' ? 'now' : '', '可以交易', '3');
    note = phase === 'trading'
      ? `申報 ${money(dep.amount)} 已通過，可以開始交易。`
      : `申報 ${money(dep.amount)} 已通過，等主持人宣布進入交易時間。`;
  } else {
    s1 = step('done', '申報金額', ok);
    s2 = step('fail', '審核遭駁回', no);
    s3 = step('', '可以交易', '3');
    note = '申報金額與實際籌碼不符，這一波不能交易。';
  }
  return `<ol class="steps" aria-label="本波存款進度">${s1}${s2}${s3}</ol><p class="steps-note">${note}</p>`;
}

/* ---------------- 圖表 ----------------
 *
 * 企劃寫的是「歷史 K 線與趨勢走勢圖」。真正的 K 棒畫不出來——K 棒要開高低收
 * 四個價，而這個遊戲一波只有一個收盤價（後台設定的那個數字），硬畫會是假資訊。
 * 所以畫的是這份資料真正能表達的東西：四檔的走勢比較、各波漲跌幅。
 *
 * 依 dataviz 規範：
 * - 系列色不用紅／綠：這個系統的紅綠已經代表「漲／跌」，是保留語意。四色用
 *   validate_palette.js 驗過（白底、--pairs all，因為線會交叉任兩條都可能相鄰）：
 *   最差 CVD ΔE 13.0、一般視覺 ΔE 16.3、對白底全部 >= 3:1。
 *   品牌主色深藍 #1e3a8a 也試過，亮度 L 0.379 落在系列色帶外，驗證不過，所以沒用。
 * - 顏色跟著股票走，不跟排名走：用股票在完整清單裡的位置取色，不是用「這張圖
 *   裡第幾條」——不然某檔還沒有價格時，其他檔的顏色會整批位移。
 * - 四條以內全部直接標名稱，另外有圖例和表格，身分永遠不只靠顏色。
 * - 格線與軸是背景，淡；數字標籤用文字色，不用系列色。
 * - 手寫 SVG 不引圖表函式庫：現場網路不一定通得到 CDN，資料也只有十幾個點。
 */
const SERIES_COLORS = ['#2a78d6', '#4a3aa7', '#c98500', '#d55181'];
const CHART_INK = { fg: '#0b1324', dim: '#55627a', grid: '#e7ecf4', axis: '#b9c3d3',
                    up: '#c0262d', down: '#047a4b' };
const shortName = n => Array.from(n).slice(0, 2).join('');

function svgEl(tag, attrs, children) {
  const a = Object.entries(attrs || {})
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
  return `<${tag} ${a}>${children || ''}</${tag}>`;
}

// 共用提示框：滑鼠移過去、手指點、鍵盤 focus 都會出現（不能只靠 hover）。
// 目標元素帶 data-tip，內容是純文字，每行一筆。
function attachTips(container) {
  let tip = document.getElementById('chartTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chartTip';
    tip.setAttribute('role', 'status');
    tip.style.cssText = 'position:fixed;z-index:50;pointer-events:none;display:none;' +
      'background:#0b1324;color:#fff;font-size:13px;line-height:1.5;padding:7px 10px;' +
      'border-radius:8px;white-space:pre;box-shadow:0 6px 18px rgba(11,19,36,.25);' +
      'font-variant-numeric:tabular-nums;';
    document.body.appendChild(tip);
  }
  const show = (el, x, y) => {
    tip.textContent = el.getAttribute('data-tip');
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + 'px';
    tip.style.top = Math.max(8, y - r.height - 12) + 'px';
    container.querySelectorAll('[data-guide]').forEach(g =>
      g.style.opacity = g.getAttribute('data-guide') === el.getAttribute('data-col') ? 1 : 0);
  };
  const hide = () => {
    tip.style.display = 'none';
    container.querySelectorAll('[data-guide]').forEach(g => g.style.opacity = 0);
  };
  container.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('pointerenter', e => show(el, e.clientX, e.clientY));
    el.addEventListener('pointermove', e => show(el, e.clientX, e.clientY));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', () => { const b = el.getBoundingClientRect(); show(el, b.left + b.width / 2, b.top); });
    el.addEventListener('blur', hide);
  });
}

// 四檔疊在同一張圖比較。series = [{ name, colorIndex, history:[{wave,price,changePct}] }]
function trendChart(series, opts) {
  const o = { w: 640, h: 260, padL: 44, padR: 64, padT: 16, padB: 34, ...(opts || {}) };
  const points = series.flatMap(s => s.history);
  const waves = [...new Set(points.map(p => p.wave))].sort((a, b) => a - b);

  // 只有一波（開盤當下）就沒有「走勢」可言，畫一排點沒有意義，直接講清楚
  if (waves.length < 2) {
    return '<p class="hint">第一波只有開盤價，進入第二波之後才看得到走勢。</p>';
  }

  const prices = points.map(p => p.price);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  if (hi === lo) { hi = lo + 1; lo = lo - 1; }   // 全部同價時避免除以 0
  const padV = (hi - lo) * 0.12; lo -= padV; hi += padV;
  const span = hi - lo;
  const iw = o.w - o.padL - o.padR, ih = o.h - o.padT - o.padB;
  const x = w => o.padL + (waves.indexOf(w) / (waves.length - 1)) * iw;
  const y = p => o.padT + ih - ((p - lo) / span) * ih;

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (span * i) / 4, yy = y(v);
    g += svgEl('line', { x1: o.padL, y1: yy, x2: o.w - o.padR, y2: yy, stroke: CHART_INK.grid, 'stroke-width': 1 });
    g += svgEl('text', { x: o.padL - 8, y: yy + 4, 'font-size': 12, fill: CHART_INK.dim, 'text-anchor': 'end' }, money(Math.round(v)));
  }
  waves.forEach(w => {
    g += svgEl('text', { x: x(w), y: o.h - 10, 'font-size': 12, fill: CHART_INK.dim, 'text-anchor': 'middle' }, `第${w}波`);
    // 十字準線：平常看不見，指到那一波才出現
    g += svgEl('line', { x1: x(w), y1: o.padT, x2: x(w), y2: o.padT + ih, stroke: CHART_INK.axis,
                         'stroke-width': 1, 'stroke-dasharray': '3 3', 'data-guide': w, style: 'opacity:0' });
  });

  // 線 2px，點 8px 直徑、外圍 2px 白圈（重疊時分得開）
  let lines = '', dots = '';
  const ends = [];
  series.forEach(s => {
    const c = SERIES_COLORS[s.colorIndex % SERIES_COLORS.length];
    const h = s.history.slice().sort((a, b) => a.wave - b.wave);
    if (!h.length) return;
    lines += svgEl('path', { d: h.map((p, n) => `${n ? 'L' : 'M'}${x(p.wave)},${y(p.price)}`).join(' '),
                             fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round' });
    h.forEach(p => { dots += svgEl('circle', { cx: x(p.wave), cy: y(p.price), r: 4, fill: c, stroke: '#fff', 'stroke-width': 2 }); });
    const last = h[h.length - 1];
    ends.push({ label: shortName(s.name), c, x: x(last.wave), y: y(last.price) });
  });

  // 直接標籤放在線尾。兩條線收在差不多的價位時標籤會疊在一起，
  // 所以照 y 排序後強制至少間隔 15px 往下推。
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  const labels = ends.map(e =>
    svgEl('rect', { x: e.x + 9, y: e.y - 6, width: 8, height: 3, rx: 1.5, fill: e.c }) +
    svgEl('text', { x: e.x + 21, y: e.y + 4, 'font-size': 13, 'font-weight': 600, fill: CHART_INK.fg }, esc(e.label))
  ).join('');

  // 每一波一個透明的直欄當觸發區：比點本身大得多，手指也點得到
  const colW = iw / (waves.length - 1);
  const hits = waves.map(w => {
    const rows = series.map(s => {
      const p = s.history.find(h => h.wave === w);
      if (!p) return null;
      const chg = p.changePct === null ? '' : `  ${p.changePct > 0 ? '+' : ''}${Number(p.changePct).toFixed(2)}%`;
      return `${s.name}  ${money(p.price)}${chg}`;
    }).filter(Boolean);
    return svgEl('rect', {
      x: Math.max(o.padL - colW / 2, x(w) - colW / 2), y: o.padT, width: colW, height: ih,
      fill: 'transparent', tabindex: 0, 'data-col': w,
      'data-tip': `第 ${w} 波\n${rows.join('\n')}`, 'aria-label': `第 ${w} 波：${rows.join('；')}`
    });
  }).join('');

  const legend = series.map(s =>
    `<span><svg width="18" height="10" aria-hidden="true"><rect y="3.5" width="18" height="3" rx="1.5" fill="${SERIES_COLORS[s.colorIndex % SERIES_COLORS.length]}"/></svg>${esc(s.name)}</span>`
  ).join('');

  // 表格：圖不是螢幕報讀器讀得懂的東西，而且顏色對比不夠亮的人也需要一個
  // 不靠圖形的看法。預設收起來，不佔版面。
  const table = `<details style="margin-top:10px"><summary class="hint" style="cursor:pointer;min-height:44px;display:flex;align-items:center">以表格檢視</summary>
    <div class="table-wrap"><table><thead><tr><th>股票</th>${waves.map(w => `<th class="n">第${w}波</th>`).join('')}</tr></thead><tbody>
    ${series.map(s => `<tr><td>${esc(s.name)}</td>${waves.map(w => {
      const p = s.history.find(h => h.wave === w);
      return `<td class="n">${p ? money(p.price) : '—'}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div></details>`;

  return `<div class="chart">${svgEl('svg', { viewBox: `0 0 ${o.w} ${o.h}`, width: o.w, height: o.h, role: 'group',
            'aria-label': '四檔股票各波收盤價走勢' }, g + lines + dots + labels + hits)}</div>
          <div class="legend">${legend}</div>${table}`;
}

// 單檔各波漲跌幅。這是「兩極」資料：主要編碼是長條在零線上方還是下方，
// 顏色（紅漲綠跌）只是輔助——所以紅綠色盲靠位置就讀得出來，數字也一定帶正負號。
// 長條只有外側那端是圓角，貼著零線的那端是平的（資料從基準線長出去）。
function changeBars(history, opts) {
  // 上方留給「上漲」的數字、下方先留給「下跌」的數字、最底下再一列給波次。
  // 第一版只算了長條本身的高度，下跌的數字和「第N波」會疊在同一個位置
  // （−12% 那張實際疊在一起）。現在長條最長只能長到預留區的邊界。
  const o = { w: 320, h: 170, pad: 20, labelTop: 22, labelBottom: 20, waveRow: 18, ...(opts || {}) };
  const hist = history.filter(h => h.changePct !== null && h.changePct !== undefined);
  if (hist.length === 0) return '<p class="hint">第一波沒有前一波可比，還沒有漲跌資料。</p>';

  const plotTop = o.labelTop, plotBottom = o.h - o.waveRow - o.labelBottom;
  const mid = (plotTop + plotBottom) / 2;
  const maxLen = (plotBottom - plotTop) / 2;
  const max = Math.max(10, ...hist.map(h => Math.abs(h.changePct)));
  const slot = (o.w - o.pad * 2) / hist.length;
  const bw = Math.min(28, slot - 16);
  const r = 4;

  const bars = hist.map((h, i) => {
    const cx = o.pad + (i + 0.5) * slot;
    const len = Math.max((Math.abs(h.changePct) / max) * maxLen, 2);
    const up = h.changePct >= 0;
    const x0 = cx - bw / 2, x1 = cx + bw / 2, rr = Math.min(r, len);
    const d = up
      ? `M${x0},${mid} V${mid - len + rr} Q${x0},${mid - len} ${x0 + rr},${mid - len} H${x1 - rr} Q${x1},${mid - len} ${x1},${mid - len + rr} V${mid} Z`
      : `M${x0},${mid} V${mid + len - rr} Q${x0},${mid + len} ${x0 + rr},${mid + len} H${x1 - rr} Q${x1},${mid + len} ${x1},${mid + len - rr} V${mid} Z`;
    const txt = `${h.changePct > 0 ? '+' : h.changePct < 0 ? '−' : ''}${Math.abs(h.changePct).toFixed(2)}%`;
    return svgEl('path', { d, fill: up ? CHART_INK.up : CHART_INK.down }) +
      svgEl('text', { x: cx, y: up ? mid - len - 7 : mid + len + 15, 'font-size': 12, 'font-weight': 700,
                      'text-anchor': 'middle', fill: CHART_INK.fg }, `${up ? '▲' : '▼'} ${txt}`) +
      svgEl('text', { x: cx, y: o.h - 4, 'font-size': 12, 'text-anchor': 'middle', fill: CHART_INK.dim }, `第${h.wave}波`) +
      // 觸發區比長條大：整個欄位都算
      svgEl('rect', { x: cx - slot / 2, y: 0, width: slot, height: o.h - o.waveRow, fill: 'transparent', tabindex: 0,
                      'data-tip': `第 ${h.wave} 波  ${txt}\n收盤 ${money(h.price)}`,
                      'aria-label': `第 ${h.wave} 波${up ? '上漲' : '下跌'} ${Math.abs(h.changePct).toFixed(2)}%，收盤 ${money(h.price)}` });
  }).join('');

  const axis = svgEl('line', { x1: o.pad - 6, y1: mid, x2: o.w - o.pad + 6, y2: mid, stroke: CHART_INK.axis, 'stroke-width': 1 });
  return `<div class="chart">${svgEl('svg', { viewBox: `0 0 ${o.w} ${o.h}`, width: o.w, height: o.h,
            role: 'group', 'aria-label': '各波漲跌幅' }, axis + bars)}</div>`;
}
