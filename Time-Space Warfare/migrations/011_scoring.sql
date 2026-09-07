-- 六級權重積分（溫馨周企劃「四、積分與勝負結算系統」）。
--
-- 大部分權重可以從既有資料即時算出來，不需要另存欄位：
--   第一權重 20分  陣營勝負      → 由 checkpoints 已完成/未完成的數量判定
--   第二權重  5分  陣營職責      → checkpoint_attempts 裡 aligned = true 的次數
--   第三權重  4分  抓內鬼        → 內鬼指認投票（尚未實作）
--   第四權重  3分  成就與榮譽    → 由修復/破壞/任務/PK 勝場的次數比出來
--   第五權重  2分  任務          → 突發任務系統（尚未實作）
--   第六權重  1分  PK 積分庫     → 需要存，見下
--
-- 只有第六權重非存不可：企劃寫「勝者可直接奪取敗者擁有的第六權重（PK 積分）」，
-- 這是一個會在隊伍之間轉移的存量，不是「贏幾場就幾分」那種可以事後從對戰紀錄
-- 重算的東西——同一份對戰紀錄，依結算順序不同會得出不同的持有量。
ALTER TABLE teams ADD COLUMN pk_points INT NOT NULL DEFAULT 0;
ALTER TABLE teams ADD CONSTRAINT teams_pk_points_nonneg CHECK (pk_points >= 0);

-- 每一級權重值也放進設定表。企劃訂的是 20/5/4/3/2/1，但這是最容易在活動前一天
-- 被調整的東西（覺得抓內鬼太甜、想加重任務比例），不該要改程式重新部署。
ALTER TABLE game_state
  ADD COLUMN w1_faction_win INT NOT NULL DEFAULT 20,
  ADD COLUMN w2_aligned_action INT NOT NULL DEFAULT 5,
  ADD COLUMN w3_spy_guess INT NOT NULL DEFAULT 4,
  ADD COLUMN w4_achievement INT NOT NULL DEFAULT 3,
  ADD COLUMN w5_mission INT NOT NULL DEFAULT 2,
  ADD COLUMN w6_pk_point INT NOT NULL DEFAULT 1;

ALTER TABLE game_state ADD CONSTRAINT game_state_weights_nonneg CHECK (
  w1_faction_win >= 0 AND w2_aligned_action >= 0 AND w3_spy_guess >= 0 AND
  w4_achievement >= 0 AND w5_mission >= 0 AND w6_pk_point >= 0
);
