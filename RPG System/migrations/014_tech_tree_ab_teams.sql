-- 同一學派帳號的線索庫維持共用；科技樹放置、驗證與分支解鎖改為 A/B 各自一份。
-- 既有進度歸入 A 隊，避免遷移時遺失現有資料；B 隊從空白科技樹開始。
ALTER TABLE school_slot_placements
  ADD COLUMN team_code CHAR(1) NOT NULL DEFAULT 'A' CHECK (team_code IN ('A', 'B'));
ALTER TABLE school_check_attempts
  ADD COLUMN team_code CHAR(1) NOT NULL DEFAULT 'A' CHECK (team_code IN ('A', 'B'));
ALTER TABLE school_branch_unlocks
  ADD COLUMN team_code CHAR(1) NOT NULL DEFAULT 'A' CHECK (team_code IN ('A', 'B'));

ALTER TABLE school_slot_placements DROP CONSTRAINT school_slot_placements_pkey;
ALTER TABLE school_slot_placements
  ADD PRIMARY KEY (school_id, team_code, slot_id);
ALTER TABLE school_branch_unlocks DROP CONSTRAINT school_branch_unlocks_pkey;
ALTER TABLE school_branch_unlocks
  ADD PRIMARY KEY (school_id, team_code, branch_id);

CREATE INDEX school_check_attempts_team_score_idx
  ON school_check_attempts (school_id, team_code, is_correct);
