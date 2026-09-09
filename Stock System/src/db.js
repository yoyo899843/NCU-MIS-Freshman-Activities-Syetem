const { Pool } = require('pg');

// 全域共用單一 pool，不要在其他檔案裡各自 new Pool()。
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10
});

module.exports = pool;
