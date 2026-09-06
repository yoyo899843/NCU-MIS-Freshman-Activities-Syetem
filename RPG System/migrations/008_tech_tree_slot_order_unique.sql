-- 科技樹槽位的 slot_order 原本沒有唯一限制，實際資料裡出現過同一個分支下兩個
-- 槽位都是 slot_order = 1。玩家端的 reachable（前面的格子沒鎖定就排不到）是照
-- 查詢回傳順序一路累積算出來的，slot_order 相同時資料庫不保證順序，同一份資料
-- 可能算出不同結果。查詢已經補上 s.id 當第二排序鍵，這裡再從資料面根除重複。

-- 1) 先把每個分支底下的槽位重新編號成 1,2,3...
--    排序用 (slot_order, id)，跟補完決勝鍵之後的實際顯示順序一致，
--    所以重新編號不會改變現在看到的排列。
WITH renumbered AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY slot_order, id) AS new_order
  FROM tech_tree_slots
)
UPDATE tech_tree_slots s
SET slot_order = r.new_order
FROM renumbered r
WHERE s.id = r.id AND s.slot_order IS DISTINCT FROM r.new_order;

-- 2) 之後不允許同一個分支裡有重複的 slot_order
ALTER TABLE tech_tree_slots
  ADD CONSTRAINT tech_tree_slots_branch_order_unique UNIQUE (branch_id, slot_order);
