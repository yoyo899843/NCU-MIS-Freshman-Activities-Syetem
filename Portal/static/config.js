/*
 * Portal 連結設定。
 * 收到正式網址後，只要填入相對應的 playerUrl / adminUrl；留空字串代表暫不顯示連結。
 * 時空戰爭依主辦要求只提供玩家入口，故不設 adminUrl。
 */
window.PORTAL_LINKS = {
  activities: [
    { id: 'time', icon: '⌁', title: '時空戰爭', subtitle: '據點攻防與 PK 對戰', playerUrl: '' },
    { id: 'rpg', icon: '◈', title: '數位偵探', subtitle: '資管皇家學院探查任務', playerUrl: '', adminUrl: '' },
    { id: 'stock', icon: '↗', title: '賭大股票', subtitle: '新聞情報與投資交易', playerUrl: '', adminUrl: '' },
    { id: 'match', icon: '⚔', title: '對抗賽', subtitle: '五學派 A／B 隊賽果', playerUrl: '', adminUrl: '' },
    { id: 'final', icon: '★', title: '總積分榜', subtitle: '四項活動的最終結算', playerUrl: '', adminUrl: '' }
  ]
};
