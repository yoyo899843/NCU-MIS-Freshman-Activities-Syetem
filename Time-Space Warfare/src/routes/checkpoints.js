const express = require('express');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');
const challenge = require('../checkpoints/session');

const router = express.Router();

router.use(playerAuth);

// 掃 QR 開始挑戰。qr_token 印在現場交摺點的實體 QR Code 上。
router.post('/:qrToken/challenge', asyncHandler(async (req, res) => {
  const { rows: stateRows } = await db.query('SELECT status FROM game_state WHERE id = 1');
  if (stateRows[0]?.status !== 'in_progress') {
    return res.status(403).json({ error: 'game is not in progress', status: stateRows[0]?.status });
  }

  // 跟 RPG 的線索碼一樣不分大小寫：掃碼一定正確，但這一頁有手動輸入的備援路徑。
  // qr_token 產生時就是大寫（見 admin.js 的 generateQrToken）。
  const { rows } = await db.query(
    'SELECT id, name FROM checkpoints WHERE qr_token = $1',
    [String(req.params.qrToken).trim().toUpperCase()]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'invalid QR code' });
  const checkpoint = rows[0];

  try {
    const { challengeId, question } = await challenge.createChallenge({
      checkpointId: checkpoint.id,
      playerId: req.player.sub,
      teamId: req.player.teamId,
      faction: req.player.faction
    });
    res.status(201).json({
      challengeId,
      checkpoint: { id: checkpoint.id, name: checkpoint.name },
      faction: req.player.faction,
      question
    });
  } catch (err) {
    // 題庫還沒建好的話回 503 而不是 500——這是「現在還不能玩」，不是程式壞了，
    // 現場關主看到這個訊息就知道要去後台補題目。
    if (err.code === 'NO_QUESTIONS') {
      return res.status(503).json({ error: '這個交摺點還沒有題目，請通知主辦人員' });
    }
    throw err;
  }
}));

// 提交一題的答案。choice 傳 "A"~"D"，倒數歸零沒作答就傳 null。
router.post('/challenge/:id/answer', asyncHandler(async (req, res) => {
  const { questionIndex, choice } = req.body || {};
  if (!Number.isInteger(questionIndex)) {
    return res.status(400).json({ error: 'questionIndex is required' });
  }
  if (choice !== null && !['A', 'B', 'C', 'D'].includes(choice)) {
    return res.status(400).json({ error: 'choice must be A, B, C, D or null' });
  }

  const session = challenge.getForPlayer(req.params.id, req.player.sub);
  if (!session) return res.status(404).json({ error: 'challenge not found or already finished' });

  let result;
  try {
    result = challenge.submitAnswer(session, questionIndex, choice ?? null);
  } catch (err) {
    if (err.code === 'INDEX_MISMATCH') {
      return res.status(409).json({ error: 'question index does not match the current question' });
    }
    if (err.code === 'FINISHED') {
      return res.status(409).json({ error: 'this challenge is already finished' });
    }
    throw err;
  }

  if (!result.finished) return res.json(result);

  // 整場答完，這時候才寫資料庫（見 src/checkpoints/session.js 的 persistResult）
  const { attemptId, checkpoint } = await challenge.persistResult(session);
  res.json({
    ...result,
    summary: {
      attemptId,
      correctCount: session.correctCount,
      totalQuestions: session.questions.length,
      totalScore: session.totalScore,
      faction: session.faction,
      checkpoint: {
        id: checkpoint.id,
        name: checkpoint.name,
        repairValue: Number(checkpoint.repair_value),
        disruptValue: Number(checkpoint.disrupt_value)
      }
    }
  });
}));

module.exports = router;
