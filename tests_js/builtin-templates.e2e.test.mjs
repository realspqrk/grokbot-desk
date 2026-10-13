// Browser tests for the shipped built-ins decide-list, approve-one and
// preview-post on the real served shell: isolated server on the worker's
// port range with a temp RS_DATA_DIR, headless Edge 1500x1000, German table.
// /copy, /copy-image and /reveal are always fulfilled by page.route (the
// posted body is checked), so the real clipboard and folders are never touched.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';
import { calmEvaluator, CALM_THRESHOLDS } from '../tools/calm.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 10;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BUILTIN = path.join(ROOT, 'templates', 'builtin');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const fixture = (id, name) => json(path.join(BUILTIN, id, 'fixtures', `${name}.json`));
const expectFor = (id, name) => json(path.join(BUILTIN, id, 'fixtures', 'expect', `${name}.json`));
const de = json(path.join(ROOT, 'core', 'i18n', 'de.json'));
const AXE = path.join(ROOT, 'vendor', 'axe.min.js');
const URL_VECTORS = json(path.join(ROOT, 'tests', 'fixtures', 'url_vectors.json'));
const t = (key, params = {}) => de[key].replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
const RS_COUNT = createRequire(import.meta.url)('../core/static/count.js');

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

/* A key can mount a panel whose post image then loads (preview-post shows
   only the selected platform). Until it has loaded, Instagram blocks a new
   approval by design, so a key sequence typed within a millisecond would
   skip that checkbox. A person sees the image first; so does the test. */
const mediaSettled = (page) => page.waitForFunction(
  () => !document.querySelector('[data-image-state="loading"]'), null, { timeout: 5000 });

async function runStep(page, step) {
  if (step.click) await page.click(step.click);
  else if (step.fill) await page.fill(step.fill[0], step.fill[1]);
  else if (step.type !== undefined) await page.keyboard.type(step.type);
  else if (step.press) {
    for (let i = 0; i < (step.repeat || 1); i++) {
      await page.keyboard.press(step.press);
      await mediaSettled(page);
    }
  } else throw new Error('unknown step ' + JSON.stringify(step));
}

describe('built-in templates (served, headless Edge)', { skip }, () => {
  let server;
  let browser;

  before(async () => {
    server = await startServer({ port: PORT });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

  /** One open run on the server (no strip), then the page for it. */
  async function open(id, name, opts = {}) {
    await server.clearRuns();
    const run = server.show(opts.data || fixture(id, name), { template: id, bot: 'example-bot', title: `${id} ${name}`, ...(opts.envelope || {}) });
    const ctx = await browser.newContext({
      viewport: opts.viewport || { width: 1500, height: 1000 }, deviceScaleFactor: 1,
      colorScheme: opts.colorScheme || 'light', reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const log = { errors: [], copies: [], images: [], paths: [], reveals: [] };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.errors.push(m.type() + ': ' + m.text()); });
    // diagnostics for a rare net::ERR_NO_BUFFER_SPACE on Windows runners: which request failed
    page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && console.error(`[requestfailed] ${r.method()} ${new URL(r.url()).pathname} range=${r.headers().range || '-'} type=${r.resourceType()} ${r.failure()?.errorText}`));
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    await page.route(ORIGIN + '/copy', async (route) => {
      log.copies.push(JSON.parse(route.request().postData()));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    log.urls = [];
    for (const [route, list] of [['/copy-image', log.images], ['/copy-path', log.paths], ['/reveal', log.reveals], ['/open-url', log.urls]]) {
      await page.route(ORIGIN + route, async (r) => {
        list.push(JSON.parse(r.request().postData()));
        await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
    }
    if (opts.beforeGoto) await opts.beforeGoto(page, run);
    await page.goto(server.url('?client=test&run=' + run.run_id + (opts.query || '')));
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
    return { ctx, page, log, run };
  }

  async function reload(page) {
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
  }

  async function submitted(page, run) {
    await page.waitForSelector('.rs-banner[data-banner="submitted"]', { timeout: 5000 });
    return server.result(run.run_id).data;
  }

  async function seriousViolations(page) {
    await page.addScriptTag({ path: AXE });
    return page.evaluate(async () => (await window.axe.run(document)).violations
      .filter((x) => x.impact === 'serious' || x.impact === 'critical')
      .map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target.join(' ')) })));
  }

  for (const [id, valid] of [
    ['decide-list', ['golden', 'edge-single', 'edge-unicode', 'edge-max', 'edge-replies', 'edge-many']],
    ['approve-one', ['golden', 'edge-access', 'edge-de', 'edge-minimal', 'edge-max']],
    ['preview-post', ['golden', 'edge-no-image', 'edge-x-limit', 'edge-x-long', 'edge-max']],
  ]) {
    test(`${id}: expect.flow (mouse) and expect.keyboard (keys only) write expect.result`, async () => {
      const expect = expectFor(id, 'golden');
      for (const mode of ['flow', 'keyboard']) {
        const { ctx, page, log, run } = await open(id, 'golden');
        try {
          for (const step of expect[mode]) await runStep(page, step);
          assert.deepEqual(await submitted(page, run), expect.result, mode);
          assert.deepEqual(log.errors, [], mode);
        } finally { await ctx.close(); }
      }
    });

    test(`${id}: every fixture renders without console errors; axe 0 serious, light and dark`, async () => {
      for (const name of valid) {
        for (const colorScheme of ['light', 'dark']) {
          const { ctx, page, log } = await open(id, name, { colorScheme });
          try {
            const data = fixture(id, name);
            /* approve-one: the footer is the decision, its primary approves in one click */
            assert.equal(await page.isDisabled('#rs-submit'), id !== 'approve-one', `${name}: nothing is decided at rest`);
            if (id === 'preview-post') {
              const manual = (item) => item && item.mode === 'manual';
              const want = data.platforms.every(manual) ? de.posted : data.platforms.some(manual) ? de.submit_mixed : de.approve_post;
              assert.equal(await page.textContent('#rs-submit-label'), want, name);
            }
            if (name === 'golden' || name === valid[1]) assert.deepEqual(await seriousViolations(page), [], `${name} ${colorScheme}`);
            assert.deepEqual(log.errors, [], `${name} ${colorScheme}`);
          } finally { await ctx.close(); }
        }
      }
    });
  }

  /* ------------------------------------------------------- fold fade (shell) */
  const fold = (page) => page.evaluate(() => {
    const mount = document.getElementById('rs-mount');
    const fade = getComputedStyle(document.querySelector('.rs-main'), '::after');
    return {
      more: mount.hasAttribute('data-rs-more'),
      fade: fade.content === 'none' ? null : fade.height,
      scrolls: mount.scrollHeight > mount.clientHeight,
    };
  });

  test('shell: the fold fade shows only while content continues below; keyboard focus scrolls clear of it', async () => {
    const { ctx, page } = await open('decide-list', 'golden', { viewport: { width: 1280, height: 720 } });
    try {
      assert.deepEqual(await fold(page), { more: true, fade: '24px', scrolls: true });
      /* every focus stop inside the report stays above the fade (outline included) */
      const stops = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        /* the focus scroll and its scroll event settle before the next paint */
        const stop = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const mount = document.getElementById('rs-mount');
          const active = document.activeElement;
          if (!mount.contains(active)) { resolve({ outside: true }); return; }
          const fadeTop = mount.getBoundingClientRect().bottom - (mount.hasAttribute('data-rs-more') ? 24 : 0);
          resolve({ tag: active.tagName, bottom: active.getBoundingClientRect().bottom + 4, fadeTop });
        }))));
        if (stop.outside) { if (stops.length) break; continue; }
        stops.push(stop.tag);
        assert.ok(stop.bottom <= stop.fadeTop + 0.5, `${stop.tag} #${stops.length}: ${stop.bottom} under the fade or fold at ${stop.fadeTop}`);
      }
      assert.ok(stops.includes('SUMMARY'), `the handled disclosure is reached: ${stops.join(' ')}`);
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
      await page.waitForTimeout(100);
      assert.deepEqual(await fold(page), { more: false, fade: null, scrolls: true }, 'padding only');
      await page.setViewportSize({ width: 1280, height: 1080 });
      await page.waitForTimeout(100);
      assert.deepEqual(await fold(page), { more: false, fade: null, scrolls: false }, 'everything fits');
    } finally { await ctx.close(); }
  });

  /* the focused element after the ResizeObserver settled, against the fade */
  const held = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const mount = document.getElementById('rs-mount');
    const active = document.activeElement;
    const more = mount.hasAttribute('data-rs-more');
    resolve({
      summary: active.tagName === 'SUMMARY',
      open: active.parentElement.open,
      more, scroll: mount.scrollTop, end: mount.scrollHeight - mount.clientHeight, top: active.getBoundingClientRect().top,
      ring: active.getBoundingClientRect().bottom + 4, fadeTop: mount.getBoundingClientRect().bottom - (more ? 24 : 0),
    });
  }))));
  /* Tab (keys only) to the first disclosure summary */
  async function tabToSummary(page) {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement.tagName === 'SUMMARY')) return;
    }
    throw new Error('no disclosure reached');
  }

  test('shell: opening a disclosure that turns the fade on keeps the held focus ring clear; closing does not scroll', async () => {
    const data = fixture('approve-one', 'golden');
    data.points = data.points.slice(0, 4);
    /* the fade mechanics at a known height: the summary stays in the report
       (the banner gets its own why) and the banner is taken out */
    const envelope = { task: { kind: 'approve_bot_acts', why: 'Staging passed.' } };
    const withoutBanner = (page) => page.evaluate(() => {
      document.getElementById('rs-task').hidden = true;
      /* the reference disclosure is the last thing in the report */
      document.querySelector('[data-ao="note"]').hidden = true;
    });
    for (const colorScheme of ['light', 'dark']) {
      const { ctx, page, log } = await open('approve-one', 'golden', { data, envelope, colorScheme, viewport: { width: 1280, height: 720 } });
      try {
        await withoutBanner(page);
        await tabToSummary(page);
        const fits = await held(page);
        assert.equal(fits.more, false, `${colorScheme}: the closed report fits`);
        /* what the person sees: no fade, the focused summary and its ring
           fully inside the report. Font metrics may leave a few pixels of
           overflow below the fade threshold, so focus may scroll into that
           overflow, never past it */
        assert.ok(fits.ring <= fits.fadeTop + 0.5, `${colorScheme}: ring visible ${JSON.stringify(fits)}`);
        assert.ok(fits.scroll <= fits.end, `${colorScheme}: no scroll beyond the content ${JSON.stringify(fits)}`);
        await page.keyboard.press('Enter');
        const opened = await held(page);
        assert.ok(opened.summary && opened.open && opened.more, `${colorScheme}: open, fade on, focus kept ${JSON.stringify(opened)}`);
        assert.ok(opened.ring <= opened.fadeTop + 0.5, `${colorScheme}: ring ${opened.ring} under the fade at ${opened.fadeTop}`);
        assert.ok(opened.scroll > 0 && opened.scroll < 24, `${colorScheme}: scrolled just clear (${opened.scroll})`);
        await page.keyboard.press('Enter');
        const closed = await held(page);
        assert.ok(closed.summary && !closed.open && !closed.more, `${colorScheme}: closed ${JSON.stringify(closed)}`);
        /* no scroll of its own: only the browser's clamp to the shorter content */
        assert.equal(closed.scroll, Math.min(opened.scroll, closed.end), `${colorScheme}: closing ${JSON.stringify(closed)}`);
        assert.equal(closed.top, opened.top + opened.scroll - closed.scroll);
        assert.deepEqual(log.errors, []);
      } finally { await ctx.close(); }
    }
    /* more already follows (a test spacer below the report): toggling the
       focused disclosure never scrolls */
    const { ctx, page } = await open('approve-one', 'golden', { data, envelope, viewport: { width: 1280, height: 720 } });
    try {
      await withoutBanner(page);
      await page.evaluate(() => { const s = document.createElement('div'); s.style.height = '400px'; document.querySelector('.rs-tpl').appendChild(s); });
      await tabToSummary(page);
      const before = await held(page);
      assert.ok(before.more && before.ring <= before.fadeTop + 0.5, JSON.stringify(before));
      await page.keyboard.press('Enter');
      const opened = await held(page);
      await page.keyboard.press('Enter');
      const closed = await held(page);
      assert.deepEqual([opened.open, closed.open, opened.more, closed.more], [!before.open, before.open, true, true]);
      assert.deepEqual([opened.scroll, closed.scroll], [before.scroll, before.scroll]);
      assert.deepEqual([opened.top, closed.top], [before.top, before.top]);
    } finally { await ctx.close(); }
  });

  test('shell: a read-only sent view fades at the window edge too, in the submit bar column', async () => {
    const expect = expectFor('approve-one', 'golden');
    const { ctx, page, log, run } = await open('approve-one', 'golden', { viewport: { width: 1280, height: 720 } });
    try {
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
      const atOpen = await column();
      const bar = await page.evaluate(() => {
        const inner = document.querySelector('.rs-submitbar__inner').getBoundingClientRect();
        const main = document.querySelector('.rs-main').getBoundingClientRect();
        return { left: inner.left - main.left, width: inner.width };
      });
      assert.deepEqual([atOpen.left, atOpen.width, atOpen.height, atOpen.bottom], [bar.left, bar.width, 24, atOpen.mount], 'the bar column, above the bar');
      for (const step of expect.flow) await runStep(page, step);
      assert.deepEqual(await submitted(page, run), expect.result);
      await page.evaluate(() => { document.getElementById('rs-mount').scrollTop = 0; });
      await page.waitForFunction(() => document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      assert.equal(await page.isHidden('#rs-submitbar'), true);
      assert.deepEqual(await fold(page), { more: true, fade: '24px', scrolls: true }, 'sent, at rest');
      const sent = await column();
      assert.deepEqual([sent.left, sent.width, sent.height], [bar.left, bar.width, 24], 'the same column');
      assert.equal(sent.bottom, sent.mount, 'at the bottom edge of the mount');
      assert.equal(sent.mount, 720, 'the window edge');
      await page.evaluate(() => { const m = document.getElementById('rs-mount'); m.scrollTop = m.scrollHeight; });
      await page.waitForFunction(() => !document.getElementById('rs-mount').hasAttribute('data-rs-more'));
      assert.deepEqual(await fold(page), { more: false, fade: null, scrolls: true }, 'sent, at the end');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  /* ------------------------------------------------------------ decide-list */
  const dlChoice = (w) => (w.choices || ['approve', 'reject', 'defer']);

  test('decide-list: a repeated item id is rejected at show with the second item\'s pointer', () => {
    assert.throws(() => server.show(fixture('decide-list', 'invalid-duplicate-ids'), { template: 'decide-list', bot: 'example-bot' }),
      /show failed \(2\):[\s\S]*\/data\/items\/1\/id[\s\S]*duplicate id 'travel-workshop', already used by \/data\/items\/0/);
  });

  test('decide-list: one card at a time; rows, status and submit follow the decisions', async () => {
    const data = fixture('decide-list', 'golden');
    const { ctx, page } = await open('decide-list', 'golden');
    try {
      assert.equal(await page.textContent('#rs-task .rs-task__why'), data.intro, 'the intro is the task banner\'s why');
      assert.equal(await page.locator('[data-dl="intro"]').count(), 0, 'and is not repeated in the report');
      assert.equal(await page.locator('.dl-card').count(), 1, 'only the current card is in the document');
      const first = data.items[0];
      const card = await page.$eval('.dl-item[data-current]', (c) => ({
        id: c.getAttribute('data-item-id'),
        eyebrow: c.querySelector('.dl-card__eyebrow').textContent,
        title: c.querySelector('.dl-card__title').textContent,
        choices: [...c.querySelectorAll('rs-action-row button')].map((b) => [b.value, b.textContent, b.getAttribute('aria-checked')]),
      }));
      assert.equal(card.id, first.id);
      assert.equal(card.eyebrow, first.source + de.sep_list + first.kind + t('due', { date: '14.10.' }));
      assert.equal(card.title, first.title, 'the request leads; who asks sits in the quiet line above');
      assert.deepEqual(card.choices, dlChoice(first).map((c) => [c, de['choice_' + c], 'false']), 'no preselection');
      const row = await page.$eval('.dl-item[data-item-id="laptop-refresh"] .dl-row', (r) => ({
        title: r.querySelector('.dl-row__title').textContent,
        meta: r.querySelector('.dl-row__meta').textContent,
      }));
      assert.deepEqual(row, { title: data.items[1].title, meta: data.items[1].source + de.sep_list + data.items[1].kind });
      assert.equal(await page.textContent('#rs-submit-label'), de.send_decisions, 'the footer sends every decision; it approves nothing by itself');
      const picked = { approve: 0, reject: 0, defer: 0 };
      const tally = () => ['approve', 'reject', 'defer'].filter((c) => picked[c])
        .map((c) => t('dl_count', { n: picked[c], label: de['choice_' + c] }));
      for (let i = 0; i < data.items.length; i++) {
        const left = data.items.slice(i);
        const full = t('items_open_named', {
          n: left.length, total: data.items.length, names: left.map((w) => w.source || w.title).join(de.sep_names),
        });
        const short = [...tally(), t('items_open_short', { n: left.length })].join(de.sep_list);
        assert.equal(await page.textContent('#rs-status'), short);
        assert.equal(await page.getAttribute('#rs-status', 'aria-label'), short + de.sep_list + full);
        assert.equal(await page.isDisabled('#rs-submit'), true);
        const w = data.items[i];
        await page.click(`rs-action-row[data-item="${w.id}"] button[value="${dlChoice(w).at(-1)}"]`);
        picked[dlChoice(w).at(-1)] += 1;
        assert.equal(await page.getAttribute(`.dl-item[data-item-id="${w.id}"]`, 'data-decided'), dlChoice(w).at(-1));
      }
      assert.equal(await page.textContent('#rs-status'), tally().join(de.sep_list), 'once decided the status counts each choice');
      assert.equal(await page.textContent('#rs-submit-label'), de.send_decisions);
      assert.equal(await page.isDisabled('#rs-submit'), false);
      assert.equal(await page.textContent('.dl-item[data-item-id="travel-workshop"] .dl-row__outcome'), de.choice_defer);
    } finally { await ctx.close(); }
  });

  test('decide-list: payload labels name the choices and the status, not the banner; the result keeps the values', async () => {
    const data = fixture('decide-list', 'edge-many');
    assert.equal(data.items.length, 12);
    const { ctx, page, log, run } = await open('decide-list', 'edge-many');
    try {
      /* the banner asks for decisions; one choice label (Pay) never names the whole desk */
      assert.equal(await page.textContent('#rs-task .rs-task__what'), t('task_line_list_continue', { bot: t('task_the_bot') }));
      assert.equal(await page.textContent('#rs-task .rs-task__steps'), t('task_steps_mixed_items', { button: de.send_decisions }));
      const labels = (id) => page.$$eval(`rs-action-row[data-item="${id}"] button`, (els) => els.map((b) => [b.value, b.textContent]));
      assert.deepEqual(await labels('inv-paper'), [['approve', 'Pay'], ['reject', 'Dispute'], ['defer', 'Next week']]);
      assert.equal(await page.$eval('#dl-todo-h', (h) => h.getBoundingClientRect().width <= 1), true, 'one group: no visible heading');
      assert.equal(await page.textContent('#dl-todo-h'), de.section_todo, 'it still names the list');
      const choose = ['approve', 'approve', 'reject', 'defer', 'reject', 'approve', 'approve', 'reject', 'approve', 'defer', 'approve', 'approve'];
      for (let i = 0; i < data.items.length; i++) {
        const w = data.items[i];
        if (w.id === 'inv-legal') {
          assert.deepEqual(await labels(w.id), [['approve', 'Pay'], ['reject', 'Ask for details'], ['defer', 'Next week']], 'the item label wins');
        }
        await page.click(`rs-action-row[data-item="${w.id}"] button[value="${choose[i]}"]`);
      }
      /* inv-legal rejects with its own label, the others with the shared one: two groups */
      assert.equal(await page.textContent('#rs-status'), [
        t('dl_count', { n: 7, label: 'Pay' }), t('dl_count', { n: 2, label: 'Dispute' }),
        t('dl_count', { n: 1, label: 'Ask for details' }), t('dl_count', { n: 2, label: 'Next week' }),
      ].join(de.sep_list));
      assert.equal(await page.textContent('.dl-item[data-item-id="inv-legal"] .dl-row__outcome'), 'Ask for details');
      await page.click('#rs-submit');
      const result = await submitted(page, run);
      assert.deepEqual(result.items.map((x) => x.choice), choose);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('decide-list: a user item offers only its own choices; the steps name the footer', async () => {
    const data = {
      items: [
        { id: 'book-room', actor: 'user', title: 'Book the meeting room for Thursday', choices: ['done', 'later'] },
        { id: 'call-back', actor: 'user', source: 'Example Bank', title: 'Call back about the card limit' },
      ],
    };
    const { ctx, page, log, run } = await open('decide-list', 'edge-single', { data });
    try {
      const values = (id) => page.$$eval(`rs-action-row[data-item="${id}"] button`, (els) => els.map((b) => b.value));
      assert.deepEqual(await values('book-room'), ['done', 'later']);
      assert.equal(await page.textContent('#rs-submit-label'), de.footer_done);
      assert.equal(await page.textContent('.rs-task__steps'), t('task_steps_user_items', { button: de.footer_done }));
      await page.click('rs-action-row[data-item="book-room"] button[value="later"]');
      assert.deepEqual(await values('call-back'), ['done', 'skipped', 'later']);
      await page.click('rs-action-row[data-item="call-back"] button[value="done"]');
      await page.click('#rs-submit');
      assert.deepEqual((await submitted(page, run)).items.map((x) => x.choice), ['later', 'done']);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('decide-list: choices and notes come back after a reload; a sent report is read-only and still copies', async () => {
    const { ctx, page, log, run } = await open('decide-list', 'golden');
    try {
      await page.click('[data-item-id="travel-workshop"] .dl-add-note');
      await page.fill('#dl-note-1', 'Cheaper fare please');
      await page.click('rs-action-row[data-item="travel-workshop"] button[value="reject"]');
      await page.click('rs-action-row[data-item="laptop-refresh"] button[value="approve"]');
      await page.click('[data-dl="overall-open"]');
      await page.fill('#dl-note', 'More tomorrow');
      await reload(page);
      assert.equal(await page.getAttribute('.dl-item[data-item-id="travel-workshop"]', 'data-decided'), 'reject');
      assert.equal(await page.getAttribute('.dl-item[data-item-id="laptop-refresh"]', 'data-decided'), 'approve');
      assert.equal(await page.getAttribute('.dl-item[data-current]', 'data-item-id'), 'billing-repo-access', 'the first open item is current');
      assert.equal(await page.inputValue('#dl-note'), 'More tomorrow');
      await page.click('.dl-item[data-item-id="travel-workshop"] .dl-row');
      assert.equal(await page.inputValue('#dl-note-1'), 'Cheaper fare please');
      await page.click('.dl-item[data-item-id="billing-repo-access"] .dl-row');
      for (const id of ['billing-repo-access', 'cleaning-renewal', 'offsite-date']) {
        await page.click(`rs-action-row[data-item="${id}"] button[value="approve"]`);
      }
      await page.keyboard.press('Control+Enter');
      const data = await submitted(page, run);
      assert.deepEqual(data.items.map((x) => [x.id, x.choice, x.note]), [
        ['travel-workshop', 'reject', 'Cheaper fare please'],
        ['laptop-refresh', 'approve', ''],
        ['billing-repo-access', 'approve', ''],
        ['cleaning-renewal', 'approve', ''],
        ['offsite-date', 'approve', ''],
      ]);
      assert.equal(data.note, 'More tomorrow');
      await reload(page);
      await page.click('.dl-item[data-item-id="travel-workshop"] .dl-row');
      assert.equal(await page.isDisabled('rs-action-row[data-item="travel-workshop"] button[value="reject"]'), true);
      assert.equal(await page.getAttribute('rs-action-row[data-item="travel-workshop"] button[value="reject"]', 'aria-checked'), 'true');
      await page.click('[data-copy-id="item-1-copy-1"] .rs-copy__btn');
      await page.waitForSelector('[data-copy-id="item-1-copy-1"][data-state="copied"]');
      assert.equal(log.copies.at(-1).text, 'NW-TRV-20418');
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
  });

  /* ------------------------------------------------------------ approve-one */
  /* the visible quiet alternatives of the footer, in order */
  const alternatives = (page) => page.$$eval('#rs-submitbar .rs-btn--quiet',
    (b) => b.filter((x) => !x.hidden && x.getClientRects().length > 0).map((x) => x.textContent));
  const alternative = (page, text) => page.locator('#rs-submitbar .rs-btn--quiet', { hasText: text }).click();

  test('approve-one: the footer is the decision; approve is one click and a shown note travels with it', async () => {
    const data = fixture('approve-one', 'golden');
    const { ctx, page, run } = await open('approve-one', 'golden');
    try {
      assert.equal(await page.locator('#rs-mount rs-action-row').count(), 0, 'no choice row in the report');
      assert.equal(await page.textContent('#rs-submit-label'), data.approve_label);
      assert.equal(await page.isDisabled('#rs-submit'), false, 'the primary approves at once');
      assert.deepEqual(await alternatives(page), [de.choice_reject, de.request_changes]);
      assert.equal(await page.textContent('#rs-status'), '');
      await page.click('[data-ao="note-open"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'ao-comment');
      await page.fill('#ao-comment', 'Watch the error rate after 18:00');
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(page, run), { decision: 'approve', comment: 'Watch the error rate after 18:00' });
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
  });

  test('approve-one: Reject sends at once without a reason; yes/no only without allow_changes', async () => {
    const { ctx, page, run } = await open('approve-one', 'edge-access');
    try {
      assert.deepEqual(await alternatives(page), [de.choice_reject]);
      await alternative(page, de.choice_reject);
      assert.deepEqual(await submitted(page, run), { decision: 'reject', comment: '' });
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
  });

  test('approve-one: Request changes asks for the comment, Cancel goes back, a request survives a reload; empty sections are not rendered', async () => {
    const { ctx, page, run } = await open('approve-one', 'golden');
    try {
      await alternative(page, de.request_changes);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'ao-comment', 'Request changes moves to the comment');
      assert.equal(await page.textContent('#rs-submit-label'), de.request_send);
      assert.deepEqual(await alternatives(page), [de.cancel]);
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.textContent('#rs-status'), de.comment_required);
      await page.fill('#ao-comment', '   ');
      assert.equal(await page.isDisabled('#rs-submit'), true, 'whitespace is not a comment');
      await page.fill('#ao-comment', 'Wait for the sale to end');
      assert.equal(await page.isDisabled('#rs-submit'), false);
      await reload(page);
      assert.equal(await page.inputValue('#ao-comment'), 'Wait for the sale to end');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'ao-comment');
      assert.equal(await page.textContent('#rs-submit-label'), de.request_send);
      await alternative(page, de.cancel);
      assert.equal(await page.isHidden('[data-ao="comment-box"]'), true, 'the change request text hides with its mode');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), de.request_changes, 'focus returns to the button that opened the request');
      assert.equal(await page.textContent('#rs-submit-label'), fixture('approve-one', 'golden').approve_label);
      await alternative(page, de.request_changes);
      assert.equal(await page.inputValue('#ao-comment'), 'Wait for the sale to end', 'the text is kept');
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(page, run), { decision: 'request_changes', comment: 'Wait for the sale to end' });
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
    const minimal = await open('approve-one', 'edge-minimal');
    try {
      const present = await minimal.page.evaluate(() => ['facts', 'copies', 'points-box', 'checks-box', 'reference-box', 'checksum']
        .filter((name) => document.querySelector(`[data-ao="${name}"]`)));
      assert.deepEqual(present, []);
      assert.equal(await minimal.page.textContent('#rs-submit-label'), de.approve_continue);
    } finally { await minimal.ctx.close(); }
  });

  test('approve-one: the checks are summed up in one line before the facts, warnings and failures by name', async () => {
    const golden = await open('approve-one', 'golden');
    try {
      const view = await golden.page.evaluate(() => {
        const sum = document.querySelector('[data-ao="checksum"]');
        const facts = document.querySelector('[data-ao="facts"]');
        return {
          text: sum.textContent,
          before: !!(sum.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING),
          lines: Math.round(sum.getBoundingClientRect().height / parseFloat(getComputedStyle(sum).lineHeight)),
          listed: document.querySelectorAll('[data-ao="checks"] > li').length,
        };
      });
      assert.equal(view.text, [t('ao_checks_ok', { n: '3' }), t('ao_checks_warn_one', { names: 'Bundle size' })].join(' · '));
      assert.deepEqual([view.before, view.lines, view.listed], [true, 1, 4]);
    } finally { await golden.ctx.close(); }
    const data = fixture('approve-one', 'golden');
    data.checks = [
      { label: 'Unit tests', state: 'fail' }, { label: 'Smoke test', state: 'fail' },
      { label: 'Bundle size', state: 'warn' }, { label: 'Lint', state: 'warn' },
    ];
    const failing = await open('approve-one', 'golden', { data });
    try {
      assert.equal(await failing.page.textContent('[data-ao="checksum"]'), [
        t('ao_checks_warn', { n: '2', names: 'Bundle size, Lint' }),
        t('ao_checks_fail', { n: '2', names: 'Unit tests, Smoke test' }),
      ].join(' · '), 'no ok part when none passed');
      assert.equal(await failing.page.locator('details [data-ao="checks"]').count(), 0, 'never behind a disclosure');
    } finally { await failing.ctx.close(); }
  });

  /* ----------------------------------------------------------- preview-post */
  test('preview-post: shown = copied = counted; LinkedIn and Instagram show the platform fold label', async () => {
    const expect = expectFor('preview-post', 'golden');
    const { ctx, page, log } = await open('preview-post', 'golden');
    try {
      for (const p of ['x', 'linkedin', 'instagram', 'facebook']) {
        await page.click(`#tab-${p}`);
        const composed = expect.copies[`${p}-text`];
        assert.equal(await page.textContent(`#panel-${p} [slot="text"]`), composed, `${p}: shown text`);
        const counted = await page.$eval(`[data-counter-id="${p}"]`, (el) => el.result.count);
        assert.equal(counted, RS_COUNT.count(composed, p).count, `${p}: counted`);
        assert.equal(counted, expect.counters[p].count, `${p}: hand oracle`);
        if (p === 'x') {
          assert.equal(await page.textContent('[data-counter-id="x"] .rs-counter__num'),
            t('counter_value', { value: String(counted), limit: '280' }), 'a standard X post reads against 280');
          assert.equal(await page.isHidden('#panel-x [data-pp="long-note"]'), true);
        }
        await page.click(`[data-copy-id="${p}-text"] .rs-copy__btn`);
        await page.waitForSelector(`[data-copy-id="${p}-text"][data-state="copied"]`);
        assert.equal(log.copies.at(-1).text, composed, `${p}: copied`);
        const fold = await page.evaluate((panel) => ({
          labels: document.querySelectorAll(`${panel} .rs-pf__see-more`).length,
          notes: [...document.querySelectorAll(`${panel} .rs-pf__foldnote`)].filter((n) => !n.hidden).map((n) => n.textContent),
        }), `#panel-${p}`);
        if (p === 'linkedin' || p === 'instagram') {
          assert.equal(fold.labels, 1, `${p}: one inline fold label`);
          assert.deepEqual(fold.notes, [t('fold_hint', { n: p === 'linkedin' ? 210 : 125, more: de['fold_more_' + p] })], `${p}: fold hint`);
        } else {
          assert.deepEqual(fold, { labels: 0, notes: [] }, `${p}: no fold`);
        }
      }
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('preview-post: a long X post folds after 280 weighted with X\'s own label, says so quietly, and stays postable', async () => {
    const expect = expectFor('preview-post', 'edge-x-long');
    const { ctx, page, log, run } = await open('preview-post', 'edge-x-long');
    try {
      const composed = expect.copies['x-text'];
      assert.equal(await page.textContent('#panel-x [slot="text"]'), composed, 'the whole text stays in the post');
      const view = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('#panel-x .rs-pf__see-more')].map((n) => n.getAttribute('data-label')),
        notes: [...document.querySelectorAll('#panel-x .rs-pf__foldnote')].filter((n) => !n.hidden).map((n) => n.textContent),
        counter: document.querySelector('[data-counter-id="x"] .rs-counter__num').textContent,
        over: document.querySelector('[data-counter-id="x"]').hasAttribute('over'),
        long: document.querySelector('#panel-x [data-pp="long-note"]').textContent,
        reason: document.querySelector('#blocked-x').hidden,
        /* X cuts at a word: the visible text before the ellipsis, the label on its own line */
        cut: (() => {
          const ellipsis = document.querySelector('#panel-x .rs-pf__ellipsis');
          const range = document.createRange();
          range.setStart(document.querySelector('#panel-x [slot="text"]'), 0);
          range.setEndBefore(ellipsis);
          return {
            before: range.toString(),
            ellipsis: ellipsis.getAttribute('data-label'),
            block: getComputedStyle(document.querySelector('#panel-x .rs-pf__see-more')).display,
          };
        })(),
      }));
      const cut = view.cut;
      delete view.cut;
      assert.equal(cut.ellipsis, '…');
      assert.equal(cut.block, 'block', 'Show more stands on its own line');
      assert.match(cut.before, /\S$/, 'the visible text ends on a word');
      assert.match(composed.slice(cut.before.length), /^\s/, 'the cut is at whitespace');
      assert.ok(RS_COUNT.count(cut.before, 'x').count <= 280, 'the visible part is a standard post');
      assert.ok(cut.before.length > 200, 'the cut stays near 280');
      assert.deepEqual(view, {
        labels: [de.fold_more_x],
        notes: [t('fold_hint', { n: 280, more: de.fold_more_x })],
        counter: t('counter_value', { value: String(expect.counters.x.count), limit: '25.000' }),
        over: false,
        long: de.x_long_post,
        reason: true,
      });
      /* posting everything yourself: the banner says it once; the panel does not repeat it */
      assert.equal(await page.textContent('#tab-x'), `${de.platform_x}${de.not_posted}`);
      assert.equal(await page.$('#panel-x [data-pp="manual-note"]'), null);
      assert.equal(await page.textContent('#rs-status'), de.select_posted);
      assert.equal(await page.textContent('#rs-alt'), de.request_changes);
      assert.equal(await page.isEnabled('#approve-x'), true);
      await page.check('#approve-x');
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(page, run), {
        decision: 'approve', platforms: [], comment: '', per_platform: { x: { mode: 'manual', decision: 'done' } },
      });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('preview-post: a manual platform over a hard limit is advice and stays postable', async () => {
    const data = fixture('preview-post', 'edge-x-limit');
    const opened = await open('preview-post', 'edge-x-limit', {
      data: {
        ...data, image: undefined, hashtags: ['a', 'b', 'c', 'd', 'e', 'f'],
        platforms: [{ platform: 'x', mode: 'manual' }, { platform: 'instagram', mode: 'manual' }],
      },
    });
    const { page } = opened;
    try {
      const x = await page.evaluate(() => ({
        advice: document.querySelector('#blocked-x').hasAttribute('data-advice'),
        text: document.querySelector('#blocked-x [data-pp="blocked-text"]').textContent,
        dot: document.querySelector('#tab-x .pp__state').getAttribute('data-rs-status'),
      }));
      assert.deepEqual(x, { advice: true, text: t('manual_over_limit', { limit: '25.000', platform: 'X' }), dot: 'open' });
      assert.equal(await page.isEnabled('#approve-x'), true, 'Posted is a fact the person reports');
      await page.click('#tab-instagram');
      assert.equal(await page.isEnabled('#approve-instagram'), true, 'no media and six hashtags: still postable by hand');
      assert.equal(await page.textContent('#blocked-instagram [data-pp="blocked-text"]'),
        [t('manual_over_hashtags', { n: 6, limit: 5, platform: 'Instagram' }), de.lint_ig_needs_image].join(` ${de.sep} `));
      await page.check('#approve-instagram');
      assert.equal(await page.textContent('#rs-status'), t('decided_count', { n: 1, total: 2 }));
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(page, opened.run), {
        decision: 'approve', platforms: [], comment: '',
        per_platform: { x: { mode: 'manual', decision: 'skipped' }, instagram: { mode: 'manual', decision: 'done' } },
      });
      assert.deepEqual(opened.log.errors, []);
    } finally { await opened.ctx.close(); }
  });

  test('preview-post: an auto platform over its limit names one recovery; nothing approvable says so', async () => {
    const limit = await open('preview-post', 'edge-x-limit');
    try {
      assert.equal(await limit.page.isDisabled('#approve-x'), true);
      const view = await limit.page.evaluate(() => ({
        reasons: [...document.querySelectorAll('#panel-x .pp__reason')].filter((n) => !n.hidden).map((n) => n.textContent),
        over: document.querySelector('[data-counter-id="x"] .rs-counter__over').textContent,
        dot: document.querySelector('#tab-x .pp__state').getAttribute('data-rs-status'),
        long: document.querySelector('#panel-x [data-pp="long-note"]').hidden,
      }));
      assert.deepEqual(view, {
        reasons: [t('shorten_to_approve', { n: 12 })], over: t('counter_over', { n: 12 }), dot: 'blocked', long: true,
      });
      assert.equal(await limit.page.textContent('#rs-status'), de.select_platform);
      await limit.page.click('#tab-linkedin');
      assert.equal(await limit.page.isDisabled('#approve-linkedin'), false);
      await limit.page.check('#approve-linkedin');
      assert.equal(await limit.page.textContent('#rs-status'), t('approve_count', { n: 1, total: 2 }));
    } finally {
      await limit.page.evaluate(() => localStorage.clear());
      await limit.ctx.close();
    }
    const data = fixture('preview-post', 'edge-x-limit');
    const dead = await open('preview-post', 'edge-x-limit', { data: { ...data, platforms: ['x'] } });
    try {
      assert.equal(await dead.page.textContent('#rs-status'), de.nothing_approvable);
      assert.equal(await dead.page.textContent('.rs-task__steps'), t('steps_nothing_approvable', { button: de.request_changes }));
      assert.equal(await dead.page.isDisabled('#rs-submit'), true);
      await dead.page.click('#rs-alt');
      assert.equal(await dead.page.textContent('.rs-task__steps'), t('task_steps_changes', { button: de.send_request }));
      assert.deepEqual(dead.log.errors, []);
    } finally { await dead.ctx.close(); }
    const max = await open('preview-post', 'edge-max');
    try {
      await max.page.click('#tab-instagram');
      assert.equal(await max.page.isDisabled('#approve-instagram'), true);
      assert.equal(await max.page.textContent('#blocked-instagram [data-pp="blocked-text"]'), t('hashtags_to_approve', { limit: 5 }));
      await max.page.click('#tab-x');
      assert.equal(await max.page.isDisabled('#approve-x'), false, 'X carries its own two hashtags');
    } finally { await max.ctx.close(); }
  });

  test('preview-post: edge-no-image blocks Instagram and names the payload flags in one quiet style note', async () => {
    const noImage = await open('preview-post', 'edge-no-image');
    try {
      assert.equal(await noImage.page.textContent('#panel-x [data-pp="style-note"]'), t('style_notes', { items: t('quoted', { text: '—' }) }),
        'only the flag that occurs');
      await noImage.page.click('#tab-instagram');
      assert.equal(await noImage.page.isDisabled('#approve-instagram'), true);
      assert.equal(await noImage.page.textContent('#blocked-instagram [data-pp="blocked-text"]'), de.lint_ig_needs_image);
      assert.equal(await noImage.page.getAttribute('#tab-instagram .pp__state', 'data-rs-status'), 'blocked');
      await noImage.page.click('#tab-facebook');
      assert.equal(await noImage.page.isVisible('#panel-facebook .rs-pf__link'), true, 'link card without an image');
      assert.equal(await noImage.page.textContent('#panel-facebook [slot="link-title"]'), fixture('preview-post', 'edge-no-image').link.title);
    } finally { await noImage.ctx.close(); }
  });

  test('preview-post: request changes needs a comment, survives a reload and sends no platforms', async () => {
    const { ctx, page, run } = await open('preview-post', 'golden');
    try {
      await page.check('#approve-x');
      await page.click('#rs-alt');
      assert.equal(await page.textContent('#rs-submit-label'), de.send_request);
      assert.equal(await page.isDisabled('#rs-submit'), true);
      await page.fill('#pp-comment', 'Use the shop front photo instead');
      await reload(page);
      assert.equal(await page.isVisible('[data-pp="request"]'), true);
      assert.equal(await page.inputValue('#pp-comment'), 'Use the shop front photo instead');
      await page.keyboard.press('Control+Enter');
      const note = 'Use the shop front photo instead';
      assert.deepEqual(await submitted(page, run), {
        decision: 'request_changes', platforms: [], comment: note,
        per_platform: {
          x: { mode: 'manual', decision: 'changes_requested', note },
          linkedin: { mode: 'auto', decision: 'changes_requested', note },
          instagram: { mode: 'auto', decision: 'changes_requested', note },
          facebook: { mode: 'auto', decision: 'changes_requested', note },
        },
      });
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
  });
  /* --------------------------------------------------- preview-post: modes */
  const label = (page) => page.textContent('#rs-submit-label');
  /* "Show in folder" lives in the overflow menu only */
  const revealFromMenu = async (page) => {
    await page.click('#rs-more-btn');
    await page.click('#rs-more-extra .rs-more__item');
  };

  test('preview-post: a manual tab is named quietly, copies come first (image too) and the primary marks it as posted', async () => {
    const { ctx, page, log, run } = await open('preview-post', 'golden');
    try {
      assert.equal(await page.textContent('#tab-x'), `${de.platform_x} · ${de.mode_manual}${de.not_posted}`, 'in a mix the mode is named');
      assert.equal(await page.textContent('#tab-linkedin'), `${de.platform_linkedin}${de.not_approved}`, 'auto is the quiet default');
      assert.equal(await page.textContent('#panel-x [data-pp="manual-note"]'), de.manual_note);
      assert.equal(await page.textContent('#panel-x [data-pp="approve-label"]'), de.posted);
      /* Tab order on the manual panel: the copies, then "Mark as posted" */
      const order = await page.$$eval('#panel-x .pp__side button, #panel-x .pp__side input', (els) => els.map((e) => e.id || e.closest('[data-copy-id]')?.dataset.copyId));
      assert.deepEqual(order, ['x-text', 'x-hashtags', 'x-comment', 'x-image', 'approve-x']);
      assert.equal(await label(page), de.submit_mixed, 'you post and the bot posts: a neutral send');
      assert.equal(await page.textContent('#rs-status'), de.select_platform_manual);
      assert.equal(await page.isDisabled('#rs-submit'), true, 'nothing ticked yet');
      const mediaId = await page.$eval('#panel-x [data-copy-id="x-image"]', (el) => el.getAttribute('media'));
      assert.match(mediaId, /^m_/, 'a media id, never a path');
      await page.click('[data-copy-id="x-image"] .rs-copy__btn');
      await page.waitForSelector('[data-copy-id="x-image"][data-state="copied"]');
      assert.deepEqual(log.images, [{ run_id: run.run_id, media_id: mediaId }]);
      assert.deepEqual(log.copies, [], 'an image is not copied as text');
      await revealFromMenu(page);
      await page.waitForFunction(() => document.querySelector('#rs-toasts .rs-toast'));
      assert.deepEqual(log.reveals, [{ run_id: run.run_id, media_id: mediaId }]);
      await page.check('#approve-x');
      assert.equal(await label(page), de.posted);
      assert.equal(await page.textContent('#rs-status'), t('mixed_posted_count', { n: 1 }));
      await page.click('#tab-linkedin');
      assert.equal(await page.$('#panel-linkedin [data-pp="manual-note"]'), null, 'auto keeps today\'s panel');
      assert.equal(await page.$('#panel-linkedin [data-copy-id="linkedin-image"]'), null);
      await page.check('#approve-linkedin');
      assert.equal(await label(page), de.submit_mixed, 'you posted X and the bot posts LinkedIn');
      assert.equal(await page.textContent('#rs-status'), `${t('mixed_approved_count', { n: 1 })} · ${t('mixed_posted_count', { n: 1 })}`);
      await page.click('#tab-x');
      await page.uncheck('#approve-x');
      assert.equal(await label(page), de.approve_post, 'only the bot posts');
      await page.check('#approve-x');
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(page, run), {
        decision: 'approve', platforms: ['linkedin'], comment: '',
        per_platform: {
          x: { mode: 'manual', decision: 'done' },
          linkedin: { mode: 'auto', decision: 'approved' },
          instagram: { mode: 'auto', decision: 'not_approved' },
          facebook: { mode: 'auto', decision: 'not_approved' },
        },
      });
      /* the decided report shows what it sent, the manual tick included */
      await reload(page);
      assert.equal(await page.isChecked('#approve-x'), true);
      await page.click('#tab-linkedin');
      assert.equal(await page.isChecked('#approve-linkedin'), true);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('preview-post: a quote with a video shows the poster, copies the file path and the link, and stays usable when locked', async () => {
    const data = fixture('preview-post', 'quote-video');
    const { ctx, page, log, run } = await open('preview-post', 'quote-video');
    try {
      await mediaSettled(page);
      const attrs = await page.$eval('#panel-x video', (el) => ({
        controls: el.controls,
        preload: el.preload,
        autoplay: el.autoplay,
        muted: el.muted,
        poster: el.poster,
        label: el.getAttribute('aria-label'),
      }));
      assert.equal(attrs.controls, true);
      assert.equal(attrs.preload, 'metadata');
      assert.equal(attrs.autoplay, false);
      assert.equal(attrs.muted, false);
      assert.match(attrs.poster, /\/media\/m_/);
      assert.equal(attrs.label, data.video.alt);
      assert.equal(await page.locator('#panel-x [slot="image"]').count(), 0);
      const placed = await page.evaluate(() => {
        const post = document.querySelector('#panel-x .rs-pf__post');
        const card = document.querySelector('#panel-x .rs-pf__quote');
        const text = document.querySelector('#panel-x [slot="text"]');
        return {
          inside: post.contains(card),
          afterText: Boolean(text.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
          replyHidden: document.querySelector('#panel-x .rs-pf__reply').hidden,
        };
      });
      assert.deepEqual(placed, { inside: true, afterText: true, replyHidden: true });
      assert.equal(await page.getAttribute('#panel-x .rs-pf__quote', 'href'), data.target.url);
      assert.equal(await page.textContent('#panel-x .rs-pf__quote-name'), 'Northwind Notes');
      assert.equal(await page.textContent('#panel-x .rs-pf__quote-handle'), t('pf_handle', { handle: 'northwindnotes' }));
      assert.equal(await page.textContent('#panel-x .rs-pf__quote-excerpt'), data.target.excerpt);
      assert.equal(await page.textContent('#panel-x .rs-pf__quote-domain'), 'example.com');
      const shown = await page.textContent('#panel-x [slot="text"]');
      assert.equal(shown, data.text);
      assert.equal(shown.includes(data.target.url), false);
      const counted = await page.$eval('[data-counter-id="x"]', (el) => el.result.count);
      assert.equal(counted, RS_COUNT.count(shown, 'x').count);
      const mediaId = await page.getAttribute('#panel-x [data-copy-id="x-video"]', 'media');
      assert.match(mediaId, /^m_/);
      await page.click('#panel-x [data-copy-id="x-video"] .rs-copy__btn');
      await page.waitForSelector('#panel-x [data-copy-id="x-video"][data-state="copied"]');
      assert.deepEqual(log.paths, [{ run_id: run.run_id, media_id: mediaId }]);
      assert.equal(await page.textContent('#panel-x [data-copy-id="x-link"] .rs-copy__value'), data.target.url);
      await page.click('#panel-x [data-copy-id="x-link"] .rs-copy__btn');
      await page.waitForSelector('#panel-x [data-copy-id="x-link"][data-state="copied"]');
      assert.equal(log.copies.at(-1).text, data.target.url);
      await revealFromMenu(page);
      await page.waitForFunction(() => document.querySelector('#rs-toasts .rs-toast'));
      assert.deepEqual(log.reveals, [{ run_id: run.run_id, media_id: mediaId }]);
      await page.click('#panel-x .rs-pf__quote');
      assert.deepEqual(log.urls, [{ run_id: run.run_id, url: data.target.url }]);
      assert.equal(page.url().startsWith(ORIGIN), true);
      await page.check('#approve-x');
      await page.keyboard.press('Control+Enter');
      await page.waitForSelector('.rs-banner[data-banner="submitted"]');
      assert.equal(await page.isEnabled('#panel-x [data-copy-id="x-video"] .rs-copy__btn'), true);
      await revealFromMenu(page);
      await page.waitForFunction(() => document.querySelectorAll('#rs-toasts .rs-toast').length > 0);
      assert.equal(log.reveals.length, 2);
      await page.click('#tab-linkedin');
      await mediaSettled(page);
      assert.equal(await page.locator('#panel-linkedin .rs-pf__quote').count(), 1);
      assert.equal(await page.locator('#panel-linkedin [data-copy-id="linkedin-video"]').count(), 0);
      assert.equal(await page.locator('#panel-linkedin [data-copy-id="linkedin-link"]').count(), 0);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }

    const replyData = { ...data, target: { ...data.target, type: 'reply' } };
    const reply = await open('preview-post', 'quote-video', { data: replyData });
    try {
      await mediaSettled(reply.page);
      assert.equal(await reply.page.textContent('#panel-x .rs-pf__reply'), t('replying_to', { handle: 'northwindnotes' }));
      const above = await reply.page.evaluate(() => {
        const post = document.querySelector('#panel-x .rs-pf__post');
        const card = document.querySelector('#panel-x .rs-pf__quote');
        return !post.contains(card) && Boolean(card.compareDocumentPosition(post) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      assert.equal(above, true);
      await reply.page.click('#tab-linkedin');
      assert.equal(await reply.page.locator('#panel-linkedin .rs-pf__quote').count(), 1);
      assert.equal(await reply.page.textContent('#panel-linkedin .rs-pf__reply'), t('replying_to', { handle: 'northwindnotes' }));
    } finally { await reply.ctx.close(); }

    const withIg = await open('preview-post', 'quote-video', {
      data: { ...data, platforms: [...data.platforms, { platform: 'instagram', mode: 'auto' }] },
    });
    try {
      await withIg.page.click('#tab-instagram');
      await mediaSettled(withIg.page);
      assert.equal(await withIg.page.locator('#panel-instagram video').count(), 1);
      assert.equal(await withIg.page.locator('#panel-instagram .rs-pf__quote').count(), 0);
      assert.equal(await withIg.page.isHidden('#lint-image-instagram'), true);
      assert.equal(await withIg.page.isDisabled('#approve-instagram'), false);
    } finally { await withIg.ctx.close(); }
  });

  test('preview-post: a reply without a handle stays a reply', async () => {
    const data = fixture('preview-post', 'quote-video');
    const cases = [
      ['missing author', { type: 'reply', url: data.target.url, excerpt: data.target.excerpt }, de.replying_to_post],
      ['empty author', { type: 'reply', url: data.target.url, excerpt: data.target.excerpt, author: {} }, de.replying_to_post],
      ['name only', { type: 'reply', url: data.target.url, excerpt: data.target.excerpt, author: { name: 'Northwind Notes' } }, t('replying_to_name', { name: 'Northwind Notes' })],
    ];
    for (const [label, target, replyText] of cases) {
      const opened = await open('preview-post', 'quote-video', { data: { ...data, target } });
      try {
        await mediaSettled(opened.page);
        assert.equal(await opened.page.textContent('#panel-x .rs-pf__reply'), replyText, label);
        const placed = await opened.page.evaluate(() => {
          const post = document.querySelector('#panel-x .rs-pf__post');
          const card = document.querySelector('#panel-x .rs-pf__quote');
          const reply = document.querySelector('#panel-x .rs-pf__reply');
          return {
            above: !post.contains(card) && Boolean(card.compareDocumentPosition(post) & Node.DOCUMENT_POSITION_FOLLOWING),
            embed: card.classList.contains('rs-pf__quote--embed'),
            replyHidden: reply.hidden,
            kind: document.querySelector('#panel-x [slot="target-type"]').textContent,
          };
        });
        assert.equal(placed.kind, 'reply', label);
        assert.equal(placed.above, true, label);
        assert.equal(placed.embed, false, label);
        assert.equal(placed.replyHidden, false, label);
        await opened.page.click('#tab-linkedin');
        const linkedin = await opened.page.evaluate(() => {
          const card = document.querySelector('#panel-linkedin .rs-pf__quote');
          const reply = document.querySelector('#panel-linkedin .rs-pf__reply');
          return {
            embed: card.classList.contains('rs-pf__quote--embed'),
            above: card.classList.contains('rs-pf__quote--above'),
            reply: reply.textContent,
            replyHidden: reply.hidden,
            kind: document.querySelector('#panel-linkedin [slot="target-type"]').textContent,
          };
        });
        assert.equal(linkedin.kind, 'reply', label);
        assert.equal(linkedin.reply, replyText, label);
        assert.equal(linkedin.replyHidden, false, label);
        assert.equal(linkedin.embed, true, label);
        assert.equal(linkedin.above, false, label);
      } finally { await opened.ctx.close(); }
    }
  });

  function clipIds(run) {
    const record = json(path.join(server.dataDir, 'runs', `${run.run_id}.json`));
    return { video: record.payload.data.video.path, poster: record.payload.data.video.poster };
  }

  test('preview-post: a video that cannot play keeps its poster and stays within three controls', async () => {
    const normal = await open('preview-post', 'quote-video');
    let normalCounts;
    try {
      await mediaSettled(normal.page);
      normalCounts = await calmCounts(normal.page);
      assert.ok(normalCounts.length && normalCounts.every((n) => n <= 3), `normal ${normalCounts}`);
    } finally { await normal.ctx.close(); }

    const corrupt = await open('preview-post', 'quote-video', {
      beforeGoto: async (page, run) => {
        const ids = clipIds(run);
        await page.route(new RegExp(`/media/${ids.video}`), (route) => route.fulfill({
          status: 200, contentType: 'video/mp4', body: Buffer.from('not-a-video'),
        }));
      },
    });
    try {
      await corrupt.page.waitForFunction(
        () => document.querySelector('#panel-x rs-post-frame')?.getAttribute('data-image-state') === 'unavailable',
        null, { timeout: 8000 },
      );
      const view = await corrupt.page.evaluate((message) => {
        const frame = document.querySelector('#panel-x rs-post-frame');
        const poster = frame.querySelector('.rs-pf__poster');
        const video = frame.querySelector('video');
        return {
          state: frame.getAttribute('data-image-state'),
          posterVisible: poster && !poster.hidden && poster.getClientRects().length > 0,
          videoHidden: video.hidden,
          note: frame.querySelector('.rs-pf__video-note')?.textContent || '',
          retry: frame.querySelectorAll('.rs-pf__image-retry').length,
          icon: frame.querySelectorAll('.rs-pf__empty-ico').length,
        };
      }, de.pf_video_unavailable);
      assert.equal(view.state, 'unavailable');
      assert.equal(view.posterVisible, true);
      assert.equal(view.videoHidden, true);
      assert.equal(view.note, de.pf_video_unavailable);
      assert.equal(view.retry, 0);
      assert.equal(view.icon, 0);
      assert.equal(await corrupt.page.locator('#panel-x [data-copy-id="x-video"]').count(), 1);
      assert.equal(await corrupt.page.locator('#rs-more-extra .rs-more__item').count(), 1, 'Show in folder stays in the menu');
      const counts = await calmCounts(corrupt.page);
      assert.deepEqual(counts, normalCounts);
      assert.ok(counts.every((n) => n <= 3), `error ${counts}`);
    } finally { await corrupt.ctx.close(); }

    const stalled = await open('preview-post', 'quote-video', {
      query: '&video_ms=400',
      beforeGoto: async (page, run) => {
        const ids = clipIds(run);
        await page.route(new RegExp(`/media/${ids.video}`), () => new Promise(() => {}));
      },
    });
    try {
      await stalled.page.waitForFunction(
        () => document.querySelector('#panel-x rs-post-frame')?.getAttribute('data-image-state') === 'unavailable',
        null, { timeout: 8000 },
      );
      const view = await stalled.page.evaluate(() => {
        const frame = document.querySelector('#panel-x rs-post-frame');
        const poster = frame.querySelector('.rs-pf__poster');
        return {
          state: frame.getAttribute('data-image-state'),
          posterVisible: poster && !poster.hidden && poster.getClientRects().length > 0,
          note: frame.querySelector('.rs-pf__video-note')?.textContent || '',
        };
      });
      assert.equal(view.state, 'unavailable');
      assert.equal(view.posterVisible, true);
      assert.equal(view.note, de.pf_video_unavailable);
    } finally { await stalled.ctx.close(); }

    const posterFail = await open('preview-post', 'quote-video', {
      beforeGoto: async (page, run) => {
        const ids = clipIds(run);
        await page.route(new RegExp(`/media/${ids.poster}`), (route) => route.fulfill({ status: 404, body: '' }));
      },
    });
    try {
      await posterFail.page.waitForFunction(
        () => document.querySelector('#panel-x rs-post-frame')?.getAttribute('data-poster-state') === 'error',
        null, { timeout: 8000 },
      );
      await mediaSettled(posterFail.page);
      const view = await posterFail.page.evaluate(() => {
        const frame = document.querySelector('#panel-x rs-post-frame');
        const poster = frame.querySelector('.rs-pf__poster');
        return {
          posterState: frame.getAttribute('data-poster-state'),
          posterHidden: !poster || poster.hidden,
          icon: frame.querySelectorAll('.rs-pf__empty-ico').length,
          video: frame.querySelectorAll('video').length,
        };
      });
      assert.equal(view.posterState, 'error');
      assert.equal(view.posterHidden, true);
      assert.equal(view.icon, 0);
      assert.equal(view.video, 1);
    } finally { await posterFail.ctx.close(); }

    const preloadNone = await open('preview-post', 'quote-video', { query: '&video_ms=300' });
    try {
      await mediaSettled(preloadNone.page);
      await preloadNone.page.evaluate(() => {
        const frame = document.querySelector('#panel-x rs-post-frame');
        const video = frame.querySelector('video');
        video.setAttribute('preload', 'none');
        video.removeAttribute('src');
        video.load();
        const ratio = frame.getAttribute('ratio');
        frame.setAttribute('ratio', ratio === '16:9' ? '4:5' : '16:9');
      });
      await preloadNone.page.waitForTimeout(700);
      const state = await preloadNone.page.getAttribute('#panel-x rs-post-frame', 'data-image-state');
      assert.ok(state === 'poster' || state === 'loaded', state);
      assert.equal(await preloadNone.page.locator('#panel-x .rs-pf__video-note').count(), 0);
      assert.equal(await preloadNone.page.locator('#panel-x .rs-pf__image-retry').count(), 0);
    } finally { await preloadNone.ctx.close(); }

    const nonePlay = await open('preview-post', 'quote-video', { query: '&video_ms=300' });
    try {
      const ids = clipIds(nonePlay.run);
      await nonePlay.page.route(new RegExp(`/media/${ids.video}`), (route) => route.fulfill({
        status: 200, contentType: 'video/mp4', body: Buffer.from('not-a-video'),
      }));
      await nonePlay.page.evaluate(() => {
        const frame = document.querySelector('#panel-x rs-post-frame');
        const video = frame.querySelector('video');
        video.setAttribute('preload', 'none');
        const next = new URL(video.src, document.baseURI);
        next.searchParams.set('rs_bad', '1');
        video.src = next.href;
        const ratio = frame.getAttribute('ratio');
        frame.setAttribute('ratio', ratio === '16:9' ? '4:5' : '16:9');
      });
      await nonePlay.page.waitForTimeout(700);
      const idle = await nonePlay.page.evaluate(() => {
        const frame = document.querySelector('#panel-x rs-post-frame');
        const poster = frame.querySelector('.rs-pf__poster');
        return {
          state: frame.getAttribute('data-image-state'),
          note: frame.querySelectorAll('.rs-pf__video-note').length,
          posterVisible: !!(poster && !poster.hidden && poster.getClientRects().length > 0),
        };
      });
      assert.equal(idle.state, 'poster', idle.state);
      assert.equal(idle.note, 0);
      assert.equal(idle.posterVisible, true);
      await nonePlay.page.evaluate(async () => {
        const video = document.querySelector('#panel-x rs-post-frame video');
        const play = HTMLMediaElement.prototype.play;
        try { await play.call(video); } catch { /* the clip cannot play */ }
      });
      await nonePlay.page.waitForFunction(
        () => document.querySelector('#panel-x rs-post-frame')?.getAttribute('data-image-state') === 'unavailable',
        null, { timeout: 8000 },
      );
      const played = await nonePlay.page.evaluate(() => {
        const frame = document.querySelector('#panel-x rs-post-frame');
        const poster = frame.querySelector('.rs-pf__poster');
        const video = frame.querySelector('video');
        return {
          state: frame.getAttribute('data-image-state'),
          posterVisible: !!(poster && !poster.hidden && poster.getClientRects().length > 0),
          videoHidden: video.hidden,
          note: frame.querySelector('.rs-pf__video-note')?.textContent || '',
          retry: frame.querySelectorAll('.rs-pf__image-retry').length,
        };
      });
      assert.equal(played.state, 'unavailable');
      assert.equal(played.posterVisible, true);
      assert.equal(played.videoHidden, true);
      assert.equal(played.note, de.pf_video_unavailable);
      assert.equal(played.retry, 0);
      const noneCounts = await calmCounts(nonePlay.page);
      assert.ok(noneCounts.length && noneCounts.every((n) => n <= 3), `none play ${noneCounts}`);
    } finally { await nonePlay.ctx.close(); }
  });

  test('preview-post: plain platform ids stay auto (no mode named); only manual platforms read "Mark as posted"', async () => {
    const data = fixture('preview-post', 'golden');
    const legacy = { ...data, platforms: ['x', 'linkedin'] };
    const plain = await open('preview-post', 'golden', { data: legacy });
    try {
      assert.equal(await plain.page.$('.pp__mode'), null);
      assert.equal(await plain.page.$('[data-pp="manual-note"]'), null);
      assert.equal(await plain.page.textContent('#panel-x [data-pp="approve-label"]'), t('approve_for', { platform: de.platform_x }));
      await plain.page.check('#approve-x');
      assert.equal(await label(plain.page), de.approve_post);
      assert.equal(await plain.page.textContent('#rs-status'), t('approve_count', { n: 1, total: 2 }));
      await plain.page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(plain.page, plain.run), {
        decision: 'approve', platforms: ['x'], comment: '',
        per_platform: { x: { mode: 'auto', decision: 'approved' }, linkedin: { mode: 'auto', decision: 'not_approved' } },
      });
    } finally { await plain.ctx.close(); }
    const handOnly = await open('preview-post', 'golden', { data: { ...data, platforms: [{ platform: 'x', mode: 'manual' }] } });
    try {
      assert.equal(await label(handOnly.page), de.posted);
      assert.equal(await handOnly.page.textContent('#rs-status'), de.select_posted);
      assert.equal(await handOnly.page.$('.pp__mode'), null, 'posting everything yourself: no mode in the tab');
      assert.equal(await handOnly.page.$('[data-pp="manual-note"]'), null);
      assert.equal(await handOnly.page.isDisabled('#rs-submit'), true);
      await handOnly.page.check('#approve-x');
      assert.equal(await label(handOnly.page), de.posted);
      await handOnly.page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(handOnly.page, handOnly.run), {
        decision: 'approve', platforms: [], comment: '',
        per_platform: { x: { mode: 'manual', decision: 'done' } },
      }, 'posted by hand: nothing for the bot to post');
    } finally { await handOnly.ctx.close(); }
  });

  test('decide-list: user items use Posted, Skip and Later, and Open post calls /open-url', async () => {
    const { ctx, page, log, run } = await open('decide-list', 'edge-replies');
    try {
      assert.equal(await page.textContent('#rs-submit-label'), de.footer_done);
      // the steps name the footer as it reads
      assert.equal(await page.textContent('.rs-task__steps'), de.task_steps_replies.replace('{button}', de.footer_done));
      const labels = await page.$$eval('[data-current] rs-action-row button', (buttons) => buttons.map((b) => b.textContent));
      assert.deepEqual(labels, [de.posted, de.skip, de.later]);
      const href = await page.getAttribute('[data-current] .dl-url a.rs-ext', 'href');
      assert.equal(href, 'https://x.com/example/status/184201');
      assert.match(await page.textContent('[data-current] .dl-card__eyebrow'), /^Example Harbour/);
      await page.click('[data-current] .dl-url a.rs-ext');
      assert.deepEqual(log.urls, [{ run_id: run.run_id, url: href }]);
      assert.equal(page.url().startsWith(ORIGIN), true);
      for (const value of ['done', 'skipped', 'later', 'done']) {
        await page.click(`[data-current] rs-action-row button[value="${value}"]`);
      }
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(page, run), {
        items: [
          { id: 'reply-ferry', choice: 'done', note: '' },
          { id: 'reply-market', choice: 'skipped', note: '' },
          { id: 'reply-library', choice: 'later', note: '' },
          { id: 'reply-bakery', choice: 'done', note: '' },
        ],
        note: '',
      });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('preview-post: posting yourself, the alternative is Request changes (no Skip); a mixed report waits for a tick', async () => {
    const data = fixture('preview-post', 'golden');
    const platforms = [{ platform: 'x', mode: 'manual' }, { platform: 'linkedin', mode: 'manual' }];
    const opened = await open('preview-post', 'golden', { data: { ...data, platforms } });
    try {
      const { page } = opened;
      assert.equal(await label(page), de.posted);
      assert.equal(await page.isDisabled('#rs-submit'), true, 'an approval always has a tick');
      assert.equal(await page.textContent('#rs-status'), de.select_posted);
      assert.equal(await page.textContent('#rs-alt'), de.request_changes);
      await page.check('#approve-x');
      assert.equal(await page.textContent('#rs-status'), t('decided_count', { n: 1, total: 2 }));
      await page.click('#rs-alt');
      assert.equal(await label(page), de.send_request);
      await page.fill('#pp-comment', 'Use the spring photo');
      await page.keyboard.press('Control+Enter');
      const note = 'Use the spring photo';
      assert.deepEqual(await submitted(page, opened.run), {
        decision: 'request_changes', platforms: [], comment: note,
        per_platform: {
          x: { mode: 'manual', decision: 'changes_requested', note },
          linkedin: { mode: 'manual', decision: 'changes_requested', note },
        },
      });
      assert.deepEqual(opened.log.errors, []);
    } finally { await opened.ctx.close(); }
    const mixed = await open('preview-post', 'golden', {
      data: { ...data, platforms: [{ platform: 'x', mode: 'manual' }, { platform: 'linkedin', mode: 'auto' }] },
    });
    try {
      assert.equal(await label(mixed.page), de.submit_mixed);
      assert.equal(await mixed.page.isDisabled('#rs-submit'), true);
      assert.equal(await mixed.page.textContent('#rs-status'), de.select_platform_manual);
      assert.equal(await mixed.page.textContent('#rs-alt'), de.request_changes);
    } finally { await mixed.ctx.close(); }
  });

  async function calmCounts(page) {
    const verified = await page.evaluate(() => {
      const selector = '[role="radiogroup"],[role="toolbar"],[role="tablist"]';
      return [...document.querySelectorAll(selector)].flatMap((group, index) => {
        const members = [...group.querySelectorAll('button,a[href],input,select,textarea,[role="radio"]')].filter((element) => {
          if (element.closest(selector) !== group) return false;
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') <= 0.05) return false;
          }
          return element.getClientRects().length > 0;
        });
        const roving = members.length > 1
          && members.filter((element) => element.tabIndex === 0).length === 1
          && members.every((element) => element.tabIndex <= 0);
        return roving ? [`group-${index}`] : [];
      });
    });
    const facts = await page.evaluate(calmEvaluator, {
      thresholds: CALM_THRESHOLDS,
      templateId: 'decide-list',
      openRuns: 1,
      verifiedRovingGroups: verified,
    });
    return facts.K2.items.map((item) => item.interactive_count);
  }

  async function assertItemBudget(page, where) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    let counts = await calmCounts(page);
    assert.ok(counts.length && counts.every((n) => n <= 3), `${where} rest ${counts}`);
    await page.hover('[data-current]');
    counts = await calmCounts(page);
    assert.ok(counts.every((n) => n <= 3), `${where} hover ${counts}`);
    await page.mouse.move(0, 0);
    await page.focus('[data-current] rs-action-row button');
    counts = await calmCounts(page);
    assert.ok(counts.every((n) => n <= 3), `${where} focus ${counts}`);
    await page.click('[data-current] .dl-add-note');
    counts = await calmCounts(page);
    assert.ok(counts.every((n) => n <= 3), `${where} note ${counts}`);
  }

  test('decide-list: links do not navigate, and each item stays within three controls', async () => {
    const { ctx, page, log, run } = await open('decide-list', 'edge-replies');
    const pause = () => page.waitForTimeout(450);
    const link = '[data-current] .dl-url a.rs-ext';
    try {
      const href = await page.getAttribute(link, 'href');
      const probe = await page.evaluate((urlVectors) => {
        const anchor = document.querySelector('[data-current] .dl-url a.rs-ext');
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
        document.querySelector('[data-current] input').dispatchEvent(fieldOver);
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
          accepted: urlVectors.both.concat(urlVectors.opener_only).filter((u) => RS.externalLink(u, 'x') === null),
          refused: urlVectors.bad.filter((u) => RS.externalLink(u, 'x') !== null),
        };
      }, URL_VECTORS);
      assert.equal(probe.draggable, 'false');
      assert.equal(probe.startCancelled, true);
      assert.equal(probe.overCancelled, true);
      assert.equal(probe.dropCancelled, true);
      assert.equal(probe.textCancelled, false);
      assert.equal(probe.fieldCancelled, false);
      assert.equal(probe.menuCancelled, true);
      assert.equal(probe.linksOnly, 'https://example.com/only-the-link');
      assert.equal(probe.badLink, true);
      assert.equal(probe.pathAt, 'https://example.com/a@b');
      assert.deepEqual(probe.accepted, [], 'the page opens what the opener accepts (url_vectors.json)');
      assert.deepEqual(probe.refused, [], 'the page refuses what the opener refuses (url_vectors.json)');
      assert.deepEqual(log.urls, []);

      await page.click(link);
      await pause();
      await page.click(link, { button: 'middle' });
      await pause();
      await page.focus(link);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+Enter');
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
      assert.deepEqual(log.urls.map((entry) => entry.url), Array(7).fill(href));
      assert.equal(new URL(page.url()).origin, ORIGIN);

      await assertItemBudget(page, 'edge-replies');
      for (const value of ['done', 'skipped', 'later', 'done']) {
        await page.click(`[data-current] rs-action-row button[value="${value}"]`);
      }
      await page.keyboard.press('Control+Enter');
      await submitted(page, run);
      await page.goto(server.url('?client=test&run=' + run.run_id));
      await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
      await pause();
      await page.click('.dl-item[data-item-id="reply-ferry"] .dl-row');
      await page.click('[data-current] .dl-url a.rs-ext');
      assert.equal(log.urls.at(-1).url, href);
      assert.equal(log.urls.length, 8);
      assert.equal(new URL(page.url()).origin, ORIGIN);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('decide-list: linked title and detail stay within three controls and do not repeat the post URL', async () => {
    const linked = {
      intro: 'Two replies with links in the text.',
      items: [
        {
          id: 'reply-linked',
          actor: 'user',
          source: 'Example Harbour',
          title: 'See https://example.com/title-note and https://x.com/example/status/184201',
          detail: 'Notes at https://example.com/detail-note.',
          url: 'https://x.com/example/status/184201',
          copy: [{ label: 'Copy reply', text: 'The 08:10 is running.' }],
        },
        {
          id: 'reply-plain',
          actor: 'user',
          source: 'Example Market',
          title: 'Reply under the stall question',
          detail: 'See https://example.com/market-note before you answer.',
          copy: [{ label: 'Copy reply', text: 'Yes, from 9:00.' }],
        },
      ],
    };
    const { ctx, page, log } = await open('decide-list', 'edge-replies', { data: linked });
    try {
      const hrefs = await page.$$eval('[data-current] a.rs-ext', (els) => els.map((a) => a.getAttribute('href')).sort());
      assert.deepEqual(hrefs, ['https://example.com/detail-note', 'https://example.com/title-note', 'https://x.com/example/status/184201'].sort());
      const titleHrefs = await page.$$eval('[data-current] .dl-card__title a', (els) => els.map((a) => a.getAttribute('href')));
      assert.deepEqual(titleHrefs, ['https://example.com/title-note']);
      assert.match(await page.textContent('[data-current] .dl-card__title'), /https:\/\/x\.com\/example\/status\/184201/);
      assert.equal(await page.locator('[data-current] [role="toolbar"]').count(), 1);
      await page.focus('[data-current] [role="toolbar"] a');
      const seen = [await page.evaluate(() => document.activeElement.getAttribute('href'))];
      for (let i = 0; i < hrefs.length; i++) {
        await page.keyboard.press('ArrowRight');
        seen.push(await page.evaluate(() => document.activeElement.getAttribute('href')));
      }
      assert.equal(seen[seen.length - 1], seen[0]);
      assert.equal(new Set(seen.slice(0, hrefs.length)).size, hrefs.length);
      await assertItemBudget(page, 'linked');
      await page.click('.dl-item[data-item-id="reply-plain"] .dl-row');
      assert.equal(await page.locator('[data-current] a.rs-ext').count(), 1);
      await assertItemBudget(page, 'detail link');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });
});
