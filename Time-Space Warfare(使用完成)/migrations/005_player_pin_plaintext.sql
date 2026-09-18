-- 改成明碼存 PIN，不雜湊——因為現場拿手機操作的是隊輔（不是玩家本人自己設的密碼），
-- 主辦需要能夠直接查得到某支隊伍的 PIN 是多少（例如隊輔忘記了要幫忙查），
-- 雜湊過的話沒有人查得回來。查詢方式就是直接用 PgAdmin 連進資料庫看 players.pin。
ALTER TABLE players DROP COLUMN pin_hash;
ALTER TABLE players ADD COLUMN pin TEXT;
