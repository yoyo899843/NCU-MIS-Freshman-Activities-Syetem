require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

// 不對外暴露的 CLI script，主辦在伺服器上直接執行，建立/重設 5 組固定學派帳號：
//   node scripts/create-school.js <username> <password> <displayName>
// 這是主辦控制的固定帳號（不是玩家自己設的、需要被隊輔查詢的 PIN），所以密碼維持雜湊儲存，
// 不比照 Time-Space Warfare 玩家 PIN 的明碼做法。忘記密碼直接用同一個 username 重新執行即可覆蓋。

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

  const passwordHash = await bcrypt.hash(password, 12);

  await db.query(
    `INSERT INTO schools (username, password_hash, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name`,
    [username, passwordHash, displayName]
  );

  console.log(`學派帳號已建立/更新: ${username}（${displayName}）`);
  await db.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
