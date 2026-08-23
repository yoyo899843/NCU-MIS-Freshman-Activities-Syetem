require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

// 不對外暴露的 CLI script，系統管理員在伺服器上直接執行：
//   node scripts/create-admin.js <email> <password> [displayName]
// 沒有任何 HTTP 端點可以新增 admin 帳號。

async function main() {
  const [email, password, displayName] = process.argv.slice(2);

  if (!email || !password) {
    console.error('用法: node scripts/create-admin.js <email> <password> [displayName]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('密碼長度至少需要 8 個字元');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.query(
    `INSERT INTO admin_users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [email, passwordHash, displayName || null]
  );

  console.log(`admin 帳號已建立/更新: ${email}`);
  await db.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
