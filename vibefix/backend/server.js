// backend/server.js — Production Express API for Render + Supabase
'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./database');
const { judgeSubmission } = require('./judge');

const app         = express();
const PORT        = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
const FRONTEND_URL = process.env.FRONTEND_URL || '';

// ─── CORS ─────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = [
      FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
    ].filter(Boolean);
    if (origin.endsWith('.vercel.app') || allowed.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-token'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── /levels ─────────────────────────────────────────────────
app.use('/levels', (req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(path.join(__dirname, '..', 'levels')));

// ─── Health ───────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));

// ─── Heartbeat ───────────────────────────────────────────────
const activeHeartbeats = new Map();

app.post('/api/heartbeat', (req, res) => {
  try {
    const { rollNumber } = req.body || {};
    if (rollNumber) activeHeartbeats.set(String(rollNumber).toUpperCase(), Date.now());
    return res.json({ ok: true });
  } catch { return res.json({ ok: false }); }
});

// ─── Join ─────────────────────────────────────────────────────
app.post('/api/join', async (req, res) => {
  try {
    const { name, rollNumber } = req.body || {};
    if (!name || !rollNumber)
      return res.status(400).json({ success: false, error: 'Name and roll number required.' });
    const roll        = String(rollNumber).trim().toUpperCase();
    const participant = await db.upsertParticipant(String(name).trim(), roll);
    const progress    = await db.getParticipantBestPerLevel(participant.id);
    return res.json({ success: true, participant, progress });
  } catch (err) {
    console.error('JOIN:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start level ──────────────────────────────────────────────
app.post('/api/start-level', async (req, res) => {
  try {
    const { rollNumber, level } = req.body || {};
    if (!rollNumber || !level) return res.status(400).json({ error: 'Missing fields.' });
    const p = await db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!p) return res.status(404).json({ error: 'Participant not found.' });
    await db.startLevelTimer(p.id, parseInt(level));
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── Judge ───────────────────────────────────────────────────
app.post('/api/judge', async (req, res) => {
  try {
    const { code, level, rollNumber } = req.body || {};
    if (!code || !level || !rollNumber)
      return res.status(400).json({ success: false, error: 'code, level and rollNumber required.' });
    const p = await db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!p) return res.status(404).json({ success: false, error: 'Participant not found.' });
    const result = await judgeSubmission(code, parseInt(level));
    return res.json(result);
  } catch (err) {
    console.error('JUDGE:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Submit ──────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  try {
    const { code, level, rollNumber } = req.body || {};
    if (!code || !level || !rollNumber)
      return res.status(400).json({ success: false, error: 'Missing fields.' });
    const p = await db.getParticipantByRoll(String(rollNumber).toUpperCase());
    if (!p) return res.status(404).json({ success: false, error: 'Participant not found.' });

    const lvl    = parseInt(level);
    const locked = p.lockedLevels || [];
    if (locked.includes(lvl))
      return res.status(409).json({ success: false, error: `Level ${lvl} already submitted.` });

    const result = await judgeSubmission(code, lvl);
    if (!result.valid)
      return res.status(422).json({ success: false, errors: result.errors, score: 0 });
    if (result.score < 50)
      return res.status(422).json({ success: false, errors: ['Need ≥50% to submit.'],
        score: result.score, breakdown: result.breakdown });

    await db.saveSubmission(p.id, lvl, result.score, code);
    const updated  = await db.lockLevel(p.id, lvl, code, result.score);
    const progress = await db.getParticipantBestPerLevel(p.id);

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

// ─── Leaderboard ─────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  try { return res.json(await db.getLeaderboard()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── Progress ────────────────────────────────────────────────
app.get('/api/progress/:rollNumber', async (req, res) => {
  try {
    const p = await db.getParticipantByRoll(req.params.rollNumber.toUpperCase());
    if (!p) return res.status(404).json({ error: 'Not found.' });
    return res.json({ participant: p, progress: await db.getParticipantBestPerLevel(p.id) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ─── Admin auth ──────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

app.get('/api/admin/participants', adminAuth, async (req, res) => {
  try { return res.json(await db.getAllParticipants()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/participant/:id', adminAuth, async (req, res) => {
  try {
    const detail = await db.getParticipantDetail(parseInt(req.params.id));
    if (!detail) return res.status(404).json({ error: 'Not found.' });
    return res.json(detail);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/leaderboard', adminAuth, async (req, res) => {
  try { return res.json(await db.getLeaderboard()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/active-rolls', adminAuth, (req, res) => {
  const now = Date.now();
  const active = [];
  activeHeartbeats.forEach((ts, roll) => { if (now - ts < 20000) active.push(roll); });
  return res.json(active);
});

// ─── 404 ─────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Vibe Animation API running on port ${PORT}`);
  console.log(`   DATABASE     = ${process.env.DATABASE_URL ? 'Supabase ✔' : '⚠️  DATABASE_URL not set!'}`);
  console.log(`   FRONTEND_URL = ${FRONTEND_URL || '(any .vercel.app)'}`);
  console.log(`   ADMIN_TOKEN  = ${ADMIN_TOKEN}\n`);
});
