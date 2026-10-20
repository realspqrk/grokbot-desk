// Calm multi-bot bursts (served, headless browser). Several bots post
// reports in quick succession; the pop-up stays one calm window:
// - the report on screen is never replaced by an arrival (open = it stays);
//   an arrival becomes active only when nothing open is shown,
// - one polite, coalesced announcement per burst ("5 new reports from 2 bots"),
// - the inbox lists every open report in arrival order: arrivals append,
//   nothing jumps, not even for a bot whose clock runs early.
// Isolated server, temp RS_DATA_DIR, public fictional bots only.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT, PLAIN_REPORT } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';

const PORT = e2ePort('burst.e2e.test.mjs');
const RESTART_PORT = e2ePort('burst.e2e.test.mjs', 1);
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const fill = (key, params) => de[key].replace(/\{([a-z_]+)\}/g, (m, name) => String(params[name]));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

const INBOX = { bot: 'example-inbox-bot', identity: { name: 'Inbox Agent', avatar_shape: 'squircle', avatar_color: 'blue' } };
const SOCIAL = { bot: 'example-social-bot', identity: { name: 'Social Agent', avatar_shape: 'hex', avatar_color: 'green' } };
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const BURST_MS = 600;

describe('multi-bot burst (served, headless browser)', { skip }, () => {
  let server;
  let browser;

  before(async () => {
    server = await startServer({ port: PORT });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });
  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });
  beforeEach(async () => { if (server) await server.clearRuns(); });

  let clock = Date.now() - 3600000;
  const push = (who, title) => {
    clock += 1000;
    return server.show(PLAIN_REPORT, { bot: who.bot, identity: who.identity, title, created: isoAt(clock) });
  };

  async function open(query, opts = {}) {
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: opts.colorScheme || 'light', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    if (opts.clock) await page.clock.install();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      // every text ever put into the polite live region, in order
      window.__announced = [];
      new MutationObserver((list) => {
        list.forEach((m) => m.addedNodes.forEach((n) => {
          if (n.nodeType === 1 && n.parentElement && n.parentElement.id === 'rs-toasts') window.__announced.push(n.textContent);
        }));
      }).observe(document, { childList: true, subtree: true });
    });
    const burst = opts.burstMs === undefined ? BURST_MS : opts.burstMs;
    const burstQuery = burst == null ? '' : `&burst_ms=${burst}`;
    await page.goto(server.url(`?client=test${burstQuery}${query ? '&' + query : ''}`));
    await ready(page);
    return { ctx, page, errors };
  }
  const ready = (page) => server.ready(page);
  const activeIs = (page, id) => page.waitForFunction((x) => window.RS.activeRun === x
    && document.documentElement.dataset.rsReady === '1', id, { timeout: 8000 });
  const announced = (page) => page.evaluate(() => window.__announced.slice());
  const inbox = (page) => page.evaluate(() => ({
    shown: !document.getElementById('rs-inbox').hidden
      && document.getElementById('rs-inbox').getClientRects().length > 0,
    rows: [...document.querySelectorAll('#rs-inbox a[data-run-id]')].map((a) => ({
      run: a.dataset.runId,
      title: a.querySelector('.rs-inbox__title').textContent,
      bot: a.querySelector('.rs-inbox__bot').textContent,
      unread: !!a.querySelector('.rs-inbox__dot[data-new]'),
      current: a.getAttribute('aria-current'),
      tabIndex: a.tabIndex,
      keys: a.getAttribute('aria-keyshortcuts'),
    })),
  }));
  const rowsAre = (page, n) => page.waitForFunction((k) => document.querySelectorAll('#rs-inbox a[data-run-id]').length === k, n, { timeout: 8000 });

  test('a burst of 6 reports from 2 bots: the shown report stays, one announcement, the inbox in arrival order', async () => {
    const first = push(INBOX, 'Inbox 1');
    const { ctx, page, errors } = await open(`run=${first.run_id}`, { clock: true });
    try {
      await activeIs(page, first.run_id);
      /* the page's clock stands still while the five pushes land: each push
         starts a CLI process, and on a slow runner two of them can be further
         apart than the shortened quiet gap, which would split the burst */
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      // untouched on purpose: in 1.0.0-beta.1 an untouched report was replaced
      const rest = [
        push(SOCIAL, 'Social 1'), push(INBOX, 'Inbox 2'), push(SOCIAL, 'Social 2'),
        push(INBOX, 'Inbox 3'), push(SOCIAL, 'Social 3'),
      ];
      await rowsAre(page, 6);
      await page.clock.resume();
      await page.waitForFunction(() => window.__announced.length > 0, null, { timeout: 8000 });
      await page.waitForTimeout(BURST_MS * 2);
      assert.equal(await page.evaluate(() => window.RS.activeRun), first.run_id, 'never yanked away');
      assert.equal(await page.textContent('#rs-title'), 'Inbox 1');
      assert.deepEqual(await announced(page), [fill('burst_arrived', { n: 5, k: 2 })], 'one coalesced announcement');
      assert.equal(await page.getAttribute('#rs-toasts', 'aria-live'), 'polite');

      const s = await inbox(page);
      assert.equal(s.shown, true);
      assert.deepEqual(s.rows.map((r) => r.run), [first.run_id, ...rest.map((r) => r.run_id)], 'one row per report, arrival order');
      assert.deepEqual(s.rows.map((r) => r.bot), ['Inbox Agent', 'Social Agent', 'Inbox Agent', 'Social Agent', 'Inbox Agent', 'Social Agent']);
      assert.deepEqual(s.rows.map((r) => r.current), ['page', null, null, null, null, null]);
      assert.deepEqual(s.rows.map((r) => r.unread), [false, true, true, true, true, true]);
      assert.deepEqual(s.rows.map((r) => r.tabIndex), [0, -1, -1, -1, -1, -1], 'one Tab stop');
      assert.deepEqual(s.rows.map((r) => r.keys), [1, 2, 3, 4, 5, 6].map((n) => `Control+${n} Meta+${n}`));

      // another report: the order stays, the dot goes
      await page.click(`#rs-inbox a[data-run-id="${rest[2].run_id}"]`);
      await activeIs(page, rest[2].run_id);
      await page.waitForFunction((id) => !document.querySelector(`#rs-inbox a[data-run-id="${id}"] .rs-inbox__dot[data-new]`), rest[2].run_id);
      const after = await inbox(page);
      assert.deepEqual(after.rows.map((r) => r.run), s.rows.map((r) => r.run), 'nothing jumps');
      assert.deepEqual(after.rows.map((r) => r.current), [null, null, null, 'page', null, null]);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('a touched report is kept too, and a later burst is announced once again', async () => {
    const first = push(INBOX, 'Inbox A');
    const { ctx, page } = await open(`run=${first.run_id}`);
    try {
      await page.click('[data-rs-note-open]');
      await page.keyboard.type('noch offen');
      const one = push(SOCIAL, 'Social A');
      await page.waitForFunction(() => window.__announced.length === 1, null, { timeout: 8000 });
      assert.deepEqual(await announced(page), [fill('new_run_arrived', { title: 'Social A' })], 'a single arrival names its report');
      await page.waitForTimeout(BURST_MS * 2);
      const two = push(SOCIAL, 'Social B');
      const three = push(SOCIAL, 'Social C');
      await page.waitForFunction(() => window.__announced.length === 2, null, { timeout: 8000 });
      await page.waitForTimeout(BURST_MS * 2);
      assert.deepEqual((await announced(page)).slice(1), [fill('burst_arrived_bot', { n: 2, bot: 'Social Agent' })]);
      assert.equal(await page.evaluate(() => window.RS.activeRun), first.run_id);
      assert.equal(await page.inputValue('#rs-note'), 'noch offen');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note', 'typing keeps its focus');
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((r) => r.run), [first.run_id, one.run_id, two.run_id, three.run_id]);
    } finally { await ctx.close(); }
  });

  test('nothing open shown: the oldest arrival becomes active, the rest wait, one announcement', async () => {
    const { ctx, page } = await open('', { clock: true });
    try {
      assert.equal(await page.evaluate(() => window.RS.activeRun), null);
      /* as in the six-report burst: the page's clock stands still while the
         three pushes land, so a slow runner cannot space them further apart
         than the quiet gap and split the one announcement */
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      const a = push(SOCIAL, 'Social X');
      const b = push(INBOX, 'Inbox X');
      const c = push(SOCIAL, 'Social Y');
      await rowsAre(page, 3);
      await page.clock.resume();
      await activeIs(page, a.run_id);
      await page.waitForFunction(() => window.__announced.length > 0, null, { timeout: 8000 });
      await page.waitForTimeout(BURST_MS * 2);
      assert.equal(await page.evaluate(() => window.RS.activeRun), a.run_id, 'the first arrival stays');
      assert.deepEqual(await announced(page), [fill('burst_arrived', { n: 3, k: 2 })]);
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((r) => r.run), [a.run_id, b.run_id, c.run_id]);
    } finally { await ctx.close(); }
  });

  test('a single arrival into an empty window is shown and needs no announcement', async () => {
    const { ctx, page } = await open('');
    try {
      const a = push(INBOX, 'Inbox only');
      await activeIs(page, a.run_id);
      await page.waitForTimeout(BURST_MS * 2);
      assert.deepEqual(await announced(page), []);
      assert.equal((await inbox(page)).shown, false, 'one open report: no inbox');
    } finally { await ctx.close(); }
  });

  test('bot ids that collide with object properties render on load and on a later arrival', async () => {
    const ctor = { bot: 'constructor', identity: { name: 'Constructor Bot', avatar_shape: 'squircle', avatar_color: 'blue' } };
    const own = { bot: 'hasownproperty', identity: { name: 'Own Bot', avatar_shape: 'hex', avatar_color: 'green' } };
    const first = server.show(PLAIN_REPORT, { ...ctor, title: 'Ctor report' });
    const { ctx, page, errors } = await open(`run=${first.run_id}`);
    try {
      await activeIs(page, first.run_id);
      assert.equal(await page.textContent('#rs-title'), 'Ctor report');
      const second = server.show(PLAIN_REPORT, { ...own, title: 'Own report' });
      await rowsAre(page, 2);
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((r) => [r.run, r.bot]), [[first.run_id, 'Constructor Bot'], [second.run_id, 'Own Bot']]);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
    const both = server.show(PLAIN_REPORT, { ...ctor, title: 'Ctor again' });
    const later = server.show(PLAIN_REPORT, { ...own, title: 'Own again' });
    const cold = await open(`run=${both.run_id}`);
    try {
      await rowsAre(cold.page, 2);
      const s = await inbox(cold.page);
      assert.deepEqual(s.rows.map((r) => r.run), [both.run_id, later.run_id]);
      assert.deepEqual(cold.errors, []);
    } finally { await cold.ctx.close(); }
  });

  test('production burst gap: six reports from two bots spaced 1.7s are one announcement', async () => {
    const first = push(INBOX, 'Inbox 1');
    const { ctx, page } = await open(`run=${first.run_id}`, { burstMs: null });
    try {
      await activeIs(page, first.run_id);
      const who = [SOCIAL, INBOX, SOCIAL, INBOX, SOCIAL];
      const titles = ['Social 1', 'Inbox 2', 'Social 2', 'Inbox 3', 'Social 3'];
      for (let i = 0; i < titles.length; i++) {
        await page.waitForTimeout(1700);
        push(who[i], titles[i]);
      }
      await page.waitForFunction(() => window.__announced.length === 1, null, { timeout: 15000 });
      await page.waitForTimeout(2000);
      assert.deepEqual(await announced(page), [fill('burst_arrived', { n: 5, k: 2 })]);
      assert.equal(await page.evaluate(() => window.RS.activeRun), first.run_id);
      await rowsAre(page, 6);
    } finally { await ctx.close(); }
  });

  test('a reload keeps an older saved report ahead of later ones', async () => {
    const older = push(INBOX, 'Inbox older');
    const social = server.show(PLAIN_REPORT, {
      bot: SOCIAL.bot, identity: SOCIAL.identity, title: 'Social later',
      created: isoAt(Date.now() - 2 * 60 * 60 * 1000),
    });
    const newer = push(INBOX, 'Inbox newer');
    const dataDir = server.dataDir;
    const env = server.env;
    server.preserveData = true;
    await server.stop();
    const file = path.join(dataDir, 'runs', `${older.run_id}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    delete record.seq;
    writeFileSync(file, JSON.stringify(record));
    server = await startServer({ port: RESTART_PORT, dataDir, env });
    const { ctx, page } = await open(`run=${social.run_id}`);
    try {
      await activeIs(page, social.run_id);
      await rowsAre(page, 3);
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((r) => r.run), [older.run_id, social.run_id, newer.run_id]);
      const listed = await page.evaluate(async () => {
        const boot = JSON.parse(document.getElementById('rs-boot').textContent);
        const res = await fetch('/api/runs', { headers: { 'X-RS-CSRF': boot.csrf } });
        return (await res.json()).runs.map((r) => ({ title: r.title, seq: r.seq }));
      });
      const byTitle = Object.fromEntries(listed.map((r) => [r.title, r]));
      assert.equal(typeof byTitle['Inbox older'].seq, 'number');
      assert.ok(byTitle['Inbox older'].seq < byTitle['Social later'].seq);
      assert.ok(byTitle['Social later'].seq < byTitle['Inbox newer'].seq);
    } finally { await ctx.close(); }
  });

  test('cold start orders reports by registration seq, not a skewed created stamp', async () => {
    const first = server.show(PLAIN_REPORT, {
      bot: INBOX.bot, identity: INBOX.identity, title: 'First arrival',
      created: isoAt(Date.now() - 30000),
    });
    const skewed = server.show(PLAIN_REPORT, {
      bot: SOCIAL.bot, identity: SOCIAL.identity, title: 'Skewed earlier',
      created: isoAt(Date.now() - 120000),
    });
    const { ctx, page } = await open(`run=${first.run_id}`);
    try {
      await activeIs(page, first.run_id);
      await rowsAre(page, 2);
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((r) => r.run), [first.run_id, skewed.run_id]);
    } finally { await ctx.close(); }
  });

  test('bot clock skew: an arrival created "earlier" still appends, nothing jumps', async () => {
    const first = push(INBOX, 'Inbox late');
    const { ctx, page } = await open(`run=${first.run_id}`);
    try {
      const early = server.show(PLAIN_REPORT, { bot: SOCIAL.bot, identity: SOCIAL.identity, title: 'Skewed', created: isoAt(clock - 600000) });
      await rowsAre(page, 2);
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((r) => r.run), [first.run_id, early.run_id]);
    } finally { await ctx.close(); }
  });
});
