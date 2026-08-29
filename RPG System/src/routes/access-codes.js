const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');

const router = express.Router();
router.use(schoolAuth);

// 權限碼兌換：關卡解鎖碼 / 隱藏線索碼。
// 骨架階段先回 501，實際邏輯留待下一輪功能開發。
router.post('/redeem', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
