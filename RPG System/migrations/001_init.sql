-- 資管皇家學院數位探查儀 初始 schema

CREATE TABLE schools (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE checkpoints (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  map_lat DOUBLE PRECISION,
  map_lng DOUBLE PRECISION,
  is_locked_by_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE school_checkpoint_progress (
  school_id INT NOT NULL REFERENCES schools(id),
  checkpoint_id INT NOT NULL REFERENCES checkpoints(id),
  unlocked_at TIMESTAMPTZ,
  challenge_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (challenge_status IN ('not_started', 'in_progress', 'completed')),
  challenge_started_at TIMESTAMPTZ,
  challenge_completed_at TIMESTAMPTZ,
  PRIMARY KEY (school_id, checkpoint_id)
);

CREATE TABLE clues (
  id SERIAL PRIMARY KEY,
  checkpoint_id INT REFERENCES checkpoints(id),
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  qr_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE school_clues (
  school_id INT NOT NULL REFERENCES schools(id),
  clue_id INT NOT NULL REFERENCES clues(id),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acquired_via TEXT NOT NULL CHECK (acquired_via IN ('scan', 'code')),
  PRIMARY KEY (school_id, clue_id)
);

CREATE TABLE access_codes (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('checkpoint_unlock', 'hidden_clue')),
  target_checkpoint_id INT REFERENCES checkpoints(id),
  target_clue_id INT REFERENCES clues(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE school_code_redemptions (
  school_id INT NOT NULL REFERENCES schools(id),
  access_code_id INT NOT NULL REFERENCES access_codes(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, access_code_id)
);

CREATE TABLE tech_tree_branches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  story_content TEXT,
  display_order INT NOT NULL DEFAULT 0
);

CREATE TABLE tech_tree_slots (
  id SERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES tech_tree_branches(id),
  slot_order INT NOT NULL DEFAULT 0,
  correct_clue_id INT NOT NULL REFERENCES clues(id)
);

CREATE TABLE school_slot_placements (
  school_id INT NOT NULL REFERENCES schools(id),
  slot_id INT NOT NULL REFERENCES tech_tree_slots(id),
  placed_clue_id INT REFERENCES clues(id),
  is_locked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, slot_id)
);

CREATE TABLE school_check_attempts (
  id SERIAL PRIMARY KEY,
  school_id INT NOT NULL REFERENCES schools(id),
  slot_id INT NOT NULL REFERENCES tech_tree_slots(id),
  attempted_clue_id INT REFERENCES clues(id),
  is_correct BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE school_branch_unlocks (
  school_id INT NOT NULL REFERENCES schools(id),
  branch_id INT NOT NULL REFERENCES tech_tree_branches(id),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, branch_id)
);

CREATE TABLE elders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE school_votes (
  school_id INT PRIMARY KEY REFERENCES schools(id),
  elder_id INT NOT NULL REFERENCES elders(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE game_state (
  id INT PRIMARY KEY DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'ended')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  voting_unlocked_at TIMESTAMPTZ,
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO game_state (id, status) VALUES (1, 'not_started');

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
