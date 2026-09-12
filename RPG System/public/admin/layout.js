// 後台共用版面：分類導覽＋登出。每個後台頁在 <head> 用 defer 載入這支，
// <body class="admin-shell">，頁面自己的內容不用改。
//
// - 電腦（>= 1024px）：左側固定側欄
// - 平板／手機：頂端一條「選單」列，點開從左邊滑出同一份導覽
//
// 頁面內容會被包進 <main class="admin-main">，寬度由 admin.css 統一控制，
// 各頁原本寫死的窄版 max-width 就不再生效。
(function () {
  // 分類。adminOnly 的項目關主看不到（真正的權限在後端 gatekeeperGuard，這裡只是不顯示）。
  const NAV = [
    { title: '遊戲進行', items: [
      { href: 'index.html', label: '遊戲控制', adminOnly: true },
      { href: 'scoreboard.html', label: '戰況板' },
      { href: 'gatekeeper.html', label: '關主現場操作' }
    ] },
    { title: '遊戲內容', adminOnly: true, items: [
      { href: 'checkpoints.html', label: '關卡' },
      { href: 'clues.html', label: '線索' },
      { href: 'access-codes.html', label: '權限碼' },
      { href: 'tech-tree.html', label: '科技樹' },
      { href: 'elders.html', label: '長老候選人' }
    ] },
    { title: '帳號管理', adminOnly: true, items: [
      { href: 'schools.html', label: '學派（玩家帳號）' },
      { href: 'admins.html', label: '工作人員帳號' }
    ] }
  ];

  const token = localStorage.getItem('adminToken');
  if (!token) return; // 頁面自己會導回登入頁

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const current = location.pathname.split('/').pop() || 'index.html';

  // 身分先用上一次存的畫出來，避免每換一頁導覽都閃一下；背景再向伺服器確認
  let me = null;
  try { me = JSON.parse(sessionStorage.getItem('adminMe') || 'null'); } catch (e) { /* 忽略 */ }

  function navHtml() {
    const isAdmin = !me || me.adminRole !== 'gatekeeper';
    return NAV.filter(sec => isAdmin || !sec.adminOnly).map(sec => {
      const items = sec.items.filter(it => isAdmin || !it.adminOnly);
      if (!items.length) return '';
      return `
        <div class="nav-section">
          <p class="nav-title">${esc(sec.title)}</p>
          ${items.map(it => `<a href="${it.href}"${it.href === current ? ' aria-current="page"' : ''}>${esc(it.label)}</a>`).join('')}
        </div>`;
    }).join('');
  }

  function whoHtml() {
    if (!me) return '';
    return `<span class="nav-role">${me.adminRole === 'gatekeeper' ? '關主' : '管理員'}</span>${esc(me.displayName || me.email)}`;
  }

  function build() {
    const body = document.body;

    // 1) 頁面原本的內容包進 <main>（script 留在原地，已經執行過了，移不移都一樣）
    const main = document.createElement('main');
    main.className = 'admin-main';
    main.id = 'adminMain';
    [...body.childNodes].forEach(node => {
      if (node.nodeType === 1 && node.tagName === 'SCRIPT') return;
      main.appendChild(node);
    });
    body.prepend(main);

    // 2) 頂端列（平板／手機才看得到）＋ 導覽 ＋ 遮罩
    body.insertAdjacentHTML('afterbegin', `
      <a class="skip-link" href="#adminMain">跳到主要內容</a>
      <header class="admin-topbar">
        <button type="button" class="menu-btn" aria-expanded="false" aria-controls="adminNav">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
          選單
        </button>
        <span class="topbar-title">數位探查儀 後台</span>
      </header>
      <nav id="adminNav" class="admin-nav" aria-label="後台功能">
        <p class="nav-brand">資管皇家學院<br>數位探查儀 · 後台</p>
        <p class="nav-who" id="navWho">${whoHtml()}</p>
        <div id="navLinks">${navHtml()}</div>
        <button type="button" class="nav-logout" id="navLogout">登出</button>
      </nav>
      <div class="nav-scrim" hidden></div>`);

    const btn = body.querySelector('.menu-btn');
    const nav = document.getElementById('adminNav');
    const scrim = body.querySelector('.nav-scrim');

    function setOpen(open) {
      body.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', String(open));
      scrim.hidden = !open;
      if (open) nav.querySelector('a, button')?.focus();
      else btn.focus();
    }
    btn.addEventListener('click', () => setOpen(!body.classList.contains('nav-open')));
    scrim.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && body.classList.contains('nav-open')) setOpen(false);
    });

    document.getElementById('navLogout').addEventListener('click', () => {
      localStorage.removeItem('adminToken');
      sessionStorage.removeItem('adminMe');
      location.href = 'login.html';
    });
  }

  async function refreshMe() {
    try {
      const res = await fetch('/admin/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return; // 401 由 authFetch.js 統一處理（清 token、回登入頁）
      const fresh = await res.json();
      const changed = JSON.stringify(fresh) !== JSON.stringify(me);
      me = fresh;
      sessionStorage.setItem('adminMe', JSON.stringify(me));
      if (changed) {
        document.getElementById('navWho').innerHTML = whoHtml();
        document.getElementById('navLinks').innerHTML = navHtml();
      }
    } catch (e) { /* 網路暫時不通就維持現狀 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
  refreshMe();
})();
