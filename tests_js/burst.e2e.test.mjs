// Calm multi-bot bursts (served, headless browser). Several bots post
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
import { readFileSync, writeFileSync } from 'node:fs';
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
    return server.show(golden, { bot: who.bot, identity: who.identity, title, created: isoAt(clock) });
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
      await stripCountIs(page, fill('strip_count', { n: 1, m: 6 }));
      await page.clock.resume();
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
      assert.equal(s.groups[0].label, `${fill('strip_cycle', { bot: 'Inbox Agent', n: 3 })} ${de.sep} ${de.new}`);
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
      await stripCountIs(page, fill('strip_count', { n: 1, m: 3 }));
      await page.clock.resume();
      await activeIs(page, a.run_id);
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

  test('bot ids that collide with object properties render on load and on a later arrival', async () => {
    const first = server.show(golden, {
      bot: 'constructor',
      identity: { name: 'Constructor Bot', avatar_shape: 'squircle', avatar_color: 'blue' },
      title: 'Ctor report',
    });
    const { ctx, page, errors } = await open(`run=${first.run_id}`);
    try {
      await activeIs(page, first.run_id);
      assert.equal(await page.textContent('#rs-title'), 'Ctor report');
      assert.equal(await page.evaluate(() => document.body.innerText.length > 0), true);
      const second = server.show(golden, {
        bot: 'hasownproperty',
        identity: { name: 'Own Bot', avatar_shape: 'hex', avatar_color: 'green' },
        title: 'Own report',
      });
      await groupsAre(page, 2);
      const s = await strip(page);
      assert.deepEqual(s.groups.map((g) => g.bot), ['constructor', 'hasownproperty']);
      assert.equal(s.groups[1].run, second.run_id);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
    const both = server.show(golden, {
      bot: 'constructor',
      identity: { name: 'Constructor Bot', avatar_shape: 'squircle', avatar_color: 'blue' },
      title: 'Ctor again',
    });
    const own = server.show(golden, {
      bot: 'hasownproperty',
      identity: { name: 'Own Bot', avatar_shape: 'hex', avatar_color: 'green' },
      title: 'Own again',
    });
    const cold = await open(`run=${both.run_id}`);
    try {
      await cold.page.waitForFunction(() => document.querySelectorAll('#rs-strip .rs-strip__run').length === 2, null, { timeout: 8000 });
      const s = await strip(cold.page);
      assert.deepEqual(s.groups.map((g) => g.bot), ['constructor', 'hasownproperty']);
      assert.equal(s.groups[1].run, own.run_id);
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
      await stripCountIs(page, fill('strip_count', { n: 1, m: 6 }));
    } finally { await ctx.close(); }
  });

  async function six() {
    const first = push(INBOX, 'Inbox 1');
    const rest = [
      push(SOCIAL, 'Social 1'), push(INBOX, 'Inbox 2'), push(SOCIAL, 'Social 2'),
      push(INBOX, 'Inbox 3'), push(SOCIAL, 'Social 3'),
    ];
    return { first, rest };
  }

  async function choose(page) {
    await page.click('rs-action-row button[value="erledigt"]');
    await page.click('#rs-submit');
  }

  async function discard(page) {
    await page.click('#rs-more-btn'); await page.click('#rs-discard');
    await page.click('#rs-discard-dialog button[value="discard"]');
  }

  test('deciding the last or a middle report stays inside that bot', async () => {
    const { first, rest } = await six();
    const social = [rest[0].run_id, rest[2].run_id, rest[4].run_id];
    const { ctx, page } = await open(`run=${first.run_id}`);
    try {
      await activeIs(page, first.run_id);
      await page.keyboard.press('Control+2');
      await activeIs(page, social[0]);
      await page.keyboard.press('Control+2');
      await activeIs(page, social[1]);
      await choose(page);
      await activeIs(page, social[2]);
      await choose(page);
      await activeIs(page, social[0]);
    } finally { await ctx.close(); }
    await server.clearRuns();

    const again = await six();
    const social2 = [again.rest[0].run_id, again.rest[2].run_id, again.rest[4].run_id];
    const discarded = await open(`run=${again.first.run_id}`);
    try {
      await activeIs(discarded.page, again.first.run_id);
      await discarded.page.keyboard.press('Control+2');
      await activeIs(discarded.page, social2[0]);
      await discarded.page.keyboard.press('Control+2');
      await activeIs(discarded.page, social2[1]);
      await discard(discarded.page);
      await activeIs(discarded.page, social2[2]);
      await discard(discarded.page);
      await activeIs(discarded.page, social2[0]);
    } finally { await discarded.ctx.close(); }
  });

  test('a reload keeps an older saved report ahead of later ones', async () => {
    const older = push(INBOX, 'Inbox older');
    const social = server.show(golden, {
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
    server = await startServer({ port: PORT + 30, dataDir, env });
    const { ctx, page } = await open(`run=${social.run_id}`);
    try {
      await activeIs(page, social.run_id);
      await groupsAre(page, 2);
      const s = await strip(page);
      assert.deepEqual(s.groups.map((g) => g.bot), [INBOX.bot, SOCIAL.bot]);
      assert.equal(s.groups[0].run, older.run_id);
      const listed = await page.evaluate(async () => {
        const boot = JSON.parse(document.getElementById('rs-boot').textContent);
        const res = await fetch('/api/runs', { headers: { 'X-RS-CSRF': boot.csrf } });
        return (await res.json()).runs.map((r) => ({ title: r.title, seq: r.seq }));
      });
      const byTitle = Object.fromEntries(listed.map((r) => [r.title, r]));
      assert.equal(typeof byTitle['Inbox older'].seq, 'number');
      assert.ok(byTitle['Inbox older'].seq < byTitle['Social later'].seq);
      assert.ok(byTitle['Social later'].seq < byTitle['Inbox newer'].seq);
      await page.click(`#rs-strip .rs-strip__run[data-bot="${INBOX.bot}"]`);
      await activeIs(page, older.run_id);
      await page.click(`#rs-strip .rs-strip__run[data-bot="${INBOX.bot}"]`);
      await activeIs(page, newer.run_id);
    } finally { await ctx.close(); }
    assert.ok(social.run_id && newer.run_id);
  });

  test('cold start orders bots by registration seq, not a skewed created stamp', async () => {
    const inbox = server.show(golden, {
      bot: INBOX.bot, identity: INBOX.identity, title: 'First arrival',
      created: isoAt(Date.now() - 30000),
    });
    const social = server.show(golden, {
      bot: SOCIAL.bot, identity: SOCIAL.identity, title: 'Skewed earlier',
      created: isoAt(Date.now() - 120000),
    });
    const { ctx, page } = await open(`run=${inbox.run_id}`);
    try {
      await activeIs(page, inbox.run_id);
      await groupsAre(page, 2);
      const s = await strip(page);
      assert.deepEqual(s.groups.map((g) => g.bot), [INBOX.bot, SOCIAL.bot]);
      assert.deepEqual(s.groups.map((g) => g.run), [inbox.run_id, social.run_id]);
      assert.equal(s.count, fill('strip_count', { n: 1, m: 2 }));
      const listed = await page.evaluate(async () => {
        const boot = JSON.parse(document.getElementById('rs-boot').textContent);
        const res = await fetch('/api/runs', { headers: { 'X-RS-CSRF': boot.csrf } });
        return (await res.json()).runs.map((r) => ({ title: r.title, seq: r.seq, bot: r.bot }));
      });
      const byTitle = Object.fromEntries(listed.map((r) => [r.title, r]));
      assert.equal(byTitle['First arrival'].seq < byTitle['Skewed earlier'].seq, true);
    } finally { await ctx.close(); }
    assert.ok(social.run_id);
  });

  test('strip badge sits beside the avatar for 1, 3, 12 and 123', async () => {
    const first = push(INBOX, 'Inbox 1');
    push(INBOX, 'Inbox 2');
    push(INBOX, 'Inbox 3');
    push(SOCIAL, 'Social 1');
    const { ctx, page } = await open(`run=${first.run_id}`);
    try {
      await groupsAre(page, 2);
      const measure = () => page.evaluate(() => {
        const button = document.querySelector('#rs-strip .rs-strip__run[aria-current]');
        const avatar = button.querySelector('.rs-avatar');
        const badge = button.querySelector('.rs-strip__badge');
        const dot = button.querySelector('.rs-strip__dot');
        const underline = getComputedStyle(button, '::after');
        const avatarBox = avatar.getBoundingClientRect();
        const badgeBox = badge.getBoundingClientRect();
        const dotBox = dot.getBoundingClientRect();
        return {
          gap: Math.round(badgeBox.left - avatarBox.right),
          badgeTop: Math.round(badgeBox.top),
          avatarTop: Math.round(avatarBox.top),
          overlap: badgeBox.left < avatarBox.right - 1,
          dotCenter: Math.round(dotBox.left + dotBox.width / 2),
          avatarRight: Math.round(avatarBox.right),
          underline: Math.round(parseFloat(underline.width)),
          cursor: getComputedStyle(button).cursor,
          badgeText: badge.textContent,
        };
      });
      const check = async (label) => {
        const box = await measure();
        assert.equal(box.overlap, false, label);
        assert.ok(box.gap >= 2, `${label} gap ${box.gap}`);
        assert.equal(box.dotCenter, box.avatarRight, label);
        assert.equal(box.underline, 32, label);
        assert.equal(box.cursor, 'pointer', label);
      };
      for (const theme of ['light', 'dark']) {
        await page.evaluate((name) => document.documentElement.setAttribute('data-theme', name), theme);
        for (const count of ['1', '3', '12', '123']) {
          await page.evaluate((text) => {
            document.querySelector('#rs-strip .rs-strip__run[aria-current] .rs-strip__badge').textContent = text;
          }, count);
          await check(`${theme} ${count}`);
        }
      }
      await page.setViewportSize({ width: 360, height: 700 });
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        document.querySelector('#rs-strip .rs-strip__run[aria-current] .rs-strip__badge').textContent = '123';
      });
      await check('narrow 123');
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
