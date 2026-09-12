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

function logoutAndRedirect() {
  localStorage.removeItem('stockAdminToken');
  location.href = 'login.html';
  return new Error('unauthorized');
}

async function api(path, options = {}) {
  // 上傳 CSV 時 body 是 FormData，這時候 Content-Type 一定要讓瀏覽器自己帶——
  // multipart 的 header 裡含一段隨機 boundary，手動蓋成 application/json 的話
  // 後端根本解不出檔案（而且錯誤訊息會完全看不出原因）。
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const res = await fetch('/admin/api' + path, {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(adminToken() ? { Authorization: 'Bearer ' + adminToken() } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 401 && adminToken()) throw logoutAndRedirect();
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// 下載後台匯出的檔案。
//
// 不能直接用 <a href="/admin/api/...">：那個請求不會帶 Authorization header，
// 伺服器只會回 401，使用者拿到的是一個裝著錯誤訊息的檔案。所以改成用 fetch 帶
// token 拿回 Blob，再用一個暫時的 <a> 觸發瀏覽器下載。
async function download(path, filename) {
  const res = await fetch('/admin/api' + path, {
    headers: adminToken() ? { Authorization: 'Bearer ' + adminToken() } : {}
  });
  if (res.status === 401 && adminToken()) throw logoutAndRedirect();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: body.error || `匯出失敗（${res.status}）` };
  }

  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 馬上 revoke 會讓部分瀏覽器（Safari）的下載中斷，等一拍再收。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true };
}

// 匯出檔名裡的時間戳。用瀏覽器的本地時間（現場機器都在台灣），跟後台表格上顯示的
// 時間是同一個時區。
function fileStamp() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

function requireAdminLogin() {
  if (!adminToken()) { location.href = 'login.html'; return false; }
  return true;
}
