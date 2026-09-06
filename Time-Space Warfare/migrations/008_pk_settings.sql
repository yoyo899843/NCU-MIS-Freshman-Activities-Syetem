-- PK 對戰的題目數量與每題作答時間改成可由主辦在後台調整。
--
-- 原本題數寫死在 src/pk/session.js（QUESTIONS_PER_DUEL = 5），作答時間則是各題
-- questions.time_limit_seconds 各自一個值——活動當天想統一改快一點/慢一點，
-- 前者要改程式重新部署，後者要一題一題改，兩個都不實際。
--
-- 放在 game_state 這張單列設定表，跟遊戲進程放一起（本來就是「全域設定」的位置）。
ALTER TABLE game_state
  ADD COLUMN pk_questions_per_duel INT NOT NULL DEFAULT 5,
  ADD COLUMN pk_answer_seconds INT NOT NULL DEFAULT 10;

-- 給合理範圍，避免手滑打成 0 題或 9999 秒讓整場對戰卡死。
ALTER TABLE game_state
  ADD CONSTRAINT game_state_pk_questions_range CHECK (pk_questions_per_duel BETWEEN 1 AND 20),
  ADD CONSTRAINT game_state_pk_seconds_range CHECK (pk_answer_seconds BETWEEN 3 AND 120);
