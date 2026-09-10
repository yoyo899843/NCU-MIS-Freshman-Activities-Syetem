// 全站共用頁尾。
//
// 用 JS 注入而不是把同一段 HTML 貼到 18 個檔案裡：這個專案的頁面還在持續增減
// （光是後台最近就多了 game.html、voting.html），貼死的話每加一頁就要記得補，
// 改一次連結要改 18 個地方。頁面本來就全部依賴 JS 取資料，多這一支不影響什麼。
//
// 樣式在 public/style.css 的 .site-footer，這裡只負責產生結構。

(function () {
  if (window.__siteFooterInstalled) return;   // 重複載入時不要疊兩個
  window.__siteFooterInstalled = true;

  // 圖示一律用 inline SVG，不連 CDN 也不用 icon font。
  // 活動當天現場網路不一定通得到外面（整個專案連地圖圖磚都是自己 host 的），
  // 外部圖示載不到就會變成一排破圖或空白。
  const ICONS = {
    instagram:
      '<rect x="2" y="2" width="20" height="20" rx="5.5"/>' +
      '<circle cx="12" cy="12" r="4.6"/>' +
      '<circle cx="17.6" cy="6.4" r="1.4" fill="currentColor" stroke="none"/>',
    blog:
      '<circle cx="12" cy="12" r="9.5"/>' +
      '<path d="M2.5 12h19"/>' +
      '<path d="M12 2.5c2.6 2.7 3.9 6 3.9 9.5s-1.3 6.8-3.9 9.5c-2.6-2.7-3.9-6-3.9-9.5S9.4 5.2 12 2.5z"/>',
    github:
      '<path fill="currentColor" stroke="none" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C16.9 4 17.9 4.3 17.9 4.3c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z"/>'
  };

  const LINKS = [
    { key: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/yoyo_c170m_/' },
    { key: 'blog',      label: 'Blog',      url: 'https://blog.yoyo899843.com' },
    { key: 'github',    label: 'GitHub',    url: 'https://github.com/yoyo899843' }
  ];

  function iconSvg(key) {
    // stroke 用 currentColor，顏色交給 CSS 的 hover 狀態控制，不用寫兩份
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" ' +
           'fill="none" stroke="currentColor" stroke-width="2" ' +
           'stroke-linecap="round" stroke-linejoin="round">' + ICONS[key] + '</svg>';
  }

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  // 這裡不放 <br> 也不放 &nbsp;。
  //
  // .site-footer 是 display:flex，flex item 不參與行內排版——<br> 會被當成一個
  // flex item，不會斷行（實測加不加完全一樣），還會多吃掉一個 gap 的寬度。
  // 連結之間的間距也一樣，交給 CSS 的 gap；用 &nbsp; 撐的話最後一顆按鈕後面會
  // 留下一段接不到東西的懸空空白。間距要調就改 style.css 的 .site-footer .links。
  footer.innerHTML =
    '<span class="made">Made by 施佑佑</span>' +
    '<span class="links">' +
      LINKS.map(l =>
        // 外部連結一律 rel="noopener noreferrer"：target="_blank" 開出去的分頁
        // 預設拿得到 window.opener，可以把原本這一頁導去別的地方。
        `<a class="flink" href="${l.url}" target="_blank" rel="noopener noreferrer">` +
          iconSvg(l.key) + `<span>${l.label}</span>` +
        '</a>'
      ).join('') +
    '</span>';

  // DOM 還沒好就等一下——這支 script 可能被放在 <head> 或頁面中間
  if (document.body) {
    document.body.appendChild(footer);
  } else {
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(footer));
  }
})();
