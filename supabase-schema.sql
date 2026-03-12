-- ================================================================
-- Vibe Animation Competition — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ================================================================

-- Participants table
CREATE TABLE IF NOT EXISTS participants (
  id                SERIAL       PRIMARY KEY,
  name              TEXT         NOT NULL,
  roll_number       TEXT         UNIQUE NOT NULL,
  joined_time       TIMESTAMPTZ  DEFAULT NOW(),
  start_time        BIGINT       NOT NULL,        -- epoch ms when they joined
  completion_time   BIGINT,                       -- ms taken to complete all 5 levels
  completed_at      TIMESTAMPTZ,                  -- ISO timestamp of completion
  level_times       JSONB        DEFAULT '{}',    -- { "1": ms, "2": ms, ... }
  level_start_times JSONB        DEFAULT '{}',    -- { "1": epoch_ms, ... }
  locked_levels     JSONB        DEFAULT '[]',    -- [1, 2, 3, ...]
  level_codes       JSONB        DEFAULT '{}',    -- { "1": "html code", ... }
  level_accuracies  JSONB        DEFAULT '{}'     -- { "1": 84, ... }
);

-- Submissions table (every judge run that was submitted)
CREATE TABLE IF NOT EXISTS submissions (
  id             SERIAL       PRIMARY KEY,
  participant_id INTEGER      NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  level          INTEGER      NOT NULL,
  accuracy       INTEGER      NOT NULL,
  code           TEXT         NOT NULL,
  timestamp      TIMESTAMPTZ  DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_participants_roll ON participants(roll_number);
CREATE INDEX IF NOT EXISTS idx_submissions_part  ON submissions(participant_id);
CREATE INDEX IF NOT EXISTS idx_submissions_level ON submissions(level);

-- Done!
SELECT 'Schema created successfully ✔' AS result;
