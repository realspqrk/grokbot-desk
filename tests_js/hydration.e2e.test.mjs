// A report decided by another client is hydrated from
// the authoritative result exactly once. The server announces the decision
// twice (SSE `runs`, then `run`), so the page fetches the run detail twice;
// whichever response comes later must not remount the decided report the user
// is already reading (open decision card, selected social tab, open approval
// disclosure, focused copy) or move focus back to the result banner.
// Real backend and real SSE: page.route only holds and orders the two real
// GET /api/run/<id> responses. Isolated server, temp RS_DATA_DIR, headless Edge.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 9;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (dir, f) => JSON.parse(readFileSync(path.join(ROOT, dir, f), 'utf8'));

const TEMPLATES = {
  _starter: {
    dir: 'templates/builtin/_starter',
    draft: (page) => page.click('rs-action-row button[value="erledigt"]'),
    sent: () => ({ choice: 'spaeter', note: 'AUTHORITATIVE' }),
    field: '#starter-note',
    /* keyboard copy of the decided report */
    async read(page) { await tabTo(page, '[data-copy-id="starter-copy"] .rs-copy__btn'); },
  },
  'decide-list': {
    dir: 'templates/builtin/decide-list',
    draft: (page) => page.click('rs-action-row[data-item="travel-workshop"] button[value="approve"]'),
    sent: (expect) => ({ ...expect.result, note: 'AUTHORITATIVE' }),
    field: '#dl-note',
    /* open the first decision card */
    async read(page, data) {
      await tabTo(page, `[data-item-id="${data.items[0].id}"] .dl-row`);
      await page.keyboard.press('Space');
      await page.waitForFunction((id) => document.querySelector('[data-current]')?.dataset.itemId === id, data.items[0].id);
    },
  },
  'preview-post': {
    dir: 'templates/builtin/preview-post',
    draft: (page) => page.check('#approve-x'),
    sent: () => ({ decision: 'request_changes', platforms: [], comment: 'AUTHORITATIVE' }),
    field: '#pp-comment',
    /* move from X to another platform tab */
    async read(page) {
      await tabTo(page, '[role="tab"][aria-selected="true"]');
      const first = await page.evaluate(() => document.activeElement.id);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction((id) => document.activeElement.getAttribute('role') === 'tab'
        && document.activeElement.id !== id && document.activeElement.getAttribute('aria-selected') === 'true', first);
    },
  },
  'approve-one': {
    dir: 'templates/builtin/approve-one',
    draft: async (page) => {
      await page.click('rs-action-row[data-item="decision"] button[value="request_changes"]');
      await page.fill('#ao-comment', 'LOCAL');
    },
    sent: () => ({ decision: 'request_changes', comment: 'AUTHORITATIVE' }),
    field: '#ao-comment',
    /* expand the reference disclosure */
    async read(page) {
      await tabTo(page, '[data-ao="reference-box"] > summary');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('[data-ao="reference-box"]')?.open === true);
    },
  },
};

async function tabTo(page, selector) {
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate((s) => document.activeElement.matches(s), selector)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('cannot Tab to ' + selector);
}

/* What the reader sees and where the keyboard is. */
const viewState = (page) => page.evaluate(() => {
  const focused = document.activeElement;
  return {
    focus: focused.id || focused.className,
    focusInTemplate: !!focused.closest('.rs-tpl'),
    current: document.querySelector('[data-current]')?.dataset.itemId || null,
    selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.id || null,
    referenceOpen: document.querySelector('[data-ao="reference-box"]')?.open || false,
    sameTemplate: document.querySelector('.rs-tpl')?.dataset.hydrationProbe === '1',
  };
});

/* The two real detail responses, delivered on the test's command. */
function holdDetails(page, runId) {
  const held = [];
  const waiters = [];
  page.route(`**/api/run/${encodeURIComponent(runId)}`, async (route) => {
    const response = await route.fetch();
    const entry = { deliver: () => route.fulfill({ response }) };
    held.push(entry);
    waiters.splice(0).forEach((w) => w());
  });
  return {
    held,
    async count(n) {
      const deadline = Date.now() + 8000;
      while (held.length < n) {
        if (Date.now() > deadline) throw new Error(`expected ${n} detail requests, saw ${held.length}`);
        await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
      }
    },
  };
}

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('external decision hydrates once (served, headless Edge)', { skip }, () => {
  let server;
  let browser;

  before(async () => {
    server = await startServer({ port: PORT, mediaRoots: [ROOT] });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

  async function submitElsewhere(runId, data) {
    const response = await fetch(server.url('submit'), {
      method: 'POST',
      headers: { 'X-RS-CSRF': await server.csrf(), 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ run_id: runId, data }),
    });
    return response.status;
  }

  /*
   * order: which of the two detail responses is delivered first ("first" =
   * the one requested first). The other one follows after the user has
   * started reading; `delay` adds a pause before that.
   */
  async function scenario(name, theme, order, delay) {
    const spec = TEMPLATES[name];
    const data = read(spec.dir, 'fixtures/golden.json');
    const sent = spec.sent(read(spec.dir, 'fixtures/expect/golden.json'));
    await server.clearRuns();
    const run = server.show(data, {
      template: name, title: `Hydration ${name} ${theme} ${order}`, ...(spec.bot ? { bot: spec.bot } : {}),
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      await page.route('**/copy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
      await page.goto(server.url('?client=test&run=' + run.run_id));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      await spec.draft(page);
      await page.click('#rs-discard');
      const details = holdDetails(page, run.run_id);
      assert.equal(await submitElsewhere(run.run_id, sent), 200);
      // both SSE messages ask for the run detail before either answer arrives
      await details.count(2);
      const [early, late] = order === 'first' ? details.held : [...details.held].reverse();

      await early.deliver();
      await page.waitForFunction(({ field }) => document.querySelector(field)?.value === 'AUTHORITATIVE', { field: spec.field });
      assert.equal(await page.locator('dialog[open]').count(), 0, 'Discard confirmation closed');
      // the transition to the authoritative result announces it once
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('rs-banner')
        || !!document.activeElement.closest('.rs-banner')), true, 'focus at the result banner');
      await page.evaluate(() => { document.querySelector('.rs-tpl').dataset.hydrationProbe = '1'; });

      await spec.read(page, data);
      const before = await viewState(page);
      assert.equal(before.focusInTemplate, true);
      if (delay) await sleep(delay);
      await late.deliver();
      await sleep(600);
      const after = await viewState(page);
      assert.deepEqual(after, before, 'the later identical response keeps the reader\'s view');
      assert.equal(await page.inputValue(spec.field), 'AUTHORITATIVE');
      assert.equal(await page.isVisible('.rs-banner[data-banner="submitted"]'), true);
      assert.deepEqual(server.result(run.run_id).data, sent, 'stored result unchanged');
      assert.deepEqual(errors, []);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await ctx.close();
    }
  }

  /* cancelled elsewhere: the `run` message shows it; the later detail answer is a no-op */
  async function cancelled(theme) {
    const spec = TEMPLATES._starter;
    await server.clearRuns();
    const run = server.show(read(spec.dir, 'fixtures/golden.json'), { title: 'Hydration cancelled ' + theme });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    try {
      await page.route('**/copy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
      await page.goto(server.url('?client=test&run=' + run.run_id));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      await spec.draft(page);
      const details = holdDetails(page, run.run_id);
      const response = await fetch(server.url('cancel'), {
        method: 'POST',
        headers: { 'X-RS-CSRF': await server.csrf(), 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ run_id: run.run_id }),
      });
      assert.equal(response.status, 200);
      await details.count(1);
      await page.waitForSelector('.rs-banner[data-banner="cancelled"]');
      await spec.read(page);
      const before = await viewState(page);
      for (const entry of details.held) await entry.deliver();
      await sleep(600);
      assert.deepEqual(await viewState(page), before);
      assert.equal(await page.isVisible('.rs-banner[data-banner="cancelled"]'), true);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await ctx.close();
    }
  }
  test('external cancel light: the later detail answer keeps focused copy', () => cancelled('light'));
  test('external cancel dark: the later detail answer keeps focused copy', () => cancelled('dark'));

  for (const name of Object.keys(TEMPLATES)) {
    for (const theme of ['light', 'dark']) {
      test(`${name} ${theme}: the second response after the first keeps the view`, () => scenario(name, theme, 'first', 0));
      test(`${name} ${theme}: the first response after the second keeps the view`, () => scenario(name, theme, 'second', 0));
      test(`${name} ${theme}: a delayed second response keeps the view`, () => scenario(name, theme, 'first', 700));
    }
  }
});
