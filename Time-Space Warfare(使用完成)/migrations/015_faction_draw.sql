-- 陣營改成「開始遊戲時抽籤」，不再是登入時邊加入邊分配。
--
-- 原本的做法是每有一支新隊伍登入，就把他丟到目前人數少的那一邊（平手隨機），
-- 結果是兩邊大致各半。企劃要的不是這個：內鬼只有固定的少數幾支（預設 3），
-- 而且要在遊戲開始的那一刻才決定——先到先登入的隊伍不該因為報到順序就影響
-- 自己是哪一邊。

-- 幾支破壞者（內鬼）。企劃寫 3，但隊伍數本來就是後台可調的，這個跟著可調。
--
-- 這個數字跟 spy_vote_count（每隊要「指認」幾支）刻意分開存：主辦可能宣布
-- 「場上有 3 個內鬼，但你們只要指認 2 支」，兩者不是同一件事。
ALTER TABLE game_state ADD COLUMN spy_team_count INT NOT NULL DEFAULT 3;
ALTER TABLE game_state
  ADD CONSTRAINT game_state_spy_team_count_range CHECK (spy_team_count BETWEEN 1 AND 20);

-- 抽籤的時間點。NULL＝這一場還沒抽，teams.faction 裡的值沒有意義，不可以拿去
-- 顯示給玩家看。
--
-- 需要這個欄位而不是只看 game_state.status，是因為「還沒抽」和「抽完了」必須
-- 是玩家端分得出來的兩種狀態：teams.faction 有 NOT NULL 的 CHECK，沒抽之前
-- 每支隊伍照樣有一個值（新隊伍一律先掛 repair），前端要是照著顯示，開賽前
-- 每個人都會看到自己是「時空修復者」，抽完又突然變成破壞者——那等於提前
-- 洩漏了「你原本不是內鬼」這件事。
ALTER TABLE game_state ADD COLUMN faction_drawn_at TIMESTAMPTZ;

-- 升級當下如果已經在跑（或跑完）了，那一場的陣營是舊制分配好的、玩家也已經
-- 看過了，補記成已抽籤，否則現場更新完會突然全部變回「未公布」。
UPDATE game_state SET faction_drawn_at = started_at WHERE status <> 'not_started';


-- team_number 改成全場唯一。
--
-- 舊制是「每個陣營各自從 1 開始編號」（INSERT 時取 MAX(team_number)+1
-- WHERE faction = ?），因為陣營一旦決定就不會變。改成開賽抽籤之後這個前提沒了：
-- 抽完把某支 repair 改成 disrupt，它的編號就可能跟原本的 disrupt #2 撞在一起，
-- 後台和投票名單上會出現兩支「#2」，主辦分不出誰是誰。
WITH renumbered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS n FROM teams
)
UPDATE teams t SET team_number = r.n FROM renumbered r WHERE t.id = r.id;

ALTER TABLE teams ADD CONSTRAINT teams_team_number_unique UNIQUE (team_number);
