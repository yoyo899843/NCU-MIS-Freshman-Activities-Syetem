-- 筆記改為「我對其他隊伍」而非「我對據點」。保留 checkpoint_notes 舊表，避免直接
-- 刪掉既有資料；新版地圖不再讀它，重啟遊戲時仍會一併清除。
CREATE TABLE team_notes (
  owner_team_id  INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  note           TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_team_id, target_team_id),
  CONSTRAINT team_notes_not_self CHECK (owner_team_id <> target_team_id),
  CONSTRAINT team_notes_len CHECK (char_length(note) BETWEEN 1 AND 10)
);
