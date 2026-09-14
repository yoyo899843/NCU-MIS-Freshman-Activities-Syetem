const db = require('./db');
const { techTreeScore } = require('./scoring');

// 後台與公開的 Final Scoreboard 都使用同一份即時計算，避免出現兩套總分。
async function buildScoreboard() {
  const { rows } = await db.query(`
    SELECT
      s.id AS school_id, s.display_name,
      COALESCE(placements.correct_count, 0) AS correct_slots,
      COALESCE(attempts.wrong_count, 0) AS wrong_attempts,
      COALESCE(clues.clue_count, 0) AS clues_collected,
      COALESCE(branches.branch_count, 0) AS branches_unlocked
    FROM schools s
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS correct_count
      FROM school_slot_placements WHERE is_locked = true GROUP BY school_id
    ) placements ON placements.school_id = s.id
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS wrong_count
      FROM school_check_attempts WHERE is_correct = false GROUP BY school_id
    ) attempts ON attempts.school_id = s.id
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS clue_count FROM school_clues GROUP BY school_id
    ) clues ON clues.school_id = s.id
    LEFT JOIN (
      SELECT school_id, COUNT(*)::int AS branch_count FROM school_branch_unlocks GROUP BY school_id
    ) branches ON branches.school_id = s.id
    ORDER BY s.id
  `);
  return rows.map(row => ({
    schoolId: row.school_id,
    displayName: row.display_name,
    correctSlots: row.correct_slots,
    wrongAttempts: row.wrong_attempts,
    cluesCollected: row.clues_collected,
    branchesUnlocked: row.branches_unlocked,
    ...techTreeScore(row.correct_slots, row.wrong_attempts)
  })).sort((a, b) => b.totalScore - a.totalScore || a.schoolId - b.schoolId);
}

module.exports = { buildScoreboard };
