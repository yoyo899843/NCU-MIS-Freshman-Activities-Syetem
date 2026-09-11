// 管理後台共用。外觀在 ../style.css，圖示／漲跌膠囊／狀態徽章在 ../ui.js（要先載入）。
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const PHASE_LABEL = {
  news: '階段一 · 新聞發布', gambling: '階段二 · 賭博賺錢（實體）',
  deposit: '階段三 · 資產申報與銀行審核', trading: '階段四 · 股票交易', closed: '已收盤'
};
const DEPOSIT_LABEL = { pending: '審核中', approved: '已通過', rejected: '已駁回' };
const pctText = p => (p === null || p === undefined) ? '—' : `${p > 0 ? '+' : ''}${p}%`;

function adminToken() { return localStorage.getItem('stockAdminToken'); }

async function api(path, options = {}) {
  const res = await fetch('/admin/api' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(adminToken() ? { Authorization: 'Bearer ' + adminToken() } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 401 && adminToken()) {
    localStorage.removeItem('stockAdminToken');
    location.href = 'login.html';
    throw new Error('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function requireAdminLogin() {
  if (!adminToken()) { location.href = 'login.html'; return false; }
  return true;
}
