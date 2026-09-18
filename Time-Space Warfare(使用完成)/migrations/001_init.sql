-- 時空戰爭 初始 schema

CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  faction TEXT NOT NULL CHECK (faction IN ('repair', 'disrupt')),
  team_number INT NOT NULL,
  name TEXT,
  last_checkpoint_attempt_id INT, -- FK 加在 checkpoint_attempts 建立後
  pk_protected_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE players (
  id SERIAL PRIMARY KEY,
  team_id INT NOT NULL REFERENCES teams(id),
  display_name TEXT NOT NULL,
  is_captain BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE checkpoints (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  map_lat DOUBLE PRECISION,
  map_lng DOUBLE PRECISION,
  qr_token TEXT NOT NULL UNIQUE,
  repair_value NUMERIC NOT NULL DEFAULT 0,
  disrupt_value NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('checkpoint', 'pk', 'general')),
  checkpoint_id INT REFERENCES checkpoints(id),
  content TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
  time_limit_seconds INT NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE checkpoint_attempts (
  id SERIAL PRIMARY KEY,
  checkpoint_id INT NOT NULL REFERENCES checkpoints(id),
  player_id INT NOT NULL REFERENCES players(id),
  team_id INT NOT NULL REFERENCES teams(id),
  faction TEXT NOT NULL CHECK (faction IN ('repair', 'disrupt')),
  correct_count INT NOT NULL DEFAULT 0,
  total_score NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE teams
  ADD CONSTRAINT teams_last_checkpoint_attempt_fk
  FOREIGN KEY (last_checkpoint_attempt_id) REFERENCES checkpoint_attempts(id);

CREATE TABLE pk_duels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code TEXT NOT NULL,
  qr_token TEXT NOT NULL UNIQUE,
  host_player_id INT NOT NULL REFERENCES players(id),
  guest_player_id INT REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'completed')),
  winner_player_id INT REFERENCES players(id),
  loser_player_id INT REFERENCES players(id),
  penalty_checkpoint_attempt_id INT REFERENCES checkpoint_attempts(id),
  penalty_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE pk_duel_answers (
  id SERIAL PRIMARY KEY,
  pk_duel_id UUID NOT NULL REFERENCES pk_duels(id),
  player_id INT NOT NULL REFERENCES players(id),
  correct_count INT NOT NULL DEFAULT 0,
  total_time_ms INT NOT NULL DEFAULT 0
);

CREATE TABLE admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_actions (
  id SERIAL PRIMARY KEY,
  admin_user_id INT NOT NULL REFERENCES admin_users(id),
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE game_state (
  id INT PRIMARY KEY DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'ended')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO game_state (id, status) VALUES (1, 'not_started');
