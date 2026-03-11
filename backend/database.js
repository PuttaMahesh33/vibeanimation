// backend/database.js
'use strict';

const fs   = require('fs');
const path = require('path');

// On Render with persistent disk → DB_PATH env var points to /data/db.json
// Locally → falls back to project root db.json
const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'db.json');

let _cache = null;

function readDB() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    _cache = JSON.parse(raw);
    return _cache;
  } catch (e) {
    _cache = { participants: [], submissions: [] };
    writeDB(_cache);
    return _cache;
  }
}

function writeDB(data) {
  _cache = data;
  fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
    if (err) console.error('[DB] Write error:', err.message);
  });
}

function nextId(arr) {
  if (!arr || arr.length === 0) return 1;
  return Math.max(...arr.map(r => r.id || 0)) + 1;
}

function upsertParticipant(name, rollNumber) {
  const db = readDB();
  const existing = db.participants.find(p => p.rollNumber === rollNumber);
  if (existing) return existing;
  const participant = {
    id: nextId(db.participants),
    name, rollNumber,
    joinedTime: new Date().toISOString(),
    startTime: Date.now(),
    completionTime: null,
    completedAt: null,
    levelTimes: {},
    levelStartTimes: {},
    lockedLevels: [],
    levelCodes: {},
    levelAccuracies: {}
  };
  db.participants.push(participant);
  writeDB(db);
  return participant;
}

function getParticipantByRoll(rollNumber) {
  return readDB().participants.find(p => p.rollNumber === rollNumber) || null;
}

function getParticipantById(id) {
  return readDB().participants.find(p => p.id === id) || null;
}

function startLevelTimer(participantId, level) {
  const db = readDB();
  const p = db.participants.find(x => x.id === participantId);
  if (!p) return null;
  if (!p.levelStartTimes) p.levelStartTimes = {};
  if (!p.levelStartTimes[level]) {
    p.levelStartTimes[level] = Date.now();
    writeDB(db);
  }
  return p;
}

function lockLevel(participantId, level, code, accuracy) {
  const db = readDB();
  const p = db.participants.find(x => x.id === participantId);
  if (!p) return null;
  if (!p.lockedLevels)    p.lockedLevels    = [];
  if (!p.levelCodes)      p.levelCodes      = {};
  if (!p.levelAccuracies) p.levelAccuracies = {};
  if (!p.levelTimes)      p.levelTimes      = {};
  if (!p.levelStartTimes) p.levelStartTimes = {};
  const startMs = p.levelStartTimes[level] || p.startTime;
  if (!p.lockedLevels.includes(level)) p.lockedLevels.push(level);
  p.levelCodes[level]      = code;
  p.levelAccuracies[level] = accuracy;
  p.levelTimes[level]      = Date.now() - startMs;
  if ([1,2,3,4,5].every(l => p.lockedLevels.includes(l)) && !p.completionTime) {
    p.completionTime = Date.now() - p.startTime;
    p.completedAt    = new Date().toISOString();
  }
  writeDB(db);
  return p;
}

function getAllParticipants() {
  const db = readDB();
  return db.participants.map(p => {
    const subs = db.submissions.filter(s => s.participantId === p.id);
    const lockedLevels = p.lockedLevels || [];
    const total = Object.values(getBestPerLevel(subs)).reduce((a,b)=>a+b,0);
    return {
      id: p.id, name: p.name, rollNumber: p.rollNumber,
      joinedTime: p.joinedTime, startTime: p.startTime,
      completionTime: p.completionTime || null,
      completedAt: p.completedAt || null,
      levelTimes: p.levelTimes || {},
      levelsCompleted: lockedLevels.length, lockedLevels,
      totalSubmissions: subs.length,
      avgAccuracy: lockedLevels.length > 0 ? Math.round(total/5) : 0,
      lastSubmission: subs.length > 0 ? subs[subs.length-1].timestamp : null,
      currentLevel: lockedLevels.length < 5 ? lockedLevels.length + 1 : 5
    };
  }).sort((a,b) => {
    if (b.levelsCompleted !== a.levelsCompleted) return b.levelsCompleted - a.levelsCompleted;
    if (b.avgAccuracy !== a.avgAccuracy) return b.avgAccuracy - a.avgAccuracy;
    if (a.completionTime && b.completionTime) return a.completionTime - b.completionTime;
    return 0;
  });
}

function getParticipantDetail(id) {
  const db = readDB();
  const participant = db.participants.find(p => p.id === id);
  if (!participant) return null;
  const submissions = db.submissions.filter(s => s.participantId === id)
    .sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp));
  const topByLevel = {};
  for (let level = 1; level <= 5; level++) {
    topByLevel[level] = db.submissions.filter(s => s.level === level)
      .sort((a,b) => b.accuracy-a.accuracy).slice(0,5)
      .map(s => {
        const owner = db.participants.find(p => p.id === s.participantId);
        return { id: s.id, accuracy: s.accuracy, timestamp: s.timestamp, code: s.code,
          name: owner ? owner.name : 'Unknown', rollNumber: owner ? owner.rollNumber : '' };
      });
  }
  return { participant, submissions, topByLevel,
    levelTimes: participant.levelTimes || {},
    lockedLevels: participant.lockedLevels || [],
    levelCodes: participant.levelCodes || {},
    levelAccuracies: participant.levelAccuracies || {} };
}

function saveSubmission(participantId, level, accuracy, code) {
  const db = readDB();
  const submission = { id: nextId(db.submissions), participantId, level, accuracy, code,
    timestamp: new Date().toISOString() };
  db.submissions.push(submission);
  writeDB(db);
  return submission;
}

function getParticipantBestPerLevel(participantId) {
  const db = readDB();
  const p = db.participants.find(x => x.id === participantId);
  const subs = db.submissions.filter(s => s.participantId === participantId);
  const byLevel = {};
  subs.forEach(s => {
    if (!byLevel[s.level]) byLevel[s.level] = { level: s.level, bestAccuracy: s.accuracy, attempts: 0 };
    else if (s.accuracy > byLevel[s.level].bestAccuracy) byLevel[s.level].bestAccuracy = s.accuracy;
    byLevel[s.level].attempts++;
  });
  if (p) {
    const ll = p.lockedLevels || [];
    Object.keys(byLevel).forEach(l => {
      byLevel[l].locked   = ll.includes(parseInt(l));
      byLevel[l].code     = (p.levelCodes || {})[l]      || null;
      byLevel[l].accuracy = (p.levelAccuracies || {})[l] || byLevel[l].bestAccuracy;
    });
  }
  return Object.values(byLevel);
}

function getLeaderboard() {
  const db = readDB();
  return db.participants.map(p => {
    const subs = db.submissions.filter(s => s.participantId === p.id);
    const best = getBestPerLevel(subs);
    const ll   = p.lockedLevels || [];
    const total = Object.values(best).reduce((a,b)=>a+b,0);
    return { id: p.id, name: p.name, rollNumber: p.rollNumber,
      levelsCompleted: ll.length, avgAccuracy: Math.round(total/5),
      completionTime: p.completionTime || null, completedAt: p.completedAt || null,
      startTime: p.startTime,
      lastSubmission: subs.length > 0 ? subs[subs.length-1].timestamp : null };
  }).sort((a,b) => {
    if (b.levelsCompleted !== a.levelsCompleted) return b.levelsCompleted - a.levelsCompleted;
    if (b.avgAccuracy !== a.avgAccuracy) return b.avgAccuracy - a.avgAccuracy;
    if (a.completionTime && b.completionTime) return a.completionTime - b.completionTime;
    if (a.completionTime) return -1;
    if (b.completionTime) return  1;
    return 0;
  });
}

function getBestPerLevel(subs) {
  const best = {};
  subs.forEach(s => { if (!best[s.level] || s.accuracy > best[s.level]) best[s.level] = s.accuracy; });
  return best;
}

module.exports = { upsertParticipant, getParticipantByRoll, getParticipantById,
  getAllParticipants, getParticipantDetail, saveSubmission,
  getParticipantBestPerLevel, getLeaderboard, startLevelTimer, lockLevel };
