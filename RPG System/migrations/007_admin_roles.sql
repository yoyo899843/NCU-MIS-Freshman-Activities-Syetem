-- 管理端帳號分兩級：
--   admin      管理員——什麼都能做（設定內容、管帳號、控制遊戲進程）。
--   gatekeeper 關主——現場工作人員，只能做活動當天的操作：幫隊伍標記關卡
--              解鎖/完成、直接發線索給隊伍、看各種清單跟戰況板，不能改設定
--              也不能管帳號。
--
-- 既有帳號一律預設 admin，行為跟加這一欄之前完全一樣，部署後不會有人突然被降權。
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'gatekeeper'));

-- 關主直接發給隊伍的線索，來源跟「自己掃碼」「自己兌換權限碼」都不一樣，
-- 多開一個 staff 值分開記，之後要查某個線索是怎麼到某支隊伍手上的才分得出來。
ALTER TABLE school_clues DROP CONSTRAINT school_clues_acquired_via_check;
ALTER TABLE school_clues ADD CONSTRAINT school_clues_acquired_via_check
  CHECK (acquired_via IN ('scan', 'code', 'staff'));
