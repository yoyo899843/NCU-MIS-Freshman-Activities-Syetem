-- 第一個真實關卡點位：大本營。座標由主辦實際到現場測量提供，跟 002/004 那兩筆
-- 明確標示「測試用」的佔位資料不同，這是真的會用在活動當天的關卡。大本營是
-- 隊伍出發/回報的據點，預設不上鎖（is_locked_by_default 沿用預設值 false）。
INSERT INTO checkpoints (name, description, map_lat, map_lng)
VALUES ('大本營', NULL, 25.0205313, 121.9389326);
