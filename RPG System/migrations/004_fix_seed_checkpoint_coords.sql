-- 002_seed_test_data.sql 塞的兩個測試關卡座標是隨便猜的佔位值（24.968x, 121.19x），
-- 是在使用者提供實際活動範圍 bounding box（25.018806~25.021761, 121.937006~121.940729）
-- 之前寫的，落在地圖範圍外，探索導覽地圖會完全看不到這兩個標記。這裡改成落在
-- 實際範圍內的座標，讓地圖功能可以端對端測試。
UPDATE checkpoints SET map_lat = 25.020500, map_lng = 121.938000 WHERE id = 1;
UPDATE checkpoints SET map_lat = 25.019500, map_lng = 121.940000 WHERE id = 2;
