const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const TEAM_SIZE = 4;

// 玩家登入分隊：隨機平均分發陣營、塞進一個未滿的小隊（沒有就開新隊），簽發 player JWT。
router.post('/join', asyncHandler(async (req, res) => {
  const { displayName } = req.body || {};
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  const name = displayName.trim().slice(0, 40);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 目前兩陣營各自的人數，用來決定這個玩家該分去哪邊（人少的那邊，平手隨機）。
    const { rows: counts } = await client.query(`
      SELECT t.faction, COUNT(p.id)::int AS cnt
      FROM teams t
      LEFT JOIN players p ON p.team_id = t.id
      GROUP BY t.faction
    `);
    const countMap = { repair: 0, disrupt: 0 };
    counts.forEach(row => { countMap[row.faction] = row.cnt; });

    let faction;
    if (countMap.repair < countMap.disrupt) faction = 'repair';
    else if (countMap.disrupt < countMap.repair) faction = 'disrupt';
    else faction = Math.random() < 0.5 ? 'repair' : 'disrupt';

    // 找一個該陣營裡還沒滿的小隊，沒有就開一支新隊。
    const { rows: openTeams } = await client.query(`
      SELECT t.id, t.team_number, COUNT(p.id)::int AS member_count
      FROM teams t
      LEFT JOIN players p ON p.team_id = t.id
      WHERE t.faction = $1
      GROUP BY t.id, t.team_number
      HAVING COUNT(p.id) < $2
      ORDER BY t.team_number
      LIMIT 1
    `, [faction, TEAM_SIZE]);

    let teamId;
    let isFirstMember = false;
    if (openTeams.length > 0) {
      teamId = openTeams[0].id;
    } else {
      const { rows: maxRows } = await client.query(
        'SELECT COALESCE(MAX(team_number), 0) + 1 AS next_number FROM teams WHERE faction = $1',
        [faction]
      );
      const teamNumber = maxRows[0].next_number;
      const { rows: newTeam } = await client.query(
        'INSERT INTO teams (faction, team_number) VALUES ($1, $2) RETURNING id',
        [faction, teamNumber]
      );
      teamId = newTeam[0].id;
      isFirstMember = true;
    }

    const { rows: playerRows } = await client.query(
      'INSERT INTO players (team_id, display_name, is_captain) VALUES ($1, $2, $3) RETURNING id, display_name, is_captain',
      [teamId, name, isFirstMember]
    );
    const player = playerRows[0];

    await client.query('COMMIT');

    const token = jwt.sign(
      { sub: player.id, teamId, faction, displayName: player.display_name, role: 'player' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      player: { id: player.id, displayName: player.display_name, isCaptain: player.is_captain },
      team: { id: teamId, faction }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/me', playerAuth, (req, res) => {
  res.json({
    playerId: req.player.sub,
    teamId: req.player.teamId,
    faction: req.player.faction,
    displayName: req.player.displayName
  });
});

module.exports = router;
