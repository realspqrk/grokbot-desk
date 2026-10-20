// Pop-up layout (served, headless Edge): one open report is a compact
// pop-up with no inbox; two or more list every open report in an inbox, one
// row per report in arrival order: a side rail in a window 720 px or wider,
// a horizontal scrolling tab row under the header below that. A decision
// advances to the next open report; after the last one a calm done state
// shows and the window closes (test clients only with ?autoclose=1).
// Keyboard: arrows on the inbox, Ctrl+1..9 and Alt+Up/Down anywhere; arrows
// in text stay text. An arrival never replaces the report on screen.
// Isolated server, temp RS_DATA_DIR, public fictional bots only.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT, PYTHON } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';
import { calmEvaluator, judgeCalmFacts, CALM_THRESHOLDS } from '../tools/calm.mjs';

// tests use 18920-18939 only (AGENTS.md); never the product port
const PORT = e2ePort('popup.e2e.test.mjs');
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const fill = (key, params = {}) => de[key].replace(/\{([a-z_]+)\}/g, (m, name) => String(params[name]));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

// three fictional backup bots, each with its own shape avatar
const BOTS = [
  { bot: 'example-backup-bot', identity: { name: 'Backup Agent', avatar_shape: 'squircle', avatar_color: 'blue' }, title: 'Nachtsicherung Server prüfen' },
  { bot: 'example-nas-bot', identity: { name: 'NAS Agent', avatar_shape: 'blob', avatar_color: 'orange' }, title: 'Sicherung Büro-NAS prüfen' },
  { bot: 'example-web-bot', identity: { name: 'Web Agent', avatar_shape: 'hex', avatar_color: 'green' }, title: 'Sicherung Webserver prüfen' },
];
// an approval with no input: the primary sends at once
const BASE = {
  schema: 'grokbot-desk/payload@2',
  why: 'The nightly check finished. Approve, and the bot files the log.',
  ask: 'approve',
  action: 'file',
  blocks: [{ type: 'facts', items: [{ label: 'Duration', value: '42 min' }, { label: 'Size', value: '18 GB' }] }],
};

describe('pop-up: inbox, auto-advance, done state, keyboard (served, headless Edge)', { skip }, () => {
  let server;
  let browser;
  let seq = 0;

  before(async () => {
    server = await startServer({ port: PORT });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });
  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });
  beforeEach(async () => { if (server) await server.clearRuns(); });

  /** Registers one report through the CLI (`show --data`), as a bot does. */
  function show(extra = {}) {
    seq += 1;
    const file = path.join(server.dataDir, `popup-${process.pid}-${seq}.json`);
    const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(file, JSON.stringify({ ...BASE, bot: BOTS[0].bot, title: 'Bericht ' + seq, created, ...extra }), 'utf8');
    const out = spawnSync(PYTHON, [path.join(ROOT, 'report_shell.py'), '--port', String(PORT), 'show', '--data', file, '--no-window'], {
      cwd: ROOT, env: server.env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    });
    if (out.status !== 0) throw new Error(`show failed (${out.status}): ${out.stderr}`);
    return JSON.parse(out.stdout.trim().split('\n').pop());
  }
  /** n open runs, oldest first (= arrival and inbox order); bots cycle. */
  function showRuns(n) {
    return Array.from({ length: n }, (_, i) => {
      const b = BOTS[i % BOTS.length];
      return show({ bot: b.bot, identity: b.identity, title: i < BOTS.length ? b.title : `${b.title} ${i + 1}` });
    });
  }

  async function open(runId, extra = '', viewport = { width: 880, height: 720 }) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // a page that never gets ready must not leave its context (and its
    // live event stream) running into the next tests
    try {
      await page.goto(server.url(`?client=test&run=${runId}${extra}`));
      await ready(page);
    } catch (e) { await ctx.close().catch(() => {}); throw e; }
    return { ctx, page, errors };
  }
  /* on a timeout, says where the page got stuck (diagnostics for a rare
     Windows-runner stall of a freshly opened window) */
  const ready = async (page) => {
    try {
      await server.ready(page);
    } catch (e) {
      const where = await page.evaluate(() => ({
        url: location.pathname + location.search.replace(/token=[^&]*/g, 'token=?'),
        readyState: document.readyState,
        rs: typeof window.RS,
        active: window.RS?.activeRun ?? null,
        ready: document.documentElement.dataset.rsReady ?? null,
        mount: document.querySelector('.rs-mount, #rs-mount')?.textContent.trim().slice(0, 80) ?? null,
      })).catch((err) => ({ evaluate: String(err) }));
      e.message += ` | page state: ${JSON.stringify(where)}`;
      throw e;
    }
  };
  const activeIs = (page, id) => page.waitForFunction((x) => window.RS.activeRun === x
    && document.documentElement.dataset.rsReady === '1', id, { timeout: 8000 });
  const rowsAre = (page, n) => page.waitForFunction((k) => document.querySelectorAll('#rs-inbox a[data-run-id]').length === k
    && (k < 2 ? document.getElementById('rs-inbox').getClientRects().length === 0
      : document.getElementById('rs-inbox').getClientRects().length > 0), n, { timeout: 8000 });
  /* the inbox as a person sees it */
  const inbox = (page) => page.evaluate(() => {
    const nav = document.getElementById('rs-inbox');
    const visible = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const list = nav.querySelector('ol, ul');
    return {
      shown: visible(nav),
      tag: nav.tagName,
      label: nav.getAttribute('aria-label'),
      heading: nav.querySelector('#rs-inbox-heading')?.textContent ?? null,
      headingShown: visible(nav.querySelector('#rs-inbox-heading')),
      box: box(nav),
      header: box(document.querySelector('.rs-header')),
      task: box(document.querySelector('.rs-task')),
      mount: box(document.querySelector('.rs-mount')),
      list: { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight },
      viewport: { width: innerWidth, height: innerHeight },
      focusable: [...nav.querySelectorAll('a, button')].filter((b) => visible(b) && b.tabIndex >= 0).length,
      rows: [...nav.querySelectorAll('a[data-run-id]')].map((a) => ({
        id: a.dataset.runId,
        current: a.getAttribute('aria-current'),
        title: a.querySelector('.rs-inbox__title').textContent,
        meta: a.querySelector('.rs-inbox__meta').textContent,
        hintTone: a.querySelector('.rs-inbox__hint')?.getAttribute('data-tone') ?? null,
        unread: !!a.querySelector('.rs-inbox__dot[data-new]'),
        keys: a.getAttribute('aria-keyshortcuts'),
        tabIndex: a.tabIndex,
        shape: a.querySelector('[data-rs-avatar]')?.getAttribute('data-shape') || null,
        box: box(a),
        titleOverflows: (() => { const t = a.querySelector('.rs-inbox__title'); return t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1; })(),
      })),
    };
  });
  async function decide(page) {
    await page.click('#rs-submit');
  }
  async function focusNote(page) {
    const opener = page.locator('[data-rs-note-open]');
    if (await opener.isVisible()) await opener.click();
    await page.focus('#rs-note');
  }
  /** Arms a pending window launch as the CLI does (same 20 s deadline as
   * LAUNCH_PENDING_SECONDS: a cold persistent Edge on a busy Windows runner
   * can take longer than 5 s to connect); returns its one-time app token. */
  function armLaunch() {
    const generation = randomBytes(16).toString('hex');
    writeFileSync(path.join(server.dataDir, 'browser-launch.pending'),
      JSON.stringify({ generation, deadline: Date.now() / 1000 + 20 }), 'ascii');
    return generation;
  }
  /** A test window opened by script (window.close() is allowed there). */
  async function openPopup(query) {
    const ctx = await browser.newContext({ viewport: { width: 880, height: 720 }, reducedMotion: 'reduce' });
    try {
      const opener = await ctx.newPage();
      await opener.goto(server.url('?client=test'));
      const popup = ctx.waitForEvent('page');
      await opener.evaluate((url) => { window.open(url); }, server.url(query));
      const page = await popup;
      await ready(page);
      return { ctx, page };
    } catch (e) { await ctx.close().catch(() => {}); throw e; }
  }

  test('1 open: compact pop-up without an inbox; header = quiet byline, strong report title', async () => {
    const [run] = showRuns(1);
    const { ctx, page, errors } = await open(run.run_id);
    try {
      const s = await inbox(page);
      assert.equal(s.shown, false, 'no inbox with exactly one open report');
      assert.equal(s.focusable, 0);
      assert.equal(await page.getAttribute('#rs-app', 'data-inbox'), 'off');
      const head = await page.evaluate(() => {
        const name = document.getElementById('rs-bot-name');
        const title = document.getElementById('rs-title');
        const avatar = document.getElementById('rs-bot-avatar');
        const more = document.getElementById('rs-more-btn');
        const task = document.getElementById('rs-task');
        const px = (el) => parseFloat(getComputedStyle(el).fontSize);
        return {
          name: name.textContent,
          title: title.textContent,
          titleTag: title.tagName,
          nameWeight: Number(getComputedStyle(name).fontWeight),
          titleWeight: Number(getComputedStyle(title).fontWeight),
          bigger: px(title) > px(name),
          shape: avatar.getAttribute('data-shape'),
          avatarSize: avatar.getBoundingClientRect().width,
          byline: avatar.getBoundingClientRect().right <= name.getBoundingClientRect().left
            && Math.abs(more.getBoundingClientRect().top + more.getBoundingClientRect().height / 2
              - (name.getBoundingClientRect().top + name.getBoundingClientRect().height / 2)) < 2,
          order: name.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 1
            && title.getBoundingClientRect().bottom <= task.getBoundingClientRect().top + 1,
          inHeader: !!title.closest('header') && !!name.closest('header'),
        };
      });
      assert.equal(head.name, 'Backup Agent');
      assert.equal(head.title, BOTS[0].title);
      assert.equal(head.titleTag, 'H1', 'the report title stays the page heading');
      assert.ok(head.titleWeight >= 600, 'strong title');
      assert.ok(head.nameWeight < 600, 'quiet name');
      assert.ok(head.bigger, 'the title is larger than the byline');
      assert.equal(head.shape, 'squircle');
      assert.equal(head.avatarSize, 24, 'a small byline avatar');
      assert.ok(head.byline, 'avatar, name and the "…" menu share the byline');
      assert.ok(head.order, 'byline, then the title, then the task banner');
      assert.ok(head.inHeader);
      // the first Tab stop is the header's overflow button: nothing above it
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-more-btn');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('one open: no inbox (calm K3)', async () => {
    const [run] = showRuns(1);
    const { ctx, page } = await open(run.run_id);
    try {
      const one = judgeCalmFacts(await page.evaluate(calmEvaluator, { thresholds: CALM_THRESHOLDS, openRuns: 1 }));
      assert.equal(one.items.K3.pass, true, (one.items.K3.reasons || []).join('; '));
      show({ bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
      await rowsAre(page, 2);
      const two = judgeCalmFacts(await page.evaluate(calmEvaluator, { thresholds: CALM_THRESHOLDS, openRuns: 2 }));
      assert.equal(two.items.K3.pass, true, (two.items.K3.reasons || []).join('; '));
    } finally { await ctx.close(); }
  });

  test('two open: rail lists both in arrival order, current marked', async () => {
    const runs = showRuns(2);
    const urgent = show({ bot: BOTS[2].bot, identity: BOTS[2].identity, title: BOTS[2].title, urgent: true });
    const all = [...runs, urgent];
    const { ctx, page, errors } = await open(runs[1].run_id);
    try {
      await rowsAre(page, 3);
      const s = await inbox(page);
      assert.equal(s.shown, true);
      assert.equal(s.tag, 'NAV');
      assert.equal(s.label, de.inbox_label);
      assert.equal(s.heading, fill('inbox_heading', { n: 3 }));
      assert.equal(s.headingShown, true, 'the rail names what it lists');
      // a rail on the left, the full window height; the report beside it
      assert.equal(s.box.left, 0);
      assert.ok(Math.abs(s.box.height - s.viewport.height) <= 1, `full height (${s.box.height})`);
      assert.ok(s.box.width >= 200 && s.box.width <= 300, `rail width ${s.box.width}`);
      assert.ok(s.header.left >= s.box.right - 0.5, 'the header sits beside the rail');
      assert.ok(s.mount.left >= s.box.right - 0.5, 'the report sits beside the rail');
      assert.deepEqual(s.rows.map((x) => x.id), all.map((r) => r.run_id), 'arrival order, oldest first');
      assert.deepEqual(s.rows.map((x) => x.title), BOTS.map((b) => b.title));
      assert.deepEqual(s.rows.map((x) => x.current), [null, 'page', null]);
      assert.deepEqual(s.rows.map((x) => x.shape), BOTS.map((b) => b.identity.avatar_shape));
      assert.deepEqual(s.rows.map((x) => x.keys), ['Control+1 Meta+1', 'Control+2 Meta+2', 'Control+3 Meta+3']);
      // bot · hint: the kind of task, or urgent (marked) before it
      assert.equal(s.rows[0].meta, `${BOTS[0].identity.name} ${de.sep} ${de.ask_kind_approve}`);
      assert.equal(s.rows[2].meta, `${BOTS[2].identity.name} ${de.sep} ${de.ask_urgent}`);
      assert.equal(s.rows[2].hintTone, 'urgent');
      // the ones not looked at yet carry the unread dot; the shown one does not
      assert.deepEqual(s.rows.map((x) => x.unread), [true, false, true]);
      // rows stack top to bottom
      assert.ok(s.rows[0].box.bottom <= s.rows[1].box.top + 0.5 && s.rows[1].box.bottom <= s.rows[2].box.top + 0.5);
      assert.deepEqual(s.rows.map((x) => x.tabIndex), [-1, 0, -1], 'one Tab stop, on the current row');

      // a click opens that report; it is read then
      await page.click(`#rs-inbox a[data-run-id="${runs[0].run_id}"]`);
      await activeIs(page, runs[0].run_id);
      await page.waitForFunction((id) => !document.querySelector(`#rs-inbox a[data-run-id="${id}"] .rs-inbox__dot[data-new]`), runs[0].run_id);
      const s2 = await inbox(page);
      assert.deepEqual(s2.rows.map((x) => x.current), ['page', null, null]);
      assert.equal(new URL(page.url()).searchParams.get('run'), runs[0].run_id);

      // dark theme: the rail keeps its own surface
      await page.emulateMedia({ colorScheme: 'dark' });
      const bg = await page.evaluate(() => [getComputedStyle(document.getElementById('rs-inbox')).backgroundColor, getComputedStyle(document.body).backgroundColor]);
      assert.notEqual(bg[0], bg[1], 'the rail is a surface of its own');
      // axe: no serious or critical findings, dark and light
      await page.addScriptTag({ content: readFileSync(path.join(ROOT, 'vendor/axe.min.js'), 'utf8') });
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        const found = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
        const bad = found.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id);
        assert.deepEqual(bad, [], scheme);
      }
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('narrow window shows tabs instead of rail', async () => {
    const runs = showRuns(5);
    const { ctx, page, errors } = await open(runs[4].run_id, '', { width: 600, height: 720 });
    try {
      await rowsAre(page, 5);
      const s = await inbox(page);
      assert.equal(s.shown, true);
      // a row under the header, above the task banner, as wide as the window
      assert.ok(s.box.top >= s.header.bottom - 0.5, 'under the header');
      assert.ok(s.box.bottom <= s.task.top + 0.5, 'above the task banner');
      assert.ok(s.header.left < 1, 'no rail beside the header');
      assert.equal(s.headingShown, false, 'tabs need no heading');
      // tabs side by side, scrolling sideways when they do not fit
      for (let i = 1; i < s.rows.length; i++) {
        assert.ok(Math.abs(s.rows[i].box.top - s.rows[0].box.top) < 1, 'one row of tabs');
        assert.ok(s.rows[i].box.left >= s.rows[i - 1].box.right - 0.5, 'side by side in arrival order');
      }
      assert.ok(s.list.scrollWidth > s.list.clientWidth, 'five tabs scroll sideways at 600 px');
      assert.ok(s.box.height <= 80, `a slim row (${s.box.height})`);
      const horizontalPageScroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(horizontalPageScroll, false, 'the page itself never scrolls sideways');
      // the current tab is scrolled into view
      const last = s.rows[4];
      assert.equal(last.current, 'page');
      assert.ok(last.box.right <= s.viewport.width + 0.5 && last.box.left >= -0.5, 'the current tab is in view');
      // the same page widened past 720 px becomes the rail
      await page.setViewportSize({ width: 880, height: 720 });
      const wide = await inbox(page);
      assert.equal(wide.box.left, 0);
      assert.ok(wide.header.left >= wide.box.right - 0.5);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('rail to tabs: narrowing the window keeps the current report in view', async () => {
    const runs = showRuns(5);
    const { ctx, page } = await open(runs[4].run_id);
    try {
      await rowsAre(page, 5);
      await page.focus('#rs-note').catch(() => {});
      const before = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
      await page.setViewportSize({ width: 600, height: 720 });
      await page.waitForFunction(() => {
        const list = document.getElementById('rs-inbox-list');
        const row = list.querySelector('a[aria-current]');
        const l = list.getBoundingClientRect(), r = row.getBoundingClientRect();
        return r.left >= l.left - 0.5 && r.right <= l.right + 0.5;
      }, null, { timeout: 3000 });
      const after = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
      assert.equal(after, before, 'the reveal does not move focus');
      // and back to the rail: still in view
      await page.setViewportSize({ width: 880, height: 300 });
      await page.waitForFunction(() => {
        const list = document.getElementById('rs-inbox-list');
        const row = list.querySelector('a[aria-current]');
        const l = list.getBoundingClientRect(), r = row.getBoundingClientRect();
        return r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5;
      }, null, { timeout: 3000 });
    } finally { await ctx.close(); }
  });

  test('twelve open: the rail scrolls on its own and long titles stay in their row', async () => {
    const long = 'Sicherung der Dateiserver an allen drei Standorten nach dem Umzug prüfen';
    const runs = showRuns(11);
    runs.push(show({ bot: BOTS[0].bot, identity: BOTS[0].identity, title: long }));
    const { ctx, page } = await open(runs[0].run_id, '', { width: 880, height: 600 });
    try {
      await rowsAre(page, 12);
      const s = await inbox(page);
      assert.equal(s.heading, fill('inbox_heading', { n: 12 }));
      assert.ok(s.list.scrollHeight > s.list.clientHeight, 'twelve rows scroll inside the rail');
      assert.ok(Math.abs(s.box.height - s.viewport.height) <= 1, 'the rail never grows the page');
      const row = s.rows[11];
      assert.equal(row.title, long);
      assert.ok(row.titleOverflows, 'a long title is cut, not wrapped endlessly');
      assert.ok(row.box.height <= 80, `the row stays compact (${row.box.height})`);
      assert.ok(row.box.right <= s.box.right + 0.5, 'inside the rail');
      // Ctrl+9 is the ninth report; Alt+Down past it reaches the twelfth
      await page.keyboard.press('Control+9');
      await activeIs(page, runs[8].run_id);
      for (const id of runs.slice(9).map((r) => r.run_id)) {
        await page.keyboard.press('Alt+ArrowDown');
        await activeIs(page, id);
      }
      const after = await inbox(page);
      const current = after.rows[11];
      assert.equal(current.current, 'page');
      assert.ok(current.box.bottom <= after.box.bottom + 0.5 && current.box.top >= after.box.top - 0.5, 'the current row is scrolled into view');
    } finally { await ctx.close(); }
  });

  test('a decision auto-advances to the next open report; the last one ends in a calm done state', async () => {
    const runs = showRuns(3);
    const { ctx, page, errors } = await open(runs[0].run_id, '&close_ms=100');
    try {
      await decide(page);
      await activeIs(page, runs[1].run_id);
      // the "sent" toast belonged to the decided report: it must not linger
      // over the next one after the advance
      assert.deepEqual(await page.$$eval('#rs-toasts .rs-toast', (t) => t.map((x) => x.textContent)), [], 'no toast over the next report');
      assert.equal(server.result(runs[0].run_id).status, 'submitted');
      await rowsAre(page, 2);
      assert.deepEqual((await inbox(page)).rows.map((x) => x.current), ['page', null]);
      assert.equal(await page.textContent('#rs-title'), BOTS[1].title);
      assert.equal(await page.isEnabled('#rs-submit'), true, 'the next report is live');

      // a discard is a decision too
      await page.click('#rs-more-btn'); await page.click('#rs-discard');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await activeIs(page, runs[2].run_id);
      assert.equal(server.result(runs[1].run_id).status, 'cancelled');
      await rowsAre(page, 1);
      assert.equal(await page.getAttribute('#rs-app', 'data-inbox'), 'off', 'one open left: no inbox');

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
        const next = show({ bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
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
      // the app window itself: a new page there (sid replaced) still owns it.
      // It replaces the entry: Chromium lets a script close a window that no
      // script opened only while its history holds one entry
      // (DOMWindow::Close), and the app window never adds one itself
      const next = show({ bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
      const nextUrl = server.url(`?run=${next.run_id}`);
      await Promise.all([page.waitForURL((u) => u.href.includes(next.run_id)), page.evaluate((u) => location.replace(u), nextUrl)]);
      await ready(page);
      await owned(page);
      assert.equal(await page.evaluate(() => history.length), 1);
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

  test('an app window the browser will not close says so instead of promising to close', async () => {
    // a second history entry (here a navigation) makes Chromium refuse
    // window.close() for a window no script opened: the banner then drops
    // the "closes in a moment" promise and the window stays usable
    const [run] = showRuns(1);
    const token = armLaunch();
    const profile = mkdtempSync(path.join(tmpdir(), 'rs-popup-app-'));
    const app = await chromium.launchPersistentContext(profile, {
      channel: browserChannel(), headless: true, viewport: { width: 864, height: 836 }, args: [`--app=${server.url(`?run=${run.run_id}&app=${token}`)}`],
    });
    try {
      const page = app.pages().find((p) => p.url().includes(run.run_id)) || await app.waitForEvent('page');
      await ready(page);
      await page.waitForFunction(() => document.documentElement.dataset.rsAppWindow === '1', null, { timeout: 8000 });
      // the same report again, as a new entry (an extra query parameter)
      await page.goto(server.url(`?run=${run.run_id}&again=1`));
      await ready(page);
      await page.waitForFunction(() => document.documentElement.dataset.rsAppWindow === '1', null, { timeout: 8000 });
      assert.equal(await page.evaluate(() => history.length), 2);
      await decide(page);
      await page.waitForSelector('.rs-banner[data-done] .rs-banner__keep');
      await page.waitForFunction(() => !document.querySelector('.rs-banner__keep'), null, { timeout: 9000 });
      assert.equal(page.isClosed(), false);
      assert.equal(await page.textContent('.rs-banner [data-rs-done-text]'), de.done_title, 'no close promise left');
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('Ctrl+2 opens the second report', async () => {
    const runs = showRuns(3);
    const ids = runs.map((r) => r.run_id);
    const { ctx, page, errors } = await open(ids[0]);
    const focused = () => page.evaluate(() => document.activeElement.dataset.runId || document.activeElement.id);
    try {
      await rowsAre(page, 3);
      // Ctrl+n from anywhere: the n-th report, not the n-th bot
      await page.keyboard.press('Control+2');
      await activeIs(page, ids[1]);
      assert.equal(await page.textContent('#rs-title'), BOTS[1].title);
      assert.deepEqual((await inbox(page)).rows.map((x) => x.current), [null, 'page', null]);
      await page.keyboard.press('Control+3');
      await activeIs(page, ids[2]);
      await page.keyboard.press('Control+1');
      await activeIs(page, ids[0]);
      // Ctrl+9 with three open: nothing happens
      await page.keyboard.press('Control+9');
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.RS.activeRun), ids[0]);

      // Alt+Down / Alt+Up: next and previous; no wrap at the ends
      await page.keyboard.press('Alt+ArrowDown');
      await activeIs(page, ids[1]);
      await page.keyboard.press('Alt+ArrowDown');
      await activeIs(page, ids[2]);
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.RS.activeRun), ids[2], 'the last stays the last');
      await page.keyboard.press('Alt+ArrowUp');
      await activeIs(page, ids[1]);

      // the inbox is one Tab stop; arrows walk it and open the report
      await page.focus(`#rs-inbox a[data-run-id="${ids[1]}"]`);
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      assert.ok(ring.style !== 'none' && ring.width >= 2, 'visible focus ring in the inbox');
      await page.keyboard.press('ArrowDown');
      await activeIs(page, ids[2]);
      assert.equal(await focused(), ids[2], 'focus moves along the inbox');
      await page.keyboard.press('Home');
      await activeIs(page, ids[0]);
      await page.keyboard.press('End');
      await activeIs(page, ids[2]);
      await page.keyboard.press('ArrowUp');
      await activeIs(page, ids[1]);
      assert.equal(await focused(), ids[1]);

      // arrows inside the note never switch reports
      await page.keyboard.press('Control+1');
      await activeIs(page, ids[0]);
      await focusNote(page);
      await page.keyboard.type('abc');
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'ArrowLeft', 'Alt+ArrowDown']) await page.keyboard.press(key);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.RS.activeRun), ids[0]);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note');
      await page.keyboard.type('X');
      assert.equal(await page.inputValue('#rs-note'), 'Xabc', 'the caret moved as text editing');
      // Ctrl+3 still switches from the text field; the draft stays with its report
      await page.keyboard.press('Control+3');
      await activeIs(page, ids[2]);
      await page.keyboard.press('Control+1');
      await activeIs(page, ids[0]);
      assert.equal(await page.inputValue('#rs-note'), 'Xabc');
      // Escape closes the "…" menu
      await page.click('#rs-more-btn');
      assert.equal(await page.isVisible('#rs-more-panel'), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.isHidden('#rs-more-panel'), true);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('arrival while typing keeps focus and report', async () => {
    const [a] = showRuns(1);
    const { ctx, page, errors } = await open(a.run_id, '&burst_ms=300');
    try {
      await focusNote(page);
      await page.keyboard.type('Bitte zuerst');
      const b = show({ bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
      await rowsAre(page, 2);
      await page.keyboard.type(' prüfen');
      assert.equal(await page.evaluate(() => window.RS.activeRun), a.run_id, 'the report on screen stays');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note', 'focus stays in the note');
      assert.equal(await page.inputValue('#rs-note'), 'Bitte zuerst prüfen', 'no keystroke lost');
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((x) => x.id), [a.run_id, b.run_id], 'the arrival is appended');
      assert.deepEqual(s.rows.map((x) => x.unread), [false, true]);
      // announced once, by its title
      await page.waitForFunction((text) => [...document.querySelectorAll('#rs-toasts .rs-toast')].some((x) => x.textContent.includes(text)), BOTS[1].title, { timeout: 4000 });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note', 'the toast does not take focus');
      assert.equal(await page.title(), de.unread_prefix + fill('window_title', { title: BOTS[0].title, bot: BOTS[0].identity.name }));
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('fix1: an ordinary tab or window never closes itself, even with one history entry', async () => {
    const ordinary = async (query, mode) => {
      const ctx = await browser.newContext({ viewport: { width: 880, height: 720 }, reducedMotion: 'reduce' });
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
    // The close delay must outlast showing the next report (a CLI process,
    // slow on a busy Windows runner) so that report arrives within it.
    const { ctx, page } = await openPopup(`?client=test&run=${run.run_id}&autoclose=1&close_ms=2500`);
    try {
      await decide(page);
      await page.waitForSelector('.rs-banner[data-done]');
      // the new report's detail answers only after the close delay
      await page.route('**/api/run/*', async (route) => {
        await new Promise((r) => setTimeout(r, 3500));
        try { await route.continue(); } catch { /* page gone */ }
      });
      const next = show({ bot: BOTS[1].bot, identity: BOTS[1].identity, title: BOTS[1].title });
      await page.waitForTimeout(2800);
      assert.equal(page.isClosed(), false, 'the arrival stops the close while its detail loads');
      await activeIs(page, next.run_id);
      assert.equal(await page.getAttribute('html', 'data-rs-done'), null);
      await page.waitForTimeout(900);
      assert.equal(page.isClosed(), false);
    } finally { await ctx.close(); }
  });

  test('fix1: auto-advance keeps the inbox order when the list update beats the response', async () => {
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
        await rowsAre(page, 3);
        if (kind === 'submit') await decide(page);
        else {
          await page.click('#rs-more-btn'); await page.click('#rs-discard');
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
      await rowsAre(page, 3);
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

  test('reload keeps the active report and its place in the inbox', async () => {
    const runs = showRuns(3);
    const { ctx, page } = await open(runs[0].run_id);
    try {
      await rowsAre(page, 3);
      await page.keyboard.press('Control+3');
      await activeIs(page, runs[2].run_id);
      await page.reload();
      await ready(page);
      assert.equal(await page.evaluate(() => window.RS.activeRun), runs[2].run_id);
      await rowsAre(page, 3);
      const s = await inbox(page);
      assert.deepEqual(s.rows.map((x) => x.id), runs.map((r) => r.run_id));
      assert.deepEqual(s.rows.map((x) => x.current), [null, null, 'page']);
      assert.equal(await page.textContent('#rs-title'), BOTS[2].title);
    } finally { await ctx.close(); }
  });
});
