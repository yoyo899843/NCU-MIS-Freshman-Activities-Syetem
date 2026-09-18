// 共用：登入 token 過期（或被撤銷）時自動清掉本機資訊、導回登入頁。
//
// 判斷條件刻意只看「這次請求本身有沒有帶 Authorization: Bearer」，不管回應內容
// 長怎樣——這樣才不會誤攔登入表單送出密碼錯誤時的那個 401（那個請求打的是
// /api/auth/login 或 /admin/api/login，本來就沒帶 token，401 在那邊代表「帳號
// 密碼錯誤」，該留在原地顯示錯誤訊息，不是 session 過期，不該被導頁走）。
//
// 三種角色（管理員/學派/玩家）共用同一份邏輯：一次性把全部已知的 token/資訊
// 清掉沒關係，反正接下來就是要離開這一頁了；哪一個 key 其實有值、要清什麼，
// 不需要每個頁面自己分辨。
//
// 用法：在會打帶 token 的 API 的頁面，最先載入這支 script（放在其他 <script>
// 之前），之後頁面裡不管是用哪個 fetch 寫法都會自動套用，不用逐一修改。
(function () {
  if (window.__authFetchInstalled) return;
  window.__authFetchInstalled = true;

  var TOKEN_KEYS = ['adminToken', 'schoolToken', 'playerToken'];
  var INFO_KEYS = ['schoolInfo', 'playerInfo'];

  function extractBearer(init) {
    var headers = init && init.headers;
    if (!headers) return null;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return headers.get('Authorization') || headers.get('authorization');
    }
    return headers.Authorization || headers.authorization || null;
  }

  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return originalFetch(input, init).then(function (response) {
      if (response.status === 401) {
        var auth = extractBearer(init);
        if (auth && /^Bearer\s+/i.test(auth) && !/\/login\.html$/.test(location.pathname)) {
          TOKEN_KEYS.forEach(function (k) { localStorage.removeItem(k); });
          INFO_KEYS.forEach(function (k) { localStorage.removeItem(k); });
          // 讓其他還在等這次 401 的呼叫端（例如 index.html 的 /me 檢查）知道
          // 「已經在導頁了」，不用再各自處理一次、也不要在導頁前閃一下舊畫面。
          window.__authRedirecting = true;
          location.href = 'login.html';
          throw new Error('unauthorized: token expired, redirecting to login');
        }
      }
      return response;
    });
  };
})();
