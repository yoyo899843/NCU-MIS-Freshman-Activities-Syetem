// 後台操作紀錄：寫進 log 檔，不存資料庫、不在網頁上顯示，主辦要查就到伺服器上看。
//
// 一筆一行、用 tab 分欄：時間　誰　做了什麼　對誰
//   2026-09-12 14:03:27	關主 小明	派發線索「古書頁碼」	鳳凰學派
//   2026-09-12 14:05:10	管理員 主辦	刪除關卡	資訊圖書館
// 只記名稱與動作，不記修改前後的內容，檔案才不會越長越大。
//
// 檔案位置：預設 <專案>/logs/actions.log（Docker 裡是 /app/logs/actions.log，
// compose.yml 把它掛到主機的 ./logs），可以用 ACTION_LOG_PATH 改。
const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.ACTION_LOG_PATH || path.join(__dirname, '..', 'logs', 'actions.log');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// 用同一條 append stream 依序寫，多個請求同時寫也不會把行弄亂
const stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
stream.on('error', err => console.error('寫入操作紀錄失敗：', err.message));

// 容器的時區是 UTC，時間一律換成台灣時間，看紀錄的人不用自己加 8 小時。
// sv-SE 的格式剛好是 2026-09-12 14:03:27。
const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

// 名稱都是使用者輸入的，換行／tab 換成空白：一筆紀錄永遠只佔一行，
// 也不能靠在名字裡塞換行偽造出另一筆紀錄。
const oneLine = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();

function actorLabel(admin) {
  const role = admin.adminRole === 'gatekeeper' ? '關主' : '管理員';
  return `${role} ${oneLine(admin.displayName || admin.email || `#${admin.sub}`)}`;
}

// admin：req.admin（adminAuth 會從資料庫帶入最新的名稱與權限）
// action：做了什麼，例如「派發線索「古書頁碼」」
// target：對誰／對什麼，例如隊伍名稱；沒有特定對象就不用給
function logAction(admin, action, target) {
  const line = [timeFormat.format(new Date()), actorLabel(admin), oneLine(action), oneLine(target) || '-'].join('\t');
  stream.write(line + '\n');
}

module.exports = { logAction, LOG_PATH };
