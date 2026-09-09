-- 賭大股票系統：三回合（波）制的虛擬股市。
--
-- 一波的流程是固定的四階段（見 賭大股票系統.pdf）：
--   news     系統發布本波新聞，各隊判讀對四間公司的利多/利空
--   gambling 玩家去實體關卡賭博賺現金（這一段完全在系統外發生）
--   deposit  各隊申報要存入的金額，實體銀行攤位數鈔核對後在後台核准或駁回
--   trading  審核通過的隊伍才能下單買賣，截止後管理端更新下一波股價
--
-- 金額一律用 NUMERIC 不用 float：這是錢，浮點數的 0.1+0.2 問題會直接變成
-- 「銀行核對金額對不起來」。

CREATE TABLE teams (
  id            SERIAL PRIMARY KEY,
  display_name  TEXT NOT NULL UNIQUE,
  pin           TEXT NOT NULL,
  -- 可用現金餘額。只會因為「銀行核准的存款」與「交易」而變動。
  cash          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cash >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 管理端帳號。role 分兩種：
--   admin  主辦，什麼都能做（發新聞、設股價、覆寫餘額）
--   banker 銀行攤位的關主，只負責核准/駁回存款申報
CREATE TABLE admin_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'banker')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stocks (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_order INT NOT NULL DEFAULT 0
);

-- 每一波的收盤價。K 線/趨勢圖就是把這張表照 wave 排出來。
-- change_pct 是相對前一波的漲跌幅，存下來而不是每次重算：管理端是「直接輸入
-- 漲跌百分比」或「直接輸入新價格」都可以，兩者算出來的數字要能對得起來。
CREATE TABLE stock_prices (
  stock_id   INT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  wave       INT NOT NULL,
  price      NUMERIC(12,2) NOT NULL CHECK (price > 0),
  change_pct NUMERIC(7,2),
  PRIMARY KEY (stock_id, wave)
);

CREATE TABLE game_state (
  id          INT PRIMARY KEY DEFAULT 1,
  wave        INT NOT NULL DEFAULT 1,
  total_waves INT NOT NULL DEFAULT 3,
  phase       TEXT NOT NULL DEFAULT 'news'
              CHECK (phase IN ('news', 'gambling', 'deposit', 'trading', 'closed')),
  CONSTRAINT single_row CHECK (id = 1)
);

CREATE TABLE news (
  id           SERIAL PRIMARY KEY,
  wave         INT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX news_wave_idx ON news(wave);

-- 存款申報與實體銀行審核。
-- UNIQUE(team_id, wave)：一波只能申報一次。允許重複申報的話，被駁回的隊伍
-- 可以一直改金額重送，實體數鈔那關就形同虛設。
CREATE TABLE deposits (
  id          SERIAL PRIMARY KEY,
  team_id     INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  wave        INT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by INT REFERENCES admin_users(id),
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, wave)
);

CREATE TABLE holdings (
  team_id  INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  stock_id INT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  shares   INT NOT NULL DEFAULT 0 CHECK (shares >= 0),
  PRIMARY KEY (team_id, stock_id)
);

-- 每一筆買賣的明細。價格與總額當下就寫死，不要事後用「當時的股價」回推——
-- 管理端可以覆寫股價，回推會讓歷史帳目跟著變動。
CREATE TABLE trades (
  id         SERIAL PRIMARY KEY,
  team_id    INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  stock_id   INT NOT NULL REFERENCES stocks(id),
  wave       INT NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  shares     INT NOT NULL CHECK (shares > 0),
  price      NUMERIC(12,2) NOT NULL,
  total      NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_team_idx ON trades(team_id, wave);

CREATE TABLE admin_actions (
  id            SERIAL PRIMARY KEY,
  admin_user_id INT REFERENCES admin_users(id),
  action_type   TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  before_value  JSONB,
  after_value   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO game_state (id) VALUES (1);

-- 企劃指定的四檔股票。開盤價統一 100，第一波的漲跌幅留空（沒有前一波可比）。
INSERT INTO stocks (name, display_order) VALUES
  ('伊競商務分析事務所', 1),
  ('佑佑國際資安', 2),
  ('松鼠宅急便', 3),
  ('皇家鑄幣局', 4);

INSERT INTO stock_prices (stock_id, wave, price, change_pct)
  SELECT id, 1, 100, NULL FROM stocks;
