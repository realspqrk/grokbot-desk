// Browser tests for the shipped built-ins decide-list, approve-one and
// preview-post on the real served shell: isolated server on the worker's
// port range with a temp RS_DATA_DIR, headless Edge 1500x1000, German table.
// /copy is always fulfilled by page.route (the posted body is checked), so
// the real clipboard is never touched.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 10;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BUILTIN = path.join(ROOT, 'templates', 'builtin');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const fixture = (id, name) => json(path.join(BUILTIN, id, 'fixtures', `${name}.json`));
const expectFor = (id, name) => json(path.join(BUILTIN, id, 'fixtures', 'expect', `${name}.json`));
const de = json(path.join(ROOT, 'core', 'i18n', 'de.json'));
const AXE = path.join(ROOT, 'vendor', 'axe.min.js');
const t = (key, params = {}) => de[key].replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
const RS_COUNT = createRequire(import.meta.url)('../core/static/count.js');

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

async function runStep(page, step) {
  if (step.click) await page.click(step.click);
  else if (step.fill) await page.fill(step.fill[0], step.fill[1]);
  else if (step.type !== undefined) await page.keyboard.type(step.type);
  else if (step.press) for (let i = 0; i < (step.repeat || 1); i++) await page.keyboard.press(step.press);
  else throw new Error('unknown step ' + JSON.stringify(step));
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
    const run = server.show(opts.data || fixture(id, name), { template: id, bot: 'example-bot', title: `${id} ${name}` });
    const ctx = await browser.newContext({
      viewport: opts.viewport || { width: 1500, height: 1000 }, deviceScaleFactor: 1,
      colorScheme: opts.colorScheme || 'light', reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const log = { errors: [], copies: [] };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.errors.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    await page.route(ORIGIN + '/copy', async (route) => {
      log.copies.push(JSON.parse(route.request().postData()));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(server.url('?client=test&run=' + run.run_id));
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
    ['decide-list', ['golden', 'edge-single', 'edge-unicode', 'edge-max']],
    ['approve-one', ['golden', 'edge-access', 'edge-minimal', 'edge-max']],
    ['preview-post', ['golden', 'edge-no-image', 'edge-x-limit', 'edge-max']],
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
            assert.equal(await page.isDisabled('#rs-submit'), true, `${name}: nothing is decided at rest`);
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
    data.points = data.points.slice(0, 2);
    for (const colorScheme of ['light', 'dark']) {
      const { ctx, page, log } = await open('approve-one', 'golden', { data, colorScheme, viewport: { width: 1280, height: 720 } });
      try {
        await tabToSummary(page);
        const fits = await held(page);
        assert.equal(fits.more, false, `${colorScheme}: the closed report fits`);
        assert.equal(fits.scroll, 0);
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
    const { ctx, page } = await open('approve-one', 'golden', { data, viewport: { width: 1280, height: 720 } });
    try {
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
      assert.equal(await page.textContent('[data-dl="intro"]'), data.intro);
      assert.equal(await page.locator('.dl-card').count(), 1, 'only the current card is in the document');
      const first = data.items[0];
      const card = await page.$eval('.dl-item[data-current]', (c) => ({
        id: c.getAttribute('data-item-id'),
        eyebrow: c.querySelector('.dl-card__eyebrow').textContent,
        title: c.querySelector('.dl-card__title').textContent,
        choices: [...c.querySelectorAll('rs-action-row button')].map((b) => [b.value, b.textContent, b.getAttribute('aria-checked')]),
      }));
      assert.equal(card.id, first.id);
      assert.equal(card.eyebrow, first.kind + t('due', { date: '14.10.' }));
      assert.equal(card.title, `${first.source} ${first.title}`);
      assert.deepEqual(card.choices, dlChoice(first).map((c) => [c, de['choice_' + c], 'false']), 'no preselection');
      for (let i = 0; i < data.items.length; i++) {
        const left = data.items.slice(i);
        assert.equal(await page.textContent('#rs-status'), t('items_open_named', {
          n: left.length, total: data.items.length, names: left.map((w) => w.source || w.title).join(de.sep_names),
        }));
        assert.equal(await page.isDisabled('#rs-submit'), true);
        const w = data.items[i];
        await page.click(`rs-action-row[data-item="${w.id}"] button[value="${dlChoice(w).at(-1)}"]`);
        assert.equal(await page.getAttribute(`.dl-item[data-item-id="${w.id}"]`, 'data-decided'), dlChoice(w).at(-1));
      }
      assert.equal(await page.textContent('#rs-status'), de.items_all_decided);
      assert.equal(await page.isDisabled('#rs-submit'), false);
      assert.equal(await page.textContent('.dl-item[data-item-id="travel-workshop"] .dl-row__outcome'), de.choice_defer);
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
  test('approve-one: the primary names the decision; a note only travels when it is shown', async () => {
    const data = fixture('approve-one', 'golden');
    const { ctx, page, run } = await open('approve-one', 'golden');
    try {
      assert.equal(await page.textContent('#rs-status'), de.decision_pick);
      assert.deepEqual(await page.$$eval('[data-ao="choice"] button', (b) => b.map((x) => [x.value, x.getAttribute('aria-checked')])),
        [['approve', 'false'], ['reject', 'false'], ['request_changes', 'false']]);
      await page.click('[data-ao="choice"] button[value="request_changes"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'ao-comment', 'Request changes moves to the comment');
      assert.equal(await page.textContent('#rs-submit-label'), de.send_request);
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.textContent('#rs-status'), de.comment_required);
      await page.fill('#ao-comment', '   ');
      assert.equal(await page.isDisabled('#rs-submit'), true, 'whitespace is not a comment');
      await page.fill('#ao-comment', 'Not before Friday');
      assert.equal(await page.isDisabled('#rs-submit'), false);
      await page.click('[data-ao="choice"] button[value="reject"]');
      assert.equal(await page.textContent('#rs-submit-label'), de.send_rejection);
      assert.equal(await page.isHidden('[data-ao="comment-box"]'), true, 'the change request text hides with its mode');
      await page.click('[data-ao="choice"] button[value="approve"]');
      assert.equal(await page.textContent('#rs-submit-label'), data.approve_label);
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(page, run), { decision: 'approve', comment: '' });
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
  });

  test('approve-one: yes/no only without allow_changes; a shown note is sent with a rejection', async () => {
    const { ctx, page, run } = await open('approve-one', 'edge-access');
    try {
      assert.deepEqual(await page.$$eval('[data-ao="choice"] button', (b) => b.map((x) => x.value)), ['approve', 'reject']);
      await page.click('[data-ao="choice"] button[value="reject"]');
      await page.click('[data-ao="note-open"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'ao-comment');
      await page.fill('#ao-comment', 'Use the weekly export for now');
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(page, run), { decision: 'reject', comment: 'Use the weekly export for now' });
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
  });

  test('approve-one: a change request survives a reload and never turns into an approval; empty sections are not rendered', async () => {
    const { ctx, page } = await open('approve-one', 'golden');
    try {
      await page.click('[data-ao="choice"] button[value="request_changes"]');
      await page.fill('#ao-comment', 'Wait for the sale to end');
      await reload(page);
      assert.equal(await page.getAttribute('[data-ao="choice"] button[value="request_changes"]', 'aria-checked'), 'true');
      assert.equal(await page.inputValue('#ao-comment'), 'Wait for the sale to end');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'ao-comment');
      assert.equal(await page.textContent('#rs-submit-label'), de.send_request);
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
    const minimal = await open('approve-one', 'edge-minimal');
    try {
      const present = await minimal.page.evaluate(() => ['facts', 'copies', 'points-box', 'checks-box', 'reference-box']
        .filter((name) => document.querySelector(`[data-ao="${name}"]`)));
      assert.deepEqual(present, []);
    } finally { await minimal.ctx.close(); }
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

  test('preview-post: edge-x-limit blocks X at 281; edge-no-image blocks Instagram and shows the payload flags', async () => {
    const limit = await open('preview-post', 'edge-x-limit');
    try {
      assert.equal(await limit.page.isDisabled('#approve-x'), true);
      assert.equal(await limit.page.textContent('#blocked-x [data-pp="blocked-text"]'), de.over_limit_blocks);
      await limit.page.click('#tab-linkedin');
      assert.equal(await limit.page.isDisabled('#approve-linkedin'), false);
      await limit.page.check('#approve-linkedin');
      assert.equal(await limit.page.textContent('#rs-status'), t('approve_count', { n: 1, total: 2 }));
    } finally {
      await limit.page.evaluate(() => localStorage.clear());
      await limit.ctx.close();
    }
    const noImage = await open('preview-post', 'edge-no-image');
    try {
      assert.deepEqual(await noImage.page.$$eval('#panel-x [data-pp="badges"] rs-badge', (b) => b.map((x) => x.textContent)),
        [t('lint_found', { text: '—' })], 'only the flag that occurs');
      await noImage.page.click('#tab-instagram');
      assert.equal(await noImage.page.isDisabled('#approve-instagram'), true);
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
      assert.deepEqual(await submitted(page, run), { decision: 'request_changes', platforms: [], comment: 'Use the shop front photo instead' });
    } finally {
      await page.evaluate(() => localStorage.clear());
      await ctx.close();
    }
  });
});
