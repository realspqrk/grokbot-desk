// P8d pop-up layout (served, headless Edge): one open report is a compact
// pop-up with no strip; two or more show a slim avatar strip at the top
// ("n of m open"), the active one underlined. A decision advances to the next
// open report; after the last one a calm done state shows and the window
// closes (test clients only with ?autoclose=1). Keyboard: Left/Right on the
// strip (roving tabindex), Ctrl+1..9 anywhere; arrows in text stay text.
// Isolated server, temp RS_DATA_DIR, public fictional bots only.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 13;
if (PORT === 18742) throw new Error('refusing the product port');
const STARTER = path.join(ROOT, 'templates/builtin/_starter');
const golden = JSON.parse(readFileSync(path.join(STARTER, 'fixtures/golden.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const fill = (key, params) => de[key].replace(/\{([a-z_]+)\}/g, (m, name) => String(params[name]));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

// three fictional backup bots, each with its own shape avatar
const BOTS = [
  { bot: 'example-backup-bot', identity: { name: 'Backup Agent', avatar_shape: 'squircle', avatar_color: 'blue' }, title: 'Nachtsicherung Server prüfen' },
  { bot: 'example-nas-bot', identity: { name: 'NAS Agent', avatar_shape: 'blob', avatar_color: 'orange' }, title: 'Sicherung Büro-NAS prüfen' },
  { bot: 'example-web-bot', identity: { name: 'Web Agent', avatar_shape: 'hex', avatar_color: 'green' }, title: 'Sicherung Webserver prüfen' },
];
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

describe('P8d pop-up: strip, auto-advance, done state, keyboard (served, headless Edge)', { skip }, () => {
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

  /** n open runs, newest first (= server and strip order). */
  function showRuns(n) {
    const now = Date.now();
    return BOTS.slice(0, n).map((b, i) => server.show(golden, {
      bot: b.bot, identity: b.identity, title: b.title, created: isoAt(now - i * 60000),
    }));
  }

  async function open(runId, extra = '', viewport = { width: 1280, height: 720 }) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url(`?client=test&run=${runId}${extra}`));
    await ready(page);
    return { ctx, page, errors };
  }
  const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
  const activeIs = (page, id) => page.waitForFunction((x) => window.RS.activeRun === x
    && document.documentElement.dataset.rsReady === '1', id, { timeout: 8000 });
  const strip = (page) => page.evaluate(() => {
    const nav = document.getElementById('rs-strip-nav');
    const visible = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const header = document.querySelector('.rs-header').getBoundingClientRect();
    return {
      shown: visible(nav),
      bottom: nav.getBoundingClientRect().bottom,
      headerTop: header.top,
      count: document.getElementById('rs-strip-count').textContent,
      focusable: [...nav.querySelectorAll('button')].filter((b) => visible(b) && b.tabIndex >= 0).length,
      items: [...nav.querySelectorAll('.rs-strip__run')].map((b) => {
        const under = getComputedStyle(b, '::after');
        return {
          id: b.dataset.runId,
          label: b.getAttribute('aria-label'),
          current: b.getAttribute('aria-current'),
          tabIndex: b.tabIndex,
          shape: b.querySelector('[data-rs-avatar]')?.getAttribute('data-shape') || null,
          avatarSize: b.querySelector('[data-rs-avatar]')?.getBoundingClientRect().width || 0,
          dot: !!b.querySelector('.rs-strip__dot'),
          underline: under.content !== 'none' && parseFloat(under.height) >= 2 && under.backgroundColor !== 'rgba(0, 0, 0, 0)',
          keys: b.getAttribute('aria-keyshortcuts'),
        };
      }),
    };
  });
  async function decide(page) {
    await page.click('rs-action-row button[value="erledigt"]');
    await page.click('#rs-submit');
  }
  /** Arms a pending window launch as the CLI does; returns its one-time app token. */
  function armLaunch() {
    const generation = randomBytes(16).toString('hex');
    writeFileSync(path.join(server.dataDir, 'browser-launch.pending'),
      JSON.stringify({ generation, deadline: Date.now() / 1000 + 5 }), 'ascii');
    return generation;
  }
  /** A test window opened by script (window.close() is allowed there). */
  async function openPopup(query) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const opener = await ctx.newPage();
    await opener.goto(server.url('?client=test'));
    const popup = ctx.waitForEvent('page');
    await opener.evaluate((url) => { window.open(url); }, server.url(query));
    const page = await popup;
    await ready(page);
    return { ctx, page };
  }

  test('1 open: compact pop-up without a strip; header = avatar, bold name, quiet report title', async () => {
    const [run] = showRuns(1);
    const { ctx, page, errors } = await open(run.run_id);
    try {
      const s = await strip(page);
      assert.equal(s.shown, false, 'no strip with exactly one open report');
      assert.equal(s.focusable, 0);
      assert.equal(await page.getAttribute('#rs-app', 'data-strip'), 'off');
      const head = await page.evaluate(() => {
        const name = document.getElementById('rs-bot-name');
        const title = document.getElementById('rs-title');
        const avatar = document.getElementById('rs-bot-avatar');
        const ink = getComputedStyle(document.documentElement).getPropertyValue('--rs-ink').trim();
        return {
          name: name.textContent,
          title: title.textContent,
          titleTag: title.tagName,
          nameWeight: Number(getComputedStyle(name).fontWeight),
          titleWeight: Number(getComputedStyle(title).fontWeight),
          nameColor: getComputedStyle(name).color,
          titleColor: getComputedStyle(title).color,
          ink,
          shape: avatar.getAttribute('data-shape'),
          avatarSize: avatar.getBoundingClientRect().width,
          order: avatar.getBoundingClientRect().right <= name.getBoundingClientRect().left
            && name.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 1,
          inHeader: !!title.closest('header') && !!name.closest('header'),
        };
      });
      assert.equal(head.name, 'Backup Agent');
      assert.equal(head.title, BOTS[0].title);
      assert.equal(head.titleTag, 'H1', 'the report title stays the page heading');
      assert.ok(head.nameWeight >= 600, 'bold name');
      assert.ok(head.titleWeight < 600, 'quiet title');
      assert.notEqual(head.titleColor, head.nameColor, 'the title line is quieter than the name');
      assert.equal(head.shape, 'squircle');
      assert.equal(head.avatarSize, 32);
      assert.ok(head.order, 'avatar left, name over title');
      assert.ok(head.inHeader);
      // the first Tab stop is the header's overflow button: nothing above it
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-more-btn');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('2 and 3 open: a slim avatar strip above the header with "n of m open", active underlined', async () => {
    const runs = showRuns(3);
    const { ctx, page, errors } = await open(runs[1].run_id);
    try {
      const s = await strip(page);
      assert.equal(s.shown, true);
      assert.ok(s.bottom <= s.headerTop + 0.5, 'strip sits above the header');
      assert.equal(s.count, fill('strip_count', { n: 2, m: 3 }));
      assert.deepEqual(s.items.map((x) => x.id), runs.map((r) => r.run_id), 'server order, newest first');
      s.items.forEach((item, i) => {
        // name and title; " · new" while a waiting report is still unread
        const base = fill('strip_item', { bot: BOTS[i].identity.name, title: BOTS[i].title });
        assert.ok([base, `${base} ${de.sep} ${de.new}`].includes(item.label), item.label);
        assert.equal(item.shape, BOTS[i].identity.avatar_shape);
        assert.equal(item.avatarSize, 32);
        assert.equal(item.dot, true, 'every open report shows its waiting dot');
        assert.equal(item.keys, 'Control+' + (i + 1));
      });
      assert.deepEqual(s.items.map((x) => x.current), [null, 'page', null]);
      assert.deepEqual(s.items.map((x) => x.underline), [false, true, false]);
      assert.deepEqual(s.items.map((x) => x.tabIndex), [-1, 0, -1], 'roving tabindex: one stop');
      assert.equal(s.focusable, 1);
      // decide one elsewhere: 2 open stay, the strip remains and counts again
      await server.clearRuns();
      const two = showRuns(2);
      await page.waitForFunction((n) => document.querySelectorAll('#rs-strip .rs-strip__run').length === n
        && document.getElementById('rs-strip-nav').getClientRects().length > 0, 2);
      await page.click(`#rs-strip [data-run-id="${two[0].run_id}"]`);
      await activeIs(page, two[0].run_id);
      const s2 = await strip(page);
      assert.equal(s2.count, fill('strip_count', { n: 1, m: 2 }));
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('a decision auto-advances to the next open report; the last one ends in a calm done state', async () => {
    const runs = showRuns(3);
    const { ctx, page, errors } = await open(runs[0].run_id, '&close_ms=100');
    try {
      await decide(page);
      await activeIs(page, runs[1].run_id);
      await page.waitForFunction((t) => [...document.querySelectorAll('#rs-toasts .rs-toast')].some((x) => x.textContent === t), de.sent);
      assert.equal(server.result(runs[0].run_id).status, 'submitted');
      await page.waitForFunction(() => document.querySelectorAll('#rs-strip .rs-strip__run').length === 2);
      assert.equal((await strip(page)).count, fill('strip_count', { n: 1, m: 2 }));
      assert.equal(await page.textContent('#rs-title'), BOTS[1].title);
      assert.equal(await page.isEnabled('rs-action-row button[value="erledigt"]'), true, 'the next report is live');

      // a discard is a decision too
      await page.click('#rs-discard');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await activeIs(page, runs[2].run_id);
      assert.equal(server.result(runs[1].run_id).status, 'cancelled');
      await page.waitForFunction(() => document.getElementById('rs-strip-nav').getClientRects().length === 0);
      assert.equal(await page.getAttribute('#rs-app', 'data-strip'), 'off', 'one open left: no strip');

      await decide(page);
      await page.waitForSelector('.rs-banner[data-banner="submitted"][data-done]');
      assert.equal(await page.getAttribute('html', 'data-rs-done'), '1');
      const banner = await page.evaluate(() => [...document.querySelectorAll('.rs-banner > *')].map((x) => x.textContent));
      assert.deepEqual(banner, [de.sent, de.done_title + ' ' + de.done_closing, de.done_keep_open]);
      assert.equal(await page.isHidden('#rs-submitbar'), true, 'no primary action in the done state');
      assert.equal(server.result(runs[2].run_id).status, 'submitted');
      // a test client never closes itself without ?autoclose=1
      await page.waitForTimeout(400);
      assert.equal(page.isClosed(), false);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('the done state closes the window; "keep open" and a new report stop it', async () => {
    const windowAlive = async () => (await (await fetch(server.url('hello'))).json()).window_alive;
    {
      // the real path: an --app window as the server launches it, with the
      // launch's one-time app token (no test client), closes itself after
      // the done state's delay, and POST /bye tells the server at once
      const [run] = showRuns(1);
      const token = armLaunch();
      const profile = mkdtempSync(path.join(tmpdir(), 'rs-popup-app-'));
      const app = await chromium.launchPersistentContext(profile, {
        channel: browserChannel(), headless: true, viewport: { width: 864, height: 836 }, args: [`--app=${server.url(`?run=${run.run_id}&app=${token}`)}`],
      });
      try {
        const page = app.pages().find((p) => p.url().includes(run.run_id)) || await app.waitForEvent('page');
        await ready(page);
        assert.equal(new URL(page.url()).searchParams.get('app'), null, 'the token leaves the address at once');
        // a reload keeps the window's confirmed ownership (the token is spent)
        await page.reload();
        await ready(page);
        assert.equal(await windowAlive(), true);
        const closed = page.waitForEvent('close', { timeout: 9000 });
        await decide(page);
        await page.waitForSelector('.rs-banner[data-done] .rs-banner__keep');
        const shown = Date.now();
        await closed;
        assert.ok(Date.now() - shown >= 3000, 'the done state stays readable for a moment');
        assert.equal(server.result(run.run_id).status, 'submitted');
        const until = Date.now() + 3000;
        while (await windowAlive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        assert.equal(await windowAlive(), false, 'no window any more');
      } finally {
        await app.close();
        rmSync(profile, { recursive: true, force: true });
      }
    }
    {
      const [run] = showRuns(1);
      const { ctx, page } = await open(run.run_id, '&autoclose=1&close_ms=800');
      try {
        await decide(page);
        await page.waitForSelector('.rs-banner[data-done] .rs-banner__keep');
        await page.click('.rs-banner__keep');
        await page.waitForTimeout(1200);
        assert.equal(page.isClosed(), false, 'kept open');
        assert.equal(await page.textContent('.rs-banner [data-rs-done-text]'), de.done_title);
        assert.equal(await page.$('.rs-banner__keep'), null);
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('rs-banner')), true, 'focus stays on the result');
      } finally { await ctx.close(); }
    }
    {
      const [run] = showRuns(1);
      const { ctx, page } = await open(run.run_id, '&autoclose=1&close_ms=1000');
      try {
        await decide(page);
        await page.waitForSelector('.rs-banner[data-done]');
        const next = server.show(golden, { bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
        await activeIs(page, next.run_id);
        await page.waitForTimeout(1400);
        assert.equal(page.isClosed(), false, 'a new report cancels the close');
        assert.equal(await page.getAttribute('html', 'data-rs-done'), null);
      } finally { await ctx.close(); }
    }
  });

  test('fix2: a tab the app window opens is an ordinary tab; the app window keeps its ownership', async () => {
    // a tab opened with window.open inherits the opener's sessionStorage,
    // so ownership must not live there: the child never closes itself, and
    // the app window (a new page in it here) still closes after its decision
    const [run] = showRuns(1);
    const token = armLaunch();
    const profile = mkdtempSync(path.join(tmpdir(), 'rs-popup-app-'));
    const app = await chromium.launchPersistentContext(profile, {
      channel: browserChannel(), headless: true, viewport: { width: 864, height: 836 }, args: [`--app=${server.url(`?run=${run.run_id}&app=${token}`)}`],
    });
    const owned = (page) => page.waitForFunction(() => document.documentElement.dataset.rsAppWindow === '1', null, { timeout: 8000 });
    try {
      const page = app.pages().find((p) => p.url().includes(run.run_id)) || await app.waitForEvent('page');
      await ready(page);
      await owned(page);
      const opened = app.waitForEvent('page');
      await page.evaluate((u) => { window.open(u, '_blank'); }, server.url(`?run=${run.run_id}`));
      const child = await opened;
      await ready(child);
      assert.deepEqual(await child.evaluate(() => [window.opener !== null, history.length]), [true, 1]);
      await decide(child);
      await child.waitForSelector('.rs-banner[data-banner="submitted"][data-done]');
      assert.equal(await child.textContent('.rs-banner [data-rs-done-text]'), de.done_title, 'no close promise');
      assert.equal(await child.$('.rs-banner__keep'), null);
      await child.waitForTimeout(4600);
      assert.equal(child.isClosed(), false, 'a tab opened from the app window never closes itself');
      assert.equal(await child.getAttribute('html', 'data-rs-app-window'), null);
      // the app window itself: a new page there (sid replaced) still owns it
      const next = server.show(golden, { bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
      await page.goto(server.url(`?run=${next.run_id}`));
      await ready(page);
      await owned(page);
      const closed = page.waitForEvent('close', { timeout: 9000 });
      await decide(page);
      await page.waitForSelector('.rs-banner[data-done] .rs-banner__keep');
      await closed;
      assert.equal(server.result(next.run_id).status, 'submitted');
      await child.waitForTimeout(400);
      assert.equal(child.isClosed(), false, 'the child stays open after the app window closed');
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('keyboard: Left/Right/Home/End on the strip, Ctrl+1..9 anywhere, arrows in text stay text', async () => {
    const runs = showRuns(3);
    const ids = runs.map((r) => r.run_id);
    const { ctx, page, errors } = await open(ids[0]);
    const focused = () => page.evaluate(() => document.activeElement.dataset.runId || document.activeElement.id);
    try {
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('Tab');
      assert.equal(await focused(), ids[0], 'the strip is the first Tab stop, on the active report');
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      assert.ok(ring.style !== 'none' && ring.width >= 2, 'visible focus ring on the strip');

      await page.keyboard.press('ArrowRight');
      await activeIs(page, ids[1]);
      assert.equal(await focused(), ids[1], 'focus moves along the strip');
      await page.keyboard.press('ArrowRight');
      await activeIs(page, ids[2]);
      await page.keyboard.press('ArrowRight');
      await activeIs(page, ids[0]);
      assert.equal(await focused(), ids[0], 'wraps around');
      await page.keyboard.press('ArrowLeft');
      await activeIs(page, ids[2]);
      await page.keyboard.press('Home');
      await activeIs(page, ids[0]);
      await page.keyboard.press('End');
      await activeIs(page, ids[2]);
      assert.equal(await focused(), ids[2]);
      // one Tab leaves the strip (one stop)
      await page.keyboard.press('Tab');
      assert.equal(await focused(), 'rs-more-btn');

      // Ctrl+n from anywhere
      await page.keyboard.press('Control+2');
      await activeIs(page, ids[1]);
      await page.keyboard.press('Control+1');
      await activeIs(page, ids[0]);
      assert.equal((await strip(page)).count, fill('strip_count', { n: 1, m: 3 }));

      // arrows inside a text input never switch reports
      const opener = page.locator('[data-starter="note-open"]');
      if (await opener.isVisible()) await opener.click();
      await page.fill('#starter-note', 'abc');
      await page.focus('#starter-note');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.RS.activeRun), ids[0]);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'starter-note');
      await page.keyboard.type('X');
      assert.equal(await page.inputValue('#starter-note'), 'Xabc', 'the caret moved as text editing');
      // Ctrl+3 still switches from the text field; the draft stays with its report
      await page.keyboard.press('Control+3');
      await activeIs(page, ids[2]);
      await page.keyboard.press('Control+1');
      await activeIs(page, ids[0]);
      assert.equal(await page.inputValue('#starter-note'), 'Xabc');
      // Ctrl+9 with three open: nothing happens
      await page.keyboard.press('Control+9');
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.RS.activeRun), ids[0]);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('fix1: an ordinary tab or window never closes itself, even with one history entry', async () => {
    const ordinary = async (query, mode) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      try {
        const url = server.url(query);
        if (mode === 'one-entry') {
          await page.evaluate((u) => location.replace(u), url);
          await page.waitForURL((u) => u.href.includes('run='));
        } else {
          await page.goto(server.url('hello'));
          await page.goto(url);
        }
        await ready(page);
        if (mode === 'one-entry') assert.equal(await page.evaluate(() => history.length), 1);
        await decide(page);
        await page.waitForSelector('.rs-banner[data-banner="submitted"][data-done]');
        assert.equal(await page.textContent('.rs-banner [data-rs-done-text]'), de.done_title, 'no close promise');
        assert.equal(await page.$('.rs-banner__keep'), null);
        await page.waitForTimeout(4600);
        assert.equal(page.isClosed(), false, `${mode}: the browser's permission is not app ownership`);
      } finally { await ctx.close(); }
    };
    for (const mode of ['one-entry', 'several-entries']) {
      const [run] = showRuns(1);
      await ordinary(`?run=${run.run_id}`, mode);
    }
    // a guessed token does not make a tab the app window either
    const [run] = showRuns(1);
    armLaunch();
    await ordinary(`?run=${run.run_id}&app=${'0'.repeat(32)}`, 'one-entry');
  });

  test('fix1: a new report cancels the close at once, before its detail has loaded', async () => {
    const [run] = showRuns(1);
    const { ctx, page } = await openPopup(`?client=test&run=${run.run_id}&autoclose=1&close_ms=700`);
    try {
      await decide(page);
      await page.waitForSelector('.rs-banner[data-done]');
      // the new report's detail answers only after the close delay
      await page.route('**/api/run/*', async (route) => {
        await new Promise((r) => setTimeout(r, 1200));
        try { await route.continue(); } catch { /* page gone */ }
      });
      const next = server.show(golden, { bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
      await page.waitForTimeout(1000);
      assert.equal(page.isClosed(), false, 'the arrival stops the close while its detail loads');
      await activeIs(page, next.run_id);
      assert.equal(await page.getAttribute('html', 'data-rs-done'), null);
      await page.waitForTimeout(900);
      assert.equal(page.isClosed(), false);
    } finally { await ctx.close(); }
  });

  test('fix1: auto-advance keeps the strip order when the list update beats the response', async () => {
    for (const kind of ['submit', 'cancel']) {
      await server.clearRuns();
      const ids = showRuns(3).map((r) => r.run_id);
      const { ctx, page, errors } = await open(ids[1]);
      try {
        // the decision reaches the server; its answer arrives after the SSE list
        await page.route(`**/${kind}`, async (route) => {
          const response = await route.fetch();
          await new Promise((r) => setTimeout(r, 700));
          await route.fulfill({ response });
        });
        await page.waitForFunction(() => document.querySelectorAll('#rs-strip .rs-strip__run').length === 3);
        if (kind === 'submit') await decide(page);
        else {
          await page.click('#rs-discard');
          await page.click('#rs-discard-dialog button[value="discard"]');
        }
        await page.waitForFunction((id) => window.RS.activeRun !== id
          && document.documentElement.dataset.rsReady === '1', ids[1], { timeout: 8000 });
        assert.equal(await page.evaluate(() => window.RS.activeRun), ids[2], `${kind}: B is followed by C, not A`);
        assert.equal(server.result(ids[1]).status, kind === 'submit' ? 'submitted' : 'cancelled');
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    }
    // the intended successor was decided meanwhile: the next remaining one (wrap)
    await server.clearRuns();
    const ids = showRuns(3).map((r) => r.run_id);
    const { ctx, page } = await open(ids[1]);
    try {
      await page.waitForFunction(() => document.querySelectorAll('#rs-strip .rs-strip__run').length === 3);
      await page.route('**/submit', async (route) => {
        const response = await route.fetch();
        const headers = { 'X-RS-CSRF': await server.csrf(), 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` };
        await fetch(server.url('cancel'), { method: 'POST', headers, body: JSON.stringify({ run_id: ids[2] }) });
        await new Promise((r) => setTimeout(r, 400));
        await route.fulfill({ response });
      });
      await decide(page);
      await page.waitForFunction((id) => window.RS.activeRun !== id
        && document.documentElement.dataset.rsReady === '1', ids[1], { timeout: 8000 });
      assert.equal(await page.evaluate(() => window.RS.activeRun), ids[0], 'C went elsewhere: wrap to A');
    } finally { await ctx.close(); }
  });

  test('reload keeps the active report and its place in the strip', async () => {
    const runs = showRuns(3);
    const { ctx, page } = await open(runs[0].run_id);
    try {
      await page.keyboard.press('Control+3');
      await activeIs(page, runs[2].run_id);
      await page.reload();
      await ready(page);
      assert.equal(await page.evaluate(() => window.RS.activeRun), runs[2].run_id);
      const s = await strip(page);
      assert.deepEqual(s.items.map((x) => x.current), [null, null, 'page']);
      assert.equal(s.count, fill('strip_count', { n: 3, m: 3 }));
      assert.equal(await page.textContent('#rs-title'), BOTS[2].title);
    } finally { await ctx.close(); }
  });
});
