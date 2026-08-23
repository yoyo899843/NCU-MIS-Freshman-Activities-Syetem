const express = require('express');
const router = express.Router();

// 9 個交摺點的即時修復值/破壞值 + 座標。
// 骨架階段先回 501，實際邏輯留待下一輪功能開發。
router.get('/checkpoints', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
