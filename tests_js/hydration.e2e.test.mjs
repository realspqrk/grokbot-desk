// A report decided by another client is hydrated from
// the authoritative result exactly once. The server announces the decision
// twice (SSE `runs`, then `run`), so the page fetches the run detail twice;
// whichever response comes later must not remount the decided report the user
// is already reading (an opened disclosure, a focused copy) or move focus
// back to the result banner.
// Real backend and real SSE: page.route only holds and orders the two real
// GET /api/run/<id> responses. Isolated server, temp RS_DATA_DIR, headless Edge.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browserChannel, startServer, loadChromium, fixtureMedia, payloadFixture } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';

const PORT = e2ePort('hydration.e2e.test.mjs');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One report per kind of reading state. draft = what the person had
   started; sent = what another client decided; read = how the person
   then reads the decided report (the view the later answer must keep). */
const REPORTS = {
  read: {
    draft: async (page) => { await page.click('[data-rs-note-open]'); await page.fill('#rs-note', 'LOCAL'); },
    sent: { decision: 'read', note: 'AUTHORITATIVE', refs: [] },
    /* open the collapsed text block */
    async read(page) {
      await tabTo(page, 'details > summary');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('.rs-report details')?.open === true);
    },
  },
  'approve-decide': {
    draft: (page) => page.click('#inp-invoices-r0-approve'),
    sent: {
      decision: 'submit', note: 'AUTHORITATIVE', refs: [],
      blocks: { invoices: { items: [
        { id: 'hosting', choice: 'approve' }, { id: 'toner', choice: 'later' }, { id: 'parking', choice: 'reject' },
      ] } },
    },
    /* keyboard to the first copy button */
    async read(page) { await tabTo(page, '.rs-report .rs-copy__btn'); },
  },
  'approve-post': {
    draft: (page) => page.click('[data-rs-leave-out="x"]'),
    sent: {
      decision: 'approve', note: 'AUTHORITATIVE', refs: [],
      blocks: { post: { platforms: [{ platform: 'x', included: true }, { platform: 'linkedin', included: false }] } },
    },
    /* the keyboard on a platform copy */
    async read(page) { await tabTo(page, '.rs-report .rs-copy__btn'); },
  },
  approve: {
    draft: async (page) => {
      await page.click('#rs-alt-2');
      await page.fill('#rs-note', 'LOCAL');
    },
    sent: { decision: 'revise', note: 'AUTHORITATIVE', refs: [] },
    async read(page) { await tabTo(page, '.rs-report .rs-copy__btn'); },
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
    focusInReport: !!focused.closest('.rs-report'),
    selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.id || null,
    openDetails: document.querySelectorAll('.rs-report details[open]').length,
    sameReport: document.querySelector('.rs-report')?.dataset.hydrationProbe === '1',
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
    const spec = REPORTS[name];
    const sent = spec.sent;
    await server.clearRuns();
    const run = server.show(media.map(payloadFixture(name)), { title: `Hydration ${name} ${theme} ${order}` });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // diagnostics for a rare net::ERR_NO_BUFFER_SPACE on Windows runners: which request failed
    page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && console.error(`[requestfailed] ${r.method()} ${new URL(r.url()).pathname} range=${r.headers().range || '-'} type=${r.resourceType()} ${r.failure()?.errorText}`));
    try {
      await page.route('**/copy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
      await page.goto(server.url('?client=test&run=' + run.run_id));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
      await spec.draft(page);
      // a report that can be discarded has the confirmation open meanwhile (read has no Discard)
      if (name !== 'read') { await page.click('#rs-more-btn'); await page.click('#rs-discard'); }
      const details = holdDetails(page, run.run_id);
      assert.equal(await submitElsewhere(run.run_id, sent), 200);
      // both SSE messages ask for the run detail before either answer arrives
      await details.count(2);
      const [early, late] = order === 'first' ? details.held : [...details.held].reverse();

      await early.deliver();
      await page.waitForFunction(() => document.querySelector('#rs-note')?.value === 'AUTHORITATIVE');
      assert.equal(await page.locator('dialog[open]').count(), 0, 'Discard confirmation closed');
      // the transition to the authoritative result announces it once
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('rs-banner')
        || !!document.activeElement.closest('.rs-banner')), true, 'focus at the result banner');
      await page.evaluate(() => { document.querySelector('.rs-report').dataset.hydrationProbe = '1'; });

      await spec.read(page);
      const before = await viewState(page);
      assert.equal(before.focusInReport, true);
      assert.equal(before.sameReport, true);
      if (delay) await sleep(delay);
      await late.deliver();
      await sleep(600);
      const after = await viewState(page);
      assert.deepEqual(after, before, 'the later identical response keeps the reader\'s view');
      assert.equal(await page.inputValue('#rs-note'), 'AUTHORITATIVE');
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
    const spec = REPORTS.approve;
    await server.clearRuns();
    const run = server.show(payloadFixture('approve'), { title: 'Hydration cancelled ' + theme });
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

  for (const name of Object.keys(REPORTS)) {
    for (const theme of ['light', 'dark']) {
      test(`${name} ${theme}: the second response after the first keeps the view`, () => scenario(name, theme, 'first', 0));
      test(`${name} ${theme}: the first response after the second keeps the view`, () => scenario(name, theme, 'second', 0));
      test(`${name} ${theme}: a delayed second response keeps the view`, () => scenario(name, theme, 'first', 700));
    }
  }
});
