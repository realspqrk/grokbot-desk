// Browser tests for the served shell: one report built from blocks, its
// footer, Discard, the inbox switch under failures, hydration of a result
// another client sent, drafts and core components (rs-copy, rs-confirm).
// Isolated server on its own test port with a temp RS_DATA_DIR; headless
// Edge (or Chrome) via playwright-core loaded by absolute path.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  browserChannel, startServer, loadChromium, ROOT, PLAIN_REPORT,
  fixtureMedia, payloadFixture, payloadFixtureNames,
} from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';
import round5Corpus from './fixtures/twitter-text-round5.mjs';

const PORT = e2ePort('shell.e2e.test.mjs');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SECOND_BOT = 'example-second-bot';
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const AXE = path.join(ROOT, 'vendor/axe.min.js');
/* the approve fixture: a primary named by its label, Reject and Request
   changes as quiet alternatives, a copy block */
const APPROVE = payloadFixture('approve');
const COPY_TEXT = APPROVE.blocks.find((b) => b.type === 'copy').items[0].text;
const COPY = '[data-rs-block-type="copy"] rs-copy';
const COPY_BUTTON = `${COPY} .rs-copy__btn`;
const round4Corpus = JSON.parse(
  readFileSync(new URL('./fixtures/twitter-text-round4.json', import.meta.url), 'utf8'),
);
const sharedReviewCorpus = [...round4Corpus.cases, ...round5Corpus.cases];
const require = createRequire(import.meta.url);
const nodeCount = require('../core/static/count.js').count;
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('report-shell page (served, headless Edge)', { skip }, () => {
  beforeEach((t) => { if (process.env.RS_TRACE) console.error('START', t.name, new Date().toISOString()); });
  let server;
  let browser;
  let media;

  before(async () => {
    media = fixtureMedia();
    server = await startServer({ port: PORT, mediaRoots: [media.dir] });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally {
      if (server) await server.stop();
      if (media) media.cleanup();
    }
  });

  /** an approve report from operations-agent unless `extra` says otherwise */
  const show = (extra = {}, payload = APPROVE) => server.show(payload, { bot: 'operations-agent', identity: undefined, ...extra });

  async function open(q = '', opts = {}) {
    const ctx = await browser.newContext({
      viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1,
      colorScheme: opts.colorScheme || 'light', reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const log = {
      errors: [], requests: [], responses: [], posts: [], requestFailures: [],
    };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.errors.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    page.on('request', (r) => { log.requests.push(r.url()); if (r.method() === 'POST') log.posts.push(r); });
    page.on('response', (r) => log.responses.push(r));
    page.on('requestfailed', (r) => {
      log.requestFailures.push({ url: r.url(), error: r.failure()?.errorText || 'unknown' });
    });
    const sep = q ? '&' : '';
    const response = await page.goto(server.url('?client=test' + sep + q));
    await ready(page);
    const focusWidth = await page.evaluate(() => (
      getComputedStyle(document.documentElement).getPropertyValue('--rs-focus-width').trim()
    ));
    assert.equal(
      focusWidth,
      '2px',
      `--rs-focus-width=${JSON.stringify(focusWidth)}; failed URLs=${JSON.stringify(log.requestFailures)}; console errors=${JSON.stringify(log.errors)}`,
    );
    return { ctx, page, log, response };
  }
  const ready = (page) => server.ready(page);
  const activeIs = (page, id) => page.waitForFunction((x) => window.RS.activeRun === x
    && document.documentElement.dataset.rsReady === '1', id, { timeout: 8000 });
  const activeId = (page) => page.evaluate(() => window.RS.activeRun);
  const row = (id) => `#rs-inbox a[data-run-id="${id}"]`;
  const draftNote = (page, id) => page.evaluate((runId) => {
    const raw = localStorage.getItem('rs-draft:' + runId);
    return raw ? JSON.parse(raw).value.composer.text : null;
  }, id);
  const toastShown = (page, message) => page.waitForFunction((msg) => [...document.querySelectorAll('#rs-toasts .rs-toast')]
    .some((x) => x.textContent === msg), message, { timeout: 3000 });
  const dialogOpen = (page) => page.evaluate(() => document.getElementById('rs-discard-dialog').open);
  async function discardOpen(page) {
    await page.click('#rs-more-btn');
    await page.click('#rs-discard');
  }
  async function result(run) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = server.result(run.run_id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no result for ' + run.run_id);
  }
  async function submitElsewhere(runId, data) {
    const response = await fetch(server.url('submit'), {
      method: 'POST',
      headers: { 'X-RS-CSRF': await server.csrf(), 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ run_id: runId, data }),
    });
    return response.status;
  }

  test('renders a report: strings, CSP, same-origin only, no console errors', async () => {
    await server.clearRuns();
    const run = show({ title: 'Sicherung prüfen' });
    const { ctx, page, log, response } = await open('run=' + run.run_id);
    try {
      assert.match(response.headers()['content-security-policy'], /default-src 'self'/);
      assert.equal(await page.getAttribute('html', 'lang'), 'de');
      // shown in a visible, focused window -> POST /read -> no "● " prefix
      await page.waitForFunction(() => document.title === 'Sicherung prüfen · Operations Agent', null, { timeout: 3000 });
      assert.equal(await page.textContent('#rs-title'), 'Sicherung prüfen');
      // calm UI: bot and creation time live in the header overflow panel
      assert.match(await page.textContent('#rs-meta'), /Operations Agent.*(Mo|Di|Mi|Do|Fr|Sa|So) \d\d\.\d\d\.\d{4} · \d\d:\d\d$/);
      // what the bot wrote is shown as it is: why, facts, the copy text
      assert.match(await page.textContent('#rs-task'), new RegExp(APPROVE.why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await page.textContent(`${COPY} .rs-copy__value`), COPY_TEXT);
      // the payload label names the primary; the alternatives come from i18n
      assert.equal(await page.textContent('#rs-submit-label'), APPROVE.label);
      assert.equal(await page.isDisabled('#rs-submit'), false);
      assert.deepEqual(
        await page.$$eval('#rs-actions button', (b) => b.filter((x) => x.getClientRects().length).map((x) => x.textContent.trim())),
        [de.ask_reject, de.ask_request_changes, APPROVE.label],
      );
      assert.equal(await page.textContent('#rs-theme'), de.theme_dark);
      // static files carry the CSP too
      const js = log.responses.find((r) => r.url().endsWith('/static/rs.js'));
      assert.ok(js && /default-src 'self'/.test(js.headers()['content-security-policy'] || ''), 'CSP on /static/rs.js');
      assert.deepEqual(log.requests.filter((u) => !u.startsWith(ORIGIN + '/')), []);
      assert.deepEqual(log.errors, []);
      // every visible core string comes from de.json
      const missing = await page.evaluate((keys) => [...document.querySelectorAll('[data-rs-t]')]
        .map((e) => e.getAttribute('data-rs-t')).filter((k) => !keys.includes(k)), Object.keys(de));
      assert.deepEqual(missing, []);
    } finally { await ctx.close(); }
  });

  test('X counter rejects a failed non-ASCII TLD within 50 ms in Edge', async () => {
    const run = server.show(PLAIN_REPORT, { title: 'Zähler prüfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.route('**/static/count-timing-worker.js', (route) => route.fulfill({
        contentType: 'text/javascript',
        body: `
          importScripts('/static/twitter-text-v3-data.js', '/static/count.js');
          onmessage = (event) => {
            RS_COUNT.setPlatforms(event.data.platforms);
            const started = performance.now();
            const result = RS_COUNT.count(event.data.text, 'x');
            postMessage({ result, elapsed: performance.now() - started });
          };
        `,
      }));
      const measurement = await page.evaluate(async () => {
        const platforms = JSON.parse(document.querySelector('#rs-boot').textContent).platforms;
        const worker = new Worker('/static/count-timing-worker.js');
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('counter exceeded 2000 ms')), 2000);
            worker.onmessage = (event) => {
              clearTimeout(timer);
              resolve(event.data);
            };
            worker.onerror = (event) => {
              clearTimeout(timer);
              reject(new Error(event.message));
            };
            worker.postMessage({ platforms, text: 'あ'.repeat(30) + '.invalid' });
          });
        } finally {
          worker.terminate();
        }
      });
      assert.deepEqual(measurement.result, { count: 68, limit: 25000, fold: 280, over: false });
      assert.ok(measurement.elapsed < 50, `counter took ${measurement.elapsed.toFixed(1)} ms`);
    } finally { await ctx.close(); }
  });

  test('X counter keeps adversarial URL parentheses below the Edge deadlines', async () => {
    const run = server.show(PLAIN_REPORT, { title: 'URL-Laufzeit prüfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.route('**/static/count-timing-worker.js', (route) => route.fulfill({
        contentType: 'text/javascript',
        body: `
          importScripts('/static/twitter-text-v3-data.js', '/static/count.js');
          onmessage = (event) => {
            RS_COUNT.setPlatforms(event.data.platforms);
            /* the fastest of three runs: a backtracking regression is slow
               every time, a cold JIT or a busy runner only once */
            let result;
            let elapsed = Infinity;
            for (let i = 0; i < 3; i += 1) {
              const started = performance.now();
              result = RS_COUNT.count(event.data.text, 'x');
              elapsed = Math.min(elapsed, performance.now() - started);
            }
            postMessage({ result, elapsed });
          };
        `,
      }));
      const prefix = 'http://example.com/';
      const cases = [
        ['30,000 unmatched closing parentheses', prefix + ')'.repeat(30000), 30023, 50],
        ['mixed balanced and unmatched parentheses', prefix + '(a)'.repeat(5000) + ')'.repeat(15000), 30019, 50],
        ['maximum spec text length of URL-like punctuation', prefix + ')'.repeat(63206 - prefix.length), 63210, 100],
      ];
      for (const [name, text, expected, limit] of cases) {
        const measurement = await page.evaluate(async ({ text }) => {
          const platforms = JSON.parse(document.querySelector('#rs-boot').textContent).platforms;
          const worker = new Worker('/static/count-timing-worker.js');
          try {
            return await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('counter exceeded 1000 ms')), 1000);
              worker.onmessage = (event) => {
                clearTimeout(timer);
                resolve(event.data);
              };
              worker.onerror = (event) => {
                clearTimeout(timer);
                reject(new Error(event.message));
              };
              worker.postMessage({ platforms, text });
            });
          } finally {
            worker.terminate();
          }
        }, { text });
        assert.equal(measurement.result.count, expected, name);
        assert.ok(measurement.elapsed < limit, `${name} took ${measurement.elapsed.toFixed(1)} ms`);
      }
    } finally { await ctx.close(); }
  });

  test('X counter matches the expanded shared upstream URL/IDNA corpus in Node and Edge', async () => {
    const run = server.show(PLAIN_REPORT, { title: 'URL-Korpus prüfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      const cases = sharedReviewCorpus.flatMap(({ text, upstream_count: value }) => [
        { text, count: value, over: false },
        // the weighting at X's standard 280 (the fold); only 25,000 is over
        { text: 'a'.repeat(279 - value) + ' ' + text, count: 280, over: false },
        { text: 'a'.repeat(280 - value) + ' ' + text, count: 281, over: false },
      ]);
      const expected = cases.map(({ count, over }) => ({ count, over }));
      const node = cases.map(({ text }) => {
        const counted = nodeCount(text, 'x');
        return { count: counted.count, over: counted.over };
      });
      const edge = await page.evaluate((items) => items.map(({ text }) => {
        const counted = RS_COUNT.count(text, 'x');
        return { count: counted.count, over: counted.over };
      }), cases);
      assert.deepEqual(node, expected, 'Node equals pinned upstream');
      assert.deepEqual(edge, expected, 'Edge equals pinned upstream');
      assert.deepEqual(edge, node, 'Node and Edge agree');
    } finally { await ctx.close(); }
  });

  test('localization contracts fill data-rs-t-<attr> and report the title with POST /title', async () => {
    await server.clearRuns();
    const run = show({ title: 'Titel melden' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    try {
      assert.equal(await page.getAttribute('#rs-more-btn', 'aria-label'), de.more);
      assert.equal(await page.getAttribute('#rs-inbox', 'aria-label'), de.inbox_label);
      const want = 'Titel melden · Operations Agent';
      await page.waitForFunction((w) => document.title === w, want, { timeout: 3000 });
      const hello = async () => (await (await fetch(server.url('hello'))).json()).window_title;
      const deadline = Date.now() + 3000;
      while ((await hello()) !== want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.equal(await hello(), want);
      // the request carries Origin and CSRF and only the title field
      const req = log.posts.filter((r) => r.url() === ORIGIN + '/title');
      assert.ok(req.length >= 1, 'POST /title sent');
      const last = req[req.length - 1];
      assert.deepEqual(JSON.parse(last.postData()), { title: want });
      const h = await last.allHeaders();
      assert.equal(h.origin, ORIGIN);
      assert.ok(h['x-rs-csrf']);
      // a title change is reported again
      await server.clearRuns();
      await page.waitForFunction(() => document.title === 'grokbot-desk · keine offenen Berichte', null, { timeout: 3000 });
      const deadline2 = Date.now() + 3000;
      while ((await hello()) !== 'grokbot-desk · keine offenen Berichte' && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 50));
      assert.equal(await hello(), 'grokbot-desk · keine offenen Berichte');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('axe-core: every payload fixture has 0 serious/critical violations, light and dark', async () => {
    for (const name of payloadFixtureNames()) {
      await server.clearRuns();
      const run = server.show(media.map(payloadFixture(name)));
      for (const colorScheme of ['light', 'dark']) {
        const { ctx, page, log } = await open('run=' + run.run_id, { colorScheme });
        try {
          await page.addScriptTag({ path: AXE });
          const v = await page.evaluate(async () => (await window.axe.run(document)).violations
            .filter((x) => x.impact === 'serious' || x.impact === 'critical')
            .map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target.join(' ')) })));
          assert.deepEqual(v, [], `${name} ${colorScheme}`);
          assert.deepEqual(log.errors, [], `${name} ${colorScheme}: console`);
        } finally { await ctx.close(); }
      }
    }
    await server.clearRuns();
  });

  test('theme toggle Hell/Dunkel flips the theme and persists it', async () => {
    const { ctx, page } = await open();
    try {
      const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rs-paper').trim());
      // calm UI: the theme switch is an entry of the header overflow panel
      await page.click('#rs-more-btn');
      await page.click('#rs-theme');
      assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
      assert.equal(await page.getAttribute('#rs-theme', 'aria-pressed'), 'true');
      const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rs-paper').trim());
      assert.notEqual(before, after);
      await page.reload();
      await ready(page);
      assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
      await page.click('#rs-more-btn');
      await page.click('#rs-theme');
      assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
      assert.equal(await page.getAttribute('#rs-theme', 'aria-pressed'), 'false');
    } finally { await ctx.close(); }
  });

  test('rs-copy: click posts the exact text to /copy, shows the check and announces it', async () => {
    await server.clearRuns();
    const run = show({ title: 'Kopieren' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.route('**/copy', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: '{"ok":true}',
      }));
      const reqP = page.waitForRequest((r) => r.url() === ORIGIN + '/copy');
      const resP = page.waitForResponse((r) => r.url() === ORIGIN + '/copy');
      await page.click(COPY_BUTTON);
      const req = await reqP;
      const res = await resP;
      assert.deepEqual(JSON.parse(req.postData()), { run_id: run.run_id, text: COPY_TEXT });
      assert.equal(req.headers()['x-rs-csrf'] !== undefined, true);
      assert.equal(res.status(), 200);
      assert.deepEqual(await res.json(), { ok: true });
      await page.waitForSelector(`${COPY}[data-state="copied"]`);
      // calm UI: icon-only copy button; the name stays, feedback is the check icon + toast
      assert.equal(await page.getAttribute(COPY_BUTTON, 'aria-label'), APPROVE.blocks.find((b) => b.type === 'copy').items[0].label);
      assert.equal(await page.getAttribute('#rs-toasts', 'aria-live'), 'polite');
      assert.ok((await page.$$eval('#rs-toasts .rs-toast', (t) => t.map((x) => x.textContent))).includes(de.copied));
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('rs-confirm on the real page: exact word only, Esc cancels', async () => {
    await server.clearRuns();
    const run = show({ title: 'Bestätigen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.evaluate(() => {
        window.__c = [];
        const c = document.createElement('rs-confirm');
        c.id = 'test-confirm';
        document.body.appendChild(c);
        c.open({ word: 'LÖSCHEN' }).then((v) => window.__c.push(v));
      });
      assert.equal(await page.textContent('#test-confirm label'), 'Zum Bestätigen „LÖSCHEN“ eintippen');
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('rs-confirm__input')), true);
      const ok = '#test-confirm button[type="submit"]';
      assert.equal(await page.isDisabled(ok), true);
      await page.keyboard.type('löschen');
      assert.equal(await page.isDisabled(ok), true);
      await page.keyboard.press('Control+Enter'); // must not submit the run while a dialog is open
      await page.fill('#test-confirm input', 'LÖSCHEN');
      assert.equal(await page.isDisabled(ok), false);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__c.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__c), [false]);
      await page.evaluate(() => { document.getElementById('test-confirm').open({ word: 'JA' }).then((v) => window.__c.push(v)); });
      await page.keyboard.type('JA');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__c.length === 2);
      assert.deepEqual(await page.evaluate(() => window.__c), [false, true]);
      assert.equal(server.result(run.run_id), null, 'no result while confirming');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('mouse: Approve writes the result file and the report turns read-only', async () => {
    await server.clearRuns();
    const run = show({ title: 'Ablauf Maus' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    try {
      await page.click('#rs-submit');
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
      assert.equal(await page.textContent('.rs-banner > span:first-child'), de.sent);
      const sent = await result(run);
      assert.equal(sent.schema, 'grokbot-desk/result@2');
      assert.equal(sent.status, 'submitted');
      assert.deepEqual(sent.data, { decision: 'approve', note: '', refs: [] });
      assert.equal(await page.isVisible('#rs-submit'), false, 'no primary on a decided report');
      assert.equal(await page.$eval('#rs-note', (note) => note.readOnly), true);
      assert.equal(await page.isEnabled(COPY_BUTTON), true, 'copy still works');
      assert.equal(await page.title(), 'grokbot-desk · keine offenen Berichte');
      assert.equal(await page.evaluate((id) => localStorage.getItem('rs-draft:' + id), run.run_id), null);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('keyboard only (one open report): a typed note and Enter on the primary write the result', async () => {
    await server.clearRuns();
    const run = show({ title: 'Ablauf Tastatur' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      // the "…" menu, the copy button, then the note
      for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note');
      await page.keyboard.type('Go ahead after 17:00.');
      // Reject, Request changes, then the primary
      for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-submit');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
      assert.deepEqual((await result(run)).data, { decision: 'approve', note: 'Go ahead after 17:00.', refs: [] });
    } finally { await ctx.close(); }
  });

  test('every Tab stop shows a focus outline of at least 2 px', async () => {
    await server.clearRuns();
    const run = show({ title: 'Fokus' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      const seen = [];
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(() => {
          const a = document.activeElement;
          /* a text field may hand its ring to its own frame (the composer) */
          let ringed = a;
          for (let n = a, i = 0; n && i < 2; n = n.parentElement, i++) {
            const own = getComputedStyle(n);
            if (own.outlineStyle !== 'none' && parseFloat(own.outlineWidth) >= 2) { ringed = n; break; }
          }
          const s = getComputedStyle(ringed);
          return {
            tag: a.tagName,
            id: a.id,
            cls: a.className,
            w: parseFloat(s.outlineWidth),
            style: s.outlineStyle,
            fv: a.matches(':focus-visible'),
          };
        });
        seen.push(f);
        if (f.tag === 'BODY') break;
        assert.ok(f.w >= 2 && f.style !== 'none', 'outline on ' + JSON.stringify(f));
      }
      const order = seen.filter((f) => f.tag !== 'BODY').map((f) => f.id || f.cls.split(' ')[0] || f.tag);
      // calm UI: one report = no inbox; theme and Discard report live behind
      // the overflow button, the copy is an icon button
      assert.deepEqual(order, ['rs-more-btn', 'rs-icon-btn', 'rs-note', 'rs-alt', 'rs-alt-2', 'rs-submit']);
    } finally { await ctx.close(); }
  });

  test('Discard asks first, then writes a cancelled result', async () => {
    await server.clearRuns();
    const run = show({ title: 'Verwerfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      // Discard report is the last "…" menu item, never a footer button
      const where = await page.evaluate(() => {
        const item = document.getElementById('rs-discard');
        return {
          menu: !!item.closest('#rs-more-panel'),
          footer: !!item.closest('#rs-submitbar'),
          last: item.parentElement.lastElementChild === item,
          visible: item.getClientRects().length > 0,
        };
      });
      assert.deepEqual(where, { menu: true, footer: false, last: true, visible: false });
      await page.click('#rs-more-btn');
      assert.equal(await page.textContent('#rs-discard'), de.discard_report);
      await page.click('#rs-discard');
      assert.equal(await page.isHidden('#rs-more-panel'), true, 'the menu closes behind the confirmation');
      assert.equal(await dialogOpen(page), true);
      assert.equal(await page.textContent('#rs-discard-h'), de.discard_confirm_title);
      await page.click('#rs-discard-dialog button[value="cancel"]');
      assert.equal(server.result(run.run_id), null);
      await discardOpen(page);
      await page.click('#rs-discard-dialog button[value="discard"]');
      await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
      assert.equal((await result(run)).status, 'cancelled');
      assert.equal(await page.isDisabled('#rs-discard'), true);
    } finally { await ctx.close(); }
  });

  test('closing Discard never steals focus after a fast Tab', async () => {
    await server.clearRuns();
    const run = show({ title: 'Fokus nach Verwerfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      const focused = () => page.evaluate(() => {
        const a = document.activeElement;
        return a.id || a.className.split(' ')[0] || a.tagName;
      });
      for (let i = 0; i < 20; i++) {
        await page.click('#rs-more-btn');
        await page.focus('#rs-discard');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        // the menu closed with the confirmation: focus is back on its button
        await page.waitForFunction(() => document.activeElement.id === 'rs-more-btn', null, { timeout: 2000 });
        await page.keyboard.press('Tab');
        const next = await focused();
        assert.notEqual(next, 'rs-more-btn');
        await page.waitForTimeout(100);
        assert.equal(await focused(), next);
      }
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('a stale Discard close event cannot consume a dialog reopened in the same task', async () => {
    await server.clearRuns();
    const run = show({ title: 'Verwerfen erneut öffnen' });
    const { ctx, page } = await open('run=' + run.run_id);
    const cancels = [];
    page.on('request', (request) => {
      if (request.url() === ORIGIN + '/cancel') cancels.push(request.postDataJSON());
    });
    try {
      await discardOpen(page);
      await page.evaluate(() => {
        const dialog = document.getElementById('rs-discard-dialog');
        dialog.close('');
        document.getElementById('rs-discard').click();
      });
      await page.waitForTimeout(0);
      assert.equal(await dialogOpen(page), true, 'the replacement confirmation stays open');

      await page.click('#rs-discard-dialog button[value="discard"]');
      await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
      assert.deepEqual(cancels, [{ run_id: run.run_id }]);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('Discard: an arrival while the confirmation is open neither switches nor changes the target', async () => {
    await server.clearRuns();
    const a = show({ title: 'Ziel A', created: isoAt(Date.now() - 60000) });
    const { ctx, page, log } = await open('run=' + a.run_id);
    try {
      await discardOpen(page); // A untouched, confirmation open
      const b = show({ bot: SECOND_BOT, title: 'Neu B', created: isoAt(Date.now()) });
      await page.waitForSelector(row(b.run_id));
      await page.waitForTimeout(300); // a switch would have started by now
      assert.equal(await activeId(page), a.run_id, 'no automatic switch under the confirmation');
      assert.equal(await page.textContent('#rs-title'), 'Ziel A');
      assert.equal(await dialogOpen(page), true);
      const req = page.waitForRequest((r) => r.url() === ORIGIN + '/cancel');
      await page.click('#rs-discard-dialog button[value="discard"]');
      assert.deepEqual(JSON.parse((await req).postData()), { run_id: a.run_id });
      // The discard is a decision, so the pop-up moves on to B
      await activeIs(page, b.run_id);
      assert.equal((await result(a)).status, 'cancelled');
      assert.equal(server.result(b.run_id), null, 'B has no result');
      assert.equal(await page.textContent('#rs-title'), 'Neu B');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('Discard: the confirmation closes when its target is decided elsewhere or expires', async () => {
    await server.clearRuns();
    // decided elsewhere (bot/CLI cancel through the API)
    const a = show({ title: 'Ziel extern' });
    {
      const { ctx, page } = await open('run=' + a.run_id);
      const cancels = [];
      page.on('request', (r) => { if (r.url() === ORIGIN + '/cancel') cancels.push(r); });
      try {
        await discardOpen(page);
        assert.equal(await dialogOpen(page), true);
        await server.clearRuns(); // cancels A through POST /cancel
        await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
        await page.waitForFunction(() => !document.getElementById('rs-discard-dialog').open, null, { timeout: 3000 });
        assert.equal(cancels.length, 0, 'the page sent no cancel');
      } finally { await ctx.close(); }
    }
    // expiry: created 5 min - 3 s ago, expires after 5 min
    const e = show({ title: 'Ziel läuft ab', created: isoAt(Date.now() - 300000 + 3000), expires_minutes: 5 });
    {
      const { ctx, page, log } = await open('run=' + e.run_id);
      const cancels = [];
      page.on('request', (r) => { if (r.url() === ORIGIN + '/cancel') cancels.push(r); });
      try {
        await discardOpen(page);
        assert.equal(await dialogOpen(page), true);
        await page.waitForSelector('.rs-banner[data-banner="expired"]', { timeout: 8000 });
        await page.waitForFunction(() => !document.getElementById('rs-discard-dialog').open, null, { timeout: 3000 });
        assert.equal((await result(e)).status, 'expired');
        assert.equal(cancels.length, 0);
        assert.equal(await page.isDisabled('#rs-discard'), true);
        assert.deepEqual(log.errors, []);
      } finally { await ctx.close(); }
    }
  });

  test('Discard: a failed /cancel request leaves the footer usable, keeps the draft, and the retry works', async () => {
    await server.clearRuns();
    const run = show({ title: 'Abbruch scheitert' });
    const { ctx, page } = await open('run=' + run.run_id);
    let held;
    try {
      await page.fill('#rs-note', 'bleibt');
      await page.route('**/cancel', (route) => { held = route; });
      await discardOpen(page);
      const requested = page.waitForRequest((request) => request.url() === ORIGIN + '/cancel');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await requested;
      assert.equal(await page.$eval('#rs-note', (note) => note.readOnly), true, 'busy while the cancel is out');
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.isEnabled(COPY_BUTTON), true);
      await held.abort('connectionfailed');
      await toastShown(page, de.discard_failed);
      assert.equal(await page.isDisabled('#rs-submit'), false, 'the primary is usable again');
      assert.equal(await page.isDisabled('#rs-discard'), false, 'Discard is usable again');
      assert.equal(await page.$eval('#rs-note', (note) => note.readOnly), false);
      assert.equal(server.result(run.run_id), null);
      assert.equal(await page.inputValue('#rs-note'), 'bleibt');
      assert.equal(await draftNote(page, run.run_id), 'bleibt', 'draft kept');
      await page.unroute('**/cancel');
      await discardOpen(page);
      await page.click('#rs-discard-dialog button[value="discard"]');
      await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
      assert.equal((await result(run)).status, 'cancelled');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  // review round 2, finding 4: busy belongs to a run and operation token
  test('switching during submit keeps the selected run busy until its own submit completes', async () => {
    await server.clearRuns();
    const a = show({ title: 'Submit A', created: isoAt(Date.now() - 60000) });
    const b = show({ bot: SECOND_BOT, title: 'Submit B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    const held = [];
    try {
      await page.route('**/submit', (route) => { held.push(route); });
      const requestA = page.waitForRequest((r) => r.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      await requestA;
      await page.click(row(b.run_id));
      await activeIs(page, b.run_id);
      await page.fill('#rs-note', 'B remains pending');
      const requestB = page.waitForRequest((r) => r.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      await requestB;
      assert.equal(await page.isDisabled('#rs-submit'), true);

      await held[0].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await page.waitForTimeout(50);
      assert.equal(await page.inputValue('#rs-note'), 'B remains pending');
      assert.equal(await page.$eval('#rs-note', (note) => note.readOnly), true);
      assert.equal(await page.isDisabled('#rs-submit'), true, 'A completion cannot unlock B');
      assert.equal(await page.isDisabled('#rs-discard'), true, 'A completion cannot unlock B discard');

      await held[1].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('switching during cancel keeps the selected run busy until its own cancel completes', async () => {
    await server.clearRuns();
    const a = show({ title: 'Cancel A', created: isoAt(Date.now() - 60000) });
    const b = show({ bot: SECOND_BOT, title: 'Cancel B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    const held = [];
    try {
      await page.route('**/cancel', (route) => { held.push(route); });
      await discardOpen(page);
      const requestA = page.waitForRequest((r) => r.url() === ORIGIN + '/cancel');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await requestA;
      await page.click(row(b.run_id));
      await activeIs(page, b.run_id);
      await discardOpen(page);
      const requestB = page.waitForRequest((r) => r.url() === ORIGIN + '/cancel');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await requestB;
      assert.equal(await page.isDisabled('#rs-discard'), true);

      await held[0].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await page.waitForTimeout(50);
      assert.equal(await page.isDisabled('#rs-submit'), true, 'A completion cannot unlock B submit');
      assert.equal(await page.isDisabled('#rs-discard'), true, 'A completion cannot unlock B discard');

      await held[1].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  // review round 1, finding 5
  test('a failed /read (network abort, then HTTP 500) is retried on the next focus; page and server agree', async () => {
    await server.clearRuns();
    const run = show({ title: 'Lesen scheitert' });
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    const serverUnread = async () => {
      const csrf = await server.csrf();
      const list = await (await fetch(server.url('api/runs'), { headers: { 'X-RS-CSRF': csrf } })).json();
      return list.runs.find((r) => r.run_id === run.run_id).unread;
    };
    try {
      let aborted = 0;
      await page.route('**/read', (r) => { aborted += 1; return r.abort('connectionfailed'); });
      await page.goto(server.url('?client=test&run=' + run.run_id));
      await ready(page);
      await page.waitForTimeout(500); // immediate and 300 ms attempts
      assert.ok(aborted >= 1);
      assert.equal(await serverUnread(), true);
      assert.ok((await page.title()).startsWith(de.unread_prefix), 'page still shows unread');

      await page.unroute('**/read');
      let failed = 0;
      await page.route('**/read', (r) => { failed += 1; return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }); });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForTimeout(200);
      assert.equal(failed, 1, 'focus retried once');
      assert.ok((await page.title()).startsWith(de.unread_prefix), 'a 500 does not clear unread');

      await page.unroute('**/read');
      const read = page.waitForResponse((r) => r.url() === ORIGIN + '/read');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      assert.equal((await read).status(), 200);
      await page.waitForFunction(() => !document.title.startsWith('●'), null, { timeout: 3000 });
      assert.equal(await serverUnread(), false);
      assert.equal(await page.title(), 'Lesen scheitert · Operations Agent');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('failed run switch keeps the rendered report live and sends its exact edited note', async () => {
    await server.clearRuns();
    const a = show({ title: 'Switch bleibt A', created: isoAt(Date.now() - 60000) });
    const b = show({ bot: SECOND_BOT, title: 'Switch scheitert B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    try {
      await page.fill('#rs-note', 'old note');
      await page.route(`**/api/run/${b.run_id}`, (route) => route.abort('connectionfailed'));
      await page.click(row(b.run_id));
      await toastShown(page, de.run_load_failed);

      assert.equal(await activeId(page), a.run_id);
      assert.equal(await page.textContent('#rs-title'), 'Switch bleibt A');
      assert.equal(await page.getAttribute('html', 'data-rs-ready'), '1');
      await page.fill('#rs-note', 'new note after failed switch');
      assert.equal(await draftNote(page, a.run_id), 'new note after failed switch');

      const expected = { decision: 'approve', note: 'new note after failed switch', refs: [] };
      const submitted = page.waitForRequest((request) => request.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      assert.deepEqual(JSON.parse((await submitted).postData()), { run_id: a.run_id, data: expected });
      await page.unroute(`**/api/run/${b.run_id}`);
      // Once sent, the pop-up advances to B
      await activeIs(page, b.run_id);
      assert.deepEqual((await result(a)).data, expected);
      assert.equal(await page.evaluate((id) => localStorage.getItem('rs-draft:' + id), a.run_id), null);
      assert.equal(server.result(b.run_id), null);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('an HTTP 500 run switch reports a retryable load error and preserves the URL', async () => {
    await server.clearRuns();
    const a = show({ title: 'Aktiv A', created: isoAt(Date.now() - 60000) });
    const b = show({ bot: SECOND_BOT, title: 'Fehler B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    try {
      await page.fill('#rs-note', 'A');
      await page.route(`**/api/run/${b.run_id}`, (route) => route.fulfill({
        status: 500, contentType: 'application/json', body: '{"error":"injected"}',
      }));
      await page.click(row(b.run_id));
      await toastShown(page, de.run_load_failed);
      assert.equal(await activeId(page), a.run_id);
      assert.equal(new URL(page.url()).searchParams.get('run'), a.run_id);
      assert.equal(await page.isEditable('#rs-note'), true);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('delayed successful switch retires the old report only when the replacement commits', async () => {
    await server.clearRuns();
    const a = show({ title: 'Verzögert A', created: isoAt(Date.now() - 60000) });
    const b = show({ bot: SECOND_BOT, title: 'Verzögert B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    let held;
    try {
      await page.fill('#rs-note', 'A before request');
      await page.route(`**/api/run/${b.run_id}`, (route) => { held = route; });
      const requested = page.waitForRequest((request) => request.url().endsWith('/api/run/' + b.run_id));
      await page.click(row(b.run_id));
      await requested;

      await page.fill('#rs-note', 'A while B is delayed');
      assert.equal(await activeId(page), a.run_id);
      assert.equal(await draftNote(page, a.run_id), 'A while B is delayed');

      const response = await held.fetch();
      await held.fulfill({ response });
      await activeIs(page, b.run_id);
      assert.equal(await page.textContent('#rs-title'), 'Verzögert B');
      assert.equal(await page.inputValue('#rs-note'), '', 'A\'s note stays with A');

      const expected = { decision: 'approve', note: 'B exact result', refs: [] };
      await page.fill('#rs-note', expected.note);
      const submitted = page.waitForRequest((request) => request.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      assert.deepEqual(JSON.parse((await submitted).postData()), { run_id: b.run_id, data: expected });
      // Once sent, the pop-up advances to the open A with its draft
      await activeIs(page, a.run_id);
      assert.deepEqual((await result(b)).data, expected);
      assert.equal(server.result(a.run_id), null);
      assert.equal(await page.inputValue('#rs-note'), 'A while B is delayed');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('a successful run switch updates the URL and a reload keeps that run and its draft', async () => {
    await server.clearRuns();
    const a = show({ title: 'URL A', created: isoAt(Date.now() - 60000) });
    const b = show({ bot: SECOND_BOT, title: 'URL B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    try {
      await page.click(row(b.run_id));
      await activeIs(page, b.run_id);
      await page.fill('#rs-note', 'Entwurf in B');
      assert.equal(new URL(page.url()).searchParams.get('run'), b.run_id);
      await page.reload();
      await ready(page);
      assert.equal(await activeId(page), b.run_id);
      assert.equal(await page.inputValue('#rs-note'), 'Entwurf in B');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('a reopened decided report shows its result read-only and copy still works', async () => {
    await server.clearRuns();
    const run = show({ title: 'Entschieden wieder öffnen' });
    const first = await open('run=' + run.run_id);
    try {
      await first.page.fill('#rs-note', 'Gesendete Notiz');
      await first.page.click('#rs-submit');
      await first.page.waitForSelector('.rs-banner[data-banner="submitted"]');
    } finally { await first.ctx.close(); }

    const { ctx, page } = await open('run=' + run.run_id);
    const copies = [];
    try {
      await page.route('**/copy', (route) => {
        copies.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      assert.equal(await page.inputValue('#rs-note'), 'Gesendete Notiz');
      assert.equal(await page.$eval('#rs-note', (note) => note.readOnly), true);
      assert.equal(await page.isVisible('#rs-submit'), false);
      assert.equal(await page.isEnabled(COPY_BUTTON), true);
      await page.click(COPY_BUTTON);
      assert.deepEqual(copies, [{ run_id: run.run_id, text: COPY_TEXT }]);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('a live report decided by another client shows the sent result read-only', async () => {
    await server.clearRuns();
    const run = show({ title: 'Anderswo gesendet' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    const copies = [];
    try {
      await page.route('**/copy', (route) => {
        copies.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.fill('#rs-note', 'lokaler Entwurf');
      const sent = { decision: 'revise', note: 'vom anderen Client', refs: [] };
      assert.equal(await submitElsewhere(run.run_id, sent), 200);
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
      await page.waitForFunction((note) => document.getElementById('rs-note')?.value === note, sent.note, { timeout: 5000 });
      assert.equal(await page.$eval('#rs-note', (note) => note.readOnly), true);
      assert.equal(await page.isVisible('#rs-submit'), false);
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('.rs-banner')), true, 'focus at the result banner');
      assert.equal(await page.isEnabled(COPY_BUTTON), true);
      await page.click(COPY_BUTTON);
      assert.deepEqual(copies, [{ run_id: run.run_id, text: COPY_TEXT }]);
      assert.deepEqual((await result(run)).data, sent, 'stored result unchanged');
      // this page's own late send is refused and changes nothing
      assert.equal(await submitElsewhere(run.run_id, { decision: 'approve', note: 'x' }), 409);
      assert.deepEqual(server.result(run.run_id).data, sent);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('a 409 on our own send shows the result another client sent first', async () => {
    await server.clearRuns();
    const run = show({ title: 'Wettlauf' });
    const { ctx, page } = await open('run=' + run.run_id);
    let held;
    try {
      await page.route('**/submit', (route) => { held = route; });
      const requested = page.waitForRequest((r) => r.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      await requested;
      const sent = { decision: 'reject', note: 'zuerst', refs: [] };
      assert.equal(await submitElsewhere(run.run_id, sent), 200);
      await held.continue();
      await page.waitForFunction((note) => document.getElementById('rs-note')?.value === note, sent.note, { timeout: 5000 });
      assert.equal(await page.$eval('#rs-note', (note) => note.readOnly), true);
      assert.deepEqual(server.result(run.run_id).data, sent);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('switching rule, unread dot, ● title prefix and Ctrl+1..3', async () => {
    await server.clearRuns();
    const a = show({ title: 'Bericht A', identity: { name: 'Operations Agent' } });
    const { ctx, page, log } = await open();
    try {
      assert.equal(await activeId(page), a.run_id);
      await page.waitForFunction(() => document.title === 'Bericht A · Operations Agent', null, { timeout: 3000 });

      // A stays even untouched; B waits in the inbox with its unread dot,
      // the title gets "● "
      const b = show({ bot: SECOND_BOT, identity: { name: 'Second Agent' }, title: 'Bericht B' }, PLAIN_REPORT);
      await page.waitForSelector(`${row(b.run_id)} .rs-inbox__dot[data-new]`);
      await page.waitForTimeout(300); // a switch would have started by now
      assert.equal(await activeId(page), a.run_id, 'an untouched report is not replaced');
      assert.equal(await page.title(), '● Bericht A · Operations Agent');
      assert.equal(
        (await page.textContent(row(b.run_id))).replace(/\s+/g, ' ').trim(),
        `Bericht B Second Agent ${de.sep} ${de.ask_kind_read} ${de.sep} ${de.new}`,
      );

      // a note on A, C arrives: arrivals append, nothing jumps
      await page.fill('#rs-note', 'erst morgen');
      const c = show({ bot: 'example-third-bot', identity: { name: 'Third Agent' }, title: 'Bericht C' });
      await page.waitForSelector(`${row(c.run_id)} .rs-inbox__dot[data-new]`);
      assert.equal(await activeId(page), a.run_id);
      const order = await page.$$eval('#rs-inbox a[data-run-id]', (x) => x.map((e) => [e.dataset.runId, e.getAttribute('aria-keyshortcuts')]));
      /* Ctrl on Windows, Cmd on macOS: both announced, as on the primary */
      assert.deepEqual(order, [[a.run_id, 'Control+1 Meta+1'], [b.run_id, 'Control+2 Meta+2'], [c.run_id, 'Control+3 Meta+3']]);

      // Ctrl+3 -> C (read: the dot goes)
      const read = page.waitForRequest((r) => r.url() === ORIGIN + '/read');
      await page.keyboard.press('Control+3');
      await read;
      await activeIs(page, c.run_id);
      await page.waitForFunction(() => document.title.includes('Bericht C'), null, { timeout: 3000 });
      await page.waitForFunction((sel) => !document.querySelector(sel), `${row(c.run_id)} .rs-inbox__dot[data-new]`, { timeout: 3000 });
      assert.equal(await page.getAttribute(row(c.run_id), 'aria-current'), 'page');

      // Ctrl+2 -> B; then the "● " prefix goes away (nothing unread)
      await page.keyboard.press('Control+2');
      await activeIs(page, b.run_id);
      await page.waitForFunction(() => !document.title.startsWith('●'), null, { timeout: 3000 });

      // Ctrl+1 -> A with its draft restored
      await page.keyboard.press('Control+1');
      await activeIs(page, a.run_id);
      await page.waitForFunction(() => document.title === 'Bericht A · Operations Agent', null, { timeout: 3000 });
      assert.equal(await page.inputValue('#rs-note'), 'erst morgen');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('expired run shows the expired banner and cannot be sent', async () => {
    await server.clearRuns();
    const created = isoAt(Date.now() - 20 * 60000);
    const run = show({ title: 'Abgelaufen', created, expires_minutes: 5 });
    assert.equal((await result(run)).status, 'expired');
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      assert.equal(await page.textContent('.rs-banner[data-banner="expired"]'), de.run_expired_msg);
      assert.equal(await page.isVisible('#rs-submit'), false);
      assert.equal(await page.isDisabled('#rs-discard'), true);
      // A decided report is not in the inbox of open reports
      assert.equal(await page.$(row(run.run_id)), null);
    } finally { await ctx.close(); }
  });

  test('footer: right under a short report; at the window bottom over a hairline once the report scrolls', async () => {
    await server.clearRuns();
    const run = show({ title: 'Kurzer Bericht' });
    const { ctx, page } = await open('run=' + run.run_id);
    const layout = () => page.evaluate(() => {
      const mount = document.getElementById('rs-mount');
      const bar = document.getElementById('rs-submitbar');
      const content = mount.querySelector('.rs-report').getBoundingClientRect();
      const composer = document.getElementById('rs-composer').getBoundingClientRect();
      const space6 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-6'));
      return {
        scrolls: mount.hasAttribute('data-rs-scrolls'),
        gap: composer.top - content.bottom,
        space6,
        barBottom: bar.getBoundingClientRect().bottom,
        windowBottom: innerHeight,
        line: getComputedStyle(bar).borderTopColor,
      };
    });
    try {
      const short = await layout();
      assert.equal(short.scrolls, false);
      assert.ok(short.gap >= 0 && short.gap <= short.space6 * 2, `the footer follows the content (${JSON.stringify(short)})`);
      assert.ok(short.barBottom < short.windowBottom - 200, 'not pinned to the window bottom');
      assert.equal(short.line, 'rgba(0, 0, 0, 0)', 'no hairline under a short report');
      await page.setViewportSize({ width: 1500, height: 300 });
      await page.waitForFunction(() => document.getElementById('rs-mount').hasAttribute('data-rs-scrolls'), null, { timeout: 3000 });
      const long = await layout();
      assert.ok(Math.abs(long.barBottom - long.windowBottom) <= 1, `at the window bottom (${JSON.stringify(long)})`);
      assert.notEqual(long.line, 'rgba(0, 0, 0, 0)', 'a hairline over the footer');
      await page.setViewportSize({ width: 1500, height: 1000 });
      await page.waitForFunction(() => !document.getElementById('rs-mount').hasAttribute('data-rs-scrolls'), null, { timeout: 3000 });
    } finally { await ctx.close(); }
  });

  test('links never navigate the window: every way to open one posts /open-url, drags and drops are cancelled', async () => {
    await server.clearRuns();
    const run = show({ title: 'Links' }, payloadFixture('approve-decide'));
    const { ctx, page, log } = await open('run=' + run.run_id);
    const opened = [];
    try {
      // the desk would open the OS browser: answer /open-url here
      await page.route('**/open-url', (route) => {
        opened.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      const link = '[data-item-id="hosting"] a.rs-ext';
      const href = await page.getAttribute(link, 'href');
      const urlVectors = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/url_vectors.json'), 'utf8'));
      const probe = await page.evaluate(({ selector, vectors }) => {
        const anchor = document.querySelector(selector);
        const start = new DragEvent('dragstart', { bubbles: true, cancelable: true });
        anchor.dispatchEvent(start);
        const uri = new DataTransfer();
        uri.setData('text/uri-list', 'https://evil.example/drop');
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: uri });
        document.body.dispatchEvent(over);
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: uri });
        document.body.dispatchEvent(drop);
        const plain = new DataTransfer();
        plain.setData('text/plain', 'hello');
        const textOver = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: plain });
        document.body.dispatchEvent(textOver);
        const fieldUri = new DataTransfer();
        fieldUri.setData('text/uri-list', 'https://evil.example/field');
        const fieldOver = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: fieldUri });
        document.getElementById('rs-note').dispatchEvent(fieldOver);
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        anchor.dispatchEvent(menu);
        const holder = document.createElement('div');
        RS.appendLinks(holder, 'See https://example.com/only-the-link today');
        return {
          draggable: anchor.getAttribute('draggable'),
          startCancelled: start.defaultPrevented,
          overCancelled: over.defaultPrevented,
          dropCancelled: drop.defaultPrevented,
          textCancelled: textOver.defaultPrevented,
          fieldCancelled: fieldOver.defaultPrevented,
          menuCancelled: menu.defaultPrevented,
          linksOnly: holder.textContent,
          badLink: RS.externalLink('https://user@example.com/a', 'x') === null,
          pathAt: RS.externalLink('https://example.com/a@b', 'x').getAttribute('href'),
          accepted: vectors.both.concat(vectors.opener_only).filter((u) => RS.externalLink(u, 'x') === null),
          refused: vectors.bad.filter((u) => RS.externalLink(u, 'x') !== null),
        };
      }, { selector: link, vectors: urlVectors });
      assert.deepEqual(probe, {
        draggable: 'false',
        startCancelled: true,
        overCancelled: true,
        dropCancelled: true,
        textCancelled: false,
        fieldCancelled: false,
        menuCancelled: true,
        linksOnly: 'https://example.com/only-the-link',
        badLink: true,
        pathAt: 'https://example.com/a@b',
        accepted: [],
        refused: [],
      });
      /* the page opens a link at most once per 400 ms */
      const pause = () => page.waitForTimeout(450);
      await page.click(link);
      await pause();
      await page.click(link, { button: 'middle' });
      await pause();
      await page.focus(link);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+Enter'); // the submit shortcut, never the link
      await pause();
      await page.focus(link);
      await page.keyboard.press('Shift+Enter');
      await pause();
      await page.focus(link);
      await page.keyboard.press('Alt+Enter');
      await pause();
      await page.click(link, { modifiers: ['Shift'] });
      await pause();
      // Ctrl+click on macOS is the context-menu gesture (no click event); Cmd+click is
      // the macOS counterpart, so the platform modifier keeps the count the same.
      await page.click(link, { modifiers: ['ControlOrMeta'] });
      await page.click(link, { button: 'right' });
      await pause();
      assert.deepEqual(opened.map((entry) => entry.url), Array(7).fill(href));
      assert.ok(opened.every((entry) => entry.run_id === run.run_id));
      assert.equal(new URL(page.url()).origin, ORIGIN, 'the window never navigated');
      assert.equal(server.result(run.run_id), null, 'Ctrl+Enter on a link sent nothing');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  /* the fold fade (shell.css .rs-main::after, rs.js updateFold) */
  const fold = (page) => page.evaluate(() => {
    const mount = document.getElementById('rs-mount');
    const fade = getComputedStyle(document.querySelector('.rs-main'), '::after');
    return {
      more: mount.hasAttribute('data-rs-more'),
      fade: fade.content === 'none' ? null : fade.height,
      scrolls: mount.scrollHeight > mount.clientHeight,
    };
  });
  const fadeHeight = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rs-fade-h').trim())
    .then(async (value) => `${await page.evaluate((v) => {
      const probe = document.createElement('div');
      probe.style.height = v;
      document.body.appendChild(probe);
      const h = probe.getBoundingClientRect().height;
      probe.remove();
      return h;
    }, value)}px`);

  test('the fold fade shows only while the report continues below; keyboard focus scrolls clear of it', async () => {
    await server.clearRuns();
    const run = server.show(media.map(payloadFixture('report-long')), { title: 'Langer Bericht' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(() => document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      const fade = await fadeHeight(page);
      assert.deepEqual(await fold(page), { more: true, fade, scrolls: true });
      /* every focus stop inside the report stays above the fade (ring included) */
      const stops = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        /* the focus scroll and its scroll event settle before the next paint */
        const stop = await page.evaluate((fadePx) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const mount = document.getElementById('rs-mount');
          const active = document.activeElement;
          if (!mount.contains(active)) { resolve({ outside: true }); return; }
          const fadeTop = mount.getBoundingClientRect().bottom - (mount.hasAttribute('data-rs-more') ? fadePx : 0);
          resolve({ tag: active.tagName, bottom: active.getBoundingClientRect().bottom + 4, fadeTop });
        }))), parseFloat(fade));
        if (stop.outside) { if (stops.length) break; continue; }
        stops.push(stop.tag);
        assert.ok(stop.bottom <= stop.fadeTop + 0.5, `${stop.tag} #${stops.length}: ${stop.bottom} under the fade or fold at ${stop.fadeTop}`);
      }
      assert.ok(stops.includes('SUMMARY'), `a disclosure is reached: ${stops.join(' ')}`);
      await page.evaluate(() => { const m = document.getElementById('rs-mount'); m.scrollTop = m.scrollHeight; });
      await page.waitForFunction(() => !document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      assert.deepEqual(await fold(page), { more: false, fade: null, scrolls: true }, 'scrolled to the end');
      /* only the mount's bottom padding below the fold: no fade */
      const size = await page.evaluate(() => {
        const mount = document.getElementById('rs-mount');
        return { chrome: innerHeight - mount.clientHeight, content: mount.lastElementChild.getBoundingClientRect().height };
      });
      await page.setViewportSize({ width: 1280, height: Math.ceil(size.chrome + size.content + 8) });
      await page.evaluate(() => { document.getElementById('rs-mount').scrollTop = 0; });
      await page.waitForFunction(() => !document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      assert.equal((await fold(page)).more, false, 'padding only');
      assert.equal((await fold(page)).fade, null, 'padding only');
      await page.setViewportSize({ width: 1280, height: Math.ceil(size.chrome + size.content + 400) });
      await page.waitForFunction(() => !document.getElementById('rs-mount').hasAttribute('data-rs-scrolls'));
      assert.deepEqual(await fold(page), { more: false, fade: null, scrolls: false }, 'everything fits');
    } finally { await ctx.close(); }
  });

  /* the focused element after the ResizeObserver settled, against the fade */
  const held = (page, fadePx) => page.evaluate((px) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const mount = document.getElementById('rs-mount');
    const active = document.activeElement;
    const more = mount.hasAttribute('data-rs-more');
    resolve({
      summary: active.tagName === 'SUMMARY',
      open: active.parentElement.open,
      more, scroll: mount.scrollTop, end: mount.scrollHeight - mount.clientHeight, top: active.getBoundingClientRect().top,
      ring: active.getBoundingClientRect().bottom + 4, fadeTop: mount.getBoundingClientRect().bottom - (more ? px : 0),
    });
  }))), fadePx);
  async function tabToSummary(page) {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement.tagName === 'SUMMARY')) return;
    }
    throw new Error('no disclosure reached');
  }

  test('opening a disclosure that turns the fade on keeps the held focus ring clear; toggling never scrolls on its own', async () => {
    /* a short report whose last block is folded: closed it fits, open it does not */
    const report = {
      ask: 'read', why: 'The weekly numbers are in.',
      blocks: [
        { type: 'facts', items: [{ label: 'Orders', value: '412' }, { label: 'Returns', value: '9' }] },
        { type: 'text', title: 'Details', collapsed: true, md: Array.from({ length: 30 }, (_, i) => `- Line ${i + 1} of the weekly details`).join('\n') },
      ],
    };
    for (const colorScheme of ['light', 'dark']) {
      await server.clearRuns();
      const run = show({ title: 'Ausklappen', identity: { name: 'Operations Agent' } }, report);
      const { ctx, page, log } = await open('run=' + run.run_id, { colorScheme });
      try {
        const px = parseFloat(await fadeHeight(page));
        /* the window just holds the page: the closed report fits, the footer
           right under it */
        const natural = await page.evaluate(() => Math.ceil(document.getElementById('rs-submitbar').getBoundingClientRect().bottom));
        await page.setViewportSize({ width: 1280, height: natural });
        await page.waitForTimeout(100);
        await tabToSummary(page);
        const fits = await held(page, px);
        assert.equal(fits.more, false, `${colorScheme}: the closed report fits ${JSON.stringify(fits)}`);
        assert.ok(fits.ring <= fits.fadeTop + 0.5, `${colorScheme}: ring visible ${JSON.stringify(fits)}`);
        await page.keyboard.press('Enter');
        const opened = await held(page, px);
        assert.ok(opened.summary && opened.open && opened.more, `${colorScheme}: open, fade on, focus kept ${JSON.stringify(opened)}`);
        assert.ok(opened.ring <= opened.fadeTop + 0.5, `${colorScheme}: ring ${opened.ring} under the fade at ${opened.fadeTop}`);
        /* at most just clear: never more than the fade and the ring */
        assert.ok(opened.scroll >= 0 && opened.scroll < px + 8, `${colorScheme}: scrolled just clear (${opened.scroll})`);
        await page.keyboard.press('Enter');
        const closed = await held(page, px);
        assert.ok(closed.summary && !closed.open && !closed.more, `${colorScheme}: closed ${JSON.stringify(closed)}`);
        /* no scroll of its own: only the browser's clamp to the shorter content */
        assert.equal(closed.scroll, Math.min(opened.scroll, closed.end), `${colorScheme}: closing ${JSON.stringify(closed)}`);
        assert.equal(closed.top, opened.top + opened.scroll - closed.scroll);

        assert.deepEqual(log.errors, []);
      } finally { await ctx.close(); }
    }
    /* more already follows (the report goes on below the disclosure):
       toggling the focused disclosure never scrolls */
    await server.clearRuns();
    const longer = {
      ...report,
      blocks: [...report.blocks, { type: 'text', title: 'Below', md: Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n') }],
    };
    const run = show({ title: 'Mehr darunter', identity: { name: 'Operations Agent' } }, longer);
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      const px = parseFloat(await fadeHeight(page));
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(() => document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      await tabToSummary(page);
      const before = await held(page, px);
      assert.ok(before.more && before.ring <= before.fadeTop + 0.5, JSON.stringify(before));
      await page.keyboard.press('Enter');
      const opened = await held(page, px);
      await page.keyboard.press('Enter');
      const closed = await held(page, px);
      assert.deepEqual([opened.open, closed.open, opened.more, closed.more], [!before.open, before.open, true, true]);
      assert.deepEqual([opened.scroll, closed.scroll], [before.scroll, before.scroll]);
      assert.deepEqual([opened.top, closed.top], [before.top, before.top]);
    } finally { await ctx.close(); }
  });

  test('a decided report fades at the window edge too, in the footer column', async () => {
    await server.clearRuns();
    const run = server.show(media.map(payloadFixture('report-long')), { title: 'Gelesen' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(() => document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      const fade = await fadeHeight(page);
      /* the painted box of .rs-main::after, from the DevTools protocol */
      const cdp = await ctx.newCDPSession(page);
      const column = async () => {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.rs-main' });
        const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 1 });
        const after = (node.pseudoElements || []).find((p) => p.pseudoType === 'after');
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: after.backendNodeId });
        const main = await page.evaluate(() => document.querySelector('.rs-main').getBoundingClientRect().left);
        const mount = await page.evaluate(() => document.getElementById('rs-mount').getBoundingClientRect().bottom);
        return { left: model.border[0] - main, width: model.width, height: model.height, bottom: model.border[5], mount };
      };
      const bar = await page.evaluate(() => {
        const inner = document.querySelector('.rs-submitbar__inner').getBoundingClientRect();
        const main = document.querySelector('.rs-main').getBoundingClientRect();
        return { left: inner.left - main.left, width: inner.width };
      });
      const atOpen = await column();
      assert.deepEqual([atOpen.left, atOpen.width, `${atOpen.height}px`, atOpen.bottom], [bar.left, bar.width, fade, atOpen.mount], 'the footer column, above the footer');
      await page.click('#rs-submit');
      assert.equal((await result(run)).data.decision, 'read');
      await page.waitForFunction(() => document.getElementById('rs-task').getAttribute('data-state') === 'decided');
      await page.evaluate(() => { document.getElementById('rs-mount').scrollTop = 0; });
      await page.waitForFunction(() => document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      assert.deepEqual(await fold(page), { more: true, fade, scrolls: true }, 'decided, at rest');
      const sent = await column();
      assert.deepEqual([sent.left, sent.width, `${sent.height}px`], [bar.left, bar.width, fade], 'the same column');
      assert.equal(sent.bottom, sent.mount, 'at the bottom edge of the mount');
      if (await page.isHidden('#rs-submitbar')) assert.equal(sent.mount, 720, 'the window edge');
      await page.evaluate(() => { const m = document.getElementById('rs-mount'); m.scrollTop = m.scrollHeight; });
      await page.waitForFunction(() => !document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      assert.deepEqual(await fold(page), { more: false, fade: null, scrolls: true }, 'decided, at the end');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('a reload event (a page from an earlier desk run) loads the page again', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      /* the first event stream answers as the desk does to a stale page */
      let streams = 0;
      await page.route(/\/events\?/, (route) => {
        streams += 1;
        if (streams > 1) return route.continue();
        return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 3600000\n\nevent: reload\ndata: {}\n\n' });
      });
      let loads = 0;
      page.on('load', () => { loads += 1; });
      await page.goto(server.url('?client=test'));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
      const deadline = Date.now() + 5000;
      while ((loads < 2 || streams < 2) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.equal(loads, 2, 'the page loaded once more');
      assert.ok(streams >= 2, 'the reloaded page connects again');
    } finally { await ctx.close(); }
  });

  test('no open reports: empty state and title', async () => {
    await server.clearRuns();
    const { ctx, page } = await open();
    try {
      assert.equal(await page.title(), 'grokbot-desk · keine offenen Berichte');
      assert.equal(await page.textContent('.rs-empty'), de.no_runs);
      assert.equal(await page.isHidden('#rs-submitbar'), true);
    } finally { await ctx.close(); }
  });
});

if (!existsSync(AXE)) throw new Error('vendor/axe.min.js missing');
