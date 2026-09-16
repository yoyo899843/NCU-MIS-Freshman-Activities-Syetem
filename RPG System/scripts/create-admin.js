require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

// 不對外暴露的 CLI script，系統管理員在伺服器上直接執行：
//   node scripts/create-admin.js <email> <password> [displayName] [role]
//   node scripts/create-admin.js delete <email>
// 沒有任何 HTTP 端點可以「新增」管理端帳號（改既有帳號的權限層級可以在後台做，
// 見 /admin/api/admins/:id/role，但新增帳號一律只能從這裡）。
//
// role 可以填 admin（管理員，預設）或 gatekeeper（關主，只能做現場操作）。
// 同一個 email 重複執行就是重設密碼；有帶 role 就順便改權限，沒帶就保留原本的。
//
// delete 刪除指定帳號，但永遠保留至少一個管理員——全刪光就再也沒有人能登入後台，
// 只能重新 SSH 進來跑這支 script。後台網頁只刪得掉關主帳號（見 routes/admin.js 的
// DELETE /admins/:id，管理員會被擋下並提示「只能在伺服器上用 CLI 調整」），
// 管理員帳號一律從這裡刪。
//
// 舊的稽核紀錄不會跟著消失：admin_actions 的外鍵是 ON DELETE SET NULL，而且每筆
// 寫入時就存了操作者的 email／名稱快照（migrations/012），帳號刪掉之後紀錄還在、
// 也還看得出當初是誰做的。

const ROLES = ['admin', 'gatekeeper'];

function printUsage() {
  console.error('建立/更新：node scripts/create-admin.js <email> <password> [displayName] [admin|gatekeeper]');
  console.error('刪除帳號：node scripts/create-admin.js delete <email>');
}

async function deleteAdmin(email) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE：兩個人同時刪最後兩個管理員時，鎖住這一列讓下面的數量檢查有意義
    const { rows } = await client.query(
      'SELECT id, email, display_name, role FROM admin_users WHERE email = $1 FOR UPDATE', [email]
    );
    const target = rows[0];
    if (!target) throw new Error(`找不到管理端帳號：${email}`);

    if (target.role === 'admin') {
      const { rows: counts } = await client.query(
        `SELECT COUNT(*)::int AS count FROM admin_users WHERE role = 'admin'`
      );
      if (counts[0].count <= 1) {
        throw new Error('不能刪除最後一個管理員帳號（刪掉就沒有人能管理後台了）');
      }
    }

    const { rows: actions } = await client.query(
      'SELECT COUNT(*)::int AS count FROM admin_actions WHERE admin_user_id = $1', [target.id]
    );

    await client.query('DELETE FROM admin_users WHERE id = $1', [target.id]);
    await client.query('COMMIT');

    console.log(`管理端帳號已刪除：${target.email}（${target.display_name || '未命名'}，權限：${target.role}）`);
    if (actions[0].count > 0) {
      console.log(`保留 ${actions[0].count} 筆舊稽核紀錄，仍看得到當初的操作者名稱。`);
    }
    console.log('這個帳號已登入的裝置會在下一次操作時被登出。');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function upsertAdmin(email, password, displayName, role) {
  if (!email || !password) {
    printUsage();
    throw new Error('email 與密碼都必填');
  }
  if (password.length < 8) {
    throw new Error('密碼長度至少需要 8 個字元');
  }
  if (role && !ROLES.includes(role)) {
    throw new Error(`role 只能是 ${ROLES.join(' 或 ')}`);
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
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'delete') {
    if (args.length !== 2 || !args[1]) {
      printUsage();
      throw new Error('刪除時請只提供帳號 email');
    }
    await deleteAdmin(args[1]);
    return;
  }

  await upsertAdmin(...args);
}

main()
  .catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
