const express = require('express');
const router = express.Router();

// 玩家登入分隊：隨機平均分發陣營/小隊、簽發 token。
// 骨架階段先回 501，實際邏輯留待下一輪功能開發。
router.post('/join', (req, res) => res.status(501).json({ error: 'not implemented' }));

router.get('/me', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
