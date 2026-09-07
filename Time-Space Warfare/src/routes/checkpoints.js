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

  // 答完最後一題不代表結束了：通關的話還要選「修復」還是「破壞」（見下面的
  // /challenge/:id/action），據點進度是那一步才會動。
  res.json(result);
}));

// 通關後選擇要對這個據點做什麼：修復（+進度）或破壞（-進度）。
//
// 企劃書：「任何隊伍通關後皆可自由選擇修復或破壞」——所以這裡不看陣營、不擋選項。
// 好人選破壞、內鬼選修復都照做，只是那一次不計第二權重積分（progress.js 會把
// aligned 記下來），這是刻意留給玩家隱藏身分用的。
router.post('/challenge/:id/action', asyncHandler(async (req, res) => {
  const { action } = req.body || {};
  if (!['repair', 'disrupt'].includes(action)) {
    return res.status(400).json({ error: "action must be 'repair' or 'disrupt'" });
  }

  const session = challenge.getForPlayer(req.params.id, req.player.sub);
  if (!session) return res.status(404).json({ error: 'challenge not found or already finished' });

  let result;
  try {
    result = await challenge.chooseAction(session, action);
  } catch (err) {
    if (err.code === 'NOT_FINISHED') {
      return res.status(409).json({ error: '題目還沒答完' });
    }
    if (err.code === 'ALREADY_SETTLED') {
      return res.status(409).json({ error: '這場挑戰已經結算過了' });
    }
    if (err.code === 'NOT_PASSED') {
      return res.status(403).json({ error: '這次沒有通關，不能改變據點進度' });
    }
    if (err.code === 'CHECKPOINT_NOT_FOUND') {
      return res.status(404).json({ error: 'checkpoint not found' });
    }
    throw err;
  }

  res.json({
    action,
    aligned: result.aligned,
    correctCount: session.correctCount,
    totalQuestions: session.questions.length,
    checkpoint: {
      id: result.checkpoint.id,
      name: result.checkpoint.name,
      progress: result.checkpoint.progress
    },
    progressBefore: result.progressBefore,
    progressAfter: result.progressAfter
  });
}));

module.exports = router;
