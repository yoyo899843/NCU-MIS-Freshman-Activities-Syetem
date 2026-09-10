-- 刪除管理端帳號時保留稽核紀錄，僅移除已不存在帳號的關聯。
ALTER TABLE admin_actions
  ALTER COLUMN admin_user_id DROP NOT NULL;
