require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

// 不對外暴露的 CLI script，主辦在伺服器上直接執行：
//   node scripts/create-admin.js <email> <password> [displayName] [admin|banker]
//   node scripts/create-admin.js delete <email>
// 沒有任何 HTTP 端點可以新增管理端帳號——新增一律只能從這裡。
// role：admin（主辦，全部功能）或 banker（銀行攤位關主，只能審核存款）。
//
// delete 刪除指定帳號，但永遠保留至少一個主辦帳號。後台網頁也刪得掉帳號，不過
// 「已經留下操作紀錄」的帳號會被擋下來（見 routes/admin.js 的 DELETE /admins/:id）；
// 這支 script 是那種情況下的唯一途徑，會把稽核紀錄的關聯清成 NULL 再刪帳號——
// 紀錄本身留著（稽核頁的操作者會顯示「（已刪除帳號）」），不會整筆消失。
const ROLES = ['admin', 'banker'];

function printUsage() {
  console.error('建立/更新：node scripts/create-admin.js <email> <password> [displayName] [admin|banker]');
  console.error('刪除帳號：node scripts/create-admin.js delete <email>');
}

async function deleteAdmin(email) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE：兩個人同時刪最後兩個主辦時，鎖住這一列讓下面的數量檢查有意義
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
        throw new Error('不能刪除最後一個主辦帳號（刪掉就沒有人能管理後台了）');
      }
    }

    // 這兩張表的外鍵沒有 ON DELETE 動作，不先清掉關聯會直接被外鍵擋住。
    // 清成 NULL 而不是把資料一起刪：稽核紀錄與存款審核結果都要留著。
    const { rowCount: actionCount } = await client.query(
      'UPDATE admin_actions SET admin_user_id = NULL WHERE admin_user_id = $1', [target.id]
    );
    const { rowCount: depositCount } = await client.query(
      'UPDATE deposits SET reviewed_by = NULL WHERE reviewed_by = $1', [target.id]
    );

    await client.query('DELETE FROM admin_users WHERE id = $1', [target.id]);
    await client.query('COMMIT');

    console.log(`管理端帳號已刪除：${target.email}（${target.display_name || '未命名'}，權限：${target.role}）`);
    if (actionCount > 0) {
      console.log(`保留 ${actionCount} 筆稽核紀錄，操作者欄位會顯示「（已刪除帳號）」。`);
    }
    if (depositCount > 0) {
      console.log(`保留 ${depositCount} 筆這個帳號審核過的存款，審核結果不變，只是不再記名。`);
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

  console.log(`管理端帳號已建立/更新: ${email}（權限：${rows[0].role}）`);
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
