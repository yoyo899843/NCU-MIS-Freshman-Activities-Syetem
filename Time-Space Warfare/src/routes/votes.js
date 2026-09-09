const express = require('express');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(playerAuth);

async function votingState() {
  const { rows } = await db.query(
    `SELECT voting_unlocked_at, voting_closed_at, spy_vote_count
     FROM game_state WHERE id = 1`
  );
  const s = rows[0];
  return {
    open: !!s.voting_unlocked_at && !s.voting_closed_at,
    unlockedAt: s.voting_unlocked_at,
    closedAt: s.voting_closed_at,
    voteCount: s.spy_vote_count
  };
}

// 投票畫面要的東西：開放與否、要指認幾支、可選的隊伍名單、自己已投的。
//
// 候選名單刻意含全部隊伍（除了自己），不預先篩掉內鬼——篩掉就等於直接公布答案。
// 名單也不帶 faction 欄位，理由同上：能從 API 看到的東西就等於公開。
router.get('/', asyncHandler(async (req, res) => {
  const state = await votingState();

  const { rows: teams } = await db.query(
    `SELECT t.id, t.team_number,
            (SELECT p.display_name FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS name
     FROM teams t WHERE t.id <> $1 ORDER BY t.id`,
    [req.player.teamId]
  );

  const { rows: mine } = await db.query(
    'SELECT suspect_team_id FROM spy_votes WHERE voter_team_id = $1', [req.player.teamId]
  );

  // 自己是不是好人陣營，玩家本來就知道（登入畫面看得到自己的陣營），
  // 回傳這個只是讓前端知道要不要顯示投票表單。
  res.json({
    ...state,
    canVote: req.player.faction === 'repair',
    candidates: teams,
    myVotes: mine.map(r => r.suspect_team_id)
  });
}));

// 送出指認。一次送齊 N 支（整批取代，不是一票一票加），這樣「改票」就只是
// 重送一次完整名單，不用再開一支刪除的 API。
router.put('/', asyncHandler(async (req, res) => {
  const state = await votingState();
  if (!state.open) {
    return res.status(403).json({ error: '目前不是最終審判階段，無法投票' });
  }
  // 內鬼自己不投票（企劃：「每個好人隊伍需投票指認」）。擋在伺服器端，
  // 不是只靠前端不顯示表單。
  if (req.player.faction !== 'repair') {
    return res.status(403).json({ error: '只有時空保衛隊需要指認內鬼' });
  }

  const raw = (req.body || {}).suspectTeamIds;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ error: 'suspectTeamIds 必須是陣列' });
  }
  const ids = [...new Set(raw.map(Number))];
  if (ids.some(id => !Number.isInteger(id))) {
    return res.status(400).json({ error: '隊伍編號不正確' });
  }
  if (ids.length !== state.voteCount) {
    return res.status(400).json({ error: `必須指認剛好 ${state.voteCount} 支隊伍（目前 ${ids.length} 支）` });
  }
  if (ids.includes(req.player.teamId)) {
    return res.status(400).json({ error: '不能指認自己的隊伍' });
  }

  const { rows: valid } = await db.query(
    'SELECT id FROM teams WHERE id = ANY($1::int[])', [ids]
  );
  if (valid.length !== ids.length) {
    return res.status(400).json({ error: '名單裡有不存在的隊伍' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 整批取代：先清掉舊的再寫新的，避免「改票之後舊票還留著」變成投超過 N 支。
    await client.query('DELETE FROM spy_votes WHERE voter_team_id = $1', [req.player.teamId]);
    for (const id of ids) {
      await client.query(
        'INSERT INTO spy_votes (voter_team_id, suspect_team_id) VALUES ($1, $2)',
        [req.player.teamId, id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true, myVotes: ids });
}));

module.exports = router;
