// README and marketing screenshots from the real served shell (isolated
// server, temp data dir, headless Edge/Chrome, English UI, fictional bots,
// synthetic data). Writes to <out-dir> only; a person approves the set
// before it is copied to docs/img. All dark.
//   hero-grokbot-dark.png  the desk pop-up over an illustrative chat-app
//                          skeleton (tools/dev/readme-scene/grokbot-skeleton.html)
//   hero-inbox-dark.png    three open reports in the inbox, a compact deploy first
//   hero-popup-dark.png    one open approve report (supplier quote), no inbox
//   hero-report-dark.png   a read report (weekly status: table, checks, a note)
//   hero-done.png          the supplier decision after it was sent, framed tight
// The README shows the four tiles at about 400 px, so they share one narrow
// viewport (TILE_WIDTH, or the third argument) and are as tall as their
// content. Shots are taken at deviceScaleFactor 2 and downscaled in the
// browser only when a PNG is larger than MAX_BYTES.
// Usage: node tools/dev/readme-shots.mjs <out-dir> [port] [tile-width]
//        (defaults: tools/dev/out/readme, 18923, 480)
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  browserChannel, startServer, loadChromium, ROOT, fixtureMedia, payloadFixture,
} from './rs-server.mjs';

const args = process.argv.slice(2);
const out = path.resolve(args[0] || 'tools/dev/out/readme');
const port = Number(args[1] || 18923);
if (port < 18920 || port > 18939) throw new Error('use a test port from 18920 to 18939');
mkdirSync(out, { recursive: true });

const SCALE = 2;
const MAX_BYTES = 600 * 1024;
const TILE_WIDTH = Number(args[2] || 480);
const MAX_HEIGHT = 1200;
/* the hero pop-up: a real narrow window, shown 1:1; the 840 px scene keeps
   it at about two thirds of the hero width */
const HERO_POPUP_WIDTH = 560;
const SCENE_WIDTH = 840;
const SKELETON = path.join(ROOT, 'tools', 'dev', 'readme-scene', 'grokbot-skeleton.html');

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* "due Friday": the next Friday at least one day ahead */
function nextFriday() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return ymd(d);
}

/* every report is a payload@2 report built from blocks */
const INVOICES = {
  title: 'Three invoices this week',
  identity: { name: 'Office Bot', avatar_shape: 'blob', avatar_color: 'orange' },
  ask: 'approve',
  why: 'Hosting is due Friday.',
  blocks: [
    {
      type: 'decide', id: 'invoices', labels: { approve: 'Pay', reject: "Don't pay", later: 'Next week' },
      items: [
        { id: 'hosting', title: 'Hosting for the web shop', meta: '89 EUR', due: nextFriday() },
        { id: 'toner', title: 'Toner for the office printer', meta: '132.90 EUR' },
        { id: 'domain', title: 'Domain renewal for one year', meta: '12 EUR' },
      ],
    },
  ],
};

const CHAIRS = {
  title: 'Accept the supplier quote for office chairs?',
  identity: { name: 'Purchasing Agent', avatar_shape: 'squircle', avatar_color: 'green' },
  ask: 'approve',
  action: 'order the chairs',
  label: 'Accept quote',
  why: 'Twelve office chairs for the second floor. The quote is within budget.',
  blocks: [
    { type: 'facts', items: [
      { label: 'Supplier', value: 'Northwind Seating' },
      { label: 'Total', value: '2,340 EUR' },
      { label: 'Delivery', value: 'In 2 weeks' },
    ] },
    { type: 'checks', items: [{ label: 'Within the furniture budget', state: 'ok' }] },
  ],
};

const DEPLOY = {
  title: 'Deploy web shop v2.4.0?',
  identity: { name: 'Ops Agent', avatar_shape: 'squircle', avatar_color: 'blue' },
  ask: 'approve',
  action: 'deploy',
  label: 'Approve deploy',
  why: 'Staging passed. Deploy tonight at 18:00?',
  blocks: [
    { type: 'text', title: 'What changes', md: '- New checkout with saved addresses\n- Faster search' },
    { type: 'checks', items: [
      { label: 'Tests', detail: '214 passed', state: 'ok' },
      { label: 'Smoke test', detail: 'All flows OK', state: 'ok' },
      { label: 'Bundle size', detail: '+18 KB', state: 'warn' },
    ] },
  ],
};

const WEEKLY = {
  title: 'Weekly operations report',
  identity: { name: 'Ops Agent', avatar_shape: 'squircle', avatar_color: 'blue' },
  ask: 'read',
  why: 'Week 41 across the two sites. Both sites ran normally; one delivery is late.',
  blocks: [
    { type: 'table', columns: [{ key: 'site', label: 'Site' }, { key: 'status', label: 'Status' }], rows: [
      { site: 'North warehouse', status: 'Normal' },
      { site: 'City shop', status: 'Normal' },
    ] },
    { type: 'checks', items: [
      { label: 'Backups finished every night', state: 'ok' },
      { label: 'Payroll file sent to the bank', state: 'ok' },
      { label: 'Packaging supplier confirms a new date', state: 'open' },
    ] },
    { type: 'text', md: '> [!WARNING]\n> One delivery is late. Stock lasts until next Friday.' },
  ],
};

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const media = fixtureMedia();
const server = await startServer({ port, mediaRoots: [media.dir], env: { RS_LANG: 'en' } });

/* three bots in the inbox; the first is the visible one */
const INBOX = [
  DEPLOY,
  { ...payloadFixture('approve-post'), title: 'Autumn menu post: approve before Monday', identity: { name: 'Social Agent', avatar_shape: 'blob', avatar_color: 'orange' } },
  { ...payloadFixture('review'), title: 'Spring opening announcement: review the draft', identity: { name: 'Garden Club Agent', avatar_shape: 'teardrop', avatar_color: 'yellow' } },
].map((report) => media.map(report));

let browser;
const written = [];

function showReport(report, index = 0) {
  return server.show(report, {
    bot: `example-readme-bot-${index + 1}`,
    created: iso(Date.now() - (index + 1) * 60e3),
  });
}

async function open(runId, theme, size = { width: TILE_WIDTH, height: MAX_HEIGHT }) {
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
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} +${el.scrollHeight - el.clientHeight}px`));
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

/** Shortens the viewport to the smallest height at which the report does
 *  not scroll: the window ends just below the footer and its own padding. */
async function fitHeight(page, width) {
  const fits = async (height) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    return page.evaluate(() => {
      const mount = document.getElementById('rs-mount');
      return mount.scrollHeight <= mount.clientHeight && !mount.hasAttribute('data-rs-more');
    });
  };
  let low = 240;
  let high = MAX_HEIGHT;
  if (!(await fits(high))) throw new Error(`report does not fit ${width}x${MAX_HEIGHT}`);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await fits(mid)) high = mid; else low = mid;
  }
  await fits(high);
  return high;
}

/** After the pointer and focus settle, grows the viewport until the report
 *  does not scroll (a late reflow can need a few more pixels). */
async function settleFitted(page, width, height) {
  await settle(page);
  for (let tries = 0; tries < 20; tries += 1) {
    const scrolls = await page.evaluate(() => {
      const mount = document.getElementById('rs-mount');
      return mount.scrollHeight > mount.clientHeight || mount.hasAttribute('data-rs-more');
    });
    if (!scrolls) return height;
    height += 4;
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
  }
  return height;
}

/** The skeleton's avatars must be the desk's own blob. */
function checkSkeletonBlob(html) {
  const shapes = JSON.parse(readFileSync(path.join(ROOT, 'core', 'static', 'avatar-shapes.json'), 'utf8'));
  const [outline, ...eyes] = shapes.shapes.blob.split('Z').filter(Boolean).map((part) => part + 'Z');
  if (!html.includes(`id="blob" d="${outline}"`) || !html.includes(`id="eyes" d="${eyes.join('')}"`)) {
    throw new Error('grokbot-skeleton.html: the blob path differs from core/static/avatar-shapes.json');
  }
}

async function save(page, name, cssWidth, clip) {
  const file = path.join(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  await shrink(file, cssWidth);
  written.push(file);
  return file;
}

/** One README tile: the tile width, as tall as the content (or `clip`). */
async function tile(runId, name, { before, clip } = {}) {
  const { ctx, page, errors } = await open(runId, 'dark');
  if (before) await before(page);
  await settleFitted(page, TILE_WIDTH, await fitHeight(page, TILE_WIDTH));
  await warnIfScrolls(page, name);
  await save(page, name, TILE_WIDTH, clip ? await clip(page) : null);
  if (errors.length) console.error(name, errors.join(' | '));
  await ctx.close();
}

try {
  browser = await chromium.launch({ channel: browserChannel(), headless: true });

  // ----------------------------------------------- 1. hero over chat app --
  await server.clearRuns();
  const invoices = showReport(INVOICES);
  const popupFile = path.join(out, '_popup-invoices-dark.png');
  let popHeight;
  {
    const { ctx, page, errors } = await open(invoices.run_id, 'dark');
    popHeight = await settleFitted(page, HERO_POPUP_WIDTH, await fitHeight(page, HERO_POPUP_WIDTH));
    await warnIfScrolls(page, 'invoices');
    await page.screenshot({ path: popupFile });
    if (errors.length) console.error('invoices', errors.join(' | '));
    await ctx.close();
  }
  {
    const html = readFileSync(SKELETON, 'utf8');
    checkSkeletonBlob(html);
    const scene = { width: SCENE_WIDTH, height: MAX_HEIGHT };
    const ctx = await browser.newContext({ viewport: scene, deviceScaleFactor: SCALE, colorScheme: 'dark' });
    const page = await ctx.newPage();
    // self-contained page: refuse anything that is not the file itself or inline data
    await page.route('**/*', (r) => (/^(file|data):/.test(r.request().url()) ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(SKELETON).href);
    await page.evaluate(async ({ src, height }) => {
      document.documentElement.style.setProperty('--pop-h', `${height}px`);
      const img = document.getElementById('popup-shot');
      img.src = src;
      await img.decode();
    }, { src: `data:image/png;base64,${readFileSync(popupFile).toString('base64')}`, height: popHeight });
    await page.evaluate(() => document.fonts.ready);
    // the scene's height follows the pop-up (body height in the skeleton)
    scene.height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await page.setViewportSize(scene);
    await save(page, 'hero-grokbot-dark.png', scene.width);
    await ctx.close();
    rmSync(popupFile, { force: true });
  }

  // ------------------------------------------------------- 2. the inbox --
  await server.clearRuns();
  const three = INBOX.map(showReport);
  await tile(three[0].run_id, 'hero-inbox-dark.png', {
    before: async (page) => {
      // the last one stays new: its dot is filled
      await markRead(page, three.slice(0, 2).map((r) => r.run_id));
      await page.reload();
      await ready(page);
    },
  });

  // --------------------------------------------------- 3. one pop-up --
  await server.clearRuns();
  await tile(showReport(CHAIRS).run_id, 'hero-popup-dark.png');

  // ---------------------------------------------- 4. a status report --
  await server.clearRuns();
  await tile(showReport(WEEKLY).run_id, 'hero-report-dark.png');

  // ------------------------------------- 5. done: the same decision, sent --
  await server.clearRuns();
  await tile(showReport(CHAIRS).run_id, 'hero-done.png', {
    before: async (page) => {
      // approve: the footer primary is the decision, one click
      await page.click('#rs-submit');
      await page.waitForSelector('#rs-task[data-state="decided"]');
      await page.waitForFunction(() => !document.querySelector('.rs-toast'), null, { timeout: 5000 });
    },
    // tight: the header, the title, the decided line and the done banner
    clip: (page) => page.evaluate((width) => {
      const task = document.getElementById('rs-task').getBoundingClientRect();
      const parts = document.querySelectorAll('[data-rs-done-text], .rs-banner__keep');
      const bottom = Math.max(task.bottom, ...[...parts].map((el) => el.getBoundingClientRect().bottom));
      return { x: 0, y: 0, width, height: Math.ceil(bottom + 16) };
    }, TILE_WIDTH),
  });
} finally {
  try { if (browser) await browser.close(); } finally {
    try { await server.stop(); } finally { media.cleanup(); }
  }
}

for (const file of written) {
  const head = readFileSync(file).subarray(16, 24);
  console.log(`${path.basename(file)}  ${head.readUInt32BE(0)}x${head.readUInt32BE(4)}  ${statSync(file).size} bytes`);
}
