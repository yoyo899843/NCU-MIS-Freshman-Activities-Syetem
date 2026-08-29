const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');

const router = express.Router();
router.use(schoolAuth);

// 數位偵探：科技樹槽位放置線索、檢查邏輯、分支劇情閱讀。
// 骨架階段先回 501，實際邏輯（拖曳判定、扣分計算）留待下一輪功能開發。
router.get('/', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/slots/:slotId/place', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.post('/check', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.get('/branches/:branchId/story', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
