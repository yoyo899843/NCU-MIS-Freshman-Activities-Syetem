const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');

const router = express.Router();
router.use(schoolAuth);

// 長老候選人清單。
// 骨架階段先回 501，實際邏輯留待下一輪功能開發。
router.get('/', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
