-- 數位偵探的槽位不分順序：線索放在所屬分支的任一格都算對（見 routes/tech-tree.js）。
--
-- 008 加的 UNIQUE (branch_id, slot_order) 是為了舊的「前一格鎖定才能放下一格」
-- 判定需要確定的順序，現在已經沒有這個規則，後台也不再讓主辦填順序。
-- slot_order 欄位保留，只用來讓格子的排列穩定（新增時自動排在最後）。
ALTER TABLE tech_tree_slots DROP CONSTRAINT tech_tree_slots_branch_order_unique;
