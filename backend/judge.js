'use strict';

const puppeteer  = require('puppeteer-core');
const { PNG }    = require('pngjs');
const pixelmatch = require('pixelmatch');
const path       = require('path');
const fs         = require('fs');

const LEVELS_DIR  = process.env.LEVELS_DIR || path.join(__dirname, '..', 'levels');
const VIEWPORT    = { width: 600, height: 400 };
const FRAME_COUNT = 8;
const DURATION_MS = 2000;

const refFrameCache = new Map();
let browserPool = [];
const MAX_BROWSERS = 2;
const BROWSER_TTL  = 120000;

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const systemPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const p of systemPaths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function getLaunchOptions() {
  const exe = findChrome();
  if (!exe) throw new Error('Chrome not found. Set PUPPETEER_EXECUTABLE_PATH env var.');
  console.log('[Puppeteer] Using Chrome:', exe);
  return {
    executablePath: exe,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--single-process',
      '--memory-pressure-off',
    ],
  };
}

async function getBrowser() {
  while (browserPool.length > 0) {
    const b = browserPool.pop();
    try { if (b.connected) return b; } catch {}
  }
  return puppeteer.launch(getLaunchOptions());
}

function releaseBrowser(browser) {
  if (browserPool.length < MAX_BROWSERS) {
    browserPool.push(browser);
    setTimeout(() => {
      const i = browserPool.indexOf(browser);
      if (i > -1) { browserPool.splice(i, 1); browser.close().catch(() => {}); }
    }, BROWSER_TTL);
  } else {
    browser.close().catch(() => {});
  }
}

function validateCode(code) {
  const errors = [];
  const stripped = code.replace(/<!--[\s\S]*?-->/g, '');
  if (/<script[\s\S]*?>/i.test(stripped))  errors.push('JavaScript <script> tags are not allowed.');
  if (/https?:\/\//i.test(stripped))        errors.push('External URLs are not allowed.');
  if (/@import/i.test(stripped))            errors.push('@import is not allowed.');
  if (/<canvas/i.test(stripped))            errors.push('<canvas> is not allowed.');
  if (/on[a-z]+\s*=/i.test(stripped))      errors.push('Inline event handlers are not allowed.');
  return errors;
}

function wrapHtml(code) {
  if (/<!doctype/i.test(code) || /<html/i.test(code)) return code;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:600px;height:400px;display:flex;align-items:center;
  justify-content:center;background:#ffffff;overflow:hidden;}
</style>
</head>
<body>${code}</body>
</html>`;
}

async function captureFrames(html, isRef = false, level = null) {
  if (isRef && level !== null && refFrameCache.has(`l${level}`)) {
    return refFrameCache.get(`l${level}`).map(b => Buffer.from(b));
  }
  let browser = null;
  const frames = [];
  try {
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.setContent(wrapHtml(html), { waitUntil: 'networkidle0', timeout: 15000 });
    await delay(120);
    const step = Math.floor(DURATION_MS / (FRAME_COUNT - 1));
    for (let i = 0; i < FRAME_COUNT; i++) {
      frames.push(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...VIEWPORT } }));
      if (i < FRAME_COUNT - 1) await delay(step);
    }
    await page.close();
  } finally {
    if (browser) releaseBrowser(browser);
  }
  if (isRef && level !== null) {
    refFrameCache.set(`l${level}`, frames.map(b => Buffer.from(b)));
    if (refFrameCache.size > 6) refFrameCache.delete(refFrameCache.keys().next().value);
  }
  return frames;
}

function compareFrames(a, b) {
  try {
    const ia = PNG.sync.read(a), ib = PNG.sync.read(b);
    if (ia.width !== ib.width || ia.height !== ib.height) return 0;
    const diff = new PNG({ width: ia.width, height: ia.height });
    const bad  = pixelmatch(ia.data, ib.data, diff.data, ia.width, ia.height,
      { threshold: 0.1, includeAA: true, alpha: 0.3 });
    return 1 - bad / (ia.width * ia.height);
  } catch { return 0; }
}

function scoreVisual(pf, rf) {
  const n = Math.min(pf.length, rf.length);
  return n > 0 ? pf.slice(0,n).reduce((s,_,i) => s + compareFrames(pf[i],rf[i]), 0) / n : 0;
}

function frameDeltas(frames) {
  const d = [];
  for (let i = 1; i < frames.length; i++) {
    try {
      const a = PNG.sync.read(frames[i-1]), b = PNG.sync.read(frames[i]);
      let diff = 0;
      for (let p = 0; p < a.data.length; p += 16)
        diff += Math.abs(a.data[p]-b.data[p]) + Math.abs(a.data[p+1]-b.data[p+1]) + Math.abs(a.data[p+2]-b.data[p+2]);
      d.push(diff / (a.data.length / 4));
    } catch { d.push(0); }
  }
  return d;
}

function scoreTiming(pf, rf) {
  const pd = frameDeltas(pf), rd = frameDeltas(rf);
  if (!pd.length || !rd.length) return 0.5;
  const len = Math.min(pd.length, rd.length);
  const pm = Math.max(...pd, 1e-6), rm = Math.max(...rd, 1e-6);
  const pn = pd.slice(0,len).map(x=>x/pm), rn = rd.slice(0,len).map(x=>x/rm);
  const pmean = pn.reduce((a,b)=>a+b,0)/len, rmean = rn.reduce((a,b)=>a+b,0)/len;
  let num=0, pv=0, rv=0;
  for (let i=0; i<len; i++) { const pp=pn[i]-pmean,rr=rn[i]-rmean; num+=pp*rr; pv+=pp*pp; rv+=rr*rr; }
  const denom = Math.sqrt(pv*rv);
  return denom === 0 ? 0.5 : Math.max(0, (num/denom + 1) / 2);
}

function scoreCss(code) {
  let s = 0;
  if (/@keyframes/i.test(code))   s += 0.4;
  if (/animation\s*:/i.test(code)) s += 0.25;
  if (/transform/i.test(code))     s += 0.2;
  if (/opacity/i.test(code))       s += 0.15;
  return Math.min(1, s);
}

function scoreDom(code) {
  let s = 0;
  if (/<[a-z]/i.test(code)) s += 0.3;
  if (/<style/i.test(code)) s += 0.3;
  if (/class\s*=/i.test(code)) s += 0.2;
  if ((code.match(/<[a-z]/gi)||[]).length >= 2) s += 0.2;
  return Math.min(1, s);
}

async function judgeSubmission(code, level) {
  const errors = validateCode(code);
  if (errors.length) return { valid: false, errors, score: 0, breakdown: null };

  const refPath = path.join(LEVELS_DIR, `level${level}-reference.html`);
  if (!fs.existsSync(refPath))
    return { valid: false, errors: [`Reference for level ${level} not found.`], score: 0, breakdown: null };

  const refHtml = fs.readFileSync(refPath, 'utf8');

  let pFrames, rFrames;
  try {
    [pFrames, rFrames] = await Promise.all([
      captureFrames(code, false),
      captureFrames(refHtml, true, level),
    ]);
  } catch (err) {
    return { valid: false, errors: ['Render failed: ' + err.message], score: 0, breakdown: null };
  }

  const visual = scoreVisual(pFrames, rFrames);
  const timing = scoreTiming(pFrames, rFrames);
  const css    = scoreCss(code);
  const dom    = scoreDom(code);

  const score  = Math.round(Math.min(100, (visual*0.6 + timing*0.2 + dom*0.1 + css*0.1) * 100));

  return {
    valid: true,
    errors: [],
    score,
    breakdown: {
      visual: Math.round(visual*100),
      timing: Math.round(timing*100),
      css:    Math.round(css*100),
      dom:    Math.round(dom*100),
    },
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('exit', () => {
  browserPool.forEach(b => { try { b.close(); } catch {} });
});

module.exports = { judgeSubmission };
