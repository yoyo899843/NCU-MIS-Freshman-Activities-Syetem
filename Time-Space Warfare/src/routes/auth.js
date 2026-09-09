const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const playerAuth = require('../middleware/playerAuth');
const asyncHandler = require('../middleware/asyncHandler');
const { createLoginThrottle } = require('../loginThrottle');
const { validateName } = require('../displayName');

const router = express.Router();

// 現在一組（一支隊伍）只用一支手機登入，所以「登入」等於「開一支新隊伍」，不再有
// 「找一個還沒滿的隊伍塞進去」這件事——每次登入都是新隊伍，直到達到隊伍上限。
// 上限本來寫死 20，改成讀後台設定（game_state.max_teams，預設 10）：報名隊數
// 每年不一樣，這種數字不該要改程式重新部署。

// PIN 錯誤次數限制（見 src/loginThrottle.js：記憶體內、會定期清掉過期項目）。
const pinThrottle = createLoginThrottle();

// 陣營是「開始遊戲」那一刻才抽的（見 admin.js 的 /game/start）。在那之前
// teams.faction 只是佔位值，任何回給玩家的東西都不能帶它——提早透露等於直接
// 公布誰不是內鬼。
//
// 這個判斷只有一個來源（game_state.faction_drawn_at），登入、/me、首頁彈窗
// 都走這裡，不要各自再判一次。
async function factionDrawnAt(client = db) {
  const { rows } = await client.query('SELECT faction_drawn_at FROM game_state WHERE id = 1');
  return rows[0] ? rows[0].faction_drawn_at : null;
}

// 玩家登入：代號 + PIN 碼。
//   - 代號是新的 → 視為新隊伍加入（要檢查隊伍是否已達上限），把這組 PIN 記下來。
//   - 代號已經有人用過 → 視為原本那支隊伍的手機掉線/換手機回來，PIN 對了才能拿回身份，
//     PIN 錯誤不透露「代號被占用」還是「PIN 打錯」，一律同樣的錯誤訊息。
router.post('/join', asyncHandler(async (req, res) => {
  const { displayName, pin } = req.body || {};
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  if (!pin || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }
  // 限制 10 個字，不論中英。用 Array.from 而不是 .length，避免 emoji 之類的
  // 字元被算成兩個字（中英文本身不會有這問題，但這樣寫比較保險）。
  //
  // 超過就直接擋下來，不默默截斷——截斷會讓「中央大學資訊管理學系第一隊」和
  // 「…第二隊」變成同一個代號，兩支隊伍會撞在一起（PIN 剛好相同的話還會直接
  // 接管到對方的帳號）。網頁上的輸入框有 maxlength="10" 擋著，這裡是給直接
  // 打 API 的情況一個明確的錯誤，而不是回一個跟送出去不一樣的名字。
  const name = displayName.trim();
  if (Array.from(name).length > 10) {
    return res.status(400).json({ error: '代號最多 10 個字' });
  }

  const { rows: existingRows } = await db.query(
    `SELECT p.id, p.pin, p.is_captain, p.team_id, t.faction, t.team_number
     FROM players p JOIN teams t ON t.id = p.team_id
     WHERE p.display_name = $1`,
    [name]
  );

  if (existingRows.length > 0) {
    const existing = existingRows[0];

    if (pinThrottle.isLocked(name)) {
      return res.status(429).json({ error: 'too many failed attempts, try again later' });
    }

    // PIN 明碼存放（不雜湊）——主辦/隊輔需要能直接從資料庫查得到某支隊伍的 PIN，
    // 這是活動現場的實際需求，見 PLAN.md。
    const valid = existing.pin && existing.pin === pin;
    if (!valid) {
      pinThrottle.recordFailure(name);
      return res.status(401).json({ error: 'this name is taken, or the PIN is incorrect' });
    }

    pinThrottle.clear(name);

    // token 裡刻意不放 faction。陣營現在會在遊戲開始時整批重抽，而 token 一簽
    // 就是 12 小時——放進去等於帶著一份會過期的快照，重抽之後玩家看到的還是
    // 舊身分。要陣營一律現查（見 /me、votes.js 的 factionOf）。
    const token = jwt.sign(
      { sub: existing.id, teamId: existing.team_id, displayName: name, role: 'player' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    const drawnAt = await factionDrawnAt();
    return res.json({
      token,
      player: { id: existing.id, displayName: name, isCaptain: existing.is_captain },
      team: {
        id: existing.team_id,
        teamNumber: existing.team_number,
        // 還沒抽籤就完全不回 faction 這個欄位，不是回 null 讓前端自己小心
        ...(drawnAt ? { faction: existing.faction } : {}),
        factionRevealed: !!drawnAt
      },
      returning: true
    });
  }

  // 字元規則（見 src/displayName.js：只准文字、數字、emoji）只套在「新代號」上，
  // 刻意放在查完既有代號之後。規則收緊之前建立的隊伍，名字可能帶空白或標點，
  // 要是在最前面就擋掉，那些隊伍連原本的身份都拿不回來——登入就是靠同一個代號
  // ＋PIN 找回身份的，擋在這裡等於直接把人鎖在門外。
  const validated = validateName(name);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: limitRows } = await client.query('SELECT max_teams FROM game_state WHERE id = 1');
    const maxTeams = limitRows[0]?.max_teams ?? 10;
    const { rows: countRows } = await client.query('SELECT COUNT(*)::int AS cnt FROM teams');
    if (countRows[0].cnt >= maxTeams) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `已達隊伍上限（${maxTeams} 隊），無法再加入` });
    }

    // 陣營不在這裡決定。新隊伍一律先掛 repair 當佔位值（欄位有 NOT NULL 的
    // CHECK，一定要給一個），真正的分配是主辦按「開始遊戲」時一次抽籤
    // （見 admin.js 的 /game/start）。
    //
    // 之前是登入時就分到人數少的那一邊，那會讓報到順序影響身分，而且兩邊各半
    // ——企劃要的是固定少數幾支內鬼、開賽當下才決定。在 faction_drawn_at 有值
    // 之前，這個 repair 沒有任何意義，玩家端也不會顯示（見 /me）。
    const faction = 'repair';

    // 編號全場唯一（見 migrations/015）。抽籤會改動 faction，若還照陣營各自
    // 編號，抽完就會出現兩支同號的隊伍。
    const { rows: maxRows } = await client.query(
      'SELECT COALESCE(MAX(team_number), 0) + 1 AS next_number FROM teams'
    );
    const teamNumber = maxRows[0].next_number;
    const { rows: newTeam } = await client.query(
      'INSERT INTO teams (faction, team_number) VALUES ($1, $2) RETURNING id',
      [faction, teamNumber]
    );
    const teamId = newTeam[0].id;

    // 一組一支手機，登入的人就是這支隊伍唯一的操作者。
    const { rows: playerRows } = await client.query(
      'INSERT INTO players (team_id, display_name, is_captain, pin) VALUES ($1, $2, true, $3) RETURNING id, display_name, is_captain',
      [teamId, name, pin]
    );
    const player = playerRows[0];

    await client.query('COMMIT');

    const token = jwt.sign(
      { sub: player.id, teamId, displayName: player.display_name, role: 'player' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    // 新隊伍一定是在抽籤之前才建得出來（抽完之後才登入的隊伍不會被抽到，
    // 主辦要重抽），所以這裡不會有 faction 可以回。
    res.json({
      token,
      player: { id: player.id, displayName: player.display_name, isCaptain: player.is_captain },
      team: { id: teamId, teamNumber, factionRevealed: false },
      returning: false
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// 玩家端每 5 秒會打這支確認 token 還有效，順便拿自己的陣營。
//
// 陣營一律現查，不用 token 裡的快照：抽籤（/game/start）和主辦手動改陣營
// （/players/:id/faction）都會在 token 有效期內改動它。
//
// factionDrawnAt 同時是玩家端「該不該彈窗」的依據——前端記住上次彈過的那個
// 時間戳，主辦重開一場、重抽一次，時間戳就變了，彈窗會再跳一次。
router.get('/me', playerAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.faction, t.team_number, g.faction_drawn_at
     FROM teams t, game_state g
     WHERE t.id = $1 AND g.id = 1`,
    [req.player.teamId]
  );
  const row = rows[0];
  if (!row) {
    // 隊伍被刪掉了（重啟遊戲會清空所有隊伍）。回 401 讓 authFetch.js 把人踢回
    // 登入頁重新建帳號，不要回一個查不到隊伍的半殘資料讓前端自己爆掉。
    return res.status(401).json({ error: '這個帳號已經不存在了，請重新登入' });
  }

  const drawn = !!row.faction_drawn_at;
  res.json({
    playerId: req.player.sub,
    teamId: req.player.teamId,
    teamNumber: row.team_number,
    displayName: req.player.displayName,
    ...(drawn ? { faction: row.faction } : {}),
    factionRevealed: drawn,
    factionDrawnAt: row.faction_drawn_at
  });
}));

module.exports = router;
