-- 學派帳號密碼改成明碼儲存，不雜湊——主辦要能透過後台「學派管理」直接查看/管理每組
-- 學派的帳號密碼（例如忘記密碼時直接後台查看，不用重設），比照 Time-Space Warfare
-- 玩家 PIN 明碼儲存的理由。這是 create-school.js 當初「跟玩家 PIN 不同、維持雜湊」
-- 這個決策的明確反向調整，改由後台管理介面取代 CLI script 作為主要管理方式。
ALTER TABLE schools DROP COLUMN password_hash;
ALTER TABLE schools ADD COLUMN password TEXT;
