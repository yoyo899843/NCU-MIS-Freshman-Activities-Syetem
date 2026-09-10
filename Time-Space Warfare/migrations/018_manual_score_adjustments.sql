-- 現場補分／扣分。不能把總分直接寫回 teams，因為排行榜每次都會從關卡、任務、PK
-- 等紀錄重算；獨立的調整流水帳才能在重算後保留，並追得出誰在什麼時候調了什麼。
CREATE TABLE score_adjustments (
  id         SERIAL PRIMARY KEY,
  team_id    INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  delta      INT NOT NULL CHECK (delta BETWEEN -1000 AND 1000 AND delta <> 0),
  reason     TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 100),
  created_by INT NOT NULL REFERENCES admin_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX score_adjustments_team_idx ON score_adjustments(team_id, created_at);
