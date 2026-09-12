// 玩家端與管理後台共用的畫面小工具：圖示、漲跌膠囊、狀態徽章。
//
// 刻意不在這裡宣告 $、esc、money、api——那些 app.js（玩家端）和 admin.js（後台）
// 各有一份、行為不同（打的 API 前綴不一樣），這支兩邊都會載入，重複宣告同名的
// const 會直接變成 SyntaxError，整頁的 script 都不會跑。
//
// 載入順序：ui.js → app.js / admin.js → 頁面自己的 script。

// 圖示一律 inline SVG，同一套語言（stroke 1.75、圓角端點）。不連 CDN、不用 icon
// font：活動現場的網路不一定通得到外面，外部圖示載不到會變成一排空白。
const UI_ICONS = {
  news:    '<rect x="3.5" y="5" width="13" height="14" rx="1.5"/><path d="M16.5 8.5H20v9a1.5 1.5 0 0 1-3 0V8.5M7 9h6M7 12.5h6M7 16h4"/>',
  chart:   '<path d="M4 19.5h16"/><path d="M5 15l4-4 3 3 6-7"/><path d="M14 7h4v4"/>',
  trade:   '<path d="M7 4 3.5 7.5 7 11M3.5 7.5H17M17 13l3.5 3.5L17 20M20.5 16.5H7"/>',
  trophy:  '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H4.5v1.5A3.5 3.5 0 0 0 8 11M16 6h3.5v1.5A3.5 3.5 0 0 1 16 11M12 13v4M8.5 20h7M10 17h4"/>',
  bank:    '<path d="M3.5 9.5 12 4l8.5 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17"/>',
  wallet:  '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M16 13.5h.01"/>',
  list:    '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  users:   '<circle cx="9" cy="8" r="3.5"/><path d="M3 19.5a6 6 0 0 1 12 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14a6 6 0 0 1 3 5.5"/>',
  key:     '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l2 2M14 8l2 2"/>',
  tag:     '<path d="M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5-8.5 8.5L3.5 12Z"/><circle cx="8" cy="8" r="1.4"/>',
  flag:    '<path d="M5 20.5V4M5 4.5h11l-2 3.5 2 3.5H5"/>',
  screen:  '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/>',
  logout:  '<path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4H9"/><path d="M15 8l4 4-4 4M19 12H9"/>',
  back:    '<path d="M15 5l-7 7 7 7"/>',
  check:   '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x:       '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  gear:    '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M4.6 7.2l1.7 1M17.7 15.8l1.7 1M4.6 16.8l1.7-1M17.7 8.2l1.7-1"/>',
  // 匯出／匯入：同一個托盤加上相反方向的箭頭，一組看就知道是一對。
  download: '<path d="M12 3.5v11M8 11l4 4 4-4"/><path d="M4.5 16.5v2A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-2"/>',
  upload:   '<path d="M12 20.5v-11M8 13l4-4 4 4"/><path d="M4.5 16.5v2A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-2"/>',
  file:     '<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Z"/><path d="M13.5 3.5v5h5M8.5 13h7M8.5 16.5h4"/>'
};

function icon(name, cls) {
  const body = UI_ICONS[name];
  if (!body) return '';
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

// 靜態 HTML 裡寫 <i data-icon="news"></i>，載入時換成真正的 SVG。
// 這樣 13 個頁面的 HTML 不用各自貼一堆 path，要換圖示只改上面這張表。
function hydrateIcons(root) {
  (root || document).querySelectorAll('i[data-icon]').forEach(el => {
    const cls = el.getAttribute('data-size') ? 'ic-' + el.getAttribute('data-size') : '';
    el.outerHTML = icon(el.getAttribute('data-icon'), cls);
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => hydrateIcons());
} else {
  hydrateIcons();
}

// 漲跌膠囊：顏色＋三角形＋正負號三重編碼。
// 台股慣例紅漲綠跌，但紅綠色盲分不出這兩個色，只靠顏色等於沒講——
// 所以形狀（▲▼）和正負號才是主要訊息，顏色是輔助。
function chgHtml(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) {
    return '<span class="chg">—</span>';
  }
  const n = Number(p);
  const txt = (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
  if (n === 0) return `<span class="chg" aria-label="持平">${txt}</span>`;
  const up = n > 0;
  const tri = up
    ? '<svg class="tri" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.8 9 8.2H1z"/></svg>'
    : '<svg class="tri" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8.2 1 1.8h8z"/></svg>';
  return `<span class="chg ${up ? 'up' : 'dn'}" aria-label="${up ? '上漲' : '下跌'} ${Math.abs(n).toFixed(2)}%">${tri}${txt}</span>`;
}

// 狀態徽章：審核中／已通過／遭拒。一樣是顏色＋文字＋圖示，不只靠顏色。
const DEPOSIT_BADGE = {
  pending:  { cls: 'pending',  text: '審核中' },
  approved: { cls: 'approved', text: '已通過', icon: 'check' },
  rejected: { cls: 'rejected', text: '遭駁回', icon: 'x' }
};
function statusBadge(status) {
  const b = DEPOSIT_BADGE[status] || { cls: 'neutral', text: status || '—' };
  return `<span class="badge ${b.cls}">${b.icon ? icon(b.icon, 'ic-sm') : ''}${b.text}</span>`;
}

function sideBadge(side) {
  return side === 'buy'
    ? '<span class="badge buy">買進</span>'
    : '<span class="badge sell">賣出</span>';
}
