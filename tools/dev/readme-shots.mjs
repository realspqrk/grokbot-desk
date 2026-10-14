// README and marketing screenshots from the real served shell (isolated
// server, temp data dir, headless Edge/Chrome, English UI, fictional bots,
// synthetic data). Writes to <out-dir> only; a person approves the set
// before it is copied to docs/img.
//   hero-grokbot-dark.png   the desk pop-up over a dark chat-app skeleton
//                           (tools/dev/readme-scene/grokbot-skeleton.html)
//   hero-strip-<theme>.png  three open reports, avatar strip, approve-one first
//   hero-popup-dark.png     one open approve-one report, no strip
//   hero-report-dark.png    a review-doc status report (task.kind fyi)
//   hero-done.png           the calm done state after the last decision
// Shots are taken at deviceScaleFactor 2 and downscaled in the browser when
// a PNG is larger than MAX_BYTES.
// Usage: node tools/dev/readme-shots.mjs <out-dir> [port]   (default 18923)
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserChannel, startServer, loadChromium, ROOT } from './rs-server.mjs';

const args = process.argv.slice(2);
const out = path.resolve(args[0] || 'tools/dev/out/readme');
const port = Number(args[1] || 18923);
if (port < 18920 || port > 18939) throw new Error('use a test port from 18920 to 18939');
mkdirSync(out, { recursive: true });

const SCALE = 2;
const MAX_BYTES = 600 * 1024;
const POPUP = { width: 864, height: 836 };
/* the scene's pop-up: the same width, as tall as its content (see fitHeight) */
const SCENE = { width: 1600, height: 1000 };
const SKELETON = path.join(ROOT, 'tools', 'dev', 'readme-scene', 'grokbot-skeleton.html');

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fixture = (template, name = 'golden') => {
  const dir = path.join(ROOT, 'templates', 'builtin', template);
  const raw = readFileSync(path.join(dir, 'fixtures', `${name}.json`), 'utf8');
  return JSON.parse(raw.split('%RS_TEMPLATE%').join(JSON.stringify(dir).slice(1, -1)));
};

/* "due Friday": the next Friday at least one day ahead */
function nextFriday() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return ymd(d);
}

const OFFICE_BOT = { name: 'Office Bot', avatar_shape: 'blob', avatar_color: 'orange' };

const INVOICES = {
  template: 'decide-list',
  title: 'Three invoices this week',
  identity: OFFICE_BOT,
  task: { kind: 'approve_bot_acts', why: 'Hosting is due Friday.' },
  data: {
    labels: { approve: 'Pay', reject: "Don't pay", defer: 'Next week' },
    items: [
      { id: 'hosting', kind: 'Invoice', source: 'Web hosting', title: 'Hosting for the web shop, 89 EUR', due: nextFriday() },
      { id: 'toner', kind: 'Invoice', source: 'Office supplies', title: 'Toner for the office printer, 132.90 EUR' },
      { id: 'domain', kind: 'Invoice', source: 'Domain registrar', title: 'Domain renewal for one year, 12 EUR' },
    ],
  },
};

const WEEKLY = {
  template: 'review-doc',
  title: 'Weekly operations report',
  identity: { name: 'Ops Agent', avatar_shape: 'squircle', avatar_color: 'blue' },
  task: { kind: 'fyi' },
  data: {
    summary: 'Week 41 across the two sites.',
    doc: [
      '**Both sites ran normally this week; one supplier delivery is late.**',
      '',
      '| Site | Status |',
      '|---|---|',
      '| North warehouse | Normal |',
      '| City shop | Normal |',
      '',
      '- [x] Backups finished every night',
      '- [x] Payroll file sent to the bank',
      '- [x] Fire doors inspected',
      '- [ ] Packaging supplier confirms a new date',
      '',
      '> [!WARNING]',
      '> One delivery is late. Stock lasts until next Friday.',
    ].join('\n'),
  },
};

/* three bots for the strip; the first is the visible one (newest) */
const STRIP = [
  { name: 'Ops Agent', shape: 'squircle', color: 'blue', template: 'approve-one', fixture: 'golden', title: 'Deploy web shop v2.4.0 to production?' },
  { name: 'Social Agent', shape: 'blob', color: 'orange', template: 'preview-post', fixture: 'golden', title: 'Autumn menu post: approve before Monday' },
  { name: 'Garden Club Agent', shape: 'teardrop', color: 'yellow', template: 'review-doc', fixture: 'golden', title: 'Spring opening announcement: review the draft' },
];

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const server = await startServer({ port, mediaRoots: [ROOT], env: { RS_LANG: 'en' } });
let browser;
const written = [];

function showReport(report, index = 0) {
  return server.show(report.data, {
    template: report.template,
    title: report.title,
    bot: `example-readme-bot-${index + 1}`,
    identity: report.identity,
    ...(report.task ? { task: report.task } : {}),
    created: iso(Date.now() - (index + 1) * 60e3),
  });
}

function showStripBot(bot, index) {
  return showReport({
    template: bot.template,
    title: bot.title,
    identity: { name: bot.name, avatar_shape: bot.shape, avatar_color: bot.color },
    data: fixture(bot.template, bot.fixture),
  }, index);
}

async function open(runId, theme, size = POPUP) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: SCALE, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/copy', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(server.url(`?client=test&run=${runId}`));
  await ready(page);
  return { ctx, page, errors };
}

async function ready(page) {
  await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  await page.evaluate(() => document.fonts.ready);
}

async function markRead(page, ids) {
  await page.evaluate(async (list) => {
    const boot = JSON.parse(document.getElementById('rs-boot').textContent);
    for (const id of list) {
      await fetch('/read', { method: 'POST', headers: { 'X-RS-CSRF': boot.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: id }) });
    }
  }, ids);
}

async function settle(page) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

/** A report that scrolls is a clipped README picture: say so. */
async function warnIfScrolls(page, label) {
  const over = await page.evaluate(() => [...document.querySelectorAll('*')]
    .filter((el) => {
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    })
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} +${el.scrollHeight - el.clientHeight}px`));
  if (over.length) console.warn(`${label}: content scrolls: ${over.join(', ')}`);
}

/** Downscales a PNG in the browser until it fits MAX_BYTES (never below 1x). */
async function shrink(file, cssWidth) {
  if (statSync(file).size <= MAX_BYTES) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const source = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  try {
    for (let factor = 0.9; ; factor -= 0.1) {
      const data = await page.evaluate(async ({ source, factor, minWidth }) => {
        const img = new Image();
        img.src = source;
        await img.decode();
        const width = Math.max(minWidth, Math.round(img.naturalWidth * factor));
        const height = Math.round(img.naturalHeight * width / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, width, height);
        return { url: canvas.toDataURL('image/png'), width };
      }, { source, factor, minWidth: cssWidth });
      const bytes = Buffer.from(data.url.split(',')[1], 'base64');
      if (bytes.length <= MAX_BYTES || data.width <= cssWidth) {
        writeFileSync(file, bytes);
        return;
      }
    }
  } finally {
    await ctx.close();
  }
}

async function shoot(page, name, cssWidth) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  await shrink(file, cssWidth);
  written.push(file);
  return file;
}

/** Shortens the viewport to the smallest height at which the report does
 *  not scroll: the window ends just below the footer and its own padding. */
async function fitHeight(page) {
  const fits = async (height) => {
    await page.setViewportSize({ width: POPUP.width, height });
    await page.waitForTimeout(80);
    return page.evaluate(() => {
      const mount = document.getElementById('rs-mount');
      return mount.scrollHeight <= mount.clientHeight && !mount.hasAttribute('data-rs-more');
    });
  };
  let low = 320;
  let high = POPUP.height;
  if (!(await fits(high))) return high;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await fits(mid)) high = mid; else low = mid;
  }
  await fits(high);
  console.log(`scene pop-up: ${POPUP.width}x${high}`);
  return high;
}

/** The skeleton's avatars must be the desk's own blob. */
function checkSkeletonBlob(html) {
  const shapes = JSON.parse(readFileSync(path.join(ROOT, 'core', 'static', 'avatar-shapes.json'), 'utf8'));
  const [outline, ...eyes] = shapes.shapes.blob.split('Z').filter(Boolean).map((part) => part + 'Z');
  if (!html.includes(`id="blob" d="${outline}"`) || !html.includes(`id="eyes" d="${eyes.join('')}"`)) {
    throw new Error('grokbot-skeleton.html: the blob path differs from core/static/avatar-shapes.json');
  }
}

async function report(runId, theme, name, { before } = {}) {
  const { ctx, page, errors } = await open(runId, theme);
  if (before) await before(page);
  await settle(page);
  await warnIfScrolls(page, name);
  const file = await shoot(page, name, POPUP.width);
  if (errors.length) console.error(name, errors.join(' | '));
  await ctx.close();
  return file;
}

try {
  browser = await chromium.launch({ channel: browserChannel(), headless: true });

  // ----------------------------------------------- 1. hero over chat app --
  await server.clearRuns();
  const invoices = showReport(INVOICES);
  const popupFile = path.join(out, '_popup-invoices-dark.png');
  {
    const { ctx, page, errors } = await open(invoices.run_id, 'dark');
    await fitHeight(page);
    await settle(page);
    await warnIfScrolls(page, 'invoices');
    await page.screenshot({ path: popupFile });
    if (errors.length) console.error('invoices', errors.join(' | '));
    await ctx.close();
  }
  {
    const html = readFileSync(SKELETON, 'utf8');
    checkSkeletonBlob(html);
    const ctx = await browser.newContext({ viewport: SCENE, deviceScaleFactor: SCALE, colorScheme: 'dark' });
    const page = await ctx.newPage();
    // self-contained page: refuse anything that is not the file itself or inline data
    await page.route('**/*', (r) => (/^(file|data):/.test(r.request().url()) ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(SKELETON).href);
    await page.evaluate(async (src) => {
      const img = document.getElementById('popup-shot');
      img.src = src;
      await img.decode();
    }, `data:image/png;base64,${readFileSync(popupFile).toString('base64')}`);
    await page.evaluate(() => document.fonts.ready);
    await shoot(page, 'hero-grokbot-dark.png', SCENE.width);
    await ctx.close();
    rmSync(popupFile, { force: true });
  }

  // ------------------------------------------------------ 2. the strip --
  await server.clearRuns();
  const three = STRIP.map(showStripBot);
  for (const theme of ['dark', 'light']) {
    await report(three[0].run_id, theme, `hero-strip-${theme}.png`, {
      before: async (page) => {
        // the last one stays new: its dot is filled, the others are rings
        await markRead(page, three.slice(0, 2).map((r) => r.run_id));
        await page.reload();
        await ready(page);
      },
    });
  }

  // --------------------------------------------------- 3. one pop-up --
  await server.clearRuns();
  const single = showStripBot(STRIP[0], 0);
  await report(single.run_id, 'dark', 'hero-popup-dark.png');

  // ---------------------------------------------- 4. a status report --
  await server.clearRuns();
  const weekly = showReport(WEEKLY);
  await report(weekly.run_id, 'dark', 'hero-report-dark.png');

  // --------------------------------------------------- 5. done state --
  await server.clearRuns();
  const last = showStripBot(STRIP[0], 0);
  await report(last.run_id, 'dark', 'hero-done.png', {
    before: async (page) => {
      // approve-one: the footer primary is the decision, one click
      await page.click('#rs-submit');
      await page.waitForSelector('.rs-banner[data-done]');
      await page.waitForFunction(() => !document.querySelector('.rs-toast'), null, { timeout: 5000 });
    },
  });
} finally {
  try { if (browser) await browser.close(); } finally { await server.stop(); }
}

for (const file of written) {
  const head = readFileSync(file).subarray(16, 24);
  console.log(`${path.basename(file)}  ${head.readUInt32BE(0)}x${head.readUInt32BE(4)}  ${statSync(file).size} bytes`);
}
