// PK 對戰的兩個逾時，集中在這裡定義——它們之間有先後關係，分散在兩個模組裡
// 各寫各的話，改了一邊很容易讓順序反過來而沒人發現。
//
// 兩段時間量的是不同階段，接續發生：
//
//   開房 ──ROOM_TIMEOUT──> 沒人加入就取消
//     └─ 有人加入(建立 session) ──MATCH_START_TIMEOUT──> 雙方沒到齊就取消
//
// 不變條件：ROOM_TIMEOUT < MATCH_START_TIMEOUT，中間留一段固定緩衝。
// 理由是前端等待畫面的倒數是照 ROOM_TIMEOUT 跑的，而「這場到底作不作廢」最終
// 由伺服器的 MATCH_START 逾時決定；房間逾時必須先到，前端才不會在伺服器都還沒
// 判定的時候就自己把畫面收掉（見 public/pk.html 的 startRoomCountdown）。

// 開房之後沒有人加入就自動取消。
// 現場是房主把 6 碼房號唸給對手、對手手動輸入，30 秒實測太趕（唸完就快到了），
// 拉到 2.5 分鐘；真的沒人來的房間也不會留太久。
const ROOM_TIMEOUT_MS = Number(process.env.PK_ROOM_TIMEOUT_MS) || 150 * 1000;

// 房間逾時之後再多給的緩衝，就是 MATCH_START 比 ROOM 多出來的那一段。
const MATCH_START_GRACE_MS = Number(process.env.PK_MATCH_START_GRACE_MS) || 60 * 1000;

// 有人加入、session 建立之後，雙方都得透過 socket 的 pk:enter 到齊才會出第一題。
// 只有一方到齊的話這裡負責收尾（不判輸、不扣分，見 session.js 的 cancelUnstartedDuel）。
const MATCH_START_TIMEOUT_MS =
  Number(process.env.PK_MATCH_START_TIMEOUT_MS) || ROOM_TIMEOUT_MS + MATCH_START_GRACE_MS;

// 用環境變數各自覆寫時很容易把順序弄反，啟動當下就擋下來，不要等到活動當天才發現。
if (MATCH_START_TIMEOUT_MS <= ROOM_TIMEOUT_MS) {
  throw new Error(
    `PK 逾時設定錯誤：MATCH_START_TIMEOUT_MS (${MATCH_START_TIMEOUT_MS}ms) ` +
    `必須大於 ROOM_TIMEOUT_MS (${ROOM_TIMEOUT_MS}ms)`
  );
}

module.exports = { ROOM_TIMEOUT_MS, MATCH_START_GRACE_MS, MATCH_START_TIMEOUT_MS };
