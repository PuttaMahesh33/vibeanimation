// backend/server.js — Production Express API for Render
'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./database');
const { judgeSubmission } = require('./judge');

const app         = express();
const PORT        = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';

// ─── CORS ─────────────────────────────────────────────────────
// Allow the Vercel frontend URL + local dev
const FRONTEND_URL = process.env.FRONTEND_URL || '';

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin), localhost, and the configured Vercel URL
    if (!origin) return cb(null, true);
    const allowed = [
      FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
    ].filter(Boolean);
    // Also allow *.vercel.app dynamically
    if (origin.endsWith('.vercel.app') || allowed.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-token'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── /levels — serve reference HTMLs in iframes from ANY origin ──
// Must be registered BEFORE general cors middleware
app.use('/levels', (req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(path.join(__dirname, '..', 'levels')));

// ─── Health ───────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));

// ─── Heartbeat (active participant tracking) ──────────────────
const activeHeartbeats = new Map();

app.post('/api/heartbeat', (req, res) => {
  try {
    const { rollNumber } = req.body || {};
    if (rollNumber) activeHeartbeats.set(String(rollNumber).toUpperCase(), Date.now());
    return res.json({ ok: true });
  } catch { return res.json({ ok: false }); }
});

// ─── Participant routes ───────────────────────────────────────

app.post('/api/join', (req, res) => {
  try {
    const { name, rollNumber } = req.body || {};
    if (!name || !rollNumber)
      return res.status(400).json({ success: false, error: 'Name and roll number required.' });
    const roll        = String(rollNumber).trim().toUpperCase();
    const participant = db.upsertParticipant(String(name).trim(), roll);
    const progress    = db.getParticipantBestPerLevel(participant.id);
    return res.json({ success: true, participant, progress });
  } catch (err) {
    console.error('JOIN:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/start-level', (req, res) => {
  try {
    const { rollNumber, level } = req.body || {};
    if (!rollNumber || !level) return res.status(400).json({ error: 'Missing fields.' });
    const p = db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!p) return res.status(404).json({ error: 'Participant not found.' });
    db.startLevelTimer(p.id, parseInt(level));
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/api/judge', async (req, res) => {
  try {
    const { code, level, rollNumber } = req.body || {};
    if (!code || !level || !rollNumber)
      return res.status(400).json({ success: false, error: 'code, level and rollNumber required.' });
    const p = db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!p) return res.status(404).json({ success: false, error: 'Participant not found.' });
    const result = await judgeSubmission(code, parseInt(level));
    return res.json(result);
  } catch (err) {
    console.error('JUDGE:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const { code, level, rollNumber } = req.body || {};
    if (!code || !level || !rollNumber)
      return res.status(400).json({ success: false, error: 'Missing fields.' });
    const p = db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!p) return res.status(404).json({ success: false, error: 'Participant not found.' });

    const lvl    = parseInt(level);
    const locked = p.lockedLevels || [];
    if (locked.includes(lvl))
      return res.status(409).json({ success: false, error: `Level ${lvl} already submitted.` });

    const result = await judgeSubmission(code, lvl);
    if (!result.valid)
      return res.status(422).json({ success: false, errors: result.errors, score: 0 });
    if (result.score < 50)
      return res.status(422).json({ success: false, errors: ['Need 50%+ to submit.'],
        score: result.score, breakdown: result.breakdown });

    db.saveSubmission(p.id, lvl, result.score, code);
    const updated  = db.lockLevel(p.id, lvl, code, result.score);
    const progress = db.getParticipantBestPerLevel(p.id);

    return res.json({
      success: true, score: result.score, breakdown: result.breakdown, progress,
      lockedLevels:   updated ? (updated.lockedLevels || []) : [],
      completionTime: updated ? (updated.completionTime || null) : null,
    });
  } catch (err) {
    console.error('SUBMIT:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/leaderboard', (req, res) => {
  try { return res.json(db.getLeaderboard()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/progress/:rollNumber', (req, res) => {
  try {
    const p = db.getParticipantByRoll(req.params.rollNumber.toUpperCase());
    if (!p) return res.status(404).json({ error: 'Not found.' });
    return res.json({ participant: p, progress: db.getParticipantBestPerLevel(p.id) });
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

app.get('/api/active-rolls', adminAuth, (req, res) => {
  const now = Date.now();
  const active = [];
  activeHeartbeats.forEach((ts, roll) => { if (now - ts < 20000) active.push(roll); });
  return res.json(active);
});

// ─── 404 catch-all ───────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Vibe Animation API running on port ${PORT}`);
  console.log(`   FRONTEND_URL = ${FRONTEND_URL || '(any .vercel.app)'}`);
  console.log(`   ADMIN_TOKEN  = ${ADMIN_TOKEN}`);
  console.log(`   DB_FILE      = ${process.env.DB_PATH || '../db.json'}\n`);
});
