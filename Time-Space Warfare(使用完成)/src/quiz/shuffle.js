// 選項洗牌：資料庫裡的 A/B/C/D 只是儲存用的固定欄位，不代表玩家畫面上看到的順序。
// 每抽到一題就當場重新洗牌決定這一次要顯示的順序，並記住「洗牌後真正正確的按鈕是哪一個」；
// 同一題之後不管送幾次（含斷線重連補送）都用同一份洗牌結果，順序不會變來變去。
//
// PK 對戰（src/pk/session.js）與交摺點挑戰（src/checkpoints/session.js）共用這一份，
// 避免兩邊各寫一套之後行為悄悄不一致。
function shuffleOptions(q) {
  const originalLabels = ['A', 'B', 'C', 'D'];
  const optionTextByLabel = { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d };

  for (let i = originalLabels.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [originalLabels[i], originalLabels[j]] = [originalLabels[j], originalLabels[i]];
  }

  const displayLabels = ['A', 'B', 'C', 'D'];
  const displayOptions = {};
  let correctDisplayLabel = null;
  originalLabels.forEach((origLabel, i) => {
    const displayLabel = displayLabels[i];
    displayOptions[displayLabel] = optionTextByLabel[origLabel];
    if (origLabel === q.correct_option) correctDisplayLabel = displayLabel;
  });

  return { displayOptions, correctDisplayLabel };
}

module.exports = { shuffleOptions };
