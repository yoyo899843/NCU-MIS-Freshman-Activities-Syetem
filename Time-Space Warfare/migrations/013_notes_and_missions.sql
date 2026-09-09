-- 1) 各隊自己的據點筆記
--
-- 每支隊伍可以幫每個據點取自己的名字/註記，只有自己隊的大地圖看得到。這是推理
-- 用的工具（「這個點剛剛掉了 50%」「三號點有人守」），所以刻意做成隊伍私有——
-- 如果所有人都看得到，等於變成公共留言板，內鬼可以直接放假消息誤導全場。
CREATE TABLE checkpoint_notes (
  team_id       INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  checkpoint_id INT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  note          TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, checkpoint_id)
);

-- 十個字。char_length 算的是字元不是位元組，中文一個字就是 1。
ALTER TABLE checkpoint_notes
  ADD CONSTRAINT checkpoint_notes_len CHECK (char_length(note) BETWEEN 1 AND 10);


-- 2) 突發任務
--
-- 改成由主辦手動派發（原本企劃寫「系統隨機派發」，但現場要的是可控）：
-- 後台選對象小隊、選接受點位、填任務內容，系統配一組解鎖碼。
-- 關主在現場確認任務完成後把解鎖碼給該隊，該隊輸入解鎖碼才結案並計分。
--
-- 解鎖碼是「完成」的唯一憑證，所以玩家端的 API 一律不得回傳它（見
-- src/routes/missions.js）——能看到碼就等於能自己結案。
CREATE TABLE missions (
  id            SERIAL PRIMARY KEY,
  team_id       INT NOT NULL REFERENCES teams(id),
  checkpoint_id INT REFERENCES checkpoints(id),
  content       TEXT NOT NULL,
  unlock_code   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  created_by    INT REFERENCES admin_users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX missions_team_idx ON missions(team_id, status);

-- 同一組解鎖碼同時間只能有一個未結案的任務在用，否則玩家拿到碼可以結掉別人的任務。
CREATE UNIQUE INDEX missions_open_code_idx ON missions(unlock_code) WHERE status = 'open';
