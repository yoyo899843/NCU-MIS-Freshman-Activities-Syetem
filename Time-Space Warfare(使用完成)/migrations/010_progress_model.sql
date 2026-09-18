-- 照「溫馨周企劃」把據點的計分模型換掉。
--
-- 原本：每個據點有 repair_value / disrupt_value 兩個各自累加的分數，誰高誰「領先」，
--       沒有上限也沒有終點。
-- 企劃：每個據點是一條 0%~100% 的修復進度。修復 +25%、破壞 -25%，四次修復滿格；
--       結算時比的是「已修復完成（100%）的據點數」對「未修復完成的據點數」。
--
-- 這兩件事沒辦法並存——「領先」在進度模型裡沒有意義，所以舊的兩個欄位直接移除，
-- 不留著當死欄位誤導後面接手的人。

ALTER TABLE checkpoints ADD COLUMN progress INT NOT NULL DEFAULT 0;
ALTER TABLE checkpoints
  ADD CONSTRAINT checkpoints_progress_range CHECK (progress BETWEEN 0 AND 100);
ALTER TABLE checkpoints DROP COLUMN repair_value;
ALTER TABLE checkpoints DROP COLUMN disrupt_value;

-- 通關紀錄改記「這次做了什麼」而不是「這次得幾分」。
--   action     這次選了修復還是破壞
--   aligned    這個動作有沒有符合自己陣營的意向。企劃寫「好人若選擇破壞，或內鬼
--              若選擇修復，該次動作將不計入個人第二權重積分」——動作照樣生效
--              （進度會動），只是不給分，這是刻意留給玩家隱藏身分的手段。
--              第二權重的實際計分之後才做，這裡先把判定結果存下來。
--   progress_* 動作前後的進度，事後查帳用（進度被誰動過、動了多少）
ALTER TABLE checkpoint_attempts ADD COLUMN action TEXT;
ALTER TABLE checkpoint_attempts
  ADD CONSTRAINT checkpoint_attempts_action_check CHECK (action IN ('repair', 'disrupt'));
ALTER TABLE checkpoint_attempts ADD COLUMN aligned BOOLEAN;
ALTER TABLE checkpoint_attempts ADD COLUMN progress_before INT;
ALTER TABLE checkpoint_attempts ADD COLUMN progress_after INT;
ALTER TABLE checkpoint_attempts DROP COLUMN total_score;

-- PK 的「扣掉敗方最近得分據點」整組移除。企劃裡 PK 只影響第六權重的 PK 積分庫
-- （勝者奪取敗者的 PK 積分），跟據點進度無關。
-- teams.last_checkpoint_attempt_id 只是為了找出「要扣哪一筆」而存在的，一併移除。
ALTER TABLE pk_duels DROP COLUMN penalty_checkpoint_attempt_id;
ALTER TABLE pk_duels DROP COLUMN penalty_amount;
ALTER TABLE pk_duels DROP COLUMN penalty_cancelled_at;
ALTER TABLE teams DROP COLUMN last_checkpoint_attempt_id;

-- 隊伍數與每次動作的幅度改成後台可調。企劃寫 10 隊、±25%，但這兩個是會臨場
-- 調整的東西（報名人數變動、想讓進度跑快一點），不該寫死在程式裡。
ALTER TABLE game_state ADD COLUMN max_teams INT NOT NULL DEFAULT 10;
ALTER TABLE game_state ADD COLUMN progress_step INT NOT NULL DEFAULT 25;
ALTER TABLE game_state
  ADD CONSTRAINT game_state_max_teams_range CHECK (max_teams BETWEEN 2 AND 100),
  ADD CONSTRAINT game_state_progress_step_range CHECK (progress_step BETWEEN 1 AND 100);
