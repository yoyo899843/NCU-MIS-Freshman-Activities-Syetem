const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');

const router = express.Router();
router.use(schoolAuth);

// 10 個關卡點位 + 這隊的解鎖/挑戰狀態 + 線索取得進度。
// 骨架階段先回 501，實際邏輯留待下一輪功能開發。
router.get('/', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
