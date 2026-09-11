-- 後台的刪除一律做得到：刪掉一筆資料時，資料庫自動處理所有指向它的資料，
-- 不再因為「已經有隊伍進度／被其他功能使用中」就擋下來。
--
-- 規則：
--   屬於被刪對象的資料 → 一起刪（ON DELETE CASCADE）
--     例：刪學派 → 它的進度、線索、兌換、科技樹放置與驗證紀錄、投票
--         刪線索 → 各隊取得的這張線索、以它為答案的槽位、放著它的格子、相關驗證紀錄、指向它的權限碼
--   只是「關聯」到被刪對象 → 保留本體、把關聯清掉（ON DELETE SET NULL）
--     例：線索的關聯關卡被刪 → 線索留著，變成沒有關聯關卡
--   稽核紀錄 → 保留，操作者欄位清空，但先存一份操作者的 email／名稱，刪帳號後仍查得到是誰做的

-- 重新建立一條外鍵。PostgreSQL 不能直接改外鍵的 ON DELETE，只能刪掉重建。
CREATE FUNCTION pg_temp.refk(tbl regclass, col text, ref regclass, action text) RETURNS void AS $$
DECLARE
  cname text;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f' AND c.conrelid = tbl AND a.attname = col;
  IF cname IS NULL THEN
    RAISE EXCEPTION '找不到 %.% 的外鍵', tbl, col;
  END IF;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, cname);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(id) ON DELETE %s',
                 tbl, cname, col, ref, action);
END;
$$ LANGUAGE plpgsql;

-- 學派（玩家帳號）
SELECT pg_temp.refk('school_checkpoint_progress', 'school_id', 'schools', 'CASCADE');
SELECT pg_temp.refk('school_clues',               'school_id', 'schools', 'CASCADE');
SELECT pg_temp.refk('school_code_redemptions',    'school_id', 'schools', 'CASCADE');
SELECT pg_temp.refk('school_slot_placements',     'school_id', 'schools', 'CASCADE');
SELECT pg_temp.refk('school_check_attempts',      'school_id', 'schools', 'CASCADE');
SELECT pg_temp.refk('school_branch_unlocks',      'school_id', 'schools', 'CASCADE');
SELECT pg_temp.refk('school_votes',               'school_id', 'schools', 'CASCADE');

-- 關卡
SELECT pg_temp.refk('school_checkpoint_progress', 'checkpoint_id',        'checkpoints', 'CASCADE');
SELECT pg_temp.refk('clues',                      'checkpoint_id',        'checkpoints', 'SET NULL');
SELECT pg_temp.refk('access_codes',               'target_checkpoint_id', 'checkpoints', 'CASCADE');

-- 線索
SELECT pg_temp.refk('school_clues',           'clue_id',           'clues', 'CASCADE');
SELECT pg_temp.refk('access_codes',           'target_clue_id',    'clues', 'CASCADE');
SELECT pg_temp.refk('tech_tree_slots',        'correct_clue_id',   'clues', 'CASCADE');
-- 放著這張線索的格子整筆刪掉（變回空格、解除鎖定），不是只把線索清成 NULL——
-- 只清線索的話，已鎖定的格子會變成「鎖著但沒有線索」，還繼續被算成答對。
SELECT pg_temp.refk('school_slot_placements', 'placed_clue_id',    'clues', 'CASCADE');
SELECT pg_temp.refk('school_check_attempts',  'attempted_clue_id', 'clues', 'CASCADE');

-- 權限碼
SELECT pg_temp.refk('school_code_redemptions', 'access_code_id', 'access_codes', 'CASCADE');

-- 科技樹
SELECT pg_temp.refk('tech_tree_slots',        'branch_id', 'tech_tree_branches', 'CASCADE');
SELECT pg_temp.refk('school_branch_unlocks',  'branch_id', 'tech_tree_branches', 'CASCADE');
SELECT pg_temp.refk('school_slot_placements', 'slot_id',   'tech_tree_slots',    'CASCADE');
SELECT pg_temp.refk('school_check_attempts',  'slot_id',   'tech_tree_slots',    'CASCADE');

-- 長老
SELECT pg_temp.refk('school_votes', 'elder_id', 'elders', 'CASCADE');

-- 稽核紀錄：先把操作者存一份快照，再讓外鍵在帳號被刪時改成 NULL
ALTER TABLE admin_actions ADD COLUMN operator_email TEXT;
ALTER TABLE admin_actions ADD COLUMN operator_name TEXT;
UPDATE admin_actions aa
SET operator_email = au.email, operator_name = au.display_name
FROM admin_users au WHERE au.id = aa.admin_user_id;

-- 寫入稽核紀錄的地方散在各支 API，用 trigger 統一補上快照，不用每個 INSERT 各自改
CREATE FUNCTION admin_actions_fill_operator() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.operator_email IS NULL AND NEW.admin_user_id IS NOT NULL THEN
    SELECT email, display_name INTO NEW.operator_email, NEW.operator_name
    FROM admin_users WHERE id = NEW.admin_user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_actions_fill_operator
BEFORE INSERT ON admin_actions
FOR EACH ROW EXECUTE FUNCTION admin_actions_fill_operator();

ALTER TABLE admin_actions ALTER COLUMN admin_user_id DROP NOT NULL;
SELECT pg_temp.refk('admin_actions', 'admin_user_id', 'admin_users', 'SET NULL');

-- 關主派發線索必須關聯關卡（011）。關卡被刪、線索的 checkpoint_id 被清成 NULL 時，
-- 原本的 trigger 會直接報錯，連帶讓刪除關卡失敗；改成自動取消「可由關主派發」。
-- 後台 API 仍會先驗證（validateClueBody），手動設定時照樣會看到錯誤訊息。
CREATE OR REPLACE FUNCTION enforce_checkpoint_staff_clue_limit()
RETURNS TRIGGER AS $$
DECLARE
  enabled_count INTEGER;
BEGIN
  IF NOT NEW.staff_grant_enabled THEN
    RETURN NEW;
  END IF;

  IF NEW.checkpoint_id IS NULL THEN
    NEW.staff_grant_enabled := false;
    RETURN NEW;
  END IF;

  -- 鎖住關卡列，讓兩位管理員同時設定時也不會各自看到少於四張而超額。
  PERFORM 1 FROM checkpoints WHERE id = NEW.checkpoint_id FOR UPDATE;
  SELECT COUNT(*) INTO enabled_count
  FROM clues
  WHERE checkpoint_id = NEW.checkpoint_id
    AND staff_grant_enabled = true
    AND id IS DISTINCT FROM NEW.id;

  IF enabled_count >= 4 THEN
    RAISE EXCEPTION '每個關卡最多只能設定 4 個可由關主派發的線索';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
