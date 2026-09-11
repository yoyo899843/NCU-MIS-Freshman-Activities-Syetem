-- 線索的「獲得地點」是玩家可讀的文字，不再讓 CSV 作者填系統內部關卡 ID。
-- checkpoint_id 仍保留給既有的關卡線索進度統計與關聯功能使用。
ALTER TABLE clues ADD COLUMN acquisition_location TEXT;

-- 已有的關卡線索沿用其關聯關卡名稱，避免升版後線索庫的地點欄位全數空白。
UPDATE clues c
SET acquisition_location = cp.name
FROM checkpoints cp
WHERE c.checkpoint_id = cp.id
  AND c.acquisition_location IS NULL;
