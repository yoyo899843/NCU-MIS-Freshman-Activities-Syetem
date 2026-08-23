const express = require('express');
const router = express.Router();

// 掃碼開始挑戰 / 提交答案。
// 骨架階段先回 501，實際抽題演算法、計分邏輯留待下一輪功能開發。
router.post('/:qrToken/challenge', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/challenge/:id/answer', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
