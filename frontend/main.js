// frontend/main.js — Production build (Vercel → Render)
'use strict';

// ⚠️  IMPORTANT: Replace with your actual Render backend URL after deployment
// Example: const BACKEND_URL = 'https://vibe-animation-backend.onrender.com';
const BACKEND_URL = window.BACKEND_URL || 'https://YOUR_RENDER_APP.onrender.com';

// ─── State ────────────────────────────────────────────────────
const S = {
  participant:    null,
  progress:       {},          // { [level]: { bestAccuracy, attempts, locked, code } }
  lockedLevels:   [],          // array of locked level numbers
  currentLevel:   null,
  lastScore:      null,
  previewed:      false,       // has user clicked Preview this session
  accuracyDone:   false,       // has Check Accuracy been run after preview
  startTime:      null,        // ms epoch from server
  completionTime: null,        // ms when all done (from server)
  timerInterval:  null,
  timerDone:      false,
  lbPaused:       false
};

const LEVELS = [1,2,3,4,5];

// ─── Helpers ─────────────────────────────────────────────────

function formatTime(ms) {
  if (ms == null || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const mins   = Math.floor(totalSec / 60);
  const secs   = totalSec % 60;
  const millis = Math.floor((ms % 1000) / 10); // 2-digit centiseconds
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}:${String(millis).padStart(2,'0')}`;
}

async function fetchTimeout(url, opts = {}, ms = 25000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(tid);
    return r;
  } catch (e) {
    clearTimeout(tid);
    if (e.name === 'AbortError') throw new Error('Request timed out. Server may be starting up — try again.');
    throw e;
  }
}

function isDone(id)      { return S.lockedLevels.includes(id); }
function isAvailable(id) { return id === 1 || isDone(id - 1); }

function progressToMap(arr) {
  const m = {};
  (arr || []).forEach(p => { m[p.level] = p; });
  return m;
}

// ─── Join ─────────────────────────────────────────────────────
async function joinCompetition() {
  const roll = document.getElementById('rollInput').value.trim();
  const name = document.getElementById('nameInput').value.trim();
  if (!roll || !name) { toast('Enter your roll number and name.', 'error'); return; }

  const btn = document.getElementById('startBtn');
  btn.textContent = 'Joining…'; btn.disabled = true;

  try {
    const res  = await fetchTimeout(`${BACKEND_URL}/api/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rollNumber: roll })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      toast(data.error || 'Failed to join.', 'error');
      btn.textContent = 'Start Competition →'; btn.disabled = false;
      return;
    }

    S.participant  = data.participant;
    S.startTime    = data.participant.startTime;
    S.progress     = progressToMap(data.progress);
    S.lockedLevels = data.participant.lockedLevels || [];
    S.completionTime = data.participant.completionTime || null;

    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('app').classList.add('active');

    const timerWrap = document.getElementById('timerWrap');
    const pill      = document.getElementById('userPill');
    timerWrap.style.display = 'block';
    pill.style.display      = 'flex';
    document.getElementById('userPillText').textContent = `${data.participant.name} · ${data.participant.rollNumber}`;

    initPreviewScaler();
    renderLevelBar();
    updateStats();
    startTimer();
    fetchLeaderboard();
    startKeepAlive();

    const first = LEVELS.find(id => isAvailable(id)) || 1;
    loadLevel(first);

  } catch (err) {
    toast('Cannot connect to server. Is it running?', 'error');
    btn.textContent = 'Start Competition →'; btn.disabled = false;
  }
}

// ─── Timer ───────────────────────────────────────────────────
function startTimer() {
  if (S.timerDone && S.completionTime !== null) {
    document.getElementById('timer').textContent = formatTime(S.completionTime);
    document.getElementById('timer').classList.add('done');
    return;
  }
  S.timerInterval = setInterval(() => {
    if (S.timerDone) return;
    const el      = document.getElementById('timer');
    const elapsed = Date.now() - S.startTime;
    el.textContent = formatTime(elapsed);
  }, 50);
}

function stopTimer() {
  S.timerDone      = true;
  S.completionTime = Date.now() - S.startTime;
  clearInterval(S.timerInterval);
  const el = document.getElementById('timer');
  el.textContent = formatTime(S.completionTime);
  el.classList.add('done');
  toast('🎉 All levels complete! Timer stopped.', 'success');
}

// ─── Level bar ───────────────────────────────────────────────
function renderLevelBar() {
  const bar = document.getElementById('levelBar');
  bar.innerHTML = '';
  LEVELS.forEach(id => {
    const pill  = document.createElement('div');
    pill.className = 'level-pill';
    const locked = isDone(id);
    const avail  = isAvailable(id);
    const active = S.currentLevel === id;
    const p      = S.progress[id];
    const pct    = p ? p.bestAccuracy || p.accuracy : null;

    if (locked) {
      pill.classList.add('done', 'locked-pill');
      pill.textContent = `✓ L${id} ${pct ? pct+'%' : ''}`;
    } else if (avail) {
      pill.classList.add('available');
      pill.textContent = `Level ${id}`;
      pill.addEventListener('click', () => loadLevel(id));
    } else {
      pill.classList.add('unavail');
      pill.textContent = `Level ${id}`;
    }
    if (active) pill.classList.add('active');

    // Locked levels: clicking shows submitted code (read-only)
    if (locked) pill.addEventListener('click', () => loadLevel(id));

    bar.appendChild(pill);
  });
}

// ─── Load Level ───────────────────────────────────────────────
async function loadLevel(id) {
  S.currentLevel  = id;
  S.lastScore     = null;
  S.previewed     = false;
  S.accuracyDone  = false;

  const locked = isDone(id);
  const editor = document.getElementById('codeEditor');
  const overlay = document.getElementById('lockOverlay');
  const checkBtn  = document.getElementById('checkBtn');
  const submitBtn = document.getElementById('submitBtn');
  const previewBtn = document.getElementById('previewBtn');

  document.getElementById('accPanel').classList.remove('show');

  if (locked) {
    // Show submitted code read-only
    const p = S.progress[id];
    editor.value    = (p && p.code) ? p.code : '<!-- Submitted code not available -->';
    editor.readOnly = true;
    overlay.style.display = 'flex';
    checkBtn.disabled  = true;
    submitBtn.disabled = true;
    previewBtn.disabled = false;
  } else {
    editor.value    = '';       // ← clear editor for new level
    editor.readOnly = false;
    overlay.style.display = 'none';
    checkBtn.disabled  = true;
    submitBtn.disabled = true;
    previewBtn.disabled = false;
  }

  // Show reference automatically
  const refFrame = document.getElementById('refFrame');
  const refUrl   = `${BACKEND_URL}/levels/level${id}-reference.html`;
  refFrame.setAttribute('data-src', refUrl);
  refFrame.src = refUrl;

  // Reset preview area
  const yourFrame  = document.getElementById('yourFrame');
  yourFrame.src    = 'about:blank';
  yourFrame.style.display = 'none';
  refFrame.style.display  = 'none';
  document.getElementById('placeholder').style.display = 'flex';

  // Switch to "Your Animation" tab view
  document.getElementById('tabYours').classList.add('active');
  document.getElementById('tabRef').classList.remove('active');

  renderLevelBar();
  updateLvlDots();

  // Tell server this level has started (for timer tracking)
  if (!locked) {
    try {
      await fetchTimeout(`${BACKEND_URL}/api/start-level`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rollNumber: S.participant.rollNumber, level: id })
      }, 5000);
    } catch (e) { /* non-critical */ }
  }
}

// ─── Preview Scaler ───────────────────────────────────────────
function initPreviewScaler() {
  updateScale();
  window.addEventListener('resize', updateScale);
  // Also observe the preview area directly for layout changes
  const area = document.getElementById('previewArea');
  if (area && window.ResizeObserver) {
    new ResizeObserver(updateScale).observe(area);
  }
}

function updateScale() {
  const area = document.getElementById('previewArea');
  if (!area) return;
  const w = area.clientWidth;
  const h = area.clientHeight;
  if (!w || !h) return;
  // Scale to fill full width — eliminates all side gaps.
  // Then vertically centre the scaled iframe within the container.
  const scale = w / 600;
  const scaledH = 400 * scale;
  const offsetY = (h - scaledH) / 2; // positive = space above/below; negative = clipped
  ['yourFrame','refFrame'].forEach(id => {
    const f = document.getElementById(id);
    if (!f) return;
    // Translate to vertical centre, then scale from top-left
    f.style.transform = `translateY(${offsetY}px) scale(${scale})`;
  });
}

// ─── Tab switching ────────────────────────────────────────────
function switchTab(which) {
  const yours = document.getElementById('yourFrame');
  const ref   = document.getElementById('refFrame');
  const ph    = document.getElementById('placeholder');
  document.getElementById('tabYours').classList.toggle('active', which === 'yours');
  document.getElementById('tabRef').classList.toggle('active', which === 'reference');

  if (which === 'yours') {
    const hasSrc = yours.src && yours.src !== window.location.href && yours.src !== 'about:blank';
    yours.style.display = hasSrc ? 'block' : 'none';
    ph.style.display    = hasSrc ? 'none'  : 'flex';
    ref.style.display   = 'none';
  } else {
    yours.style.display = 'none';
    ph.style.display    = 'none';
    ref.style.display   = 'block';
    const stored = ref.getAttribute('data-src');
    if (stored) ref.src = stored;   // force reload if was hidden
    updateScale();
  }
}

// ─── Preview ─────────────────────────────────────────────────
function previewCode() {
  const code = document.getElementById('codeEditor').value;
  if (!code.trim()) { toast('Write some code first!', 'error'); return; }

  const blob = new Blob([code], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const frame = document.getElementById('yourFrame');
  frame.src = url;
  frame.style.display = 'block';
  document.getElementById('placeholder').style.display = 'none';

  // Switch to your tab
  document.getElementById('refFrame').style.display = 'none';
  document.getElementById('tabYours').classList.add('active');
  document.getElementById('tabRef').classList.remove('active');
  updateScale();

  S.previewed    = true;
  S.accuracyDone = false;

  // Enable Check Accuracy only after preview
  if (!isDone(S.currentLevel)) {
    document.getElementById('checkBtn').disabled = false;
    document.getElementById('submitBtn').disabled = true;
  }
}

// ─── Check Accuracy ───────────────────────────────────────────
async function checkAccuracy() {
  if (!S.previewed) { toast('Click Preview first!', 'error'); return; }
  const code = document.getElementById('codeEditor').value.trim();
  if (!code) { toast('Write some code first!', 'error'); return; }
  if (!S.currentLevel) { toast('Select a level first.', 'error'); return; }

  S.lbPaused = true;
  showSpinner('Judging animation…');

  try {
    const res  = await fetchTimeout(`${BACKEND_URL}/api/judge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, level: S.currentLevel, rollNumber: S.participant.rollNumber })
    }, 40000);
    const data = await res.json();

    hideSpinner();
    S.lbPaused = false;

    if (!res.ok)    { toast(data.error || 'Judge failed.', 'error'); return; }
    if (!data.valid){ toast('❌ Invalid: ' + (data.errors||[]).join(' '), 'error'); return; }

    S.lastScore    = data.score;
    S.accuracyDone = true;
    showAccuracy(data.score, data.breakdown);

    // Enable submit only after accuracy check, and only if not locked
    if (!isDone(S.currentLevel)) {
      document.getElementById('submitBtn').disabled = data.score < 50;
    }

    if (data.score >= 50) toast(`Score: ${data.score}% — ready to submit!`, 'success');
    else toast(`Score: ${data.score}% — need 50%+ to submit.`, 'info');

  } catch (err) {
    hideSpinner();
    S.lbPaused = false;
    toast('Connection error. Is the server running?', 'error');
  }
}

function showAccuracy(score, bd) {
  const panel = document.getElementById('accPanel');
  panel.classList.add('show');

  const scoreEl = document.getElementById('accScore');
  const fillEl  = document.getElementById('accBarFill');
  const msgEl   = document.getElementById('accMsg');
  const bdEl    = document.getElementById('breakdown');

  scoreEl.textContent = score + '%';
  scoreEl.className   = 'acc-score ' + (score >= 75 ? 'high' : score >= 50 ? 'med' : 'low');

  fillEl.style.width      = score + '%';
  fillEl.style.background = score >= 75 ? 'linear-gradient(90deg,#10b981,#059669)'
    : score >= 50 ? 'linear-gradient(90deg,#f59e0b,#d97706)' : 'linear-gradient(90deg,#ef4444,#dc2626)';

  msgEl.textContent = score >= 50 ? '✅ Ready to submit!' : '❌ Below 50% — keep refining!';

  if (bd) {
    bdEl.innerHTML = `
      <div class="bd-item"><div class="bd-val">${bd.visual}%</div><div class="bd-lbl">Visual</div></div>
      <div class="bd-item"><div class="bd-val">${bd.timing}%</div><div class="bd-lbl">Timing</div></div>
      <div class="bd-item"><div class="bd-val">${bd.css}%</div><div class="bd-lbl">CSS</div></div>
      <div class="bd-item"><div class="bd-val">${bd.dom}%</div><div class="bd-lbl">DOM</div></div>`;
  }
}

// ─── Submit ───────────────────────────────────────────────────
async function submitLevel() {
  if (isDone(S.currentLevel)) { toast('This level is already submitted!', 'error'); return; }
  if (!S.accuracyDone || S.lastScore === null) { toast('Run Check Accuracy first.', 'error'); return; }
  if (S.lastScore < 50) { toast('Need 50%+ to submit.', 'error'); return; }

  const code = document.getElementById('codeEditor').value.trim();
  if (!code) return;

  S.lbPaused = true;
  showSpinner('Submitting…');

  try {
    const res  = await fetchTimeout(`${BACKEND_URL}/api/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, level: S.currentLevel, rollNumber: S.participant.rollNumber })
    }, 40000);
    const data = await res.json();

    hideSpinner();
    S.lbPaused = false;

    if (!res.ok || !data.success) {
      toast((data.errors || [data.error]).join(' ') || 'Submit failed.', 'error');
      return;
    }

    // Update local state
    S.lockedLevels = data.lockedLevels || S.lockedLevels;
    if (!S.lockedLevels.includes(S.currentLevel)) S.lockedLevels.push(S.currentLevel);
    S.progress = progressToMap(data.progress);

    // Sync submitted code into progress map
    if (S.progress[S.currentLevel]) {
      S.progress[S.currentLevel].locked = true;
      S.progress[S.currentLevel].code   = code;
    }

    // Check if all done → stop timer
    if (data.completionTime) {
      S.completionTime = data.completionTime;
      stopTimer();
    }

    // After submit: show reference animation automatically
    const refFrame = document.getElementById('refFrame');
    const yourFrame = document.getElementById('yourFrame');
    yourFrame.style.display = 'none';
    yourFrame.src = 'about:blank';
    refFrame.style.display  = 'block';
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('tabRef').classList.add('active');
    document.getElementById('tabYours').classList.remove('active');
    document.getElementById('accPanel').classList.remove('show');
    updateScale();

    // Lock current level UI
    document.getElementById('lockOverlay').style.display = 'flex';
    document.getElementById('checkBtn').disabled  = true;
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('codeEditor').readOnly = true;

    showAccuracy(data.score, data.breakdown);
    updateStats();
    renderLevelBar();
    fetchLeaderboard();

    toast(`🎉 Level ${S.currentLevel} submitted! Score: ${data.score}%`, 'success');

    // Auto-advance to next level after a brief pause
    const next = S.currentLevel + 1;
    if (next <= 5 && isAvailable(next)) {
      setTimeout(() => loadLevel(next), 1800);
    }

  } catch (err) {
    hideSpinner();
    S.lbPaused = false;
    toast('Connection error.', 'error');
  }
}

// ─── Stats ────────────────────────────────────────────────────
function updateStats() {
  const done = S.lockedLevels.length;
  const accs = S.lockedLevels.map(l => {
    const p = S.progress[l];
    return p ? (p.accuracy || p.bestAccuracy || 0) : 0;
  });
  const avg = accs.length > 0 ? Math.round(accs.reduce((a,b)=>a+b,0) / 5) : 0;
  document.getElementById('statDone').textContent = `${done} / 5`;
  document.getElementById('statAvg').textContent  = avg > 0 ? avg + '%' : '—';
  updateLvlDots();
}

function updateLvlDots() {
  document.querySelectorAll('.lvl-dot').forEach((dot, i) => {
    const lvl = i + 1;
    dot.classList.remove('done','current');
    if (isDone(lvl)) {
      dot.classList.add('done');
      dot.textContent = '✓';
    } else if (S.currentLevel === lvl) {
      dot.classList.add('current');
      dot.textContent = '';
    } else {
      dot.textContent = '';
    }
  });
}

// ─── Leaderboard ─────────────────────────────────────────────
async function fetchLeaderboard() {
  try {
    const res  = await fetch(`${BACKEND_URL}/api/leaderboard`);
    const data = await res.json();
    renderLeaderboard(data);
  } catch (e) { /* silent */ }
}

function renderLeaderboard(entries) {
  const el = document.getElementById('lbList');
  if (!entries || !entries.length) {
    el.innerHTML = '<div class="lb-loading">No submissions yet</div>'; return;
  }
  const medals  = ['🥇','🥈','🥉'];
  const myRoll  = S.participant ? S.participant.rollNumber : null;
  let myRank    = -1;

  el.innerHTML = entries.slice(0,8).map((e, i) => {
    const me = myRoll && e.rollNumber === myRoll;
    if (me) myRank = i + 1;
    const timeStr = e.completionTime ? formatTime(e.completionTime) : '';
    return `<div class="lb-item${me?' me':''}">
      <div class="lb-rank">${medals[i] || '#'+(i+1)}</div>
      <div class="lb-name">${e.name}${me?' ◀':''}</div>
      <div class="lb-score">${e.avgAccuracy}%</div>
      ${timeStr ? `<div class="lb-time">${timeStr}</div>` : ''}
    </div>`;
  }).join('');

  // Update rank in stats
  if (myRank > 0) {
    document.getElementById('statRank').textContent = `#${myRank}`;
  } else if (myRoll) {
    // Check if participant is beyond top 8
    const fullIdx = entries.findIndex(e => e.rollNumber === myRoll);
    if (fullIdx >= 0) {
      document.getElementById('statRank').textContent = `#${fullIdx+1}`;
    }
  }
}

let _lbInterval;
function startKeepAlive() {
  // Heartbeat every 10s — tells server this participant is still active
  setInterval(() => {
    if (!S.participant) return;
    try {
      fetch(`${BACKEND_URL}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rollNumber: S.participant.rollNumber })
      });
    } catch(e) {}
  }, 10000);

  // Keep-alive health ping every 14 min (prevents Render sleep)
  setInterval(() => {
    try { fetch(`${BACKEND_URL}/api/health`); } catch(e) {}
  }, 14 * 60 * 1000);

  // Smart leaderboard polling — pause during judging
  _lbInterval = setInterval(() => {
    if (S.participant && !S.lbPaused) fetchLeaderboard();
  }, 15000);
}

// ─── UI Helpers ──────────────────────────────────────────────
let toastTimer;
function toast(msg, type='info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

function showSpinner(label) {
  document.getElementById('spinnerLabel').textContent = label;
  document.getElementById('spinner').classList.add('show');
}
function hideSpinner() {
  document.getElementById('spinner').classList.remove('show');
}

// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ['rollInput','nameInput'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') joinCompetition();
    });
  });
});
