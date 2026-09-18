/*
 * Portal 連結設定。
 * 收到正式網址後，只要填入相對應的 playerUrl / adminUrl；留空字串代表暫不顯示連結。
 */
window.PORTAL_LINKS = {
  portalUrl: 'https://宿營.佑佑.台灣',
  activities: [
    { id: 'rpg', icon: '◈', title: '數位偵探', subtitle: '資管皇家學院探查任務', playerUrl: 'https://rpg.佑佑.台灣', adminUrl: 'https://rpg.佑佑.台灣/admin' },
    { id: 'stock', icon: '↗', title: '賭大股票', subtitle: '新聞情報與投資交易', playerUrl: 'https://賭大.佑佑.台灣', adminUrl: 'https://賭大.佑佑.台灣/admin' },
    { id: 'final', icon: '★', title: '總積分榜', subtitle: '三項活動的最終結算', playerUrl: 'https://總分.佑佑.台灣', adminUrl: 'https://總分.佑佑.台灣/admin.html' }
  ]
};
