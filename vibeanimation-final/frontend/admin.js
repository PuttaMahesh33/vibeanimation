// frontend/admin.js — Production build (Vercel → Render)
'use strict';

// ⚠️  Replace with your actual Render backend URL
const BACKEND_URL = window.BACKEND_URL || 'https://vibeanimation-maheshputta7991-176c7r8m.leapcell.site';


let TOKEN       = localStorage.getItem('adminToken') || '';
let allData     = [];
let lbData      = [];
let activeRolls = new Set();
let countdown   = 5;
let refreshInt;
let currentSection = 'all';
const codeCache = {};

// ─── Formatters ───────────────────────────────────────────────

function fmt(ms) {
  if (!ms || ms < 0) return '—';
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s / 60);
  const cs = Math.floor((ms % 1000) / 10);
  return `${pad(m)}:${pad(s % 60)}:${pad(cs)}`;
}
function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function ago(iso) {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000)   return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  return Math.floor(d / 3600000) + 'h ago';
}

function badge(v) {
  if (!v && v !== 0) return '<span class="badge none">—</span>';
  const c = v >= 75 ? 'high' : v >= 50 ? 'med' : 'low';
  return `<span class="badge ${c}">${v}%</span>`;
}

// Level pills: ✔ L1 ✔ L2  L3  L4  L5
function levelPills(lockedLevels) {
  const ll = lockedLevels || [];
  return Array.from({length:5}, (_, i) => {
    const n    = i + 1;
    const done = ll.includes(n);
    return `<span class="lvl-pill ${done ? 'done' : 'pending'}">${done ? '✔' : ''} L${n}</span>`;
  }).join('');
}

function statusTag(p) {
  if (p.levelsCompleted === 5) return '<span class="status-tag done">✅ Done</span>';
  if (activeRolls.has(p.rollNumber)) return '<span class="status-tag active">🟢 Active</span>';
  return '<span class="status-tag idle">⚪ Idle</span>';
}

// ─── Auth ─────────────────────────────────────────────────────

async function doLogin() {
  const t = document.getElementById('tokenInput').value.trim();
  try {
    const r = await fetch(`${BACKEND_URL}/api/admin/participants`, { headers: {'x-admin-token': t} });
    if (r.ok) {
      TOKEN = t; localStorage.setItem('adminToken', t);
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('adminApp').style.display = 'block';
      startApp();
    } else {
      document.getElementById('loginError').textContent = 'Invalid token.';
    }
  } catch { document.getElementById('loginError').textContent = 'Cannot reach server.'; }
}

function logout() {
  localStorage.removeItem('adminToken'); TOKEN = '';
  clearInterval(refreshInt);
  document.getElementById('adminApp').style.display  = 'none';
  document.getElementById('loginOverlay').style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tokenInput').addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); });
  if (TOKEN) doLogin();
});

// ─── App boot ─────────────────────────────────────────────────

function startApp() {
  fetchAll();
  refreshInt = setInterval(() => {
    countdown--;
    document.getElementById('refreshLabel').textContent = `Auto-refresh: ${countdown}s`;
    if (countdown <= 0) { countdown = 5; fetchAll(); }
  }, 1000);
}

async function fetchAll() {
  try {
    const h = { 'x-admin-token': TOKEN };
    const [pr, lr, ar] = await Promise.all([
      fetch(`${BACKEND_URL}/api/admin/participants`, {headers:h}),
      fetch(`${BACKEND_URL}/api/admin/leaderboard`,  {headers:h}),
      fetch(`${BACKEND_URL}/api/active-rolls`,        {headers:h})
    ]);
    allData     = await pr.json();
    lbData      = await lr.json();
    activeRolls = new Set(await ar.json());
    renderStats();
    renderCurrentSection();
  } catch (e) { console.error(e); }
}

// ─── Stats bar ────────────────────────────────────────────────

function renderStats() {
  const total = allData.length;
  const done  = allData.filter(p => p.levelsCompleted === 5).length;
  const act   = allData.filter(p => activeRolls.has(p.rollNumber) && p.levelsCompleted < 5).length;
  const top   = total ? Math.max(...allData.map(p => p.avgAccuracy)) : 0;
  el('sParticipants').textContent = total;
  el('sCompleted').textContent    = done;
  el('sActive').textContent       = act;
  el('sTopScore').textContent     = top + '%';
}

// ─── Section nav ──────────────────────────────────────────────

function showSection(name) {
  currentSection = name;
  ['all','active','completed','leaderboard'].forEach(s => {
    el(`sec-${s}`).style.display   = s === name ? 'block' : 'none';
    el(`nav-${s}`).classList.toggle('active', s === name);
  });
  renderCurrentSection();
}

function renderCurrentSection() {
  if (currentSection === 'all')         renderAll('');
  if (currentSection === 'active')      renderActive('');
  if (currentSection === 'completed')   renderCompleted('');
  if (currentSection === 'leaderboard') renderLeaderboard('');
}

// ─── All participants ──────────────────────────────────────────

function filterAll()       { renderAll(el('searchAll').value.toLowerCase()); }
function filterActive()    { renderActive(el('searchActive').value.toLowerCase()); }
function filterCompleted() { renderCompleted(el('searchCompleted').value.toLowerCase()); }
function filterLb()        { renderLeaderboard(el('searchLb').value.toLowerCase()); }

function match(p, q) {
  return !q || p.name.toLowerCase().includes(q) || p.rollNumber.toLowerCase().includes(q);
}

function renderAll(q) {
  const now = Date.now();
  const rows = allData.filter(p => match(p, q)).map((p, i) => {
    const t = fmt(p.completionTime || (now - p.startTime));
    return `<tr onclick="openDetail(${p.id})">
      <td>${i+1}</td>
      <td class="mono cyan">${p.rollNumber}</td>
      <td class="bold">${p.name}</td>
      <td>${statusTag(p)}</td>
      <td><div class="lpills">${levelPills(p.lockedLevels)}</div></td>
      <td>${badge(p.avgAccuracy)}</td>
      <td class="mono amber">${t}</td>
      <td class="muted">${ago(p.lastSubmission || p.joinedTime)}</td>
    </tr>`;
  }).join('') || emptyRow(8);
  el('allBody').innerHTML = rows;
}

function renderActive(q) {
  const now = Date.now();
  const rows = allData
    .filter(p => activeRolls.has(p.rollNumber) && p.levelsCompleted < 5 && match(p, q))
    .map((p, i) => {
      const elapsed = fmt(now - p.startTime);
      return `<tr onclick="openDetail(${p.id})">
        <td>${i+1}</td>
        <td class="mono cyan">${p.rollNumber}</td>
        <td class="bold">${p.name}</td>
        <td><div class="lpills">${levelPills(p.lockedLevels)}</div></td>
        <td>${badge(p.avgAccuracy)}</td>
        <td class="mono amber">${elapsed}</td>
        <td class="muted">${ago(p.lastSubmission || p.joinedTime)}</td>
      </tr>`;
    }).join('') || emptyRow(7, 'No active participants right now');
  el('activeBody').innerHTML = rows;
}

function renderCompleted(q) {
  const medals = ['🥇','🥈','🥉'];
  const rows = allData
    .filter(p => p.levelsCompleted === 5 && match(p, q))
    .sort((a,b) => {
      if (b.avgAccuracy !== a.avgAccuracy) return b.avgAccuracy - a.avgAccuracy;
      return (a.completionTime||Infinity) - (b.completionTime||Infinity);
    })
    .map((p, i) => `<tr onclick="openDetail(${p.id})">
      <td>${medals[i] || i+1}</td>
      <td class="mono cyan">${p.rollNumber}</td>
      <td class="bold">${p.name}</td>
      <td><div class="lpills">${levelPills(p.lockedLevels)}</div></td>
      <td>${badge(p.avgAccuracy)}</td>
      <td class="mono amber">${fmt(p.completionTime)}</td>
    </tr>`).join('') || emptyRow(6, 'No completed participants yet');
  el('completedBody').innerHTML = rows;
}

function renderLeaderboard(q) {
  const medals  = ['🥇','🥈','🥉'];
  const winTags = ['🥇 1st Winner','🥈 2nd Winner','🥉 3rd Winner'];
  const wCls    = ['w1','w2','w3'];
  const filtered = lbData.filter(e => match(e, q));
  if (!filtered.length) { el('lbGrid').innerHTML = '<div class="empty-card">No participants found.</div>'; return; }
  el('lbGrid').innerHTML = filtered.map((e, fi) => {
    const gi  = lbData.indexOf(e);
    const win = gi < 3;
    const timeStr = e.completionTime
      ? fmt(e.completionTime)
      : fmt(Date.now() - e.startTime) + ' <em class="ongoing">ongoing</em>';
    return `<div class="lb-card ${win ? wCls[gi] : ''}" onclick="openDetail(e.id)" style="cursor:pointer">
      <div class="lb-left">
        <div class="lb-medal">${medals[gi] || '#'+(gi+1)}</div>
        <div>
          <div class="lb-name-row">
            <span class="lb-name">${e.name}</span>
            ${win ? `<span class="win-tag ${wCls[gi]}">${winTags[gi]}</span>` : ''}
          </div>
          <div class="lb-roll">${e.rollNumber}</div>
          <div class="lb-meta">
            <span>Levels: <strong>${e.levelsCompleted}/5</strong></span>
            <span>⏱ ${timeStr}</span>
          </div>
        </div>
      </div>
      <div class="lb-score">${e.avgAccuracy}<span class="pct">%</span></div>
    </div>`;
  }).join('');
}

function emptyRow(cols, msg = 'No participants found') {
  return `<tr><td colspan="${cols}" class="empty-cell">${msg}</td></tr>`;
}

function el(id) { return document.getElementById(id); }

// ─── Participant detail ────────────────────────────────────────

let currentDetailId   = null;
let currentDetailLevel = null;

async function openDetail(id) {
  currentDetailId    = id;
  currentDetailLevel = null;

  // Show the modal
  el('modalOverlay').style.display = 'flex';
  el('modalBody').innerHTML        = '<div class="modal-loading">Loading participant data…</div>';

  try {
    const r    = await fetch(`${BACKEND_URL}/api/admin/participant/${id}`, { headers: {'x-admin-token': TOKEN} });
    const data = await r.json();
    const p    = data.participant;
    const lt   = data.levelTimes      || {};
    const la   = data.levelAccuracies || {};
    const ll   = data.lockedLevels    || [];
    const lc   = data.levelCodes      || {};

    // Cache codes
    for (let lvl = 1; lvl <= 5; lvl++) {
      if (lc[lvl]) codeCache[`${id}_${lvl}`] = lc[lvl];
    }

    // Compute derived fields
    const levelsCompleted = ll.length;
    const accs   = ll.map(l => la[l] || 0);
    const avgAcc = ll.length > 0 ? Math.round(accs.reduce((a,b)=>a+b,0) / 5) : 0;
    const now    = Date.now();
    const isDone = levelsCompleted === 5;
    const totalMs = p.completionTime || (now - p.startTime);
    const statusHTML = isDone
      ? '<span class="status-tag done">✅ Completed</span>'
      : activeRolls.has(p.rollNumber)
        ? '<span class="status-tag active">🟢 Active</span>'
        : '<span class="status-tag idle">⚪ Idle</span>';

    // Level breakdown HTML
    let lvlRows = '';
    for (let lvl = 1; lvl <= 5; lvl++) {
      const done   = ll.includes(lvl);
      const acc    = la[lvl];
      const accCls = acc >= 75 ? 'high' : acc >= 50 ? 'med' : 'low';
      const t      = lt[lvl] ? fmt(lt[lvl]) : '—';
      const btn    = done ? `<button class="inspect-btn" onclick="loadInspect(${id},${lvl})">Inspect →</button>` : '';
      lvlRows += `
        <div class="lvl-row ${done ? 'done' : 'pending'}" id="lvlrow-${lvl}">
          <div class="lvl-row-left">
            <div class="lvl-num">${done ? '✔' : lvl}</div>
            <div>
              <div class="lvl-label">Level ${lvl}</div>
              <div class="lvl-sub">${done ? 'Submitted' : 'Not submitted'}</div>
            </div>
          </div>
          <div class="lvl-row-right">
            ${acc !== undefined ? `<span class="acc-chip ${accCls}">${acc}%</span>` : ''}
            <span class="time-chip">${t}</span>
            ${btn}
          </div>
        </div>`;
    }

    el('modalBody').innerHTML = `
      <!-- PARTICIPANT HEADER -->
      <div class="modal-header-row">
        <div class="modal-p-info">
          <div class="modal-name">${p.name} ${statusHTML}</div>
          <div class="modal-roll">${p.rollNumber}</div>
          <div class="modal-joined">Joined ${new Date(p.joinedTime).toLocaleString()}</div>
        </div>
        <div class="modal-stats">
          <div class="modal-stat"><div class="ms-val">${levelsCompleted}/5</div><div class="ms-lbl">Levels Done</div></div>
          <div class="modal-stat"><div class="ms-val acc">${avgAcc}%</div><div class="ms-lbl">Avg Score</div></div>
          <div class="modal-stat"><div class="ms-val tm">${fmt(totalMs)}</div><div class="ms-lbl">${isDone ? 'Total Time' : 'Elapsed'}</div></div>
        </div>
      </div>

      <!-- LEVEL BREAKDOWN -->
      <div class="modal-section-title">📋 Level Breakdown</div>
      <div class="modal-levels">${lvlRows}</div>

      <!-- INSPECT SPLIT (shown when user clicks Inspect) -->
      <div id="inspectSection" style="display:none">
        <div class="modal-section-title" id="inspectTitle">Code & Animation</div>
        <div class="inspect-split">
          <div class="inspect-code-panel">
            <div class="inspect-panel-hdr">📄 Submitted Code</div>
            <pre id="splitCode" class="inspect-code-pre">Select a level above to inspect</pre>
          </div>
          <div class="inspect-anim-panel">
            <div class="inspect-panel-hdr">🎬 Animation Preview</div>
            <div class="inspect-anim-box" id="inspectAnimBox">
              <iframe id="splitAnimFrame" sandbox="allow-scripts allow-same-origin"></iframe>
            </div>
          </div>
        </div>
      </div>
    `;

    // Scale the anim frame once visible
    setTimeout(scaleSplitFrame, 80);

  } catch(e) {
    el('modalBody').innerHTML = `<div class="modal-loading" style="color:var(--red)">Error loading data.</div>`;
  }
}


async function loadInspect(participantId, level) {
  currentDetailLevel = level;

  // Highlight active row
  document.querySelectorAll('.lvl-row').forEach(r => r.classList.remove('inspecting'));
  const row = el(`lvlrow-${level}`);
  if (row) { row.classList.add('inspecting'); }

  // Show inspect section
  const sec = el('inspectSection');
  sec.style.display = 'block';
  el('inspectTitle').textContent = `Level ${level} — Code & Animation`;
  el('splitCode').textContent    = 'Loading…';
  el('splitAnimFrame').src       = 'about:blank';

  // Load code
  const key = `${participantId}_${level}`;
  let code  = codeCache[key];
  if (!code) {
    try {
      const r    = await fetch(`${BACKEND_URL}/api/admin/participant/${participantId}`, { headers: {'x-admin-token': TOKEN} });
      const data = await r.json();
      code = (data.levelCodes || {})[level] || '';
      if (code) codeCache[key] = code;
    } catch { code = ''; }
  }

  el('splitCode').textContent = code || '<!-- No code available -->';

  if (code) {
    const blob = new Blob([code], {type:'text/html'});
    el('splitAnimFrame').src = URL.createObjectURL(blob);
  }

  sec.scrollIntoView({behavior:'smooth', block:'start'});
  setTimeout(scaleSplitFrame, 120);
}

function closeDetail(event) {
  if (!event || event.target === el('modalOverlay')) {
    el('modalOverlay').style.display = 'none';
    const f = el('splitAnimFrame');
    if (f) f.src = 'about:blank';
  }
}

// ─── Scale split animation iframe to fill its container ───────
function scaleSplitFrame() {
  const box   = el('inspectAnimBox');
  const frame = el('splitAnimFrame');
  if (!box || !frame) return;
  const w     = box.clientWidth;
  const h     = box.clientHeight;
  // Fill width, centre vertically
  const scale   = w / 600;
  const scaledH = 400 * scale;
  const offsetY = Math.max(0, (h - scaledH) / 2);
  frame.style.transform = `translate(0px, ${offsetY}px) scale(${scale})`;
}

// Re-scale animation whenever window resizes
window.addEventListener('resize', scaleSplitFrame);
