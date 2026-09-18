-- 企劃書裡沒有 QR Code。關卡是關主現場主持、過關後由關主在系統輸入結果，
-- 不是玩家掃碼自己答題；PK 是路上遭遇後主動發起，用房號就夠。
--
-- 掃碼那條路整條移除之後，這兩個欄位沒有任何讀取者，留著只會讓後面接手的人
-- 以為還有掃碼流程。
ALTER TABLE checkpoints DROP COLUMN qr_token;
ALTER TABLE pk_duels DROP COLUMN qr_token;
