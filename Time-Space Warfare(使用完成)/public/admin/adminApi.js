// 管理後台各頁共用的樣板。
//
// 抽出來之前，每一頁都各自複製同一份 token 檢查 ＋ api() ＋ escapeHtml() ＋
// loadMe()，大約三十行。後台頁面拆得越細（遊戲進程、最終審判各自獨立成頁），
// 這份複製就越多份，改一個地方要記得改 N 個檔案。
//
// 用法：在 ../authFetch.js 之後、頁面自己的 script 之前載入。

const token = localStorage.getItem('adminToken');
if (!token) location.href = 'login.html';

// 所有管理端 API 都走這裡。401 一律導回登入頁——token 過期不會讓 localStorage
// 自動清空，不處理的話畫面會停在已登入狀態、每個操作都默默失敗。
//
// 401 也可能是「這個帳號已經被刪掉了」：middleware/adminAuth.js 現在會回資料庫
// 確認帳號還在，不是只驗簽章。
async function api(path, options = {}) {
  const res = await fetch('/admin/api' + path, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) }
  });
  if (res.status === 401) {
    localStorage.removeItem('adminToken');
    location.href = 'login.html';
    throw new Error('unauthorized');
  }
  return res;
}

// 送 JSON 的簡寫。後台幾乎每個寫入操作都是這個形狀，少寫一次 headers 就少一次
// 忘記加 Content-Type 而收到 400 的機會。
function apiJson(path, method, body) {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const $ = id => document.getElementById(id);

// 把一段訊息顯示成成功或失敗。兩者共用同一個 <p>，所以 class 一定要一起換掉，
// 不然上一次的紅字狀態會留著、把成功訊息也染成錯誤色。
function showMsg(id, text, ok) {
  const el = $(id);
  if (!el) return;
  el.className = ok ? 'hint' : 'error';
  el.textContent = text;
}

// 依登入者的權限層級決定畫面。回傳 isAdmin。
//
// 純前端隱藏只是介面上的體貼，真正的權限是後端 middleware/gatekeeperGuard.js
// 在擋，關主就算自己打 API 也一樣會被 403。
//
// wholePage: true 用在「整頁都只有管理員能用」的頁面（遊戲進程、最終審判）。
// 關主進來會看到一句說明，而不是一整頁按不動的按鈕——按鈕全部 disabled 卻不說
// 為什麼，比直接講「這一頁你沒有權限」更難懂。
async function loadMe(options = {}) {
  const res = await api('/me');
  const me = await res.json();
  const isAdmin = me.adminRole === 'admin';

  const roleEl = $('roleLabel');
  if (roleEl) roleEl.textContent = isAdmin ? '管理員' : '關主';

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });

  if (options.wholePage && !isAdmin) {
    const note = $('gatekeeperBlock');
    if (note) note.style.display = '';
  }
  return isAdmin;
}

// 遊戲狀態的中文標籤，遊戲進程頁和最終審判頁都會用到。
const STATUS_LABELS = { not_started: '未開始', in_progress: '進行中', ended: '已結束' };
