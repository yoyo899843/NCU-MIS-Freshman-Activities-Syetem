const express = require('express');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(schoolAuth);

// 長老候選人清單，給 voting.html 顯示供指認。候選人本身的管理（新增/編輯/刪除）
// 在 /admin/api/elders，這裡只讀。
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT id, name, description FROM elders ORDER BY id ASC');
  res.json(rows);
}));

module.exports = router;
