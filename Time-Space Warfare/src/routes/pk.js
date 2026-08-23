const express = require('express');
const router = express.Router();

// PK 對戰開房/加入。
// 骨架階段先回 501，實際的 roomCode -> duelId 對照表、即時配對邏輯留待下一輪功能開發。
router.post('/create', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/join', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
