const db = require('./db');
const { techTreeScore } = require('./scoring');

// A/B 有各自的科技樹分數，但對外排行榜與 Final Scoreboard 使用兩隊加總的學派總分。
async function buildScoreboard() {
  const { rows } = await db.query(`
    SELECT s.id AS school_id, s.display_name, team.team_code,
      COALESCE(placements.correct_count, 0)::int AS correct_slots,
      COALESCE(attempts.wrong_count, 0)::int AS wrong_attempts,
      COALESCE(branches.branch_count, 0)::int AS branches_unlocked,
      COALESCE(clues.clue_count, 0)::int AS clues_collected
    FROM schools s
    CROSS JOIN (VALUES ('A'::char(1)), ('B'::char(1))) AS team(team_code)
    LEFT JOIN (SELECT school_id, team_code, COUNT(*)::int AS correct_count FROM school_slot_placements WHERE is_locked = true GROUP BY school_id, team_code) placements ON placements.school_id = s.id AND placements.team_code = team.team_code
    LEFT JOIN (SELECT school_id, team_code, COUNT(*)::int AS wrong_count FROM school_check_attempts WHERE is_correct = false GROUP BY school_id, team_code) attempts ON attempts.school_id = s.id AND attempts.team_code = team.team_code
    LEFT JOIN (SELECT school_id, team_code, COUNT(*)::int AS branch_count FROM school_branch_unlocks GROUP BY school_id, team_code) branches ON branches.school_id = s.id AND branches.team_code = team.team_code
    LEFT JOIN (SELECT school_id, COUNT(*)::int AS clue_count FROM school_clues GROUP BY school_id) clues ON clues.school_id = s.id
    ORDER BY s.id, team.team_code
  `);
  const schools = new Map();
  for (const row of rows) {
    if (!schools.has(row.school_id)) schools.set(row.school_id, { schoolId:row.school_id, displayName:row.display_name, cluesCollected:row.clues_collected, teamScores:[] });
    const score = techTreeScore(row.correct_slots, row.wrong_attempts);
    schools.get(row.school_id).teamScores.push({ team:row.team_code, correctSlots:row.correct_slots, wrongAttempts:row.wrong_attempts, branchesUnlocked:row.branches_unlocked, ...score });
  }
  return [...schools.values()].map(school => {
    const total = school.teamScores.reduce((sum, team) => sum + team.totalScore, 0);
    const earned = school.teamScores.reduce((sum, team) => sum + team.earnedScore, 0);
    const mistakes = school.teamScores.reduce((sum, team) => sum + team.mistakeScore, 0);
    return { ...school, correctSlots:school.teamScores.reduce((sum, team) => sum + team.correctSlots, 0), wrongAttempts:school.teamScores.reduce((sum, team) => sum + team.wrongAttempts, 0), branchesUnlocked:school.teamScores.reduce((sum, team) => sum + team.branchesUnlocked, 0), earnedScore:earned, mistakeScore:mistakes, totalScore:total };
  }).sort((a, b) => b.totalScore - a.totalScore || a.schoolId - b.schoolId);
}

module.exports = { buildScoreboard };
