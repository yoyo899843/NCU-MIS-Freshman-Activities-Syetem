-- 管理端帳號分兩級：
--   admin      管理員——什麼都能做（題庫、遊戲進程、玩家帳號、戰況覆寫）。
--   gatekeeper 關主——現場工作人員，只能查看各種清單（交摺點、題庫、PK 對戰
--              紀錄、玩家帳號含 PIN，方便現場幫忙查），不能改任何東西。
--
-- 既有帳號一律預設 admin，行為跟加這一欄之前完全一樣，部署後不會有人突然被降權。
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'gatekeeper'));
