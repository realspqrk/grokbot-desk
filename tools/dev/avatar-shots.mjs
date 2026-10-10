// Dev screenshots for P8c shape avatars on the real served shell (isolated
// server, temp data dir, headless Edge, English UI):
//   contact-sheet-<theme>@<1|2>x.png  every shape x every colour (+ default
//       fill and the initials fallbacks) at 24, 32 and 64 px, drawn with the
//       page's own avatar markup, tokens and the core shape set
//   header-<template>-<theme>-1280x720.png  three templates with different
//       shapes (strip on: three open reports)
//   strip-<theme>.png  the avatar strip of eight fictional bots
//   side-by-side-dark.png  --reference <png> on the left, our dark strip on
//       the right
// Usage: node tools/dev/avatar-shots.mjs <out-dir> [port] [--reference <png>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from './rs-server.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const [, value] = args.splice(index, 2);
  return value;
};
const reference = option('--reference');
const out = path.resolve(args[0] || 'tools/dev/out/avatars');
const port = Number(args[1] || 18979);
mkdirSync(out, { recursive: true });
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const shapes = JSON.parse(readFileSync(path.join(ROOT, 'core/static/avatar-shapes.json'), 'utf8'));
const fixture = (template, name = 'golden') => {
  const dir = path.join(ROOT, 'templates', 'builtin', template);
  const raw = readFileSync(path.join(dir, 'fixtures', `${name}.json`), 'utf8');
  return JSON.parse(raw.split('%RS_TEMPLATE%').join(JSON.stringify(dir).slice(1, -1)));
};

/* reports whose titles match their fixture's body (built-ins only) */
const REPORTS = [
  { template: 'decide-list', fixture: 'golden', title: '5 requests waiting for you' },
  { template: 'approve-one', fixture: 'golden', title: 'Deploy web shop v2.4.0 to production?' },
  { template: 'preview-post', fixture: 'golden', title: 'Autumn menu post: approve before Monday' },
  { template: 'review-doc', fixture: 'golden', title: 'Spring opening announcement: review the draft' },
  { template: 'pick-option', fixture: 'golden', title: 'Spring team day: pick a venue' },
  { template: 'approve-one', fixture: 'edge-access', title: 'Read access to the reporting database for Lena Park' },
  { template: 'pick-option', fixture: 'edge-two', title: 'New desks: pick a delivery slot' },
  { template: 'decide-list', fixture: 'edge-single', title: 'Publish the 2027 holiday calendar?' },
  { template: 'review-doc', fixture: 'edge-plain', title: 'Reply to Sam about garden plot 23' },
  { template: 'approve-one', fixture: 'edge-minimal', title: 'Conference ticket for 690 EUR?' },
  { template: 'preview-post', fixture: 'edge-no-image', title: 'Sourdough class post: approve the text' },
  { template: 'review-doc', fixture: 'edge-max', title: "Season report 2026 for the members' meeting" },
];

/* fictional bots in the reference's order of shapes and colours, each with
   the kind of report it would send */
const STRIP = [
    { name: 'Ops Agent', shape: 'squircle', color: 'blue', ...REPORTS[1] },
    { name: 'Desk Agent', shape: 'blob', color: 'black', ...REPORTS[0] },
    { name: 'Social Agent', shape: 'blob', color: 'orange', ...REPORTS[2] },
    { name: 'Garden Club Agent', shape: 'pebble', color: 'yellow', ...REPORTS[3] },
    { name: 'Team Agent', shape: 'blob', color: 'orange', ...REPORTS[4] },
    { name: 'Access Agent', shape: 'teardrop', color: 'yellow', ...REPORTS[5] },
    { name: 'Facilities Agent', shape: 'hex', color: 'gray', ...REPORTS[6] },
    { name: 'People Agent', shape: 'blob', color: 'yellow', ...REPORTS[7] },
];
const HEADERS = [
  { template: 'decide-list', title: '5 requests waiting for you', bot: 'example-inbox-bot', identity: { name: 'Inbox Agent', avatar_shape: 'blob', avatar_color: 'orange' } },
  { template: 'approve-one', title: 'Deploy web shop v2.4.0 to production?', bot: 'example-ops-bot', identity: { name: 'Ops Agent', avatar_shape: 'squircle', avatar_color: 'blue' } },
  { template: 'review-doc', title: 'Spring opening announcement: review the draft', bot: 'example-garden-bot', identity: { name: 'Garden Club Agent', avatar_shape: 'teardrop', avatar_color: 'yellow' } },
];

const chromium = await loadChromium();
if (!chromium) throw new Error('playwright-core not found (set RS_PLAYWRIGHT_CORE)');
const server = await startServer({ port, mediaRoots: [ROOT], env: { RS_LANG: 'en' } });
// launched inside try: a failed launch still stops the server
let browser;
const written = [];

async function open(runId, theme, { width = 1280, height = 720, scale = 1 } = {}) {
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

/* every run but `keep` read, so only one unread dot shows (as in a real day) */
async function markRead(page, ids) {
  await page.evaluate(async (list) => {
    const boot = JSON.parse(document.getElementById('rs-boot').textContent);
    for (const id of list) {
      await fetch('/read', { method: 'POST', headers: { 'X-RS-CSRF': boot.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: id }) });
    }
  }, ids);
}

async function settle(page) {
  await page.mouse.move(2, 715);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(250);
}

async function shoot(page, name, clip) {
  const file = path.join(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  written.push(file);
  return file;
}

try {
  browser = await chromium.launch({ channel: browserChannel(), headless: true });
  // ------------------------------------------------------ contact sheet --
  await server.clearRuns();
  const base = server.show(fixture('_starter'), { title: 'Contact sheet', bot: 'example-sheet-bot', identity: { name: 'Sheet Agent' } });
  for (const theme of ['light', 'dark']) {
    for (const scale of [1, 2]) {
      const { ctx, page, errors } = await open(base.run_id, theme, { width: 1560, height: 600, scale });
      await page.evaluate(({ set }) => {
        const boot = JSON.parse(document.getElementById('rs-boot').textContent);
        const table = boot.avatar_shapes;
        if (JSON.stringify(table) !== JSON.stringify(set)) throw new Error('boot shape set differs from the core file');
        const ns = 'http://www.w3.org/2000/svg';
        const avatar = (shape, color, size) => {
          const box = document.createElement('span');
          box.className = 'rs-avatar';
          box.setAttribute('data-rs-avatar', '');
          box.style.width = box.style.height = `${size}px`;
          if (!shape) {
            box.setAttribute('data-initials', color);
            return box;
          }
          box.setAttribute('data-shape', shape);
          box.setAttribute('data-color', color);
          const svg = document.createElementNS(ns, 'svg');
          svg.setAttribute('viewBox', table.view_box);
          svg.setAttribute('data-rs-shape', shape);
          const p = document.createElementNS(ns, 'path');
          p.setAttribute('fill-rule', table.fill_rule);
          p.setAttribute('d', table.shapes[shape]);
          svg.appendChild(p);
          box.appendChild(svg);
          return box;
        };
        const sheet = document.createElement('div');
        sheet.style.cssText = 'position:fixed;inset:0;z-index:99;overflow:hidden;padding:16px 20px;background:var(--rs-paper);color:var(--rs-ink);font:13px/1.3 var(--rs-font)';
        const grid = document.createElement('div');
        const colors = [...table.colors, 'default'];
        grid.style.cssText = `display:grid;grid-template-columns:72px repeat(${colors.length}, 1fr);gap:6px 4px;align-items:center;justify-items:center`;
        const label = (text) => { const s = document.createElement('span'); s.textContent = text; s.style.color = 'var(--rs-muted)'; return s; };
        grid.appendChild(label(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
        colors.forEach((c) => grid.appendChild(label(c)));
        for (const shape of Object.keys(table.shapes)) {
          grid.appendChild(label(shape));
          for (const c of colors) {
            const cell = document.createElement('span');
            cell.style.cssText = 'display:flex;gap:6px;align-items:center';
            cell.appendChild(avatar(shape, c, 24));
            cell.appendChild(avatar(shape, c, 32));
            cell.appendChild(avatar(shape, c, 52));
            grid.appendChild(cell);
          }
        }
        grid.appendChild(label('fallback'));
        for (const initials of ['IA', 'RA', 'OA', 'É', '4B']) {
          const cell = document.createElement('span');
          cell.style.cssText = 'display:flex;gap:6px;align-items:center';
          cell.appendChild(avatar(null, initials, 24));
          cell.appendChild(avatar(null, initials, 32));
          grid.appendChild(cell);
        }
        sheet.appendChild(grid);
        document.body.appendChild(sheet);
      }, { set: shapes });
      await settle(page);
      const height = await page.evaluate(() => document.body.lastElementChild.firstElementChild.getBoundingClientRect().bottom + 16);
      await shoot(page, `contact-sheet-${theme}@${scale}x.png`, { x: 0, y: 0, width: 1560, height: Math.ceil(height) });
      if (errors.length) console.error('sheet', theme, errors.join(' | '));
      await ctx.close();
    }
  }

  // ------------------------------------------------------ header shots --
  await server.clearRuns();
  const headerRuns = HEADERS.map((item, index) => server.show(fixture(item.template), {
    template: item.template, title: item.title, bot: item.bot, identity: item.identity,
    created: iso(Date.now() - (index + 1) * 300e3),
  }));
  for (const [index, item] of HEADERS.entries()) {
    for (const theme of ['light', 'dark']) {
      const { ctx, page, errors } = await open(headerRuns[index].run_id, theme);
      await markRead(page, headerRuns.map((run) => run.run_id));
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      await settle(page);
      await shoot(page, `header-${item.template}-${theme}-1280x720.png`);
      if (errors.length) console.error('header', item.template, theme, errors.join(' | '));
      await ctx.close();
    }
  }

  // --------------------------------------------------- strip + reference --
  await server.clearRuns();
  const stripRuns = STRIP.map((bot, index) => server.show(fixture(bot.template, bot.fixture), {
    template: bot.template, title: bot.title.slice(0, 80), bot: `example-strip-bot-${index + 1}`,
    identity: {
      name: bot.name,
      ...(bot.shape ? { avatar_shape: bot.shape } : {}),
      ...(bot.color ? { avatar_color: bot.color } : {}),
    },
    created: iso(Date.now() - (index + 1) * 60e3),   // newest first: the list order
  }));
  const order = await (async () => {
    const { ctx, page } = await open(stripRuns[0].run_id, 'dark');
    const ids = await page.$$eval('.rs-strip__run', (rows) => rows.map((row) => row.dataset.runId));
    await ctx.close();
    return ids;
  })();
  const first = order[0];
  const unread = order[Math.min(6, order.length - 1)];
  const stripFiles = {};
  for (const theme of ['light', 'dark']) {
    const { ctx, page, errors } = await open(first, theme, { width: 1280, height: 720 });
    await markRead(page, order.filter((id) => id !== unread));
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
    await settle(page);
    const strip = await page.evaluate(() => {
      const r = document.getElementById('rs-strip-nav').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await shoot(page, `strip-full-${theme}-1280x720.png`);
    stripFiles[theme] = await shoot(page, `strip-${theme}.png`, strip);
    if (errors.length) console.error('strip', theme, errors.join(' | '));
    await ctx.close();
  }
  if (reference) {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 660 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const data = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    await page.setContent(`<body style="margin:0;background:#000;display:flex;gap:16px;padding:20px;align-items:flex-start;font:12px system-ui;color:#999">
      <figure style="margin:0"><img src="${data(reference)}" style="display:block"><figcaption>reference (bot app)</figcaption></figure>
      <figure style="margin:0"><img src="${data(stripFiles.dark)}" style="display:block"><figcaption>report-shell strip (dark)</figcaption></figure></body>`);
    await page.waitForFunction(() => [...document.images].every((img) => img.complete));
    const size = await page.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
    await page.setViewportSize(size);
    await shoot(page, 'side-by-side-dark.png');
    await ctx.close();
  }
} finally {
  try { if (browser) await browser.close(); } finally { await server.stop(); }
}
writeFileSync(path.join(out, 'shots.txt'), written.join('\n') + '\n');
console.log(written.join('\n'));
