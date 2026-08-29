const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');

const router = express.Router();
router.use(schoolAuth);

// 最終投票（開放與否由 game_state.voting_unlocked_at 控制）。
// 骨架階段先回 501，實際邏輯留待下一輪功能開發。
router.post('/', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
