// 數位偵探計分規則。玩家端（routes/tech-tree.js）和戰況板（routes/admin.js）
// 都從這裡算，兩邊看到的數字才會一致。
//
// - 答對＝線索放在正確的分支（同一分支任一格都算），按提交驗證後那格鎖定：得分 +5
// - 答錯＝線索放在不屬於它的分支，每一次驗證失敗：推理失誤分 +2
// - 沒放的格子不算任何分數
// - 總分＝得分 − 推理失誤分，結束時用來排名
//
// 得分跟推理失誤分分開累計、各自都只會增加，不在過程中直接「扣分」。
const POINTS_PER_CORRECT = 5;
const MISTAKE_POINTS_PER_WRONG = 2;

function techTreeScore(correctCount, wrongCount) {
  const earnedScore = correctCount * POINTS_PER_CORRECT;
  const mistakeScore = wrongCount * MISTAKE_POINTS_PER_WRONG;
  return { earnedScore, mistakeScore, totalScore: earnedScore - mistakeScore };
}

module.exports = { POINTS_PER_CORRECT, MISTAKE_POINTS_PER_WRONG, techTreeScore };
