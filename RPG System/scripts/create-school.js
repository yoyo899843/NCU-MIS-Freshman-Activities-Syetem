require('dotenv').config();
const db = require('../src/db');

// 不對外暴露的 CLI script，主辦在伺服器上直接執行，建立/重設固定學派帳號：
//   node scripts/create-school.js <username> <password> <displayName>
// 密碼明碼儲存（不雜湊）——主辦要能直接查得到某組學派的帳密，忘記時不用重設。
// 這支 script 適合活動前一次建立多組帳號；活動期間要新增/改密碼，用後台的
// 「學派管理」頁面（/admin/schools.html）更方便，兩者操作的是同一張 schools 表。
// 忘記密碼直接用同一個 username 重新執行即可覆蓋。

async function main() {
  const [username, password, displayName] = process.argv.slice(2);

  if (!username || !password || !displayName) {
    console.error('用法: node scripts/create-school.js <username> <password> <displayName>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('密碼長度至少需要 8 個字元');
    process.exit(1);
  }

  await db.query(
    `INSERT INTO schools (username, password, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, display_name = EXCLUDED.display_name`,
    [username, password, displayName]
  );

  console.log(`學派帳號已建立/更新: ${username}（${displayName}）`);
  await db.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
