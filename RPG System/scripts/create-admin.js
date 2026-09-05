require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

// 不對外暴露的 CLI script，系統管理員在伺服器上直接執行：
//   node scripts/create-admin.js <email> <password> [displayName] [role]
// 沒有任何 HTTP 端點可以「新增」管理端帳號（改既有帳號的權限層級可以在後台做，
// 見 /admin/api/admins/:id/role，但新增帳號一律只能從這裡）。
//
// role 可以填 admin（管理員，預設）或 gatekeeper（關主，只能做現場操作）。
// 同一個 email 重複執行就是重設密碼；有帶 role 就順便改權限，沒帶就保留原本的。

const ROLES = ['admin', 'gatekeeper'];

async function main() {
  const [email, password, displayName, role] = process.argv.slice(2);

  if (!email || !password) {
    console.error('用法: node scripts/create-admin.js <email> <password> [displayName] [admin|gatekeeper]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('密碼長度至少需要 8 個字元');
    process.exit(1);
  }
  if (role && !ROLES.includes(role)) {
    console.error(`role 只能是 ${ROLES.join(' 或 ')}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { rows } = await db.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, COALESCE($4, 'admin'))
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = COALESCE($4, admin_users.role)
     RETURNING role`,
    [email, passwordHash, displayName || null, role || null]
  );

  console.log(`admin 帳號已建立/更新: ${email}（權限：${rows[0].role}）`);
  await db.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
