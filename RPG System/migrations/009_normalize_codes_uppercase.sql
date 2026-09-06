-- 權限碼與線索 QR 代碼改成大小寫不敏感。
--
-- 原本是精確比對，玩家在手機上打小寫（自動大寫沒開、注音切換、直接貼上）就會
-- 得到「查無此碼」這種完全看不出原因的錯誤。程式端已經改成寫入與查詢都轉大寫，
-- 這裡把既有資料一次轉過去，讓已經印出去的 QR 跟已經發出去的碼繼續有效
-- （查詢會把輸入也轉大寫，所以大小寫怎麼寫都對得上）。
--
-- 自動產生的代碼是十六進位（CLUE-xxxxxxxxxxxx），轉大寫是一對一對應，
-- 不會兩個不同的代碼被合併成同一個。

-- 先擋掉「只差在大小寫」的既有資料：這種情況轉大寫會撞 UNIQUE，
-- 與其讓 migration 噴一個看不懂的 23505，不如講清楚是哪些值有衝突。
DO $$
DECLARE
  conflict_list TEXT;
BEGIN
  SELECT string_agg(DISTINCT upper_code, ', ') INTO conflict_list
  FROM (
    SELECT upper(qr_token) AS upper_code
    FROM clues GROUP BY upper(qr_token) HAVING count(*) > 1
  ) x;
  IF conflict_list IS NOT NULL THEN
    RAISE EXCEPTION '有只差在大小寫的線索 QR 代碼，轉成大寫會衝突，請先手動改掉：%', conflict_list;
  END IF;

  SELECT string_agg(DISTINCT upper_code, ', ') INTO conflict_list
  FROM (
    SELECT upper(code) AS upper_code
    FROM access_codes GROUP BY upper(code) HAVING count(*) > 1
  ) x;
  IF conflict_list IS NOT NULL THEN
    RAISE EXCEPTION '有只差在大小寫的權限碼，轉成大寫會衝突，請先手動改掉：%', conflict_list;
  END IF;
END $$;

UPDATE clues        SET qr_token = upper(trim(qr_token)) WHERE qr_token <> upper(trim(qr_token));
UPDATE access_codes SET code     = upper(trim(code))     WHERE code     <> upper(trim(code));
