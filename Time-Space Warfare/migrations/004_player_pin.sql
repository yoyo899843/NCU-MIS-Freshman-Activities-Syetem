-- 現在一組（一支隊伍）只用一支手機登入，所以「代號」唯一對應一支隊伍，
-- 加一組 PIN 碼讓同一支隊伍之後（掉線、換手機、瀏覽器資料被清掉）可以用
-- 同樣的代號 + PIN 拿回原本的身份/隊伍，而不是意外又開了一支新隊伍。
ALTER TABLE players ADD COLUMN pin_hash TEXT;
ALTER TABLE players ADD CONSTRAINT players_display_name_unique UNIQUE (display_name);
