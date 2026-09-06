-- 開了房但沒人加入的 PK 對戰，現在會在逾時後標記成 cancelled。
--
-- 原本只有 waiting/active/completed 三種狀態，逾時只清掉記憶體裡的房號對照表，
-- pk_duels 那一列永遠停在 waiting——結果是：
--   1. 用 qr_token 加入的路徑不看房號表，直接查 DB，所以幾小時前廢棄的房間還加得進去
--   2. 服務重啟後房號表清空，但那些 waiting 的列還在，同樣可以用 QR 加入
-- 多一個 cancelled 狀態，讓「這場已經作廢」變成資料庫裡查得到的事實。
ALTER TABLE pk_duels DROP CONSTRAINT IF EXISTS pk_duels_status_check;
ALTER TABLE pk_duels ADD CONSTRAINT pk_duels_status_check
  CHECK (status IN ('waiting', 'active', 'completed', 'cancelled'));

-- 既有的殘留：開了很久還停在 waiting 的，一律當作已作廢。
UPDATE pk_duels
SET status = 'cancelled'
WHERE status = 'waiting'
  AND created_at < now() - interval '10 minutes';
