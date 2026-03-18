// server/judge.js - Optimized version
'use strict';

const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const path = require('path');
const fs = require('fs');

const LEVELS_DIR = path.join(__dirname, '..', 'levels');
const VIEWPORT = { width: 600, height: 400 };

// Performance optimizations
const FRAME_COUNT = 8; // Reduced from 12 to 8 for faster processing
const DURATION_MS = 2000; // Reduced from 3000ms to 2000ms

// Cache for reference frames (to avoid re-capturing every time)
const refFrameCache = new Map();

// Browser pool for reuse
let browserPool = [];
const MAX_BROWSERS = 3;
const BROWSER_TIMEOUT = 60000; // 1 minute

// Chrome paths for different platforms
const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Windows - Puppeteer default cache location
  process.env.USERPROFILE
    ? require('path').join(process.env.USERPROFILE, '.cache', 'puppeteer', 'chrome', 'win64-121.0.6167.85', 'chrome-win64', 'chrome.exe')
    : null,
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  // Windows system installs
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

// Dynamically scan Puppeteer cache dirs (handles Render.com and other hosts)
function findChromeInCacheDir(cacheDir) {
  try {
    const chromeDir = path.join(cacheDir, 'chrome');
    if (!fs.existsSync(chromeDir)) return null;
    const versions = fs.readdirSync(chromeDir);
    for (const version of versions) {
      // Windows
      for (const sub of ['chrome-win64/chrome.exe', 'chrome-win32/chrome.exe']) {
        const p = path.join(chromeDir, version, sub);
        if (fs.existsSync(p)) return p;
      }
      // Linux
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(chromeDir, version, sub);
        if (fs.existsSync(p)) return p;
      }
      // Mac
      for (const sub of [
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
      ]) {
        const p = path.join(chromeDir, version, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Add cache-dir candidates: works on Windows, Mac, Linux, and Render
const PUPPETEER_CACHE_CANDIDATES = [
  process.env.PUPPETEER_CACHE_DIR,
  // Windows
  path.join(process.env.USERPROFILE || '', '.cache', 'puppeteer'),
  // Linux/Mac
  path.join(process.env.HOME || '/root', '.cache', 'puppeteer'),
  // Render.com paths
  '/opt/render/project/.render/chrome',
  '/opt/render/.cache/puppeteer',
].filter(Boolean);

for (const cacheDir of PUPPETEER_CACHE_CANDIDATES) {
  const found = findChromeInCacheDir(cacheDir);
  if (found) {
    CHROME_PATHS.unshift(found); // highest priority
    break;
  }
}

// ─── Validation ───────────────────────────────────────────────

function validateCode(code) {
  const errors = [];
  const stripped = code.replace(/<!--[\s\S]*?-->/g, '');
  
  if (/<script[\s\S]*?>/i.test(stripped)) 
    errors.push('JavaScript <script> tags are not allowed.');
  if (/https?:\/\//i.test(stripped)) 
    errors.push('External URLs are not allowed.');
  if (/@import/i.test(stripped)) 
    errors.push('@import is not allowed.');
  if (/<canvas/i.test(stripped)) 
    errors.push('<canvas> is not allowed.');
  if (/on[a-z]+\s*=/i.test(stripped)) 
    errors.push('Inline event handlers are not allowed.');
  
  return errors;
}

// ─── Browser Pool Management ──────────────────────────────────

async function getBrowser() {
  // Try to get a browser from the pool
  if (browserPool.length > 0) {
    const browser = browserPool.pop();
    try {
      // Check if browser is still connected
      if (browser.connected) return browser;
    } catch (e) {
      // Browser is dead, create new one
    }
  }
  
  // Find Chrome executable
  let executablePath = null;
  for (const chromePath of CHROME_PATHS) {
    try {
      if (chromePath && fs.existsSync(chromePath)) {
        executablePath = chromePath;
        break;
      }
    } catch (e) { /* continue */ }
  }
  
  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--no-first-run',
      '--single-process' // Helps on some platforms
    ]
  };
  
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  
  return await puppeteer.launch(launchOptions);
}

function returnBrowser(browser) {
  if (browserPool.length < MAX_BROWSERS) {
    browserPool.push(browser);
    // Auto-cleanup after timeout
    setTimeout(() => {
      const idx = browserPool.indexOf(browser);
      if (idx > -1) {
        browserPool.splice(idx, 1);
        browser.close().catch(() => {});
      }
    }, BROWSER_TIMEOUT);
  } else {
    browser.close().catch(() => {});
  }
}

// ─── Frame capture ────────────────────────────────────────────

function buildFullHtml(code) {
  if (/<!doctype/i.test(code) || /<html/i.test(code)) return code;
  
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:600px;height:400px;display:flex;align-items:center;justify-content:center;background:#ffffff;overflow:hidden;}
</style>
</head>
<body>${code}</body>
</html>`;
}

async function captureFrames(html, isReference = false, level = null) {
  // Check cache for reference frames
  if (isReference && level !== null) {
    const cacheKey = `level${level}`;
    if (refFrameCache.has(cacheKey)) {
      const cached = refFrameCache.get(cacheKey);
      return cached.map(buf => Buffer.from(buf));
    }
  }
  
  let browser = null;
  const frames = [];
  
  try {
    browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setViewport(VIEWPORT);
    
    await page.setContent(buildFullHtml(html), { 
      waitUntil: 'networkidle0', 
      timeout: 10000 
    });
    
    await delay(100);
    
    const interval = Math.floor(DURATION_MS / (FRAME_COUNT - 1));
    
    for (let i = 0; i < FRAME_COUNT; i++) {
      const buf = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }
      });
      frames.push(buf);
      
      if (i < FRAME_COUNT - 1) {
        await delay(interval);
      }
    }
    
    // Cache reference frames
    if (isReference && level !== null) {
      const cacheKey = `level${level}`;
      refFrameCache.set(cacheKey, frames.map(buf => Buffer.from(buf)));
      if (refFrameCache.size > 5) {
        const firstKey = refFrameCache.keys().next().value;
        refFrameCache.delete(firstKey);
      }
    }
    
  } finally {
    if (browser) {
      returnBrowser(browser);
    }
  }
  
  return frames;
}

// ─── Optimized Scoring ───────────────────────────────────────

function compareFramePair(buf1, buf2) {
  try {
    const img1 = PNG.sync.read(buf1);
    const img2 = PNG.sync.read(buf2);
    
    if (img1.width !== img2.width || img1.height !== img2.height) return 0;
    
    const diff = new PNG({ width: img1.width, height: img1.height });
    const mismatched = pixelmatch(
      img1.data, 
      img2.data, 
      diff.data,
      img1.width, 
      img1.height, 
      { threshold: 0.1, includeAA: true, alpha: 0.3 }
    );
    
    return 1 - (mismatched / (img1.width * img1.height));
  } catch (e) {
    return 0;
  }
}

function scoreVisual(pFrames, rFrames) {
  const count = Math.min(pFrames.length, rFrames.length);
  let total = 0;
  
  for (let i = 0; i < count; i++) {
    total += compareFramePair(pFrames[i], rFrames[i]);
  }
  
  return count > 0 ? total / count : 0;
}

function scoreTimingRhythm(pFrames, rFrames) {
  const pDeltas = frameDeltas(pFrames);
  const rDeltas = frameDeltas(rFrames);
  
  if (!pDeltas.length || !rDeltas.length) return 0.5;
  
  const len = Math.min(pDeltas.length, rDeltas.length);
  const pMax = Math.max(...pDeltas, 0.001);
  const rMax = Math.max(...rDeltas, 0.001);
  
  const pN = pDeltas.slice(0, len).map(d => d / pMax);
  const rN = rDeltas.slice(0, len).map(d => d / rMax);
  
  const pMean = avg(pN), rMean = avg(rN);
  
  let num = 0, pv = 0, rv = 0;
  for (let i = 0; i < len; i++) {
    const pd = pN[i] - pMean;
    const rd = rN[i] - rMean;
    num += pd * rd;
    pv += pd * pd;
    rv += rd * rd;
  }
  
  const denom = Math.sqrt(pv * rv);
  return denom === 0 ? 0.5 : Math.max(0, (num / denom + 1) / 2);
}

function frameDeltas(frames) {
  const deltas = [];
  
  for (let i = 1; i < frames.length; i++) {
    try {
      const a = PNG.sync.read(frames[i - 1]);
      const b = PNG.sync.read(frames[i]);
      
      let diff = 0;
      const step = 4;
      for (let p = 0; p < a.data.length; p += step * 4) {
        diff += Math.abs(a.data[p] - b.data[p]) + 
                Math.abs(a.data[p+1] - b.data[p+1]) + 
                Math.abs(a.data[p+2] - b.data[p+2]);
      }
      
      deltas.push(diff / (a.data.length / 4));
    } catch (e) {
      deltas.push(0);
    }
  }
  
  return deltas;
}

function scoreCss(code) {
  let s = 0;
  if (/@keyframes/i.test(code)) s += 0.4;
  if (/animation[\s]*:/i.test(code)) s += 0.25;
  if (/transform/i.test(code)) s += 0.2;
  if (/opacity/i.test(code)) s += 0.15;
  return Math.min(1, s);
}

function scoreDom(code) {
  let s = 0;
  if (/<[a-z]/i.test(code)) s += 0.3;
  if (/<style/i.test(code)) s += 0.3;
  if (/class\s*=/i.test(code)) s += 0.2;
  if ((code.match(/<[a-z]/gi) || []).length >= 2) s += 0.2;
  return Math.min(1, s);
}

// ─── Main judge ───────────────────────────────────────────────

async function judgeSubmission(code, level) {
  const errors = validateCode(code);
  if (errors.length > 0) {
    return { valid: false, errors, score: 0, breakdown: null };
  }

  const refPath = path.join(LEVELS_DIR, `level${level}-reference.html`);
  if (!fs.existsSync(refPath)) {
    return { 
      valid: false, 
      errors: [`Reference for level ${level} not found.`], 
      score: 0, 
      breakdown: null 
    };
  }

  const refHtml = fs.readFileSync(refPath, 'utf8');

  let pFrames, rFrames;
  
  try {
    [pFrames, rFrames] = await Promise.all([
      captureFrames(code, false),
      captureFrames(refHtml, true, level)
    ]);
  } catch (err) {
    return { 
      valid: false, 
      errors: ['Render failed: ' + err.message], 
      score: 0, 
      breakdown: null 
    };
  }

  const visual = scoreVisual(pFrames, rFrames);
  const timing = scoreTimingRhythm(pFrames, rFrames);
  const css = scoreCss(code);
  const dom = scoreDom(code);

  const final = visual * 0.6 + timing * 0.2 + dom * 0.1 + css * 0.1;
  const score = Math.round(Math.min(100, final * 100));

  return {
    valid: true,
    errors: [],
    score,
    breakdown: {
      visual: Math.round(visual * 100),
      timing: Math.round(timing * 100),
      css: Math.round(css * 100),
      dom: Math.round(dom * 100)
    }
  };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

// Cleanup browser pool on exit
process.on('exit', () => {
  for (const browser of browserPool) {
    try { browser.close(); } catch (e) { /* ignore */ }
  }
});

module.exports = { judgeSubmission };
