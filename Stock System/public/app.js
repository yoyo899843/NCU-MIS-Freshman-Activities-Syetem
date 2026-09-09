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
