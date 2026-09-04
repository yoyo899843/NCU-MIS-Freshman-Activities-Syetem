const express = require('express');
const db = require('../db');
const schoolAuth = require('../middleware/schoolAuth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(schoolAuth);

// 數位偵探：科技樹槽位放置線索、檢查邏輯、分支劇情閱讀。
// 正確答案（tech_tree_slots.correct_clue_id）只有管理端（/admin/api/tech-tree/*）看得到，
// 這裡任何一支 API 都絕對不能把它回傳給玩家端，不然就等於直接洩題。

// 每個分支＋底下槽位目前的狀態：這支隊伍放了什麼線索、有沒有鎖定（驗證正確）、
// 分支本身有沒有解鎖（school_branch_unlocks 是不是有這一筆）、這一格目前排得到
// 排不到（reachable，見下面順序限制的說明）。scoreDeducted 是目前總共扣了多少
// 分——刻意不開欄位存這個數字，直接從 school_check_attempts 的錯誤次數即時算，
// 避免存了一份跟實際紀錄兜不起來的累計值（跟這個系統一貫的計分設計原則一致）。
router.get('/', asyncHandler(async (req, res) => {
  const schoolId = req.school.sub;

  const { rows: branchRows } = await db.query(
    `SELECT b.id, b.name, b.display_order,
            (sbu.branch_id IS NOT NULL) AS unlocked
     FROM tech_tree_branches b
     LEFT JOIN school_branch_unlocks sbu ON sbu.branch_id = b.id AND sbu.school_id = $1
     ORDER BY b.display_order, b.id`,
    [schoolId]
  );

  const { rows: slotRows } = await db.query(
    `SELECT s.id, s.branch_id, s.slot_order,
            ssp.placed_clue_id, c.name AS placed_clue_name, COALESCE(ssp.is_locked, false) AS is_locked
     FROM tech_tree_slots s
     LEFT JOIN school_slot_placements ssp ON ssp.slot_id = s.id AND ssp.school_id = $1
     LEFT JOIN clues c ON c.id = ssp.placed_clue_id
     ORDER BY s.branch_id, s.slot_order`,
    [schoolId]
  );

  const { rows: errorRows } = await db.query(
    'SELECT COUNT(*)::int AS error_count FROM school_check_attempts WHERE school_id = $1 AND is_correct = false',
    [schoolId]
  );

  const branches = branchRows.map(b => {
    const slots = slotRows.filter(s => s.branch_id === b.id);
    // 順序限制：一個槽位「排得到」的條件是同一分支裡排在它前面（slot_order 較小）
    // 的槽位全部都已經鎖定。第一格永遠排得到（沒有更前面的槽位）。
    let blocked = false;
    return {
      id: b.id,
      name: b.name,
      displayOrder: b.display_order,
      unlocked: b.unlocked,
      slots: slots.map(s => {
        const reachable = !blocked;
        if (!s.is_locked) blocked = true;
        return {
          id: s.id,
          slotOrder: s.slot_order,
          placedClueId: s.placed_clue_id,
          placedClueName: s.placed_clue_name,
          isLocked: s.is_locked,
          reachable
        };
      })
    };
  });

  res.json({ errorScore: errorRows[0].error_count, branches });
}));

// 把手上的一張線索放進（或清空）一個槽位。已經鎖定（驗證成功過）的槽位不能再改，
// 對應規格「對了鎖定變綠...不可再改」。只能放這支隊伍自己已經拿到的線索
// （school_clues 裡有的），不能放別人手上、自己還沒拿到的線索。
//
// 順序限制：同一分支的槽位要照 slot_order 由小到大依序解鎖，前面的槽位還沒鎖定
// （驗證正確）之前，不能跳著放線索到後面的槽位——但不用一次把整條分支排完，
// 排到目前排得到的那一格、按檢查邏輯，之後隨時可以回來繼續排下一格。
router.post('/slots/:slotId/place', asyncHandler(async (req, res) => {
  const schoolId = req.school.sub;
  const slotId = parseInt(req.params.slotId, 10);
  if (!Number.isInteger(slotId)) return res.status(400).json({ error: 'invalid slot id' });

  const { rows: slotRows } = await db.query('SELECT id, branch_id, slot_order FROM tech_tree_slots WHERE id = $1', [slotId]);
  if (slotRows.length === 0) return res.status(404).json({ error: 'slot not found' });
  const slot = slotRows[0];

  const { rows: placementRows } = await db.query(
    'SELECT is_locked FROM school_slot_placements WHERE school_id = $1 AND slot_id = $2',
    [schoolId, slotId]
  );
  if (placementRows[0]?.is_locked) {
    return res.status(409).json({ error: 'this slot is already locked in and cannot be changed' });
  }

  const { rows: earlierRows } = await db.query(
    `SELECT COUNT(*)::int AS unfinished
     FROM tech_tree_slots s
     LEFT JOIN school_slot_placements ssp ON ssp.slot_id = s.id AND ssp.school_id = $1
     WHERE s.branch_id = $2 AND s.slot_order < $3 AND COALESCE(ssp.is_locked, false) = false`,
    [schoolId, slot.branch_id, slot.slot_order]
  );
  if (earlierRows[0].unfinished > 0) {
    return res.status(409).json({ error: 'you must complete the earlier slots in this branch first' });
  }

  // clueId 是 null／沒帶 = 把這個槽位清空。
  const { clueId } = req.body || {};
  let placedClueId = null;
  if (clueId !== null && clueId !== undefined) {
    placedClueId = Number.isInteger(clueId) ? clueId : parseInt(clueId, 10);
    if (!Number.isInteger(placedClueId)) return res.status(400).json({ error: 'invalid clueId' });

    const { rows: ownedRows } = await db.query(
      'SELECT 1 FROM school_clues WHERE school_id = $1 AND clue_id = $2',
      [schoolId, placedClueId]
    );
    if (ownedRows.length === 0) {
      return res.status(400).json({ error: 'your school does not own this clue yet' });
    }
  }

  const { rows } = await db.query(
    `INSERT INTO school_slot_placements (school_id, slot_id, placed_clue_id, is_locked, updated_at)
     VALUES ($1, $2, $3, false, now())
     ON CONFLICT (school_id, slot_id) DO UPDATE
       SET placed_clue_id = EXCLUDED.placed_clue_id, updated_at = now()
     RETURNING placed_clue_id, is_locked`,
    [schoolId, slotId, placedClueId]
  );

  res.json({ slotId, placedClueId: rows[0].placed_clue_id, isLocked: rows[0].is_locked });
}));

// 檢查邏輯：一次檢查這支隊伍目前所有「已放置、還沒鎖定」的槽位（不是只檢查一格），
// 對照 schema 設計（school_check_attempts 的用途說明）。對的鎖定＋留下嘗試紀錄；
// 錯的只留嘗試紀錄（用來算扣分），槽位維持原狀，隊伍可以換一張線索再檢查一次。
// 檢查完之後，順便看看有沒有分支因此整條槽位都鎖定了、可以標記解鎖（一次解鎖後
// 不會再收回，即使之後管理員又替該分支加了新槽位）。
router.post('/check', asyncHandler(async (req, res) => {
  const schoolId = req.school.sub;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: pending } = await client.query(
      `SELECT ssp.slot_id, ssp.placed_clue_id, s.branch_id, s.correct_clue_id
       FROM school_slot_placements ssp
       JOIN tech_tree_slots s ON s.id = ssp.slot_id
       WHERE ssp.school_id = $1 AND ssp.is_locked = false AND ssp.placed_clue_id IS NOT NULL
       FOR UPDATE`,
      [schoolId]
    );

    const results = [];
    const touchedBranchIds = new Set();

    for (const slot of pending) {
      const isCorrect = slot.placed_clue_id === slot.correct_clue_id;
      touchedBranchIds.add(slot.branch_id);

      await client.query(
        `INSERT INTO school_check_attempts (school_id, slot_id, attempted_clue_id, is_correct)
         VALUES ($1, $2, $3, $4)`,
        [schoolId, slot.slot_id, slot.placed_clue_id, isCorrect]
      );

      if (isCorrect) {
        await client.query(
          `UPDATE school_slot_placements SET is_locked = true, updated_at = now()
           WHERE school_id = $1 AND slot_id = $2`,
          [schoolId, slot.slot_id]
        );
      }

      results.push({ slotId: slot.slot_id, correct: isCorrect });
    }

    const newlyUnlockedBranches = [];
    for (const branchId of touchedBranchIds) {
      const { rows: unlockedRows } = await client.query(
        'SELECT 1 FROM school_branch_unlocks WHERE school_id = $1 AND branch_id = $2',
        [schoolId, branchId]
      );
      if (unlockedRows.length > 0) continue; // 已經解鎖過了，不用重複判斷

      const { rows: slotStatusRows } = await client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ssp.is_locked = true)::int AS locked
         FROM tech_tree_slots s
         LEFT JOIN school_slot_placements ssp ON ssp.slot_id = s.id AND ssp.school_id = $1
         WHERE s.branch_id = $2`,
        [schoolId, branchId]
      );
      const { total, locked } = slotStatusRows[0];
      if (total > 0 && total === locked) {
        await client.query(
          'INSERT INTO school_branch_unlocks (school_id, branch_id) VALUES ($1, $2)',
          [schoolId, branchId]
        );
        newlyUnlockedBranches.push(branchId);
      }
    }

    await client.query('COMMIT');
    res.json({ results, newlyUnlockedBranches });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// 分支劇情沉浸式閱讀：只有這支隊伍已經解鎖過這個分支才看得到內容，沒解鎖回 403，
// 不會把劇情內容洩漏給還沒解完的隊伍。
router.get('/branches/:branchId/story', asyncHandler(async (req, res) => {
  const schoolId = req.school.sub;
  const branchId = parseInt(req.params.branchId, 10);
  if (!Number.isInteger(branchId)) return res.status(400).json({ error: 'invalid branch id' });

  const { rows: unlockedRows } = await db.query(
    'SELECT unlocked_at FROM school_branch_unlocks WHERE school_id = $1 AND branch_id = $2',
    [schoolId, branchId]
  );
  if (unlockedRows.length === 0) {
    return res.status(403).json({ error: 'this branch has not been unlocked yet' });
  }

  const { rows: branchRows } = await db.query(
    'SELECT id, name, story_content FROM tech_tree_branches WHERE id = $1',
    [branchId]
  );
  if (branchRows.length === 0) return res.status(404).json({ error: 'branch not found' });

  res.json({
    id: branchRows[0].id,
    name: branchRows[0].name,
    storyContent: branchRows[0].story_content,
    unlockedAt: unlockedRows[0].unlocked_at
  });
}));

module.exports = router;
