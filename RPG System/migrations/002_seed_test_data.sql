-- 測試資料：權限碼兌換功能需要至少有真實存在的 checkpoint/clue 可以當兌換目標，
-- 但 checkpoint/clue 的 admin CRUD 還沒開發（見 PLAN.md），先塞幾筆固定測試資料，
-- 讓「線索兌換」這個模組可以端對端測試。之後 checkpoint/clue CRUD 做出來後，
-- 這幾筆可以留著當範例，也可以由主辦自行刪除重建。

INSERT INTO checkpoints (id, name, description, map_lat, map_lng, is_locked_by_default) VALUES
  (1, '資訊圖書館', '測試用關卡點位一', 24.968, 121.191, true),
  (2, '管理學院大樓', '測試用關卡點位二', 24.969, 121.192, true);
SELECT setval('checkpoints_id_seq', (SELECT MAX(id) FROM checkpoints));

INSERT INTO clues (id, checkpoint_id, name, description, image_url, qr_token) VALUES
  (1, 1, '泛黃的筆記', '在資訊圖書館找到的線索，測試用。', NULL, 'CLUE-TEST-001'),
  (2, 2, '模糊的合照', '在管理學院大樓找到的線索，測試用。', NULL, 'CLUE-TEST-002'),
  (3, NULL, '隱藏的密函', '不屬於任何關卡、只能靠隱藏線索碼兌換取得，測試用。', NULL, 'CLUE-TEST-003');
SELECT setval('clues_id_seq', (SELECT MAX(id) FROM clues));
