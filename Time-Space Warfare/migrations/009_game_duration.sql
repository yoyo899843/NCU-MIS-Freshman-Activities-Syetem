-- 大會投影 Dashboard 的倒數計時需要知道「這場玩多久」，但 game_state 只記了
-- started_at/ended_at，沒有任何地方寫著預計時長，倒數無從算起。
--
-- 這裡補一個時長設定。倒數是「從 started_at 起算 duration_minutes」，時間到
-- 只是畫面上顯示「時間到」，不會自動把遊戲結束掉——什麼時候真的收，仍然由主辦
-- 在後台按「強制結束遊戲」決定（現場常常要多留幾分鐘讓還在路上的隊伍回來）。
--
-- 跟 PK 設定一樣放在 game_state 這張單列設定表。
ALTER TABLE game_state
  ADD COLUMN duration_minutes INT NOT NULL DEFAULT 90;

-- 5 分鐘到 10 小時。下限擋手滑打成 0（會變成一開始就時間到），
-- 上限純粹是防呆，不是真的預期有人要玩 10 小時。
ALTER TABLE game_state
  ADD CONSTRAINT game_state_duration_range CHECK (duration_minutes BETWEEN 5 AND 600);
