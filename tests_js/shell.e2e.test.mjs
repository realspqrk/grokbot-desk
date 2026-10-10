// Browser tests for the served shell + _starter + core components (plan 2.5).
// Isolated server in the worker's assigned range with a temp RS_DATA_DIR; headless Edge via
// playwright-core loaded by absolute path. The server is stopped in after().
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';
import round5Corpus from './fixtures/twitter-text-round5.mjs';

// RS_E2E_PORT: another worktree may run this suite at the same time
const PORT = Number(process.env.RS_E2E_PORT || 18900);
if (PORT === 18742) throw new Error('refusing the product port');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STARTER = path.join(ROOT, 'templates/builtin/_starter');
const golden = JSON.parse(readFileSync(path.join(STARTER, 'fixtures/golden.json'), 'utf8'));
const expect = JSON.parse(readFileSync(path.join(STARTER, 'fixtures/expect/golden.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const AXE = path.join(ROOT, 'vendor/axe.min.js');
const round4Corpus = JSON.parse(
  readFileSync(new URL('./fixtures/twitter-text-round4.json', import.meta.url), 'utf8'),
);
const sharedReviewCorpus = [...round4Corpus.cases, ...round5Corpus.cases];
const require = createRequire(import.meta.url);
const nodeCount = require('../core/static/count.js').count;

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('report-shell page (served, headless Edge)', { skip }, () => {
  beforeEach((t) => { if (process.env.RS_TRACE) console.error('START', t.name, new Date().toISOString()); });
  let server;
  let browser;

  before(async () => {
    server = await startServer({ port: PORT });
    const show = server.show;
    server.show = (data, extra = {}) => show(data, {
      bot: 'operations-agent',
      ...extra,
    });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

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
  const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
  // calm UI: the starter note sits behind its "Notiz hinzufügen" text button
  async function fillNote(page, text) {
    const opener = page.locator('[data-starter="note-open"]');
    if (await opener.isVisible()) await opener.click();
    await page.fill('#starter-note', text);
  }
  const activeId = (page) => page.evaluate(() => window.RS.activeRun);

  test('renders the starter golden: strings, copy text, CSP, same-origin only, no console errors', async () => {
    const run = server.show(golden, { title: 'Sicherung prüfen' });
    const { ctx, page, log, response } = await open('run=' + run.run_id);
    try {
      assert.match(response.headers()['content-security-policy'], /default-src 'self'/);
      assert.equal(await page.getAttribute('html', 'lang'), 'de');
      // shown in a visible, focused window -> POST /read -> no "● " prefix
      await page.waitForFunction(() => document.title === 'Sicherung prüfen · Operations Agent', null, { timeout: 3000 });
      assert.equal(await page.textContent('#rs-title'), 'Sicherung prüfen');
      // calm UI: bot and creation time live in the header overflow panel
      assert.match(await page.textContent('#rs-meta'), /^Von Operations AgentErstellt (Mo|Di|Mi|Do|Fr|Sa|So) \d\d\.\d\d\.\d{4} · \d\d:\d\d$/);
      assert.equal(await page.textContent('[data-starter="message"]'), golden.message);
      assert.equal(await page.textContent('[data-copy-id="starter-copy"] .rs-copy__value'), expect.copies['starter-copy']);
      // calm UI: no visible item heading; it names the decision group instead
      assert.equal(await page.getAttribute('rs-action-row', 'aria-label'), de.choice_group_label.replace('{what}', de.starter_heading));
      assert.equal(await page.textContent('#rs-submit-label'), de.submit);
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.textContent('#rs-status'), de.starter_pick_choice);
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
    const run = server.show(golden, { title: 'Zähler prüfen' });
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
      assert.deepEqual(measurement.result, { count: 68, limit: 280, over: false });
      assert.ok(measurement.elapsed < 50, `counter took ${measurement.elapsed.toFixed(1)} ms`);
    } finally { await ctx.close(); }
  });

  test('X counter keeps adversarial URL parentheses below the Edge deadlines', async () => {
    const run = server.show(golden, { title: 'URL-Laufzeit prüfen' });
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
    const run = server.show(golden, { title: 'URL-Korpus prüfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      const cases = sharedReviewCorpus.flatMap(({ text, upstream_count: value }) => [
        { text, count: value, over: value > 280 },
        { text: 'a'.repeat(279 - value) + ' ' + text, count: 280, over: false },
        { text: 'a'.repeat(280 - value) + ' ' + text, count: 281, over: true },
      ]);
      const expected = cases.map(({ count, over }) => ({ count, over }));
      const node = cases.map(({ text }) => {
        const result = nodeCount(text, 'x');
        return { count: result.count, over: result.over };
      });
      const edge = await page.evaluate((items) => items.map(({ text }) => {
        const result = RS_COUNT.count(text, 'x');
        return { count: result.count, over: result.over };
      }), cases);
      assert.deepEqual(node, expected, 'Node equals pinned upstream');
      assert.deepEqual(edge, expected, 'Edge equals pinned upstream');
      assert.deepEqual(edge, node, 'Node and Edge agree');
    } finally { await ctx.close(); }
  });

  test('localization contracts fill data-rs-t-<attr> and report the title with POST /title', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Titel melden' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    try {
      assert.equal(await page.getAttribute('#starter-note', 'placeholder'), de.starter_note_placeholder);
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

  test('axe-core: 0 serious/critical violations, light and dark', async () => {
    const run = server.show(golden, { title: 'Sicherung prüfen' });
    for (const colorScheme of ['light', 'dark']) {
      const { ctx, page } = await open('run=' + run.run_id, { colorScheme });
      try {
        await page.addScriptTag({ path: AXE });
        const v = await page.evaluate(async () => (await window.axe.run(document)).violations
          .filter((x) => x.impact === 'serious' || x.impact === 'critical')
          .map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target.join(' ')) })));
        assert.deepEqual(v, [], colorScheme);
      } finally { await ctx.close(); }
    }
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

  test('finding 2: reload restores the working field focus and selection with the draft', async () => {
    const run = server.show(golden, { title: 'Pfeiltasten' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    try {
      const radios = () => page.$$eval('rs-action-row button', (b) => b.map((x) => [x.value, x.getAttribute('aria-checked'), x.tabIndex]));
      assert.deepEqual(await radios(), [['erledigt', 'false', 0], ['spaeter', 'false', -1]]);
      assert.equal(await page.getAttribute('rs-action-row', 'role'), 'radiogroup');
      assert.equal(await page.getAttribute('rs-action-row', 'aria-label'), 'Entscheidung: Beispielbericht');
      await page.focus('rs-action-row button[value="erledigt"]');
      const logged = page.waitForRequest((r) => r.url() === ORIGIN + '/log');
      await page.keyboard.press('ArrowRight');
      const body = JSON.parse((await logged).postData());
      assert.deepEqual(body, { run_id: run.run_id, event: 'choice', detail: { item: 'starter', choice: 'spaeter' } });
      assert.deepEqual(await radios(), [['erledigt', 'false', -1], ['spaeter', 'true', 0]]);
      assert.equal(await page.evaluate(() => document.activeElement.value), 'spaeter');
      await page.keyboard.press('ArrowRight'); // wraps
      assert.deepEqual(await radios(), [['erledigt', 'true', 0], ['spaeter', 'false', -1]]);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.isDisabled('#rs-submit'), false);
      await fillNote(page, 'Später ansehen 👀');
      await page.$eval('#starter-note', (note) => {
        note.setSelectionRange(3, 9, 'backward');
        note.dispatchEvent(new Event('select', { bubbles: true }));
      });
      assert.equal(await page.evaluate(() => window.RS.touched), true);

      await page.reload();
      await ready(page);
      assert.deepEqual(await radios(), [['erledigt', 'false', -1], ['spaeter', 'true', 0]]);
      assert.equal(await page.inputValue('#starter-note'), 'Später ansehen 👀');
      assert.equal(await page.isDisabled('#rs-submit'), false);
      assert.equal(await page.evaluate(() => window.RS.touched), true);
      assert.deepEqual(await page.evaluate(() => {
        const note = document.getElementById('starter-note');
        return {
          active: document.activeElement.id,
          start: note.selectionStart,
          end: note.selectionEnd,
          direction: note.selectionDirection,
        };
      }), { active: 'starter-note', start: 3, end: 9, direction: 'backward' });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('rs-copy: click posts the exact text to /copy, shows Kopiert ✓ and announces it', async () => {
    const run = server.show(golden, { title: 'Kopieren' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.route('**/copy', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: '{"ok":true}',
      }));
      const reqP = page.waitForRequest((r) => r.url() === ORIGIN + '/copy');
      const resP = page.waitForResponse((r) => r.url() === ORIGIN + '/copy');
      await page.click('[data-copy-id="starter-copy"] .rs-copy__btn');
      const req = await reqP;
      const res = await resP;
      assert.deepEqual(JSON.parse(req.postData()), { run_id: run.run_id, text: expect.copies['starter-copy'] });
      assert.equal(req.headers()['x-rs-csrf'] !== undefined, true);
      assert.equal(res.status(), 200);
      assert.deepEqual(await res.json(), { ok: true });
      await page.waitForSelector('[data-copy-id="starter-copy"][data-state="copied"]');
      // calm UI: icon-only copy button; the name stays, feedback is the check icon + toast
      assert.equal(await page.getAttribute('[data-copy-id="starter-copy"] .rs-copy__btn', 'aria-label'), golden.copy.label);
      assert.equal(await page.getAttribute('#rs-toasts', 'aria-live'), 'polite');
      assert.ok((await page.$$eval('#rs-toasts .rs-toast', (t) => t.map((x) => x.textContent))).includes(de.copied));
      assert.equal(await page.evaluate(() => window.RS.touched), true);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  // review round 2, finding 3: an API object belongs to one activation
  test('scoped API: stale side effects cannot affect the active run or its requests', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'Scoped A', created: isoAt(Date.now() - 60000) });
    const b = server.show(golden, { title: 'Scoped B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    const sideEffects = [];
    try {
      for (const endpoint of ['copy', 'reveal', 'submit']) {
        await page.route(`**/${endpoint}`, (route) => {
          sideEffects.push({ endpoint, body: route.request().postDataJSON() });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        });
      }
      await page.evaluate(() => {
        window.__scoped = {};
        window.RS._define('_starter', function (api) {
          window.__scoped[api.run.run_id] = api;
          api.setResult({ choice: 'erledigt', note: '' });
          if (api.run.title === 'Scoped A') api.draft.set({ choice: 'spaeter', note: 'keep A' });
        });
      });
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await ready(page);
      await page.click(`.rs-strip__run[data-run-id="${a.run_id}"]`);
      await ready(page);
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await ready(page);
      const before = await page.evaluate((id) => ({
        touched: window.RS.touched,
        draft: localStorage.getItem('rs-draft:' + id),
      }), a.run_id);
      assert.equal(before.touched, false);
      assert.ok(before.draft && before.draft.includes('keep A'));

      await page.evaluate(async (id) => {
        const old = window.__scoped[id];
        await Promise.all([
          old.copy('stale copy'),
          old.reveal('stale-media'),
          old.submit(),
        ]);
        old.draft.set({ choice: 'erledigt', note: 'overwrite A' });
        old.draft.clear();
        old.toast('stale toast');
        old.setStatus('stale status');
        old.setSubmitLabel('stale label');
        old.setResult(null);
      }, a.run_id);
      await page.waitForTimeout(100);

      assert.deepEqual(sideEffects, []);
      assert.equal(await page.evaluate(() => window.RS.touched), false);
      assert.ok(await page.evaluate((id) => localStorage.getItem('rs-draft:' + id), a.run_id), 'A draft remains');
      assert.equal(await page.locator('#rs-toasts').getByText('stale toast').count(), 0);
      assert.notEqual(await page.textContent('#rs-submit-label'), 'stale label');
      assert.notEqual(await page.textContent('#rs-status'), 'stale status');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('rs-confirm on the real page: exact word only, Esc cancels', async () => {
    const run = server.show(golden, { title: 'Bestätigen' });
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

  test('expect.flow (mouse) + Ctrl+Enter writes the result file = expect.result', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Ablauf Maus' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    try {
      for (const step of expect.flow) await runStep(page, step);
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
      assert.equal(await page.textContent('.rs-banner > span:first-child'), de.sent);
      const result = server.result(run.run_id);
      assert.equal(result.status, 'submitted');
      assert.deepEqual(result.data, expect.result);
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.evaluate(() => document.querySelector('.rs-tpl').inert), false);
      assert.equal(await page.isDisabled('rs-action-row button[value="erledigt"]'), true);
      assert.equal(await page.$eval('#starter-note', (note) => note.readOnly), true);
      assert.equal(await page.isEnabled('[data-copy-id="starter-copy"] .rs-copy__btn'), true);
      assert.equal(await page.title(), 'grokbot-desk · keine offenen Berichte');
      assert.equal(await page.evaluate((id) => localStorage.getItem('rs-draft:' + id), run.run_id), null);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('expect.keyboard (keys only, one open run) writes the same result', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Ablauf Tastatur' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      for (const step of expect.keyboard) await runStep(page, step);
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
      assert.deepEqual(server.result(run.run_id).data, expect.result);
    } finally { await ctx.close(); }
  });

  test('every Tab stop shows a focus outline of at least 2 px', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Fokus' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      const seen = [];
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(() => {
          const a = document.activeElement;
          const s = getComputedStyle(a);
          return {
            tag: a.tagName,
            id: a.id,
            cls: a.className,
            w: parseFloat(s.outlineWidth),
            style: s.outlineStyle,
            tab: a.tabIndex,
            fv: a.matches(':focus-visible'),
            hasFocus: document.hasFocus(),
            token: getComputedStyle(document.documentElement)
              .getPropertyValue('--rs-focus-width').trim(),
          };
        });
        seen.push(f);
        if (f.tag === 'BODY') break;
        assert.ok(f.w >= 2 && f.style !== 'none', 'outline on ' + JSON.stringify(f));
      }
      const order = seen.filter((f) => f.tag !== 'BODY').map((f) => f.id || f.cls.split(' ')[0] || f.tag);
      // the disabled submit button is not a tab stop until a choice is made
      // calm UI: one run = no strip; theme lives behind the overflow button,
      // the copy is an icon button and the note opens from a text button
      assert.deepEqual(order.slice(0, 5), ['rs-more-btn', 'rs-icon-btn', 'rs-choice', 'rs-link', 'rs-discard']);
    } finally { await ctx.close(); }
  });

  test('Verwerfen asks first, then writes a cancelled result', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Verwerfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.click('#rs-discard');
      assert.equal(await page.evaluate(() => document.getElementById('rs-discard-dialog').open), true);
      assert.equal(await page.textContent('#rs-discard-h'), de.discard_confirm_title);
      await page.click('#rs-discard-dialog button[value="cancel"]');
      assert.equal(server.result(run.run_id), null);
      await page.click('#rs-discard');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
      assert.equal(server.result(run.run_id).status, 'cancelled');
      assert.equal(await page.isDisabled('#rs-discard'), true);
    } finally { await ctx.close(); }
  });

  test('finding 4: closing Verwerfen never steals focus after a fast Tab', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Fokus nach Verwerfen' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      await page.click('rs-action-row button[value="erledigt"]');
      for (let i = 0; i < 20; i++) {
        await page.focus('#rs-discard');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-submit');
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-submit');
      }
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('a stale Verwerfen close event cannot consume a dialog reopened in the same task', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Verwerfen erneut öffnen' });
    const { ctx, page } = await open('run=' + run.run_id);
    const cancels = [];
    page.on('request', (request) => {
      if (request.url() === ORIGIN + '/cancel') cancels.push(request.postDataJSON());
    });
    try {
      await page.click('#rs-discard');
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

  // review round 1, finding 1: the confirmation keeps its target
  const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const dialogOpen = (page) => page.evaluate(() => document.getElementById('rs-discard-dialog').open);

  test('Verwerfen: a push while the confirmation is open neither switches nor changes the target', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'Ziel A', created: isoAt(Date.now() - 60000) });
    const { ctx, page, log } = await open('run=' + a.run_id);
    try {
      await page.click('#rs-discard'); // A untouched, confirmation open
      const b = server.show(golden, { title: 'Neu B', created: isoAt(Date.now()) });
      await page.waitForSelector(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await page.waitForTimeout(300); // a switch would have started by now
      assert.equal(await activeId(page), a.run_id, 'no automatic switch under the confirmation');
      assert.equal(await page.textContent('#rs-title'), 'Ziel A');
      assert.equal(await dialogOpen(page), true);
      const req = page.waitForRequest((r) => r.url() === ORIGIN + '/cancel');
      await page.click('#rs-discard-dialog button[value="discard"]');
      assert.deepEqual(JSON.parse((await req).postData()), { run_id: a.run_id });
      // P8d: the discard is a decision, so the pop-up moves on to B
      await page.waitForFunction((id) => window.RS.activeRun === id
        && document.documentElement.dataset.rsReady === '1', b.run_id);
      assert.equal(server.result(a.run_id).status, 'cancelled');
      assert.equal(server.result(b.run_id), null, 'B has no result');
      assert.equal(await page.textContent('#rs-title'), 'Neu B');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('Verwerfen: the confirmation closes when its target is decided elsewhere or expires', async () => {
    await server.clearRuns();
    // decided elsewhere (bot/CLI cancel through the API)
    const a = server.show(golden, { title: 'Ziel extern' });
    {
      const { ctx, page } = await open('run=' + a.run_id);
      const cancels = [];
      page.on('request', (r) => { if (r.url() === ORIGIN + '/cancel') cancels.push(r); });
      try {
        await page.click('#rs-discard');
        assert.equal(await dialogOpen(page), true);
        await server.clearRuns(); // cancels A through POST /cancel
        await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
        await page.waitForFunction(() => !document.getElementById('rs-discard-dialog').open, null, { timeout: 3000 });
        assert.equal(cancels.length, 0, 'the page sent no cancel');
      } finally { await ctx.close(); }
    }
    // expiry: created 5 min - 3 s ago, expires after 5 min
    const e = server.show(golden, { title: 'Ziel läuft ab', created: isoAt(Date.now() - 300000 + 3000), expires_minutes: 5 });
    {
      const { ctx, page, log } = await open('run=' + e.run_id);
      const cancels = [];
      page.on('request', (r) => { if (r.url() === ORIGIN + '/cancel') cancels.push(r); });
      try {
        await page.click('#rs-discard');
        assert.equal(await dialogOpen(page), true);
        await page.waitForSelector('.rs-banner[data-banner="expired"]', { timeout: 8000 });
        await page.waitForFunction(() => !document.getElementById('rs-discard-dialog').open, null, { timeout: 3000 });
        assert.equal(server.result(e.run_id).status, 'expired');
        assert.equal(cancels.length, 0);
        assert.equal(await page.isDisabled('#rs-discard'), true);
        assert.deepEqual(log.errors, []);
      } finally { await ctx.close(); }
    }
  });

  // review round 1, finding 4
  test('Verwerfen: a failed /cancel request leaves the bar usable, keeps the draft, and the retry works', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Abbruch scheitert' });
    const { ctx, page } = await open('run=' + run.run_id);
    let held;
    try {
      await page.click('rs-action-row button[value="erledigt"]');
      await fillNote(page, 'bleibt');
      await page.route('**/cancel', (route) => { held = route; });
      await page.click('#rs-discard');
      const requested = page.waitForRequest((request) => request.url() === ORIGIN + '/cancel');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await requested;
      assert.equal(await page.isDisabled('rs-action-row button[value="erledigt"]'), true);
      assert.equal(await page.$eval('#starter-note', (note) => note.readOnly), true);
      assert.equal(await page.isEnabled('[data-copy-id="starter-copy"] .rs-copy__btn'), true);
      assert.equal(await page.isEnabled(`.rs-strip__run[data-run-id="${run.run_id}"]`), true);
      await held.abort('connectionfailed');
      await page.waitForFunction((msg) => [...document.querySelectorAll('#rs-toasts .rs-toast')].some((x) => x.textContent === msg), de.discard_failed, { timeout: 3000 });
      assert.equal(await page.isDisabled('#rs-submit'), false, 'An Bot senden usable again');
      assert.equal(await page.isDisabled('#rs-discard'), false, 'Verwerfen usable again');
      assert.equal(await page.isDisabled('rs-action-row button[value="erledigt"]'), false);
      assert.equal(await page.$eval('#starter-note', (note) => note.readOnly), false);
      assert.equal(server.result(run.run_id), null);
      assert.equal(await page.inputValue('#starter-note'), 'bleibt');
      assert.ok(await page.evaluate((id) => localStorage.getItem('rs-draft:' + id), run.run_id), 'draft kept');
      await page.unroute('**/cancel');
      await page.click('#rs-discard');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
      assert.equal(server.result(run.run_id).status, 'cancelled');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  // review round 2, finding 4: busy belongs to a run and operation token
  test('switching during submit keeps the selected run busy until its own submit completes', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'Submit A', created: isoAt(Date.now() - 60000) });
    const b = server.show(golden, { title: 'Submit B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    const held = [];
    try {
      await page.route('**/submit', (route) => { held.push(route); });
      await page.click('rs-action-row button[value="erledigt"]');
      const requestA = page.waitForRequest((r) => r.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      await requestA;
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await ready(page);
      await page.click('rs-action-row button[value="erledigt"]');
      await fillNote(page, 'B remains pending');
      const requestB = page.waitForRequest((r) => r.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      await requestB;
      assert.equal(await page.isDisabled('#rs-submit'), true);

      await held[0].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      assert.equal(await page.inputValue('#starter-note'), 'B remains pending');
      assert.equal(await page.$eval('#starter-note', (note) => note.readOnly), true);
      assert.equal(await page.isDisabled('#rs-submit'), true, 'A completion cannot unlock B');
      assert.equal(await page.isDisabled('#rs-discard'), true, 'A completion cannot unlock B discard');

      await held[1].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('switching during cancel keeps the selected run busy until its own cancel completes', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'Cancel A', created: isoAt(Date.now() - 60000) });
    const b = server.show(golden, { title: 'Cancel B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    const held = [];
    try {
      await page.route('**/cancel', (route) => { held.push(route); });
      await page.click('#rs-discard');
      const requestA = page.waitForRequest((r) => r.url() === ORIGIN + '/cancel');
      await page.click('#rs-discard-dialog button[value="discard"]');
      await requestA;
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await ready(page);
      await page.click('#rs-discard');
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
    const run = server.show(golden, { title: 'Lesen scheitert' });
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

  test('failed run switch keeps the rendered form live and submits its exact edited draft', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'Switch bleibt A', created: isoAt(Date.now() - 60000) });
    const b = server.show(golden, { title: 'Switch scheitert B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    try {
      await page.click('rs-action-row button[value="erledigt"]');
      await fillNote(page, 'old note');
      await page.route(`**/api/run/${b.run_id}`, (route) => route.abort('connectionfailed'));
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await page.waitForFunction((message) => [...document.querySelectorAll('#rs-toasts .rs-toast')]
        .some((item) => item.textContent === message), de.run_load_failed);

      assert.equal(await activeId(page), a.run_id);
      assert.equal(await page.textContent('#rs-title'), 'Switch bleibt A');
      assert.equal(await page.getAttribute('html', 'data-rs-ready'), '1');
      await page.click('rs-action-row button[value="spaeter"]');
      await fillNote(page, 'new note after failed switch');
      const expected = { choice: 'spaeter', note: 'new note after failed switch' };
      assert.deepEqual(
        await page.evaluate((id) => JSON.parse(localStorage.getItem('rs-draft:' + id)).value, a.run_id),
        expected,
      );
      assert.equal(await page.isDisabled('#rs-submit'), false);

      const submitted = page.waitForRequest((request) => request.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      assert.deepEqual(JSON.parse((await submitted).postData()), { run_id: a.run_id, data: expected });
      await page.unroute(`**/api/run/${b.run_id}`);
      // P8d: once sent, the pop-up advances to B
      await page.waitForFunction((id) => window.RS.activeRun === id
        && document.documentElement.dataset.rsReady === '1', b.run_id);
      assert.deepEqual(server.result(a.run_id).data, expected);
      assert.equal(await page.evaluate((id) => localStorage.getItem('rs-draft:' + id), a.run_id), null);
      assert.equal(server.result(b.run_id), null);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('finding 5: an HTTP 500 run switch reports a retryable load error and preserves the URL', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'Aktiv A', created: isoAt(Date.now() - 60000) });
    const b = server.show(golden, { title: 'Fehler B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    try {
      await page.click('rs-action-row button[value="erledigt"]');
      await page.route(`**/api/run/${b.run_id}`, (route) => route.fulfill({
        status: 500, contentType: 'application/json', body: '{"error":"injected"}',
      }));
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await page.waitForFunction((message) => [...document.querySelectorAll('#rs-toasts .rs-toast')]
        .some((item) => item.textContent === message), de.run_load_failed);
      assert.equal(await activeId(page), a.run_id);
      assert.equal(new URL(page.url()).searchParams.get('run'), a.run_id);
      assert.equal(await page.isEnabled('#starter-note'), true);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('delayed successful switch retires the old result only when the replacement commits', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'Verzögert A', created: isoAt(Date.now() - 60000) });
    const b = server.show(golden, { title: 'Verzögert B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    let held;
    try {
      await page.click('rs-action-row button[value="erledigt"]');
      await fillNote(page, 'A before request');
      await page.route(`**/api/run/${b.run_id}`, (route) => { held = route; });
      const requested = page.waitForRequest((request) => request.url().endsWith('/api/run/' + b.run_id));
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await requested;

      await page.click('rs-action-row button[value="spaeter"]');
      await fillNote(page, 'A while B is delayed');
      assert.equal(await activeId(page), a.run_id);
      assert.deepEqual(
        await page.evaluate((id) => JSON.parse(localStorage.getItem('rs-draft:' + id)).value, a.run_id),
        { choice: 'spaeter', note: 'A while B is delayed' },
      );

      const response = await held.fetch();
      await held.fulfill({ response });
      await page.waitForFunction((id) => window.RS.activeRun === id
        && document.documentElement.dataset.rsReady === '1', b.run_id);
      assert.equal(await page.textContent('#rs-title'), 'Verzögert B');
      assert.equal(await page.evaluate(() => document.querySelector('rs-action-row').value), '');
      assert.equal(await page.inputValue('#starter-note'), '');
      assert.equal(await page.isDisabled('#rs-submit'), true, 'A result cannot enable B submit');

      const expected = { choice: 'erledigt', note: 'B exact result' };
      await page.click('rs-action-row button[value="erledigt"]');
      await fillNote(page, expected.note);
      const submitted = page.waitForRequest((request) => request.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      assert.deepEqual(JSON.parse((await submitted).postData()), { run_id: b.run_id, data: expected });
      // P8d: once sent, the pop-up advances to the open A with its draft
      await page.waitForFunction((id) => window.RS.activeRun === id
        && document.documentElement.dataset.rsReady === '1', a.run_id);
      assert.deepEqual(server.result(b.run_id).data, expected);
      assert.equal(server.result(a.run_id), null);
      assert.equal(await page.inputValue('#starter-note'), 'A while B is delayed');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('finding 1: a successful run switch updates the URL and reload keeps that run', async () => {
    await server.clearRuns();
    const a = server.show(golden, { title: 'URL A', created: isoAt(Date.now() - 60000) });
    const b = server.show(golden, { title: 'URL B', created: isoAt(Date.now()) });
    const { ctx, page } = await open('run=' + a.run_id);
    try {
      await page.click(`.rs-strip__run[data-run-id="${b.run_id}"]`);
      await ready(page);
      await page.click('rs-action-row button[value="spaeter"]');
      await fillNote(page, 'Entwurf in B');
      assert.equal(new URL(page.url()).searchParams.get('run'), b.run_id);
      await page.reload();
      await ready(page);
      assert.equal(await activeId(page), b.run_id);
      assert.equal(await page.inputValue('#starter-note'), 'Entwurf in B');
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('finding 3: a reopened submitted run shows its result read-only and copy still works', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Entschieden wieder öffnen' });
    const first = await open('run=' + run.run_id);
    try {
      await first.page.click('rs-action-row button[value="spaeter"]');
      await fillNote(first.page, 'Gesendete Notiz');
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
      assert.equal(await page.$eval('rs-action-row', (row) => row.value), 'spaeter');
      assert.equal(await page.inputValue('#starter-note'), 'Gesendete Notiz');
      assert.equal(await page.textContent('#rs-status'), '');
      assert.equal(await page.$eval('#starter-note', (note) => note.readOnly), true);
      assert.equal(await page.isDisabled('rs-action-row button[value="spaeter"]'), true);
      assert.equal(await page.isEnabled('[data-copy-id="starter-copy"] .rs-copy__btn'), true);
      await page.click('[data-copy-id="starter-copy"] .rs-copy__btn');
      assert.deepEqual(copies, [{ run_id: run.run_id, text: expect.copies['starter-copy'] }]);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  async function submitElsewhere(runId, data) {
    const response = await fetch(server.url('submit'), {
      method: 'POST',
      headers: { 'X-RS-CSRF': await server.csrf(), 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ run_id: runId, data }),
    });
    return response.status;
  }

  test('a live report submitted by another client hydrates the sent result read-only', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Anderswo gesendet' });
    const { ctx, page, log } = await open('run=' + run.run_id);
    const copies = [];
    try {
      await page.route('**/copy', (route) => {
        copies.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.click('rs-action-row button[value="erledigt"]');
      await fillNote(page, 'lokaler Entwurf');
      const sent = { choice: 'spaeter', note: 'vom anderen Client' };
      assert.equal(await submitElsewhere(run.run_id, sent), 200);
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
      await page.waitForFunction((note) => document.getElementById('starter-note')?.value === note, sent.note, { timeout: 5000 });
      assert.equal(await page.$eval('rs-action-row', (row) => row.value), 'spaeter');
      assert.equal(await page.isDisabled('rs-action-row button[value="spaeter"]'), true);
      assert.equal(await page.$eval('#starter-note', (note) => note.readOnly), true);
      assert.equal(await page.isHidden('#rs-submitbar'), true);
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('rs-banner')), true);
      assert.equal(await page.isEnabled('[data-copy-id="starter-copy"] .rs-copy__btn'), true);
      await page.click('[data-copy-id="starter-copy"] .rs-copy__btn');
      assert.deepEqual(copies, [{ run_id: run.run_id, text: expect.copies['starter-copy'] }]);
      assert.deepEqual(server.result(run.run_id).data, sent, 'stored result unchanged');
      // this page's own late send is refused and changes nothing
      assert.equal(await submitElsewhere(run.run_id, { choice: 'erledigt', note: 'x' }), 409);
      assert.deepEqual(server.result(run.run_id).data, sent);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('a 409 on our own send hydrates the result another client sent first', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Wettlauf' });
    const { ctx, page } = await open('run=' + run.run_id);
    let held;
    try {
      await page.click('rs-action-row button[value="erledigt"]');
      await page.route('**/submit', (route) => { held = route; });
      const requested = page.waitForRequest((r) => r.url() === ORIGIN + '/submit');
      await page.click('#rs-submit');
      await requested;
      const sent = { choice: 'spaeter', note: 'zuerst' };
      assert.equal(await submitElsewhere(run.run_id, sent), 200);
      await held.continue();
      await page.waitForFunction((note) => document.getElementById('starter-note')?.value === note, sent.note, { timeout: 5000 });
      assert.equal(await page.$eval('rs-action-row', (row) => row.value), 'spaeter');
      assert.equal(await page.$eval('#starter-note', (note) => note.readOnly), true);
      assert.deepEqual(server.result(run.run_id).data, sent);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('finding 7: shell and kit expose only neutral fictional sample identities', async () => {
    await server.clearRuns();
    const run = server.show(golden, { title: 'Neutrale Beispiele' });
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      assert.match(await page.textContent('#rs-meta'), /Operations Agent/);
      const kit = await ctx.newPage();
      await kit.goto(pathToFileURL(path.join(ROOT, 'tools/dev/kit-preview.html')).href);
      const visible = await kit.locator('body').innerText();
      assert.match(visible, /Inbox Agent/);
      // P8d: the waiting report is an avatar in the strip, named by bot and title
      assert.match(await kit.getAttribute('.rs-strip__run:not([aria-current])', 'aria-label'), /^Social Agent · /);
      assert.match(visible, /Northwind/);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('switching rule, new dot, ● title prefix and Ctrl+1..3', async () => {
    await server.clearRuns();
    const t0 = Date.now() - 30 * 60000;
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
    const a = server.show(golden, { title: 'Bericht A', created: iso(t0) });
    const { ctx, page, log } = await open();
    try {
      assert.equal(await activeId(page), a.run_id);
      await page.waitForFunction(() => document.title === 'Bericht A · Operations Agent', null, { timeout: 3000 });

      // A untouched -> B takes over
      const b = server.show(golden, { title: 'Bericht B', created: iso(t0 + 60000) });
      await page.waitForFunction((id) => window.RS.activeRun === id && document.documentElement.dataset.rsReady === '1', b.run_id);
      await page.waitForFunction(() => !document.title.startsWith('●'));
      assert.equal(await page.title(), 'Bericht B · Operations Agent');

      // B touched -> C waits in the strip with its "new" dot, title gets "● "
      await page.click('rs-action-row button[value="erledigt"]');
      const c = server.show(golden, { title: 'Bericht C', created: iso(t0 + 120000) });
      await page.waitForSelector(`.rs-strip__run[data-run-id="${c.run_id}"] .rs-strip__dot[data-new]`);
      assert.equal(await activeId(page), b.run_id);
      assert.equal(
        await page.getAttribute(`.rs-strip__run[data-run-id="${c.run_id}"]`, 'aria-label'),
        `Operations Agent ${de.sep} Bericht C ${de.sep} ${de.new}`,
      );
      assert.equal(await page.title(), '● Bericht B · Operations Agent');
      const order = await page.$$eval('.rs-strip__run', (x) => x.map((e) => [e.dataset.runId, e.getAttribute('aria-keyshortcuts')]));
      assert.deepEqual(order, [[c.run_id, 'Control+1'], [b.run_id, 'Control+2'], [a.run_id, 'Control+3']]);

      // Ctrl+1 -> C (read: the dot turns to a ring, the prefix goes away)
      const read = page.waitForRequest((r) => r.url() === ORIGIN + '/read');
      await page.keyboard.press('Control+1');
      await read;
      await page.waitForFunction((id) => window.RS.activeRun === id && document.documentElement.dataset.rsReady === '1', c.run_id);
      await page.waitForFunction(() => document.title === 'Bericht C · Operations Agent', null, { timeout: 3000 });
      assert.equal(await page.$(`.rs-strip__run[data-run-id="${c.run_id}"] .rs-strip__dot[data-new]`), null);
      assert.equal(await page.getAttribute(`.rs-strip__run[data-run-id="${c.run_id}"]`, 'aria-current'), 'page');

      // Ctrl+2 -> B with its draft restored
      await page.keyboard.press('Control+2');
      await page.waitForFunction((id) => window.RS.activeRun === id && document.documentElement.dataset.rsReady === '1', b.run_id);
      assert.equal(await page.getAttribute('rs-action-row button[value="erledigt"]', 'aria-checked'), 'true');
      assert.equal(await page.isDisabled('#rs-submit'), false);

      // Ctrl+3 -> A
      await page.keyboard.press('Control+3');
      await page.waitForFunction((id) => window.RS.activeRun === id && document.documentElement.dataset.rsReady === '1', a.run_id);
      await page.waitForFunction(() => document.title === 'Bericht A · Operations Agent', null, { timeout: 3000 });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    await server.clearRuns();
  });

  test('expired run shows the expired banner and cannot be sent', async () => {
    const created = new Date(Date.now() - 20 * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    const run = server.show(golden, { title: 'Abgelaufen', created, expires_minutes: 5 });
    const deadline = Date.now() + 5000;
    while (!server.result(run.run_id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.result(run.run_id).status, 'expired');
    const { ctx, page } = await open('run=' + run.run_id);
    try {
      assert.equal(await page.textContent('.rs-banner[data-banner="expired"]'), de.run_expired_msg);
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.isDisabled('#rs-discard'), true);
      // P8d: a decided report is not in the strip of open reports
      assert.equal(await page.$(`.rs-strip__run[data-run-id="${run.run_id}"]`), null);
    } finally { await ctx.close(); }
  });

  test('no open runs: empty state and title', async () => {
    await server.clearRuns();
    const { ctx, page } = await open();
    try {
      assert.equal(await page.title(), 'grokbot-desk · keine offenen Berichte');
      assert.equal(await page.textContent('.rs-empty'), de.no_runs);
      assert.equal(await page.isHidden('#rs-submitbar'), true);
    } finally { await ctx.close(); }
  });
});

async function runStep(page, step) {
  if (step.click) await page.click(step.click);
  else if (step.fill) await page.fill(step.fill[0], step.fill[1]);
  else if (step.type) await page.keyboard.type(step.type);
  else if (step.press) {
    for (let i = 0; i < (step.repeat || 1); i++) await page.keyboard.press(step.press);
  } else throw new Error('unknown step ' + JSON.stringify(step));
}

if (!existsSync(AXE)) throw new Error('vendor/axe.min.js missing');
