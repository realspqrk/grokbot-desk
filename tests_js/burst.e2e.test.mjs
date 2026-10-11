// Slice C: calm multi-bot bursts (served, headless browser). Several bots post
// reports in quick succession; the pop-up stays one calm window:
// - the report on screen is never replaced by an arrival (open = it stays);
//   an arrival becomes active only when nothing open is shown,
// - one polite, coalesced announcement per burst ("5 new reports from 2 bots"),
// - the strip groups open reports by bot (one avatar per bot, a count badge
//   when it has more than one), in arrival order: arrivals append, nothing
//   jumps; "n of m open" counts reports,
// - a group goes to that bot's oldest open report; activating the current
//   group again steps through that bot's reports; Left/Right, Home/End and
//   Ctrl+1..9 work on groups.
// Isolated server, temp RS_DATA_DIR, public fictional bots only.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 14;
if (PORT === 18742) throw new Error('refusing the product port');
const STARTER = path.join(ROOT, 'templates/builtin/_starter');
const golden = JSON.parse(readFileSync(path.join(STARTER, 'fixtures/golden.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const fill = (key, params) => de[key].replace(/\{([a-z_]+)\}/g, (m, name) => String(params[name]));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

const INBOX = { bot: 'example-inbox-bot', identity: { name: 'Inbox Agent', avatar_shape: 'squircle', avatar_color: 'blue' } };
const SOCIAL = { bot: 'example-social-bot', identity: { name: 'Social Agent', avatar_shape: 'hex', avatar_color: 'green' } };
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const BURST_MS = 600;

describe('slice C: multi-bot burst (served, headless browser)', { skip }, () => {
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
    return server.show(golden, { bot: who.bot, identity: who.identity, title, created: isoAt(clock) });
  };

  async function open(query) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
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
    await page.goto(server.url(`?client=test&burst_ms=${BURST_MS}${query ? '&' + query : ''}`));
    await ready(page);
    return { ctx, page, errors };
  }
  const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
  const activeIs = (page, id) => page.waitForFunction((x) => window.RS.activeRun === x
    && document.documentElement.dataset.rsReady === '1', id, { timeout: 8000 });
  const announced = (page) => page.evaluate(() => window.__announced.slice());
  const strip = (page) => page.evaluate(() => ({
    count: document.getElementById('rs-strip-count').textContent,
    shown: document.getElementById('rs-strip-nav').getClientRects().length > 0,
    groups: [...document.querySelectorAll('#rs-strip .rs-strip__run')].map((b) => ({
      bot: b.dataset.bot,
      run: b.dataset.runId,
      label: b.getAttribute('aria-label'),
      badge: b.querySelector('.rs-strip__badge')?.textContent || null,
      current: b.getAttribute('aria-current'),
      tabIndex: b.tabIndex,
      keys: b.getAttribute('aria-keyshortcuts'),
    })),
  }));
  const groupsAre = (page, n) => page.waitForFunction((k) => document.querySelectorAll('#rs-strip .rs-strip__run').length === k, n, { timeout: 8000 });
  const stripCountIs = (page, text) => page.waitForFunction((x) => document.getElementById('rs-strip-count').textContent === x, text, { timeout: 8000 });

  test('a burst of 6 reports from 2 bots: the shown report stays, one announcement, grouped strip', async () => {
    const first = push(INBOX, 'Inbox 1');
    const { ctx, page, errors } = await open(`run=${first.run_id}`);
    try {
      await activeIs(page, first.run_id);
      // untouched on purpose: before slice C an untouched report was replaced
      const rest = [
        push(SOCIAL, 'Social 1'), push(INBOX, 'Inbox 2'), push(SOCIAL, 'Social 2'),
        push(INBOX, 'Inbox 3'), push(SOCIAL, 'Social 3'),
      ];
      await stripCountIs(page, fill('strip_count', { n: 1, m: 6 }));
      await page.waitForFunction(() => window.__announced.length > 0, null, { timeout: 8000 });
      await page.waitForTimeout(BURST_MS * 2);
      assert.equal(await page.evaluate(() => window.RS.activeRun), first.run_id, 'never yanked away');
      assert.equal(await page.textContent('#rs-title'), 'Inbox 1');
      assert.deepEqual(await announced(page), [fill('burst_arrived', { n: 5, k: 2 })], 'one coalesced announcement');
      assert.equal(await page.getAttribute('#rs-toasts', 'aria-live'), 'polite');

      const s = await strip(page);
      assert.equal(s.shown, true);
      assert.deepEqual(s.groups.map((g) => g.bot), [INBOX.bot, SOCIAL.bot], 'one avatar per bot, arrival order');
      assert.deepEqual(s.groups.map((g) => g.badge), ['3', '3']);
      assert.deepEqual(s.groups.map((g) => g.current), ['page', null]);
      assert.deepEqual(s.groups.map((g) => g.tabIndex), [0, -1]);
      assert.deepEqual(s.groups.map((g) => g.keys), ['Control+1', 'Control+2']);
      // the active bot's own group still says "new": two of its reports wait unread
      assert.equal(s.groups[0].label, `${fill('strip_group', { bot: 'Inbox Agent', n: 3 })} ${de.sep} ${de.new}`);
      assert.equal(s.groups[1].label, `${fill('strip_group', { bot: 'Social Agent', n: 3 })} ${de.sep} ${de.new}`);
      assert.equal(s.groups[1].run, rest[0].run_id, 'a group goes to its bot\'s oldest open report');

      // the group of another bot: its oldest open report; n of m counts reports
      await page.click(`#rs-strip .rs-strip__run[data-bot="${SOCIAL.bot}"]`);
      await activeIs(page, rest[0].run_id);
      assert.equal((await strip(page)).count, fill('strip_count', { n: 4, m: 6 }));
      // the current group again: that bot's next report
      await page.click(`#rs-strip .rs-strip__run[data-bot="${SOCIAL.bot}"]`);
      await activeIs(page, rest[2].run_id);
      assert.equal((await strip(page)).count, fill('strip_count', { n: 5, m: 6 }));
      // keyboard on the strip: Left goes to the other group, Ctrl+2 back
      await page.focus(`#rs-strip .rs-strip__run[data-bot="${SOCIAL.bot}"]`);
      await page.keyboard.press('ArrowLeft');
      await activeIs(page, first.run_id);
      await page.keyboard.press('Control+2');
      await activeIs(page, rest[0].run_id);
      // a decision moves on within the bot first, the order never jumps
      await page.click('rs-action-row button[value="erledigt"]');
      await page.click('#rs-submit');
      await activeIs(page, rest[2].run_id);
      await stripCountIs(page, fill('strip_count', { n: 4, m: 5 }));
      const after = await strip(page);
      assert.deepEqual(after.groups.map((g) => [g.bot, g.badge]), [[INBOX.bot, '3'], [SOCIAL.bot, '2']]);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('a touched report is kept too, and a later burst is announced once again', async () => {
    const first = push(INBOX, 'Inbox A');
    const { ctx, page } = await open(`run=${first.run_id}`);
    try {
      await page.click('rs-action-row button[value="erledigt"]');
      const one = push(SOCIAL, 'Social A');
      await page.waitForFunction(() => window.__announced.length === 1, null, { timeout: 8000 });
      assert.deepEqual(await announced(page), [fill('new_run_arrived', { title: 'Social A' })], 'a single arrival names its report');
      await page.waitForTimeout(BURST_MS * 2);
      push(SOCIAL, 'Social B');
      push(SOCIAL, 'Social C');
      await page.waitForFunction(() => window.__announced.length === 2, null, { timeout: 8000 });
      await page.waitForTimeout(BURST_MS * 2);
      assert.deepEqual((await announced(page)).slice(1), [fill('burst_arrived_bot', { n: 2, bot: 'Social Agent' })]);
      assert.equal(await page.evaluate(() => window.RS.activeRun), first.run_id);
      const s = await strip(page);
      assert.deepEqual(s.groups.map((g) => [g.bot, g.badge, g.run]), [[INBOX.bot, null, first.run_id], [SOCIAL.bot, '3', one.run_id]]);
      assert.equal(s.groups[0].label, fill('strip_item', { bot: 'Inbox Agent', title: 'Inbox A' }));
    } finally { await ctx.close(); }
  });

  test('nothing open shown: the oldest arrival becomes active, the rest wait, one announcement', async () => {
    const { ctx, page } = await open('');
    try {
      assert.equal(await page.evaluate(() => window.RS.activeRun), null);
      const a = push(SOCIAL, 'Social X');
      const b = push(INBOX, 'Inbox X');
      const c = push(SOCIAL, 'Social Y');
      await activeIs(page, a.run_id);
      await stripCountIs(page, fill('strip_count', { n: 1, m: 3 }));
      await page.waitForFunction(() => window.__announced.length > 0, null, { timeout: 8000 });
      await page.waitForTimeout(BURST_MS * 2);
      assert.equal(await page.evaluate(() => window.RS.activeRun), a.run_id, 'the first arrival stays');
      assert.deepEqual(await announced(page), [fill('burst_arrived', { n: 3, k: 2 })]);
      const s = await strip(page);
      assert.deepEqual(s.groups.map((g) => [g.bot, g.badge]), [[SOCIAL.bot, '2'], [INBOX.bot, null]]);
      assert.equal(s.groups[1].run, b.run_id);
      assert.ok(c.run_id);
    } finally { await ctx.close(); }
  });

  test('a single arrival into an empty window is shown and needs no announcement', async () => {
    const { ctx, page } = await open('');
    try {
      const a = push(INBOX, 'Inbox only');
      await activeIs(page, a.run_id);
      await page.waitForTimeout(BURST_MS * 2);
      assert.deepEqual(await announced(page), []);
      assert.equal((await strip(page)).shown, false, 'one open report: no strip');
    } finally { await ctx.close(); }
  });

  test('bot clock skew: an arrival created "earlier" still appends, nothing jumps', async () => {
    const first = push(INBOX, 'Inbox late');
    const { ctx, page } = await open(`run=${first.run_id}`);
    try {
      const early = server.show(golden, { bot: SOCIAL.bot, identity: SOCIAL.identity, title: 'Skewed', created: isoAt(clock - 600000) });
      await groupsAre(page, 2);
      const s = await strip(page);
      assert.deepEqual(s.groups.map((g) => g.run), [first.run_id, early.run_id]);
      assert.equal(s.count, fill('strip_count', { n: 1, m: 2 }));
    } finally { await ctx.close(); }
  });
});
