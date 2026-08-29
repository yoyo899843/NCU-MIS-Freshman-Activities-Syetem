const express = require('express');
const schoolAuth = require('../middleware/schoolAuth');

const router = express.Router();
router.use(schoolAuth);

// QR 掃描取得線索、線索庫清單（依取得時間序排列）。
// 骨架階段先回 501，實際邏輯留待下一輪功能開發。
router.post('/scan', (req, res) => res.status(501).json({ error: 'not implemented' }));
router.get('/vault', (req, res) => res.status(501).json({ error: 'not implemented' }));

module.exports = router;
