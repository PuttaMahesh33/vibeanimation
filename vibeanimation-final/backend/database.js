// backend/database.js — Supabase PostgreSQL edition
// Uses the standard `pg` driver with a connection pool.
// Set DATABASE_URL in your Render environment variables to your Supabase connection string.
'use strict';

const { Pool } = require('pg');

// Supabase provides a "Transaction" pooler URL (port 6543) — use that for serverless.
// For Render (long-running server) the direct URL (port 5432) also works fine.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // required for Supabase
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

// ─── Schema bootstrap ─────────────────────────────────────────
// Run once on startup: creates tables if they don't exist.
// (You can also run the SQL manually in the Supabase SQL editor.)

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS participants (
      id               SERIAL PRIMARY KEY,
      name             TEXT        NOT NULL,
      roll_number      TEXT        UNIQUE NOT NULL,
      joined_time      TIMESTAMPTZ DEFAULT NOW(),
      start_time       BIGINT      NOT NULL,
      completion_time  BIGINT,
      completed_at     TIMESTAMPTZ,
      level_times      JSONB       DEFAULT '{}',
      level_start_times JSONB      DEFAULT '{}',
      locked_levels    JSONB       DEFAULT '[]',
      level_codes      JSONB       DEFAULT '{}',
      level_accuracies JSONB       DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id             SERIAL  PRIMARY KEY,
      participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
      level          INTEGER NOT NULL,
      accuracy       INTEGER NOT NULL,
      code           TEXT    NOT NULL,
      timestamp      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_participant ON submissions(participant_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_level       ON submissions(level);
  `);
  console.log('[DB] Schema ready ✔');
}

// Call on startup — errors are logged but do not crash the server
initSchema().catch(e => console.error('[DB] Schema init failed:', e.message));

// ─── Helper: row → participant object ──────────────────────────

function rowToParticipant(r) {
  return {
    id:               r.id,
    name:             r.name,
    rollNumber:       r.roll_number,
    joinedTime:       r.joined_time,
    startTime:        Number(r.start_time),
    completionTime:   r.completion_time ? Number(r.completion_time) : null,
    completedAt:      r.completed_at || null,
    levelTimes:       r.level_times        || {},
    levelStartTimes:  r.level_start_times  || {},
    lockedLevels:     r.locked_levels      || [],
    levelCodes:       r.level_codes        || {},
    levelAccuracies:  r.level_accuracies   || {},
  };
}

function rowToSubmission(r) {
  return {
    id:            r.id,
    participantId: r.participant_id,
    level:         r.level,
    accuracy:      r.accuracy,
    code:          r.code,
    timestamp:     r.timestamp,
  };
}

// ─── Public API ───────────────────────────────────────────────

async function upsertParticipant(name, rollNumber) {
  // Return existing participant if roll already registered
  const existing = await pool.query(
    'SELECT * FROM participants WHERE roll_number = $1', [rollNumber]
  );
  if (existing.rows.length > 0) return rowToParticipant(existing.rows[0]);

  const now = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO participants
       (name, roll_number, joined_time, start_time,
        level_times, level_start_times, locked_levels, level_codes, level_accuracies)
     VALUES ($1,$2,NOW(),$3,'{}','{}','[]','{}','{}')
     RETURNING *`,
    [name, rollNumber, now]
  );
  return rowToParticipant(rows[0]);
}

async function getParticipantByRoll(rollNumber) {
  const { rows } = await pool.query(
    'SELECT * FROM participants WHERE roll_number = $1', [rollNumber]
  );
  return rows.length > 0 ? rowToParticipant(rows[0]) : null;
}

async function getParticipantById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM participants WHERE id = $1', [id]
  );
  return rows.length > 0 ? rowToParticipant(rows[0]) : null;
}

async function startLevelTimer(participantId, level) {
  // Only record the start time if it hasn't been set yet
  await pool.query(
    `UPDATE participants
     SET level_start_times = CASE
       WHEN (level_start_times->>$2::text) IS NULL
         THEN jsonb_set(level_start_times, ARRAY[$2::text], $3::jsonb)
       ELSE level_start_times
     END
     WHERE id = $1`,
    [participantId, String(level), JSON.stringify(Date.now())]
  );
  return getParticipantById(participantId);
}

async function lockLevel(participantId, level, code, accuracy) {
  const p = await getParticipantById(participantId);
  if (!p) return null;

  const startMs   = p.levelStartTimes[level] || p.startTime;
  const levelTime = Date.now() - startMs;

  // Build updated JSON columns
  const newLocked    = p.lockedLevels.includes(level) ? p.lockedLevels : [...p.lockedLevels, level];
  const newCodes     = { ...p.levelCodes,      [level]: code };
  const newAccs      = { ...p.levelAccuracies, [level]: accuracy };
  const newTimes     = { ...p.levelTimes,      [level]: levelTime };

  const allDone      = [1,2,3,4,5].every(l => newLocked.includes(l));
  const compTime     = (allDone && !p.completionTime) ? Date.now() - p.startTime : p.completionTime;
  const compAt       = (allDone && !p.completedAt)    ? new Date().toISOString()  : p.completedAt;

  const { rows } = await pool.query(
    `UPDATE participants SET
       locked_levels    = $2,
       level_codes      = $3,
       level_accuracies = $4,
       level_times      = $5,
       completion_time  = $6,
       completed_at     = $7
     WHERE id = $1
     RETURNING *`,
    [
      participantId,
      JSON.stringify(newLocked),
      JSON.stringify(newCodes),
      JSON.stringify(newAccs),
      JSON.stringify(newTimes),
      compTime || null,
      compAt   || null,
    ]
  );
  return rowToParticipant(rows[0]);
}

async function saveSubmission(participantId, level, accuracy, code) {
  const { rows } = await pool.query(
    `INSERT INTO submissions (participant_id, level, accuracy, code, timestamp)
     VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
    [participantId, level, accuracy, code]
  );
  return rowToSubmission(rows[0]);
}

async function getParticipantBestPerLevel(participantId) {
  const p = await getParticipantById(participantId);
  if (!p) return [];

  const { rows } = await pool.query(
    `SELECT level, MAX(accuracy) as best, COUNT(*) as attempts
     FROM submissions WHERE participant_id = $1
     GROUP BY level`,
    [participantId]
  );

  const ll = p.lockedLevels || [];
  return rows.map(r => ({
    level:        r.level,
    bestAccuracy: r.best,
    attempts:     Number(r.attempts),
    locked:       ll.includes(r.level),
    code:         (p.levelCodes || {})[r.level]      || null,
    accuracy:     (p.levelAccuracies || {})[r.level] || r.best,
  }));
}

async function getAllParticipants() {
  const { rows: parts } = await pool.query('SELECT * FROM participants ORDER BY id');
  const { rows: subs  } = await pool.query(
    'SELECT participant_id, level, MAX(accuracy) as best FROM submissions GROUP BY participant_id, level'
  );
  const { rows: lastSub } = await pool.query(
    `SELECT DISTINCT ON (participant_id) participant_id, timestamp
     FROM submissions ORDER BY participant_id, timestamp DESC`
  );

  const lastSubMap = {};
  lastSub.forEach(r => { lastSubMap[r.participant_id] = r.timestamp; });

  const subMap = {};
  subs.forEach(r => {
    if (!subMap[r.participant_id]) subMap[r.participant_id] = {};
    subMap[r.participant_id][r.level] = Number(r.best);
  });

  return parts.map(row => {
    const p   = rowToParticipant(row);
    const ll  = p.lockedLevels || [];
    const bpl = subMap[p.id] || {};
    const total = Object.values(bpl).reduce((a, b) => a + b, 0);

    return {
      id: p.id, name: p.name, rollNumber: p.rollNumber,
      joinedTime: p.joinedTime, startTime: p.startTime,
      completionTime: p.completionTime || null,
      completedAt:    p.completedAt    || null,
      levelTimes:     p.levelTimes     || {},
      levelsCompleted: ll.length,
      lockedLevels:    ll,
      totalSubmissions: Object.values(bpl).length,
      avgAccuracy: ll.length > 0 ? Math.round(total / 5) : 0,
      lastSubmission: lastSubMap[p.id] || null,
      currentLevel: ll.length < 5 ? ll.length + 1 : 5,
    };
  }).sort((a, b) => {
    if (b.levelsCompleted !== a.levelsCompleted) return b.levelsCompleted - a.levelsCompleted;
    if (b.avgAccuracy     !== a.avgAccuracy)     return b.avgAccuracy     - a.avgAccuracy;
    if (a.completionTime  && b.completionTime)   return a.completionTime  - b.completionTime;
    return 0;
  });
}

async function getParticipantDetail(id) {
  const p = await getParticipantById(id);
  if (!p) return null;

  const { rows: subs } = await pool.query(
    'SELECT * FROM submissions WHERE participant_id = $1 ORDER BY timestamp DESC',
    [id]
  );

  const topByLevel = {};
  for (let level = 1; level <= 5; level++) {
    const { rows: top } = await pool.query(
      `SELECT s.*, p.name as owner_name, p.roll_number as owner_roll
       FROM submissions s
       JOIN participants p ON p.id = s.participant_id
       WHERE s.level = $1
       ORDER BY s.accuracy DESC LIMIT 5`,
      [level]
    );
    topByLevel[level] = top.map(r => ({
      id: r.id, accuracy: r.accuracy, timestamp: r.timestamp, code: r.code,
      name: r.owner_name, rollNumber: r.owner_roll,
    }));
  }

  return {
    participant:     p,
    submissions:     subs.map(rowToSubmission),
    topByLevel,
    levelTimes:      p.levelTimes      || {},
    lockedLevels:    p.lockedLevels    || [],
    levelCodes:      p.levelCodes      || {},
    levelAccuracies: p.levelAccuracies || {},
  };
}

async function getLeaderboard() {
  const { rows: parts } = await pool.query('SELECT * FROM participants ORDER BY id');
  const { rows: subs  } = await pool.query(
    'SELECT participant_id, level, MAX(accuracy) as best FROM submissions GROUP BY participant_id, level'
  );
  const { rows: lastSub } = await pool.query(
    `SELECT DISTINCT ON (participant_id) participant_id, timestamp
     FROM submissions ORDER BY participant_id, timestamp DESC`
  );

  const lastSubMap = {};
  lastSub.forEach(r => { lastSubMap[r.participant_id] = r.timestamp; });

  const subMap = {};
  subs.forEach(r => {
    if (!subMap[r.participant_id]) subMap[r.participant_id] = {};
    subMap[r.participant_id][r.level] = Number(r.best);
  });

  return parts.map(row => {
    const p     = rowToParticipant(row);
    const ll    = p.lockedLevels || [];
    const bpl   = subMap[p.id]   || {};
    const total = Object.values(bpl).reduce((a, b) => a + b, 0);
    return {
      id: p.id, name: p.name, rollNumber: p.rollNumber,
      levelsCompleted: ll.length,
      avgAccuracy:     Math.round(total / 5),
      completionTime:  p.completionTime || null,
      completedAt:     p.completedAt    || null,
      startTime:       p.startTime,
      lastSubmission:  lastSubMap[p.id] || null,
    };
  }).sort((a, b) => {
    if (b.levelsCompleted !== a.levelsCompleted) return b.levelsCompleted - a.levelsCompleted;
    if (b.avgAccuracy     !== a.avgAccuracy)     return b.avgAccuracy     - a.avgAccuracy;
    if (a.completionTime  && b.completionTime)   return a.completionTime  - b.completionTime;
    if (a.completionTime) return -1;
    if (b.completionTime) return  1;
    return 0;
  });
}

module.exports = {
  upsertParticipant, getParticipantByRoll, getParticipantById,
  getAllParticipants, getParticipantDetail, saveSubmission,
  getParticipantBestPerLevel, getLeaderboard, startLevelTimer, lockLevel,
};
