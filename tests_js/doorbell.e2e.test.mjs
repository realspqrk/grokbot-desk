// The doorbell setup page (?page=doorbell, opened by `doorbell setup`): the
// person pastes URL and key, Save writes the file and rings a test, the page
// shows the outcome and on/off with the host, never the key. The test ring
// goes to a port where nothing listens, so the page must show the failure.
// Real server, temp RS_DATA_DIR, headless Edge.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT, PLAIN_REPORT } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';

// the desk and the refused ring target, both inside the test range 18920-18939
const PORT = e2ePort('doorbell.e2e.test.mjs');
const REFUSED = e2ePort('doorbell.e2e.test.mjs', 1);
const KEY = 'fake-doorbell-key-e2e-41b7';
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('doorbell setup page (served, headless Edge)', { skip }, () => {
  let server;
  let browser;

  before(async () => {
    server = await startServer({ port: PORT });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

  test('save writes the file, rings a test and shows the outcome without the key', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const answers = [];
    page.on('response', async (r) => {
      if (new URL(r.url()).pathname.includes('doorbell')) answers.push(await r.text());
    });
    try {
      await page.goto(server.url('?client=test&page=doorbell'));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      assert.equal(await page.textContent('#rs-title'), de.doorbell_title);
      await page.waitForFunction((text) => document.querySelector('#rs-doorbell-state')?.textContent === text, de.doorbell_off);
      assert.equal(await page.getAttribute('#rs-doorbell-key', 'type'), 'password');

      await page.fill('#rs-doorbell-url', 'http://hooks.example.test/ring');
      await page.fill('#rs-doorbell-key', KEY);
      await page.click('#rs-doorbell-save');
      await page.waitForFunction((text) => document.querySelector('#rs-doorbell-outcome')?.textContent === text, de.doorbell_invalid_url);
      assert.equal(await page.getAttribute('#rs-doorbell-url', 'aria-invalid'), 'true');
      assert.equal(await page.getAttribute('#rs-doorbell-url', 'aria-describedby'), 'rs-doorbell-outcome');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-doorbell-url');
      await page.fill('#rs-doorbell-url', 'https://hooks.example.test/ring');
      assert.equal(await page.getAttribute('#rs-doorbell-url', 'aria-invalid'), null, 'corrected: no longer marked');
      await page.fill('#rs-doorbell-key', '');
      await page.click('#rs-doorbell-save');
      await page.waitForFunction((text) => document.querySelector('#rs-doorbell-outcome')?.textContent === text, de.doorbell_missing_key);
      assert.equal(await page.getAttribute('#rs-doorbell-key', 'aria-invalid'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-doorbell-key');
      await page.fill('#rs-doorbell-key', KEY);
      assert.equal(existsSync(path.join(server.dataDir, 'doorbell.json')), false);

      // a report that arrives meanwhile waits; the form keeps its input
      const run = server.show(PLAIN_REPORT);
      await page.waitForSelector(`[data-run-id="${run.run_id}"]`, { state: 'attached' });
      assert.equal(await page.inputValue('#rs-doorbell-key'), KEY);

      await page.fill('#rs-doorbell-url', `https://127.0.0.1:${REFUSED}/ring`);
      await page.click('#rs-doorbell-save');
      await page.waitForFunction((text) => document.querySelector('#rs-doorbell-outcome')?.textContent === text,
        de.doorbell_saved_test_failed.replace('{reason}', de.doorbell_reason_unreachable));
      assert.equal(await page.textContent('#rs-doorbell-state'), de.doorbell_on.replace('{host}', '127.0.0.1'));
      assert.equal(await page.inputValue('#rs-doorbell-key'), '', 'the key leaves the page once saved');
      const saved = JSON.parse(readFileSync(path.join(server.dataDir, 'doorbell.json'), 'utf8'));
      assert.deepEqual(saved, { url: `https://127.0.0.1:${REFUSED}/ring`, key: KEY });

      await page.evaluate(() => { document.querySelector('#rs-doorbell-outcome').textContent = ''; });
      await page.click('#rs-doorbell-test');
      await page.waitForFunction((text) => document.querySelector('#rs-doorbell-outcome')?.textContent === text,
        de.doorbell_test_failed.replace('{reason}', de.doorbell_reason_unreachable));
      assert.ok(answers.length >= 5, 'GET, three saves and a test answered');
      assert.ok(answers.every((text) => !text.includes(KEY)), 'no answer carries the key');
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });

  test('an open window showing a report switches to the setup page; the report stays open', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    try {
      const run = server.show(PLAIN_REPORT, { title: 'Still open' });
      await page.goto(server.url('?client=test&run=' + run.run_id));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      assert.equal(await page.textContent('#rs-title'), 'Still open');
      const { token } = JSON.parse(readFileSync(path.join(server.dataDir, 'state.json'), 'utf8'));
      const response = await fetch(server.url('doorbell/show'), {
        method: 'POST', headers: { 'X-RS-Token': token, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 200);
      await page.waitForSelector('[data-rs-doorbell]');
      assert.equal(await page.textContent('#rs-title'), de.doorbell_title);
      // the open report keeps its inbox row
      await page.waitForSelector('#rs-inbox [data-run-id]', { state: 'attached' });
      assert.equal(server.result(run.run_id), null, 'the report is still open');
    } finally {
      await ctx.close();
    }
  });

  /* the inbox stays hidden with one open report: the setup page itself
     names what waits and opens it; the form keeps what was typed */
  async function waitingScenario(arrivesDuringSetup) {
    await server.stop();
    server = await startServer({ port: PORT });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    try {
      let run = arrivesDuringSetup ? null : server.show(PLAIN_REPORT, { title: 'Waiting report' });
      await page.goto(server.url('?client=test&page=doorbell'));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      await page.waitForSelector('[data-rs-doorbell]');
      await page.fill('#rs-doorbell-url', 'https://hooks.example.test/typed');
      if (arrivesDuringSetup) {
        assert.equal(await page.isVisible('#rs-doorbell-waiting'), false);
        run = server.show(PLAIN_REPORT, { title: 'Waiting report' });
      }
      await page.waitForSelector('#rs-doorbell-waiting', { state: 'visible' });
      assert.equal(await page.textContent('#rs-doorbell-waiting'), de.doorbell_waiting_one.replace('{title}', 'Waiting report'));
      assert.equal(await page.inputValue('#rs-doorbell-url'), 'https://hooks.example.test/typed');
      assert.equal(await page.locator('[data-rs-doorbell] .rs-btn--primary').count(), 1, 'Save stays the only accent');
      await page.click('#rs-doorbell-waiting');
      await page.waitForFunction(() => document.querySelector('#rs-title')?.textContent === 'Waiting report');
      await page.waitForSelector('#rs-mount .rs-report');
      assert.equal(server.result(run.run_id), null);
    } finally {
      await ctx.close();
    }
  }
  test('one report already waiting: the setup page names it and opens it', () => waitingScenario(false));
  test('the first report arriving during setup: named on the page, opens on click', () => waitingScenario(true));
});
