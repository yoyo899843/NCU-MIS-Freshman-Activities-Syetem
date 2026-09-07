// 據點進度的唯一入口：一支隊伍對某個據點執行一次「修復」或「破壞」。
//
// 刻意抽成獨立模組而不是寫在挑戰流程裡，因為「誰來觸發」還沒定案——企劃書寫的是
// 關主在隊伍過關後於系統輸入結果，目前實作則是玩家自己掃碼答題。無論之後接的是
// 哪一種（或兩種都有），改動據點進度這件事都只有這一份實作，不會兩邊各寫一套、
// 各自漏掉夾範圍或漏寫紀錄。
const db = require('../db');
const { getIO } = require('../io');

const ACTIONS = ['repair', 'disrupt'];

// 企劃：好人陣營的意向是修復、內鬼陣營的意向是破壞。違背意向的動作照樣生效，
// 只是不計第二權重積分（留給玩家隱藏身分用），所以這裡只做判定、不擋動作。
function isAligned(faction, action) {
  return (faction === 'repair' && action === 'repair') ||
         (faction === 'disrupt' && action === 'disrupt');
}

async function loadSettings() {
  const { rows } = await db.query('SELECT progress_step FROM game_state WHERE id = 1');
  const step = Number(rows[0]?.progress_step);
  return { step: Number.isInteger(step) && step > 0 ? step : 25 };
}

// 回傳 { attemptId, checkpoint, progressBefore, progressAfter, aligned, delta }。
// 找不到據點時丟出 code='CHECKPOINT_NOT_FOUND' 的錯誤。
async function applyAction({ checkpointId, playerId, teamId, faction, action, correctCount = 0 }) {
  if (!ACTIONS.includes(action)) {
    const err = new Error('action must be repair or disrupt');
    err.code = 'BAD_ACTION';
    throw err;
  }

  const { step } = await loadSettings();
  const aligned = isAligned(faction, action);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE 鎖住這一列：兩支隊伍幾乎同時在同一個據點交結果時，沒有鎖的話
    // 兩邊都會讀到同一個舊進度、後寫的覆蓋先寫的，等於少算一次動作。
    const { rows: before } = await client.query(
      'SELECT id, name, progress FROM checkpoints WHERE id = $1 FOR UPDATE',
      [checkpointId]
    );
    if (before.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('checkpoint not found');
      err.code = 'CHECKPOINT_NOT_FOUND';
      throw err;
    }

    const progressBefore = before[0].progress;
    // 夾在 0~100：已經 0% 再破壞不會變負的，已經 100% 再修復也不會超過。
    // 資料庫的 CHECK 也擋，但那會變成 500 錯誤，這裡先夾成正常結果。
    const delta = action === 'repair' ? step : -step;
    const progressAfter = Math.max(0, Math.min(100, progressBefore + delta));

    const { rows: attemptRows } = await client.query(
      `INSERT INTO checkpoint_attempts
         (checkpoint_id, player_id, team_id, faction, correct_count,
          action, aligned, progress_before, progress_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [checkpointId, playerId, teamId, faction, correctCount,
       action, aligned, progressBefore, progressAfter]
    );

    const { rows: after } = await client.query(
      `UPDATE checkpoints SET progress = $1, updated_at = now()
       WHERE id = $2 RETURNING id, name, progress`,
      [progressAfter, checkpointId]
    );

    await client.query('COMMIT');

    // 大地圖與大螢幕都在看據點進度，變動當下就廣播出去。
    // 交摺點結算這條路徑原本沒有廣播（只有 PK 那邊有），所以兩邊都只能靠輪詢。
    try { getIO().emit('checkpoint:update', after[0]); } catch (err) { /* io 還沒起來就算了 */ }

    return {
      attemptId: attemptRows[0].id,
      checkpoint: after[0],
      progressBefore,
      progressAfter,
      aligned,
      delta: progressAfter - progressBefore
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyAction, isAligned, ACTIONS };
