// 六級權重積分的計算（溫馨周企劃「四、積分與勝負結算系統」）。
//
// 每次呼叫都從現有資料重算一次，不做快取、不寫入任何「總分」欄位。原因是這些
// 分數在遊戲進行中隨時會變（據點被翻、又打了一場 PK），存一份總分就要在十幾個
// 地方記得同步，遲早會出現「大螢幕顯示的分數跟明細對不起來」。資料量是十幾支
// 隊伍、幾百筆動作，重算的成本遠低於維護一致性的成本。
const db = require('./db');

async function loadWeights() {
  const { rows } = await db.query(
    `SELECT w1_faction_win, w2_aligned_action, w3_spy_guess,
            w4_achievement, w5_mission, w6_pk_point
     FROM game_state WHERE id = 1`
  );
  return rows[0] || {
    w1_faction_win: 20, w2_aligned_action: 5, w3_spy_guess: 4,
    w4_achievement: 3, w5_mission: 2, w6_pk_point: 1
  };
}

// 「最多」類的成就會並列：三支隊伍都做了 5 次修復就三支都拿。企劃寫的是「完成
// 最多修復次數之隊伍」，沒有說要打破平手，硬要挑一支反而需要一個 PDF 裡沒有的
// 規則（比時間？比隊號？），所以並列全拿。次數 0 不算成就——沒人做過的事不該
// 讓全部隊伍都拿一份。
function topTeams(counts) {
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return new Set();
  return new Set(Object.keys(counts).filter(id => counts[id] === max).map(Number));
}

async function computeScores() {
  const w = await loadWeights();

  const { rows: teams } = await db.query(
    `SELECT t.id, t.faction, t.team_number, t.pk_points,
            (SELECT p.display_name FROM players p WHERE p.team_id = t.id ORDER BY p.id LIMIT 1) AS name
     FROM teams t ORDER BY t.id`
  );

  // --- 第一權重：陣營勝負 ---
  // 已修復完成的據點數 > 未修復完成的 → 好人陣營（repair）勝，反之內鬼陣營（disrupt）勝。
  const { rows: cpRows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE progress >= 100)::int AS done
     FROM checkpoints`
  );
  const done = cpRows[0].done;
  const notDone = cpRows[0].total - done;
  let winningFaction = null;
  if (done > notDone) winningFaction = 'repair';
  else if (notDone > done) winningFaction = 'disrupt';

  // --- 第二權重：符合陣營意向的動作次數 ---
  const { rows: alignedRows } = await db.query(
    `SELECT team_id, count(*)::int AS n FROM checkpoint_attempts
     WHERE aligned IS TRUE GROUP BY team_id`
  );
  const aligned = Object.fromEntries(alignedRows.map(r => [r.team_id, r.n]));

  // --- 第四權重：成就（修復最多、破壞最多、任務最多、PK 勝場最多）---
  const { rows: actionRows } = await db.query(
    `SELECT team_id, action, count(*)::int AS n FROM checkpoint_attempts
     WHERE action IS NOT NULL GROUP BY team_id, action`
  );
  const repairs = {}, disrupts = {};
  teams.forEach(t => { repairs[t.id] = 0; disrupts[t.id] = 0; });
  actionRows.forEach(r => {
    (r.action === 'repair' ? repairs : disrupts)[r.team_id] = r.n;
  });

  const { rows: pkWinRows } = await db.query(
    `SELECT p.team_id, count(*)::int AS n
     FROM pk_duels d JOIN players p ON p.id = d.winner_player_id
     WHERE d.status = 'completed' GROUP BY p.team_id`
  );
  const pkWins = {};
  teams.forEach(t => { pkWins[t.id] = 0; });
  pkWinRows.forEach(r => { pkWins[r.team_id] = r.n; });

  // 任務系統還沒做，全部算 0。等它做好之後，這裡換成真的任務完成數即可，
  // 其餘計分不用動。
  const missions = {};
  teams.forEach(t => { missions[t.id] = 0; });

  const topRepair = topTeams(repairs);
  const topDisrupt = topTeams(disrupts);
  const topMission = topTeams(missions);
  const topPkWin = topTeams(pkWins);

  const rows = teams.map(t => {
    const achievements = [];
    if (topRepair.has(t.id)) achievements.push('修復次數最多');
    if (topDisrupt.has(t.id)) achievements.push('破壞次數最多');
    if (topMission.has(t.id)) achievements.push('任務最多');
    if (topPkWin.has(t.id)) achievements.push('PK 勝場最多');

    const w1 = winningFaction && t.faction === winningFaction ? w.w1_faction_win : 0;
    const w2 = (aligned[t.id] || 0) * w.w2_aligned_action;
    const w3 = 0; // 內鬼指認投票尚未實作
    const w4 = achievements.length * w.w4_achievement;
    const w5 = (missions[t.id] || 0) * w.w5_mission;
    const w6 = t.pk_points * w.w6_pk_point;

    return {
      teamId: t.id,
      teamNumber: t.team_number,
      name: t.name,
      faction: t.faction,
      breakdown: {
        factionWin: w1,
        alignedActions: w2,
        spyGuess: w3,
        achievements: w4,
        missions: w5,
        pkPoints: w6
      },
      detail: {
        alignedCount: aligned[t.id] || 0,
        repairCount: repairs[t.id] || 0,
        disruptCount: disrupts[t.id] || 0,
        pkWins: pkWins[t.id] || 0,
        pkPoints: t.pk_points,
        achievements
      },
      total: w1 + w2 + w3 + w4 + w5 + w6
    };
  });

  // 總分高的在前；同分時用隊號排，避免每次重算順序都在跳。
  rows.sort((a, b) => b.total - a.total || a.teamId - b.teamId);

  // 名次要處理並列：同分同名次，下一個名次跳號（1,1,3）。
  let rank = 0, prevTotal = null;
  rows.forEach((r, i) => {
    if (r.total !== prevTotal) { rank = i + 1; prevTotal = r.total; }
    r.rank = rank;
  });

  return {
    weights: w,
    checkpoints: { total: cpRows[0].total, done, notDone },
    winningFaction,
    // 還沒接上資料來源的權重，明白標出來，免得大螢幕上一排 0 分讓人以為算錯了
    pending: ['第三權重（抓內鬼）尚未實作', '第五權重（任務）尚未實作'],
    teams: rows
  };
}

module.exports = { computeScores };
