// Dev screenshots for the P8d pop-up layout on the real served shell
// (isolated server, temp data dir, headless Edge, English UI), light and
// dark, at 1280x720 and at the default pop-up viewport (864x836: the 880x920
// window minus the measured app frame):
//   popup-1open-<theme>-<size>.png   one open report: no strip
//   popup-3open-<theme>-<size>.png   three open: the avatar strip on top,
//       "1 of 3 open", one report still new (filled dot)
//   popup-done-<theme>-<size>.png    the calm done state after the last
//       decision (a test client never closes itself)
//   popup-strip-<theme>@2x.png       the strip alone at 2x
// Usage: node tools/dev/popup-shots.mjs <out-dir> [port]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from './rs-server.mjs';

const args = process.argv.slice(2);
const out = path.resolve(args[0] || 'tools/dev/out/popup');
const port = Number(args[1] || 18976);
mkdirSync(out, { recursive: true });
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const fixture = (template, name = 'golden') => {
  const dir = path.join(ROOT, 'templates', 'builtin', template);
  const raw = readFileSync(path.join(dir, 'fixtures', `${name}.json`), 'utf8');
  return JSON.parse(raw.split('%RS_TEMPLATE%').join(JSON.stringify(dir).slice(1, -1)));
};

/* reports whose titles match their fixture's body (built-ins only) */
const REPORTS = [
  { template: 'preview-post', fixture: 'golden', title: 'Autumn menu post: approve before Monday' },
  { template: 'approve-one', fixture: 'golden', title: 'Deploy web shop v2.4.0 to production?' },
  { template: 'review-doc', fixture: 'golden', title: 'Spring opening announcement: review the draft' },
];
const BOTS = [
  { name: 'Social Agent', shape: 'blob', color: 'orange', ...REPORTS[0] },
  { name: 'Ops Agent', shape: 'squircle', color: 'blue', ...REPORTS[1] },
  { name: 'Garden Club Agent', shape: 'teardrop', color: 'yellow', ...REPORTS[2] },
];
const SIZES = [
  { width: 1280, height: 720 },
  { width: 864, height: 836 },
];

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const server = await startServer({ port, mediaRoots: [ROOT], env: { RS_LANG: 'en' } });
// launched inside try: a failed launch still stops the server
let browser;
const written = [];

function showBot(bot, index) {
  return server.show(fixture(bot.template, bot.fixture), {
    template: bot.template,
    title: bot.title.slice(0, 80),
    bot: `example-popup-bot-${index + 1}`,
    identity: {
      name: bot.name,
      ...(bot.shape ? { avatar_shape: bot.shape } : {}),
      ...(bot.color ? { avatar_color: bot.color } : {}),
    },
    created: iso(Date.now() - (index + 1) * 60e3),   // newest first: the strip order
  });
}

async function open(runId, theme, { width, height }, scale = 1) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/copy', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(server.url(`?client=test&run=${runId}`));
  await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  return { ctx, page, errors };
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
  await page.waitForTimeout(250);
}

async function shoot(page, name, clip) {
  const file = path.join(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  written.push(file);
  return file;
}

const sizeName = ({ width, height }) => `${width}x${height}`;

try {
  browser = await chromium.launch({ channel: browserChannel(), headless: true });
  // -------------------------------------------------------- one open --
  await server.clearRuns();
  const single = showBot(BOTS[1], 0);
  for (const theme of ['light', 'dark']) {
    for (const size of SIZES) {
      const { ctx, page, errors } = await open(single.run_id, theme, size);
      await settle(page);
      await shoot(page, `popup-1open-${theme}-${sizeName(size)}.png`);
      if (errors.length) console.error('1open', theme, errors.join(' | '));
      await ctx.close();
    }
  }

  // ------------------------------------------------------ three open --
  await server.clearRuns();
  const three = BOTS.map(showBot);
  for (const theme of ['light', 'dark']) {
    for (const size of SIZES) {
      const { ctx, page, errors } = await open(three[0].run_id, theme, size);
      // the last one stays new: its dot is filled, the others are rings
      await markRead(page, three.slice(0, 2).map((r) => r.run_id));
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      await page.waitForFunction(() => [...document.images].every((img) => img.complete));
      await settle(page);
      await shoot(page, `popup-3open-${theme}-${sizeName(size)}.png`);
      if (errors.length) console.error('3open', theme, errors.join(' | '));
      await ctx.close();
    }
    const { ctx, page } = await open(three[0].run_id, theme, SIZES[1], 2);
    await settle(page);
    const clip = await page.evaluate(() => {
      const r = document.getElementById('rs-strip-nav').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height + 72 };
    });
    await shoot(page, `popup-strip-${theme}@2x.png`, clip);
    await ctx.close();
  }

  // ------------------------------------------------------- done state --
  for (const theme of ['light', 'dark']) {
    for (const size of SIZES) {
      await server.clearRuns();
      const run = showBot(BOTS[1], 0);
      const { ctx, page, errors } = await open(run.run_id, theme, size);
      await page.click('rs-action-row[data-item="decision"] button[value="approve"]');
      await page.click('#rs-submit');
      await page.waitForSelector('.rs-banner[data-done]');
      await page.waitForFunction(() => !document.querySelector('.rs-toast'), null, { timeout: 5000 });
      await settle(page);
      await shoot(page, `popup-done-${theme}-${sizeName(size)}.png`);
      if (errors.length) console.error('done', theme, errors.join(' | '));
      await ctx.close();
    }
  }
} finally {
  try { if (browser) await browser.close(); } finally { await server.stop(); }
}
writeFileSync(path.join(out, 'popup-shots.txt'), written.join('\n') + '\n');
console.log(written.join('\n'));
