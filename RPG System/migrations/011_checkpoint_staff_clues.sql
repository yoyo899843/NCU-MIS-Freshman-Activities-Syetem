-- 一個關卡最多指定四張可由關主現場派發的線索；其餘關聯或通用線索仍走 QR／權限碼。
ALTER TABLE clues ADD COLUMN staff_grant_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION enforce_checkpoint_staff_clue_limit()
RETURNS TRIGGER AS $$
DECLARE
  enabled_count INTEGER;
BEGIN
  IF NOT NEW.staff_grant_enabled THEN
    RETURN NEW;
  END IF;

  IF NEW.checkpoint_id IS NULL THEN
    RAISE EXCEPTION '可由關主派發的線索必須關聯一個關卡';
  END IF;

  -- 鎖住關卡列，讓兩位管理員同時設定時也不會各自看到少於四張而超額。
  PERFORM 1 FROM checkpoints WHERE id = NEW.checkpoint_id FOR UPDATE;
  SELECT COUNT(*) INTO enabled_count
  FROM clues
  WHERE checkpoint_id = NEW.checkpoint_id
    AND staff_grant_enabled = true
    AND id IS DISTINCT FROM NEW.id;

  IF enabled_count >= 4 THEN
    RAISE EXCEPTION '每個關卡最多只能設定 4 個可由關主派發的線索';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clues_staff_grant_limit
BEFORE INSERT OR UPDATE OF checkpoint_id, staff_grant_enabled ON clues
FOR EACH ROW EXECUTE FUNCTION enforce_checkpoint_staff_clue_limit();
