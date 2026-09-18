-- 讓管理員可以取消某次 PK 扣分懲罰。penalty_amount 保留原本扣了多少分（歷史紀錄），
-- 用 penalty_cancelled_at 是否有值來判斷「這筆懲罰現在還算不算數」，而不是直接把
-- penalty_amount 歸零覆蓋掉——這樣之後回頭查「這場對戰原本扣了多少分」還查得到。
ALTER TABLE pk_duels ADD COLUMN penalty_cancelled_at TIMESTAMPTZ;
