// Built-ins review-doc and pick-option in the served shell (headless
// Edge, isolated server with a temp RS_DATA_DIR): the safe Markdown subset
// stays inert, drafts survive a reload, a submitted report reopens read-only,
// and the option cards are one radio group with aligned rows.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 11;
if (PORT === 18742) throw new Error('refusing the product port');
const DIR = (id) => path.join(ROOT, 'templates', 'builtin', id);
const fixture = (id, name) => JSON.parse(readFileSync(path.join(DIR(id), 'fixtures', name + '.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(ROOT, 'core', 'i18n', 'de.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('built-ins review-doc and pick-option (served, headless Edge)', { skip }, () => {
  let server;
  let browser;

  before(async () => {
    server = await startServer({ port: PORT });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

  const show = (template, data, title = 'Test report') => server.show(data, { template, version: 1, title });

  async function open(runId, viewport = { width: 1280, height: 720 }) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => requests.push(r.url()));
    page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.goto(server.url(`?client=test&run=${runId}`));
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
    return { ctx, page, errors, requests };
  }
  async function reload(page) {
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
  }
  /* Open the decided report again by its own address. A plain reload is not
     enough: after a send the page moves on to the next open report (earlier
     tests leave some open) and puts that report's id in the address; on a
     fast machine that happens before the reload. */
  async function reopen(page, runId) {
    await page.goto(server.url(`?client=test&run=${runId}`));
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
  }
  async function tabTo(page, selector) {
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((s) => document.activeElement.matches(s), selector)) return;
    }
    throw new Error('cannot Tab to ' + selector);
  }
  async function waitResult(runId) {
    const deadline = Date.now() + 5000;
    while (!server.result(runId) && Date.now() < deadline) await sleep(20);
    const result = server.result(runId);
    assert.ok(result, 'no result file');
    return result;
  }

  test('review-doc: pasted HTML, links and web images stay inert text', async () => {
    const run = show('review-doc', fixture('review-doc', 'edge-html'));
    const { ctx, page, errors, requests } = await open(run.run_id);
    try {
      const doc = await page.evaluate(() => {
        const d = document.querySelector('.rd__doc');
        return {
          text: d.textContent,
          tags: [...new Set([...d.querySelectorAll('*')].map((n) => n.tagName.toLowerCase()))].sort(),
          missing: [...d.querySelectorAll('.rd__img-missing')].map((n) => n.textContent),
          urls: [...d.querySelectorAll('.rd__url')].map((n) => n.textContent),
        };
      });
      for (const tag of ['script', 'img', 'b']) assert.ok(!doc.tags.includes(tag), `unexpected <${tag}>`);
      assert.ok(doc.tags.includes('a'), 'a markdown http link is a real anchor');
      assert.ok(doc.text.includes('<script>alert(1)</script>'));
      assert.ok(doc.text.includes('<b>every day from 8:00 to 20:00</b>'));
      assert.ok(doc.text.includes('<a href="https://larkspur.example/rules">'), 'raw HTML stays text');
      assert.deepEqual(doc.missing, [de.rd_image_missing.replace('{alt}', 'Photo of the gate')]);
      assert.deepEqual(doc.urls, ['https://larkspur.example/contact']);
      const href = await page.getAttribute('.rd__doc a.rs-ext', 'href');
      assert.equal(href, 'https://larkspur.example/contact');
      const opened = [];
      await page.route('**/open-url', async (route) => {
        opened.push(JSON.parse(route.request().postData()));
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      const stayed = page.url();
      await page.click('.rd__doc a.rs-ext');
      assert.equal(page.url(), stayed, 'the app window does not navigate');
      assert.equal(opened.length, 1);
      assert.equal(opened[0].url, 'https://larkspur.example/contact');
      assert.equal(opened[0].run_id, run.run_id);
      const origin = new URL(server.url()).origin;
      assert.deepEqual(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:')), []);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: the media image loads through the media route', async () => {
    const run = show('review-doc', fixture('review-doc', 'edge-max'));
    const { ctx, page, errors } = await open(run.run_id);
    try {
      await page.locator('.rd__img').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('.rd__img')?.complete);
      const img = await page.evaluate(() => {
        const i = document.querySelector('.rd__img');
        return { src: i.getAttribute('src'), natural: i.naturalWidth, alt: i.alt };
      });
      assert.match(img.src, /^\/media\/m_[0-9a-f]+$/);
      assert.ok(img.natural > 0);
      assert.equal(img.alt, 'Harvest by month in kilograms, May to October');
      assert.equal(await page.locator('.rd__section[data-rs-item]').count(), 8);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: a half-done review survives a reload, sends, and reopens read-only', async () => {
    const run = show('review-doc', fixture('review-doc', 'golden'));
    const { ctx, page, errors } = await open(run.run_id);
    try {
      assert.equal(await page.locator('.rd__comment-open').count(), 5);
      assert.equal(await page.textContent('#rs-submit-label'), de.looks_good);
      assert.equal(await page.textContent('#rs-alt'), de.request_changes, 'the alternative says what it does');
      assert.equal((await page.textContent('#rs-status')).trim(), '', 'no status while it only repeats the banner');
      await page.click('[data-section="4"] .rd__comment-open');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rd-c-4');
      await page.keyboard.type('Per season, please.');
      await page.click('#rs-alt');
      await page.fill('#rd-comment', 'Fix the fee note.');
      assert.equal(await page.textContent('#rs-submit-label'), de.send_request);
      await reload(page);
      assert.equal(await page.inputValue('#rd-c-4'), 'Per season, please.');
      assert.equal(await page.inputValue('#rd-comment'), 'Fix the fee note.');
      assert.equal(await page.isVisible('[data-rd="request"]'), true);
      assert.equal(await page.isVisible('[data-section="4"] .rd__comment-open'), false);
      assert.equal(await page.textContent('#rs-submit-label'), de.send_request);
      await page.click('[data-rd="request-cancel"]');
      assert.equal(await page.textContent('#rs-submit-label'), de.looks_good);
      assert.equal(await page.textContent('#rs-status'), de.rd_with_comments_one);
      await page.click('#rs-alt');
      await page.fill('#rd-comment', 'Fix the fee note.');
      await page.keyboard.press('Control+Enter');
      const result = await waitResult(run.run_id);
      assert.deepEqual(result.data, {
        decision: 'request_changes',
        comment: 'Fix the fee note.',
        comments: [{ section: 4, heading: 'Plot fees', comment: 'Per season, please.' }],
      });
      await reopen(page, run.run_id);
      const view = await page.evaluate(() => ({
        section: document.querySelector('#rd-c-4').value,
        sectionReadOnly: document.querySelector('#rd-c-4').readOnly,
        overall: document.querySelector('#rd-comment').value,
        requestVisible: !document.querySelector('[data-rd="request"]').hidden,
      }));
      assert.deepEqual(view, { section: 'Per season, please.', sectionReadOnly: true, overall: 'Fix the fee note.', requestVisible: true });
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: a failed Skip goes back to Done, so the primary never sends skipped', async () => {
    const run = show('review-doc', { ...fixture('review-doc', 'golden'), actor: 'user' });
    const { ctx, page } = await open(run.run_id);
    try {
      const done = await page.textContent('#rs-submit-label');
      let failed = 0;
      await page.route('**/submit', async (route) => {
        failed += 1;
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test"}' });
      });
      await page.click('#rs-alt');
      await page.waitForSelector('.rs-toast');
      await page.waitForFunction(() => !document.querySelector('[data-rs-pending]') && !document.querySelector('#rs-submit').disabled);
      assert.equal(failed, 1);
      await page.unroute('**/submit');
      assert.equal(await page.textContent('#rs-submit-label'), done);
      await page.click('#rs-submit');
      const result = await waitResult(run.run_id);
      assert.equal(result.data.decision, 'done');
    } finally { await ctx.close(); }
  });

  test('review-doc: information only sends its note only while the note is open', async () => {
    const run = show('review-doc', { ...fixture('review-doc', 'golden'), actor: 'none' });
    const { ctx, page, errors } = await open(run.run_id);
    try {
      const summary = page.locator('#rs-mount summary');
      await summary.click();
      await page.fill('#rd-comment', 'Second thoughts');
      await summary.click();
      assert.equal(await summary.evaluate((el) => el.parentElement.open), false);
      await reload(page);
      assert.equal(await summary.evaluate((el) => el.parentElement.open), false, 'a closed note stays closed');
      await page.click('#rs-submit');
      const result = await waitResult(run.run_id);
      assert.deepEqual(result.data, { decision: 'acknowledged', comment: '', comments: [] });
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: with section comments, Request changes can send at once and does not jump into the blank comment', async () => {
    const run = show('review-doc', fixture('review-doc', 'golden'));
    const { ctx, page, errors } = await open(run.run_id);
    try {
      await page.click('[data-section="2"] .rd__comment-open');
      await page.keyboard.type('Name the tested limits.');
      await page.click('#rs-alt');
      assert.equal(await page.textContent('#rs-submit-label'), de.send_request);
      assert.equal(await page.isDisabled('#rs-submit'), false, 'the section comment is the request');
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'rd-comment');
      await page.click('#rs-submit');
      const result = await waitResult(run.run_id);
      assert.equal(result.data.decision, 'request_changes');
      assert.equal(result.data.comment, '');
      assert.equal(result.data.comments.length, 1);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: an empty section comment closes with Escape; request needs a comment', async () => {
    const run = show('review-doc', fixture('review-doc', 'golden'));
    const { ctx, page, errors } = await open(run.run_id);
    try {
      await page.click('[data-section="2"] .rd__comment-open');
      await page.keyboard.press('Escape');
      assert.equal(await page.isHidden('#rd-c-2'), true);
      assert.equal(await page.evaluate(() => document.activeElement.matches('[data-section="2"] .rd__comment-open')), true);
      await page.click('#rs-alt');
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.textContent('#rs-status'), de.comment_required);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: plain text keeps line breaks and has no sections', async () => {
    const run = show('review-doc', fixture('review-doc', 'edge-plain'));
    const { ctx, page, errors } = await open(run.run_id);
    try {
      assert.equal(await page.locator('[data-rs-item]').count(), 0);
      assert.equal(await page.locator('.rd__p--plain').count(), 5);
      const last = await page.locator('.rd__p--plain').last().textContent();
      assert.equal(last, 'Best wishes from the garden,\nMira for the garden team');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: uneven list indents keep every item; emphasis, code and breaks stay text-safe', async () => {
    const doc = '  - first, indented\n- second\n  - nested\n\n1. one\n2. two **bold** and `x < y`  \nnext line';
    const run = show('review-doc', { doc });
    const { ctx, page, errors } = await open(run.run_id);
    try {
      const view = await page.evaluate(() => ({
        items: [...document.querySelectorAll('.rd__doc li')].map((li) => li.firstChild.textContent),
        nested: document.querySelectorAll('.rd__doc ul ul > li').length,
        ordered: document.querySelectorAll('.rd__doc ol > li').length,
        strong: document.querySelector('.rd__doc strong')?.textContent,
        code: document.querySelector('.rd__doc .rd__code')?.textContent,
        breaks: document.querySelectorAll('.rd__doc br').length,
      }));
      assert.deepEqual(view.items, ['first, indented', 'second', 'nested', 'one', 'two ']);
      assert.equal(view.nested, 1);
      assert.equal(view.ordered, 2);
      assert.equal(view.strong, 'bold');
      assert.equal(view.code, 'x < y');
      assert.equal(view.breaks, 1);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  // Stress case: 3000 nested link labels (15 004 characters, inside the
  // 60 000 limit) exhausted the stack. Deeper than 16 levels stays literal.
  for (const [name, doc, literal] of [
    ['nested links', '['.repeat(3000) + 'text' + '](x)'.repeat(3000), '['.repeat(2984) + 'text' + '](x)'.repeat(2984)],
    ['nested links with emphasis', '[*'.repeat(6000) + 'x' + '*](u)'.repeat(6000), null],
  ]) {
    test(`review-doc: ${name} render as bounded, readable text and can be approved`, async () => {
      const run = show('review-doc', { doc });
      const { ctx, page, errors } = await open(run.run_id);
      try {
        const view = await page.evaluate(() => {
          const d = document.querySelector('.rd__doc');
          let depth = 0;
          for (const n of d.querySelectorAll('*')) {
            let k = 0;
            for (let p = n; p && p !== d; p = p.parentElement) k++;
            depth = Math.max(depth, k);
          }
          return { text: d.textContent, depth, meta: document.querySelector('[data-rd="meta"]').textContent };
        });
        assert.ok(view.depth <= 2 * 16 + 4, `element depth ${view.depth}`);
        if (literal) {
          assert.ok(view.text.includes(literal), 'deep levels stay literal text');
          assert.ok(view.meta.startsWith(de.rd_words_one), view.meta);
        }
        assert.equal(await page.isDisabled('#rs-submit'), false);
        await page.click('#rs-submit');
        const result = await waitResult(run.run_id);
        assert.deepEqual(result.data, { decision: 'approve', comment: '', comments: [] });
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });
  }

  test('review-doc: reading facts use the singular for one word and the plural otherwise', async () => {
    for (const [doc, words] of [['Hello', de.rd_words_one], ['Hello world', de.rd_words.replace('{n}', '2')]]) {
      const run = show('review-doc', { doc });
      const { ctx, page, errors } = await open(run.run_id);
      try {
        const meta = await page.textContent('[data-rd="meta"]');
        assert.ok(meta.startsWith(words + de.sep_list), meta);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    }
  });

  test('pick-option: nothing preselected, rows line up, arrows pick, reload restores, read-only after send', async () => {
    const data = fixture('pick-option', 'golden');
    const run = show('pick-option', data);
    const { ctx, page, errors } = await open(run.run_id);
    try {
      const cards = page.locator('rs-action-row[role="radiogroup"] > button[role="radio"]');
      assert.equal(await cards.count(), 3);
      assert.deepEqual(await cards.evaluateAll((b) => b.map((x) => x.getAttribute('aria-checked'))), ['false', 'false', 'false']);
      assert.equal(await page.locator('button[data-suggested]').getAttribute('value'), 'old-mill');
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.textContent('#rs-status'), '', 'the banner already says to pick one');
      const question = await page.evaluate(() => {
        const q = document.querySelector('[data-po="question"]');
        return { tag: q.tagName, text: q.textContent, weight: Number(getComputedStyle(q).fontWeight) };
      });
      assert.deepEqual([question.tag, question.text], ['H2', data.question], 'the question is the decision heading');
      assert.ok(question.weight >= 600, `strong (${question.weight})`);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.po__card')].map((c) => (
        [...c.querySelectorAll('.po__fact')].map((f) => Math.round(f.getBoundingClientRect().top))
      )));
      assert.deepEqual(rows[1], rows[0]);
      assert.deepEqual(rows[2], rows[0]);
      await page.focus('.po__card[value="boathouse"]');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.getAttribute('.po__card[value="old-mill"]', 'aria-checked'), 'true');
      assert.equal(await page.textContent('#rs-submit-label'), de.po_choose.replace('{name}', 'Old Mill Studio'));
      await reload(page);
      assert.equal(await page.getAttribute('.po__card[value="old-mill"]', 'aria-checked'), 'true');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('.po__options')), false,
        'a restored draft does not pull focus into the cards');
      await tabTo(page, '.po__card');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'old-mill', 'Tab enters the group at the pick');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+Enter');
      const result = await waitResult(run.run_id);
      assert.deepEqual(result.data, { choice: 'hilltop', note: '' });
      await reopen(page, run.run_id);
      const view = await page.evaluate(() => [...document.querySelectorAll('.po__card')].map((c) => [c.value, c.getAttribute('aria-checked'), c.disabled]));
      assert.deepEqual(view, [['boathouse', 'false', true], ['old-mill', 'false', true], ['hilltop', 'true', true]]);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('pick-option: None of these asks what is missing and sends no pick; Cancel goes back; allow_none false hides it', async () => {
    const data = fixture('pick-option', 'golden');
    const run = show('pick-option', data);
    const { ctx, page, errors } = await open(run.run_id);
    const quiet = () => page.$$eval('#rs-submitbar .rs-btn--quiet', (b) => b.filter((x) => !x.hidden).map((x) => x.textContent));
    try {
      assert.deepEqual(await quiet(), [de.po_none]);
      await page.click('#rs-alt');
      await page.click('#rs-alt');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), de.po_none, 'Cancel without a pick returns focus to the button that opened it');
      await page.click('.po__card[value="hilltop"]');
      await page.click('#rs-alt');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'po-note');
      assert.equal(await page.getAttribute('.po__card[value="hilltop"]', 'aria-checked'), 'false', 'no pick while none fits');
      assert.equal(await page.textContent('#rs-submit-label'), de.request_send);
      assert.deepEqual(await quiet(), [de.cancel]);
      assert.equal(await page.isDisabled('#rs-submit'), true);
      assert.equal(await page.textContent('#rs-status'), de.po_none_required);
      assert.equal(await page.isVisible('[data-po="label-none"]'), true);
      await page.click('#rs-alt');
      assert.equal(await page.getAttribute('.po__card[value="hilltop"]', 'aria-checked'), 'true', 'Cancel brings the pick back');
      assert.equal(await page.textContent('#rs-submit-label'), de.po_choose.replace('{name}', 'Hilltop Farm'));
      await page.click('#rs-alt');
      await page.fill('#po-note', 'All three are too far for the night shift.');
      await reload(page);
      assert.equal(await page.inputValue('#po-note'), 'All three are too far for the night shift.');
      assert.equal(await page.textContent('#rs-submit-label'), de.request_send);
      await page.click('#rs-alt');
      assert.equal(await page.getAttribute('.po__card[value="hilltop"]', 'aria-checked'), 'true', 'after a reload Cancel still brings the pick back');
      await page.click('#rs-alt');
      assert.equal(await page.inputValue('#po-note'), 'All three are too far for the night shift.');
      await page.keyboard.press('Control+Enter');
      const result = await waitResult(run.run_id);
      assert.deepEqual(result.data, { decision: 'request_changes', note: 'All three are too far for the night shift.' });
      /* the decided banner says new options were asked for, not that one was chosen */
      const doneLine = async () => {
        await page.waitForFunction(() => document.getElementById('rs-task').getAttribute('data-state') === 'decided');
        return page.textContent('#rs-task .rs-task__what');
      };
      assert.equal(await doneLine(), de.task_done_pick_none, 'right after sending');
      await reopen(page, run.run_id);
      assert.equal(await page.inputValue('#po-note'), 'All three are too far for the night shift.');
      assert.equal(await page.isVisible('[data-po="label-none"]'), true);
      assert.equal(await doneLine(), de.task_done_pick_none, 'reopened');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
    const strict = show('pick-option', { ...data, allow_none: false, question: 'Venue for the spring team day?' }, 'Venue for the spring team day');
    const second = await open(strict.run_id);
    try {
      assert.deepEqual(await second.page.$$eval('#rs-submitbar .rs-btn--quiet', (b) => b.filter((x) => !x.hidden).length), 0);
      assert.equal(await second.page.locator('[data-po="question"]').count(), 0, 'a question that repeats the title is left out');
      assert.equal(await second.page.getAttribute('rs-action-row', 'aria-label'), de.choice_group_label.replace('{what}', 'Venue for the spring team day?'));
    } finally { await second.ctx.close(); }
  });

  test('pick-option: a repeated id is rejected at show; four options wrap to two columns when narrow', async () => {
    assert.throws(() => show('pick-option', fixture('pick-option', 'invalid-duplicate-ids')),
      /show failed \(2\):[\s\S]*\/data\/options\/1\/id[\s\S]*duplicate id 'slot', already used by \/data\/options\/0/);
    let opened;
    const wide = show('pick-option', fixture('pick-option', 'edge-max'));
    for (const [viewport, columns] of [[{ width: 1280, height: 720 }, 4], [{ width: 600, height: 900 }, 2]]) {
      opened = await open(wide.run_id, viewport);
      try {
        const lefts = await opened.page.evaluate(() => [...new Set([...document.querySelectorAll('.po__card')].map((c) => Math.round(c.getBoundingClientRect().left)))]);
        assert.equal(lefts.length, columns, `${viewport.width}px`);
      } finally { await opened.ctx.close(); }
    }
  });

  test('review-doc: callouts are quiet notes with a title and no copy; quotes and code keep copy', async () => {
    const doc = [
      'Lead text.', '',
      '> [!NOTE]', '> Read this first.', '',
      '> [!tip]', '> - one', '> - two', '',
      '> [!IMPORTANT]', '> Important.', '',
      '> [!WARNING]', '> Careful.', '',
      '> [!CAUTION]', '> Stop.', '',
      '> [!NOTE]', '> ```', '> inside a callout', '> ```', '> > nested quote', '',
      '> [!NOTE] with text', '', '> A plain quote.', '',
      '```', 'code', '```',
    ].join('\n');
    const run = show('review-doc', { doc });
    const { ctx, page, errors } = await open(run.run_id);
    try {
      const view = await page.evaluate(() => ({
        callouts: [...document.querySelectorAll('.rd__callout')].map((c) => [
          c.className.replace('rd__callout rd__callout--', ''), c.getAttribute('role'),
          c.querySelector('.rd__callout-title').textContent, !!c.querySelector('rs-copy'),
        ]),
        listInTip: document.querySelectorAll('.rd__callout--tip li').length,
        quoteCopies: document.querySelectorAll('rs-copy[data-copy-id^="quote-"]').length,
        codeCopies: document.querySelectorAll('rs-copy[data-copy-id^="code-"]').length,
        literal: [...document.querySelectorAll('.rd__doc > * > .rd__copyblock .rd__quote')].map((q) => q.textContent.trim()),
        ids: [...document.querySelectorAll('rs-copy')].map((c) => c.dataset.copyId),
        inner: document.querySelectorAll('.rd__callout pre, .rd__callout blockquote').length,
      }));
      assert.deepEqual(view.callouts, [
        ['note', 'note', de.rd_callout_note, false],
        ['tip', 'note', de.rd_callout_tip, false],
        ['important', 'note', de.rd_callout_important, false],
        ['warning', 'note', de.rd_callout_warning, false],
        ['caution', 'note', de.rd_callout_caution, false],
        ['note', 'note', de.rd_callout_note, false],
      ]);
      assert.equal(view.listInTip, 2);
      assert.deepEqual([view.quoteCopies, view.codeCopies], [2, 1]);
      assert.deepEqual(view.ids, ['quote-1', 'quote-2', 'code-1'], 'code and quotes inside a callout take no copy id');
      assert.equal(view.inner, 2, 'the callout still shows its code block and nested quote');
      assert.deepEqual(view.literal, ['[!NOTE] with text', 'A plain quote.'], 'a marker with text after it stays a quote');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('review-doc: with copy texts only a bold lead paragraph moves to the top', async () => {
    const copy = [{ label: 'Copy reply', text: 'Thanks, see you Friday.' }];
    for (const [doc, lifted] of [
      ['# Reply draft\n\n**Send it as is.**\n\n## Notes\n\nPlain.', 'Send it as is.'],
      ['# Reply draft\n\nNo verdict here.\n\n## Notes\n\nA **bold** word further down.', null],
    ]) {
      await server.clearRuns();
      const run = show('review-doc', { doc, copy });
      const { ctx, page, errors } = await open(run.run_id);
      try {
        const strong = await page.evaluate(() => document.querySelector('.rd__lead strong')?.textContent ?? null);
        assert.equal(strong, lifted, doc);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    }
  });

  test('review-doc: edge-listing leads with the verdict, then the texts to paste', async () => {
    const run = show('review-doc', fixture('review-doc', 'edge-listing'));
    const { ctx, page, errors } = await open(run.run_id);
    try {
      const view = await page.evaluate(() => {
        const doc = document.querySelector('.rd__doc');
        const strong = document.querySelector('.rd__lead strong');
        const copies = document.querySelector('.rd__copies');
        const rows = [...doc.querySelectorAll('tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim());
        const checks = [...doc.querySelectorAll('li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim());
        return {
          /* the summary is the task banner's why (the rest folded there) */
          summary: document.querySelector('#rs-task').textContent,
          repeated: !!document.querySelector('.rd__summary'),
          verdict: strong ? strong.textContent : '',
          verdictBeforeCopies: !!(strong && copies && (strong.compareDocumentPosition(copies) & Node.DOCUMENT_POSITION_FOLLOWING)),
          copiesBeforeDoc: !!(copies && (copies.compareDocumentPosition(doc) & Node.DOCUMENT_POSITION_FOLLOWING)),
          rows,
          checks,
        };
      });
      assert.match(view.summary, /You paste the corrected tagline/);
      assert.match(view.summary, /Done means those three are live/);
      assert.ok(view.summary.includes(de.task_line_do), view.summary);
      assert.equal(await page.textContent('#rs-submit-label'), de.done_mark);
      assert.equal(view.repeated, false);
      assert.match(view.verdict, /fix the tagline, the description and the price/);
      assert.equal(view.verdictBeforeCopies, true);
      assert.equal(view.copiesBeforeDoc, true);
      assert.ok(view.rows.some((row) => row.includes('Description') && row.includes('Stoneware mug')));
      assert.ok(view.rows.some((row) => row.includes('€21 each for three')));
      assert.ok(view.checks.some((line) => line.includes('The corrected tagline is live')));
      assert.ok(view.checks.some((line) => line.includes('The price is €21 each for three')));
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('pick-option: each copy sits under its own card and names the option, below both breakpoints', async () => {
    const posts = fixture('pick-option', 'edge-posts');
    const four = {
      question: posts.question,
      options: posts.options.concat([{
        id: 'short',
        name: 'Short',
        summary: 'One line.',
        facts: [{ label: 'Score', value: '5.0' }],
        copy: 'Tea stays hot.',
      }]),
    };
    for (const [data, widths] of [[posts, [3, 2, 1]], [four, [4, 2, 1]]]) {
      const run = show('pick-option', data);
      const viewports = [{ width: 1280, height: 720 }, { width: 600, height: 900 }, { width: 280, height: 900 }];
      for (let i = 0; i < viewports.length; i++) {
        const opened = await open(run.run_id, viewports[i]);
        try {
          const view = await opened.page.evaluate(() => {
            const container = document.querySelector('.po').getBoundingClientRect().width;
            const cards = [...document.querySelectorAll('.po__card')];
            return {
              container,
              lefts: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left))).size,
              pairs: cards.map((card) => {
                const extra = card.nextElementSibling;
                const box = card.getBoundingClientRect();
                const copy = extra.getBoundingClientRect();
                const button = extra.querySelector('button');
                const caption = extra.querySelector('.rs-copy__caption');
                const between = cards.some((other) => {
                  if (other === card) return false;
                  const otherBox = other.getBoundingClientRect();
                  return otherBox.top >= box.bottom - 1 && otherBox.top < copy.top - 1 && Math.abs(otherBox.left - box.left) < 8;
                });
                return {
                  name: card.querySelector('.po__name').textContent,
                  sibling: extra.classList.contains('po__beside') && extra.getAttribute('data-i') === card.getAttribute('data-i') && !card.contains(extra),
                  aligned: Math.abs(copy.left - box.left) < 8,
                  below: copy.top >= box.bottom - 2 && copy.top - box.bottom < 80,
                  between,
                  label: button.getAttribute('aria-label'),
                  caption: caption.textContent,
                };
              }),
            };
          });
          assert.equal(view.lefts, widths[i], `${viewports[i].width}px container ${view.container}`);
          for (const pair of view.pairs) {
            assert.equal(pair.sibling, true, pair.name);
            assert.equal(pair.aligned, true, `${pair.name} at ${viewports[i].width}`);
            assert.equal(pair.below, true, `${pair.name} at ${viewports[i].width}`);
            assert.equal(pair.between, false, pair.name);
            const expected = de.copy_named.replace('{name}', pair.name);
            assert.equal(pair.label, expected, pair.name);
            assert.equal(pair.caption, expected, pair.name);
          }
        } finally { await opened.ctx.close(); }
      }
    }
  });
});
