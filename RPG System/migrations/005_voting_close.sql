-- 最終決策投票支援主辦手動關閉（原本只能開放，開了就沒辦法關）。
-- voting_unlocked_at 保留「最初開放的時間」不動，voting_closed_at 有值就代表
-- 現在是關閉狀態；重新開放時把 voting_closed_at 清空即可，不用另外開一張
-- 開關歷程表——這個功能只需要知道「現在開著還關著」，不需要完整的操作歷史。
ALTER TABLE game_state ADD COLUMN voting_closed_at TIMESTAMPTZ;
