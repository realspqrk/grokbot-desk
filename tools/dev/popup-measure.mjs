// P8d: measures what the pop-up window needs for one report. For every
// golden fixture of the built-in and shipped templates (one open report, no
// strip) it renders the served shell at the given viewport width and reports
// the natural height: header + the report's content + the submit bar, i.e.
// the viewport height at which nothing scrolls. With --chrome it also opens
// one headed Edge app window (own temp profile, offscreen, closed again) and
// reports outer minus inner size: the window frame to add to a viewport.
// Isolated server, temp data dir; nothing is left running.
// Usage: node tools/dev/popup-measure.mjs [--width 864] [--port 18975] [--chrome] [--out <json>]
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, loadChromium, ROOT } from './rs-server.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const width = Number(option('--width', 864));
const port = Number(option('--port', 18975));
const outFile = option('--out', null);
const withChrome = args.includes('--chrome');

/* every template directory that ships a golden fixture */
function templates() {
  const found = [];
  for (const group of ['builtin', 'global']) {
    const base = path.join(ROOT, 'templates', group);
    for (const id of readdirSync(base)) {
      const dir = path.join(base, id);
      if (id !== '_starter' && existsSync(path.join(dir, 'fixtures', 'golden.json'))) found.push({ id, dir });
    }
  }
  for (const ns of readdirSync(path.join(ROOT, 'templates'))) {
    if (['builtin', 'global'].includes(ns)) continue;
    for (const id of readdirSync(path.join(ROOT, 'templates', ns))) {
      const dir = path.join(ROOT, 'templates', ns, id);
      if (existsSync(path.join(dir, 'fixtures', 'golden.json'))) found.push({ id, dir, bot: ns });
    }
  }
  return found;
}

const fixture = (dir) => JSON.parse(readFileSync(path.join(dir, 'fixtures', 'golden.json'), 'utf8')
  .split('%RS_TEMPLATE%').join(JSON.stringify(dir).slice(1, -1)));

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const server = await startServer({ port, mediaRoots: [ROOT], env: { RS_LANG: 'en' } });
// launched inside try: a failed launch still stops the server
let browser;
const report = { width, templates: [], chrome: null };
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const item of templates()) {
    await server.clearRuns();
    const manifest = JSON.parse(readFileSync(path.join(item.dir, 'template.json'), 'utf8'));
    const run = server.show(fixture(item.dir), {
      template: item.id, title: manifest.title_de || item.id, ...(item.bot ? { bot: item.bot } : {}),
    });
    const ctx = await browser.newContext({ viewport: { width, height: 3000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.route('**/copy', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await page.goto(server.url(`?client=test&run=${run.run_id}`));
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
    await page.waitForFunction(() => [...document.images].every((img) => img.complete));
    await page.waitForTimeout(200);
    const facts = await page.evaluate(() => {
      const mount = document.getElementById('rs-mount');
      const header = document.querySelector('.rs-header').getBoundingClientRect();
      const bar = document.getElementById('rs-submitbar').getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(mount).paddingBottom) || 0;
      const last = mount.lastElementChild.getBoundingClientRect();
      const content = last.bottom - mount.getBoundingClientRect().top + padding;
      return {
        header: Math.round(header.height),
        content: Math.round(content),
        bar: Math.round(bar.height),
        natural: Math.ceil(header.height + content + bar.height),
      };
    });
    report.templates.push({ template: item.id, ...facts });
    await ctx.close();
  }
  if (withChrome) {
    // one headed app window, offscreen, own temp profile; closed below
    const profile = mkdtempSync(path.join(tmpdir(), 'rs-chrome-'));
    const target = { width: 880, height: 820 };
    const ctx = await chromium.launchPersistentContext(profile, {
      channel: 'msedge',
      headless: false,
      viewport: null,
      // no "controlled by automated software" bar: it would count as frame
      ignoreDefaultArgs: ['--enable-automation'],
      args: [`--app=${server.url('hello')}`, `--window-size=${target.width},${target.height}`, '--window-position=-2400,40'],
    });
    try {
      const page = ctx.pages()[0] || await ctx.waitForEvent('page');
      await page.waitForLoadState();
      const sizes = await page.evaluate(() => ({
        outerWidth, outerHeight, innerWidth, innerHeight, dpr: devicePixelRatio,
      }));
      report.chrome = {
        window_size: target,
        ...sizes,
        frame_width: sizes.outerWidth - sizes.innerWidth,
        frame_height: sizes.outerHeight - sizes.innerHeight,
      };
    } finally {
      await ctx.close();
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
} finally {
  try { if (browser) await browser.close(); } finally { await server.stop(); }
}
const naturals = report.templates.map((t) => t.natural).sort((a, b) => a - b);
report.summary = {
  min: naturals[0],
  median: naturals[Math.floor(naturals.length / 2)],
  max: naturals[naturals.length - 1],
};
const text = JSON.stringify(report, null, 2);
if (outFile) writeFileSync(outFile, text + '\n');
console.log(text);
