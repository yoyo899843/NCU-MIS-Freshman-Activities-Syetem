-- 初始價格是第 1 波開始前的開盤基準，不是第 1 波的結算價。
-- 舊版把開盤價放在 stock_prices.wave = 1；升版時把那筆搬到 stocks，
-- 讓 stock_prices 從此只記錄「各波結束」後的價格。
ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS initial_price NUMERIC(12,2);

UPDATE stocks s
SET initial_price = COALESCE((
  SELECT p.price
  FROM stock_prices p
  WHERE p.stock_id = s.id AND p.wave = 1
), 100)
WHERE s.initial_price IS NULL;

ALTER TABLE stocks
  ALTER COLUMN initial_price SET NOT NULL;

ALTER TABLE stocks
  DROP CONSTRAINT IF EXISTS stocks_initial_price_positive;

ALTER TABLE stocks
  ADD CONSTRAINT stocks_initial_price_positive CHECK (initial_price > 0);

-- 既有第 1 波資料原本是初始價格，已在上方搬移，避免誤當成第 1 波結算價。
DELETE FROM stock_prices WHERE wave = 1;
