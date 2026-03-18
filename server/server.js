// server/server.js
'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./database');
const { judgeSubmission } = require('./judge');

const app          = express();
const PORT         = process.env.PORT || 3000;
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || 'localadmin';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// /levels served FIRST (before cors) with permissive frame headers
app.use('/levels', (req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(path.join(__dirname, '..', 'levels')));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];
    if (allowed.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET','POST'],
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Health ───────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// ─── Heartbeat (active participant tracking) ─────────────────
// Participants ping this every 10s. After 20s silence → marked inactive.
const activeHeartbeats = new Map(); // rollNumber → timestamp

app.post('/api/heartbeat', (req, res) => {
  try {
    const { rollNumber } = req.body || {};
    if (rollNumber) activeHeartbeats.set(String(rollNumber).toUpperCase(), Date.now());
    return res.json({ ok: true });
  } catch { return res.json({ ok: false }); }
});

app.get('/api/active-rolls', adminAuth, (req, res) => {
  const now = Date.now();
  const active = [];
  activeHeartbeats.forEach((ts, roll) => {
    if (now - ts < 20000) active.push(roll); // active within last 20s
  });
  return res.json(active);
});

// ─── Participant routes ───────────────────────────────────────
app.post('/api/join', (req, res) => {
  try {
    const { name, rollNumber } = req.body || {};
    if (!name || !rollNumber) return res.status(400).json({ success: false, error: 'Name and roll number required.' });
    const roll        = String(rollNumber).trim().toUpperCase();
    const cleanName   = String(name).trim();
    const participant = db.upsertParticipant(cleanName, roll);
    const progress    = db.getParticipantBestPerLevel(participant.id);
    return res.json({ success: true, participant, progress });
  } catch (err) {
    console.error('JOIN ERROR:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/start-level', (req, res) => {
  try {
    const { rollNumber, level } = req.body || {};
    if (!rollNumber || !level) return res.status(400).json({ error: 'rollNumber and level required.' });
    const participant = db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!participant) return res.status(404).json({ error: 'Participant not found.' });
    db.startLevelTimer(participant.id, parseInt(level));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/judge', async (req, res) => {
  try {
    const { code, level, rollNumber } = req.body || {};
    if (!code || !level || !rollNumber) return res.status(400).json({ success: false, error: 'code, level and rollNumber required.' });
    const participant = db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!participant) return res.status(404).json({ success: false, error: 'Participant not found. Please join first.' });
    console.log(`Judging L${level} for ${rollNumber}...`);
    const result = await judgeSubmission(code, parseInt(level));
    return res.json(result);
  } catch (err) {
    console.error('JUDGE ERROR:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const { code, level, rollNumber } = req.body || {};
    if (!code || !level || !rollNumber) return res.status(400).json({ success: false, error: 'code, level and rollNumber required.' });
    const participant = db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!participant) return res.status(404).json({ success: false, error: 'Participant not found.' });

    const lvl = parseInt(level);

    // Prevent re-submission of locked level
    const locked = participant.lockedLevels || [];
    if (locked.includes(lvl)) {
      return res.status(409).json({ success: false, error: `Level ${lvl} is already submitted and locked.` });
    }

    console.log(`Submitting L${lvl} for ${rollNumber}...`);
    const result = await judgeSubmission(code, lvl);

    if (!result.valid) return res.status(422).json({ success: false, errors: result.errors, score: 0 });
    if (result.score < 50) return res.status(422).json({ success: false, errors: ['Score must be at least 50% to submit.'], score: result.score, breakdown: result.breakdown });

    // Save submission record
    db.saveSubmission(participant.id, lvl, result.score, code);

    // Lock the level
    const updated = db.lockLevel(participant.id, lvl, code, result.score);

    const progress = db.getParticipantBestPerLevel(participant.id);

    return res.json({
      success:        true,
      score:          result.score,
      breakdown:      result.breakdown,
      progress,
      lockedLevels:   updated ? (updated.lockedLevels || []) : [],
      completionTime: updated ? (updated.completionTime || null) : null
    });
  } catch (err) {
    console.error('SUBMIT ERROR:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/leaderboard', (req, res) => {
  try { return res.json(db.getLeaderboard()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/progress/:rollNumber', (req, res) => {
  try {
    const participant = db.getParticipantByRoll(req.params.rollNumber.toUpperCase());
    if (!participant) return res.status(404).json({ error: 'Not found.' });
    const progress = db.getParticipantBestPerLevel(participant.id);
    return res.json({ participant, progress });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── Admin routes ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

app.get('/api/admin/participants', adminAuth, (req, res) => {
  try { return res.json(db.getAllParticipants()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/participant/:id', adminAuth, (req, res) => {
  try {
    const detail = db.getParticipantDetail(parseInt(req.params.id));
    if (!detail) return res.status(404).json({ error: 'Not found.' });
    return res.json(detail);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/leaderboard', adminAuth, (req, res) => {
  try { return res.json(db.getLeaderboard()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── Pages ───────────────────────────────────────────────────
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'admin',  'admin.html')));

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  Vibe Animation Competition Server    ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Participant: http://localhost:${PORT}    ║`);
  console.log(`║  Admin:       http://localhost:${PORT}/admin ║`);
  console.log(`║  Token:       ${ADMIN_TOKEN}          ║`);
  console.log('╚═══════════════════════════════════════╝\n');
});
