-- 內鬼指認投票（第三權重）。
--
-- 企劃：「遊戲結束前進入最終審判階段，每個好人隊伍需在平板上投票指認 3 個內鬼
-- 隊伍，指認正確者獲得額外積分」；計分是「每成功猜中 1 支內鬼隊伍即獲得一份
-- 該權重積分（最多 3 份）」。

-- 投票開關。沿用 RPG System 的做法：unlocked_at 記「最初開放的時間」不動，
-- closed_at 有值就代表現在是關閉狀態，重新開放時清空即可，不用另開一張表。
ALTER TABLE game_state
  ADD COLUMN voting_unlocked_at TIMESTAMPTZ,
  ADD COLUMN voting_closed_at   TIMESTAMPTZ;

-- 要指認幾支。企劃寫 3（10 隊裡有 3 支內鬼），但隊伍數本來就是後台可調的，
-- 這個數字也跟著可調。
--
-- 刻意不從「目前有幾支 disrupt 隊伍」推算：那等於系統直接告訴玩家答案有幾個，
-- 而且開賽簡報本來就會公布內鬼有幾支，這是主辦要主動宣布的數字，不是推導出來的。
ALTER TABLE game_state ADD COLUMN spy_vote_count INT NOT NULL DEFAULT 3;
ALTER TABLE game_state
  ADD CONSTRAINT game_state_spy_vote_count_range CHECK (spy_vote_count BETWEEN 1 AND 20);

-- 一張票 = 一支好人隊伍指認一支隊伍。要投 N 支就是 N 列。
--
-- UNIQUE(voter_team_id, suspect_team_id) 擋掉「同一隊被同一個投票者重複指認」——
-- 不擋的話送三次同一支隊伍就能把命中率變成賭一支，而不是真的要指認三支。
CREATE TABLE spy_votes (
  voter_team_id   INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  suspect_team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (voter_team_id, suspect_team_id)
);

CREATE INDEX spy_votes_suspect_idx ON spy_votes(suspect_team_id);
