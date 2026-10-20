// The footer every report ends in: one composer (note + reply chips), at
// most two quiet alternatives and exactly one primary, by the report's ask
// (core/static/ask.js). Request changes enters a request state; Reject and
// Skip send at once; drafts survive a reload; a decided report shows what
// was sent, read-only.
// Isolated server on RS_E2E_PORT with a temp RS_DATA_DIR; headless Edge (or
// Chrome) via playwright-core.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT, PYTHON } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';
import { calmEvaluator, judgeCalmFacts, CALM_THRESHOLDS } from '../tools/calm.mjs';

// tests use 18920-18939 only (AGENTS.md); never the product port
const PORT = e2ePort('footer.e2e.test.mjs');
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const FIXTURES = path.join(ROOT, 'tests/fixtures/payloads');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));
const fill = (key, vars = {}) => de[key].replace(/\{([a-z_]+)\}/g, (m, k) => String(vars[k]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('footer: composer, chips, ask contract, request state (served, headless browser)', { skip }, () => {
  let server;
  let browser;
  let media;
  let seq = 0;

  before(async () => {
    media = mkdtempSync(path.join(tmpdir(), 'rs-footer-media-'));
    writeFileSync(path.join(media, 'floor-plan.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    server = await startServer({ port: PORT, mediaRoots: [media] });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally {
      if (server) await server.stop();
      if (media) rmSync(media, { recursive: true, force: true });
    }
  });

  beforeEach(async () => { if (server) await server.clearRuns(); });

  function withMedia(value) {
    return JSON.parse(JSON.stringify(value), (key, v) => (
      typeof v === 'string' && v.startsWith('/srv/media/') ? path.join(media, path.basename(v)) : v
    ));
  }

  function show(payload) {
    seq += 1;
    const file = path.join(server.dataDir, `footer-${process.pid}-${seq}.json`);
    const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(file, JSON.stringify({ ...withMedia(payload), created, dedupe_key: undefined, dedupe_hours: undefined }), 'utf8');
    const out = spawnSync(PYTHON, [path.join(ROOT, 'report_shell.py'), '--port', String(PORT), 'show', '--data', file, '--no-window'], {
      cwd: ROOT, env: server.env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    });
    if (out.status !== 0) throw new Error(`show failed (${out.status}): ${out.stderr}`);
    return JSON.parse(out.stdout.trim().split('\n').pop());
  }

  async function open(run, { colorScheme = 'light', width = 1100, height = 860 } = {}) {
    const ctx = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const log = { errors: [] };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.errors.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    await page.goto(server.url('?client=test&run=' + encodeURIComponent(run.run_id)));
    await ready(page);
    return { ctx, page, log };
  }

  const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });

  async function submitted(run) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = server.result(run.run_id);
      if (result) return result.data;
      await sleep(50);
    }
    throw new Error('no result for ' + run.run_id);
  }

  /* the footer as a person sees it: visible buttons in order, the status line */
  const footer = (page) => page.evaluate(() => {
    const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
    const bar = document.getElementById('rs-submitbar');
    const buttons = [...bar.querySelectorAll('button')].filter(shown)
      .filter((b) => !b.closest('[data-rs-ref]'));
    const note = document.getElementById('rs-note');
    return {
      buttons: buttons.map((b) => b.textContent.trim()),
      primary: document.getElementById('rs-submit-label').textContent,
      primaryEnabled: !document.getElementById('rs-submit').disabled,
      status: document.getElementById('rs-status').textContent,
      note: shown(note),
      noteRequired: !!note && note.getAttribute('aria-required') === 'true',
      placeholder: note ? note.placeholder : null,
      discard: shown(document.getElementById('rs-discard')) || !document.getElementById('rs-discard').hidden,
    };
  });

  async function oneCalmPrimary(page, label) {
    const facts = await page.evaluate(calmEvaluator, { thresholds: CALM_THRESHOLDS });
    const judged = judgeCalmFacts(facts);
    assert.equal(judged.items.K1.pass, true, label + ': ' + (judged.items.K1.reasons || []).join('; '));
    assert.equal(facts.K1.primary_ids.length, 1, label);
  }

  test('read: Got it sends read with no alternative; the note stays one quiet "Add a note"', async () => {
    const run = show(load('read'));
    const { ctx, page, log } = await open(run);
    try {
      const f = await footer(page);
      assert.deepEqual(f.buttons, [de.cmp_add_note, de.ask_got_it]);
      assert.equal(f.note, false, 'collapsed');
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), { decision: 'read', note: '', refs: [] });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('read: an opened note names the bot and rides along', async () => {
    const run = show(load('read'));
    const { ctx, page } = await open(run);
    try {
      await page.click('[data-rs-note-open]');
      const f = await footer(page);
      assert.equal(f.note, true);
      assert.equal(f.placeholder, fill('cmp_placeholder', { bot: 'Ops Bot' }));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note');
      assert.deepEqual(f.buttons, [de.ask_got_it]);
      await page.keyboard.type('Thanks, seen.');
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(run), { decision: 'read', note: 'Thanks, seen.', refs: [] });
    } finally { await ctx.close(); }
  });

  test('read has no Discard', async () => {
    const run = show(load('read'));
    const { ctx, page } = await open(run);
    try {
      await page.click('#rs-more-btn');
      assert.equal(await page.isVisible('#rs-discard'), false);
    } finally { await ctx.close(); }
    const other = show(load('review'));
    const second = await open(other);
    try {
      await second.page.click('#rs-more-btn');
      assert.equal(await second.page.isVisible('#rs-discard'), true);
    } finally { await second.ctx.close(); }
  });

  test('review: Looks good and Request changes; a typed note rides along with accept', async () => {
    const run = show(load('review'));
    const { ctx, page, log } = await open(run);
    try {
      const f = await footer(page);
      assert.deepEqual(f.buttons, [de.ask_request_changes, de.ask_looks_good]);
      assert.equal(f.note, true);
      assert.equal(f.placeholder, de.cmp_placeholder_anon, 'a bare bot id reads "the bot"');
      await page.fill('#rs-note', '  Nice.  ');
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), { decision: 'accept', note: 'Nice.', refs: [] });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('approve: the payload label names the primary; Reject and Request changes stay quiet; urgent is red', async () => {
    const run = show(load('approve'));
    const { ctx, page } = await open(run);
    try {
      const f = await footer(page);
      assert.deepEqual(f.buttons, [de.ask_reject, de.ask_request_changes, 'Deploy 4.2.0']);
      assert.equal(await page.getAttribute('#rs-task', 'data-tone'), 'urgent');
      assert.match(await page.textContent('#rs-task .rs-task__what'), /^Deploy 4\.2\.0, dann macht der Bot weiter$/);
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), { decision: 'approve', note: '', refs: [] });
    } finally { await ctx.close(); }
  });

  test('approve without label: Approve & send; the banner tint says approve', async () => {
    const payload = { ...load('approve'), action: 'send', urgent: false, due: undefined };
    delete payload.label;
    const run = show(payload);
    const { ctx, page } = await open(run);
    try {
      assert.equal((await footer(page)).primary, de.ask_approve_send);
      assert.equal(await page.getAttribute('#rs-task', 'data-tone'), 'approve');
    } finally { await ctx.close(); }
  });

  test('do: Sent, Skip, Request changes; the primary reports done', async () => {
    const run = show(load('do'));
    const { ctx, page } = await open(run);
    try {
      assert.deepEqual((await footer(page)).buttons, [de.ask_skip, de.ask_request_changes, de.ask_sent]);
      assert.equal(await page.getAttribute('#rs-task', 'data-tone'), 'do');
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), { decision: 'done', note: '', refs: [] });
    } finally { await ctx.close(); }
  });

  test('reject sends at once with typed note', async () => {
    const run = show(load('approve'));
    const { ctx, page } = await open(run);
    try {
      await page.fill('#rs-note', 'Not before the board meeting.');
      await page.getByRole('button', { name: de.ask_reject, exact: true }).click();
      assert.deepEqual(await submitted(run), { decision: 'reject', note: 'Not before the board meeting.', refs: [] });
    } finally { await ctx.close(); }
  });

  test('request changes enters request state; Ctrl+Enter there sends revise, never approve', async () => {
    const run = show(load('approve'));
    const { ctx, page } = await open(run);
    try {
      await page.getByRole('button', { name: de.ask_request_changes, exact: true }).click();
      let f = await footer(page);
      assert.deepEqual(f.buttons, [de.cancel, de.ask_send_request]);
      assert.equal(f.noteRequired, true);
      assert.equal(f.placeholder, de.cmp_placeholder_request);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note', 'composer focused');
      /* Cancel returns; Escape too */
      await page.getByRole('button', { name: de.cancel, exact: true }).click();
      f = await footer(page);
      assert.deepEqual([f.primary, f.noteRequired], ['Deploy 4.2.0', false]);
      await page.getByRole('button', { name: de.ask_request_changes, exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal((await footer(page)).primary, 'Deploy 4.2.0');
      await page.getByRole('button', { name: de.ask_request_changes, exact: true }).click();
      /* Ctrl+Enter on an empty request sends nothing */
      await page.keyboard.press('Control+Enter');
      await sleep(300);
      assert.equal(server.result(run.run_id), null);
      await page.keyboard.type('Wait for the hotfix.');
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(run), { decision: 'revise', note: 'Wait for the hotfix.', refs: [] });
    } finally { await ctx.close(); }
  });

  test('Send request disabled until composer has text', async () => {
    const run = show(load('review'));
    const { ctx, page } = await open(run);
    try {
      await page.getByRole('button', { name: de.ask_request_changes, exact: true }).click();
      let f = await footer(page);
      assert.deepEqual([f.primary, f.primaryEnabled, f.status], [de.ask_send_request, false, de.ask_request_hint]);
      await page.keyboard.type('   ');
      assert.equal((await footer(page)).primaryEnabled, false, 'blank is not a request');
      await page.keyboard.type('Shorter, please.');
      f = await footer(page);
      assert.deepEqual([f.primaryEnabled, f.status], [true, '']);
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), { decision: 'revise', note: 'Shorter, please.', refs: [] });
    } finally { await ctx.close(); }
  });

  test('reply chips quote their target, de-duplicate, remove, and focus the composer', async () => {
    const run = show(load('review'));
    const { ctx, page } = await open(run);
    try {
      const reply = (n) => page.locator(`[data-rs-block="guide"] [data-rs-reply-section="${n}"]`);
      await reply(0).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note');
      await reply(0).click();
      await reply(1).click();
      const chips = page.locator('#rs-submitbar [data-rs-ref]');
      assert.deepEqual(await chips.allTextContents(), ['First day', 'First week'].map((x) => x));
      await page.getByRole('button', { name: fill('cmp_ref_remove', { what: 'First day' }) }).click();
      assert.deepEqual(await chips.allTextContents(), ['First week']);
      await page.fill('#rs-note', 'Add the parking info here.');
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), {
        decision: 'accept', note: 'Add the parking info here.',
        refs: [{ block: 'guide', item: 'section:1', label: 'First week' }],
      });
    } finally { await ctx.close(); }
  });

  test('the composer grows from one line to six, then scrolls', async () => {
    const run = show(load('review'));
    const { ctx, page } = await open(run);
    try {
      const size = () => page.$eval('#rs-note', (n) => ({
        h: n.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(n).lineHeight),
        scrolls: n.scrollHeight > n.clientHeight + 1,
      }));
      const one = await size();
      await page.fill('#rs-note', 'a\nb\nc');
      const three = await size();
      await page.fill('#rs-note', Array.from({ length: 12 }, (_, i) => 'line ' + i).join('\n'));
      const many = await size();
      assert.ok(Math.abs(three.h - one.h - 2 * one.line) <= 2, `${one.h} -> ${three.h}`);
      assert.ok(Math.abs(many.h - one.h - 5 * one.line) <= 2, `${one.h} -> ${many.h}`);
      assert.equal(many.scrolls, true);
    } finally { await ctx.close(); }
  });

  test('reload restores composer text, chips, request state', async () => {
    const run = show(load('review'));
    const { ctx, page } = await open(run);
    try {
      await page.locator('[data-rs-block="guide"] [data-rs-reply-section="1"]').click();
      await page.getByRole('button', { name: de.ask_request_changes, exact: true }).click();
      await page.keyboard.type('Move this up.');
      await page.reload();
      await ready(page);
      const f = await footer(page);
      assert.deepEqual([f.primary, f.primaryEnabled, f.noteRequired], [de.ask_send_request, true, true]);
      assert.equal(await page.inputValue('#rs-note'), 'Move this up.');
      assert.deepEqual(await page.locator('#rs-submitbar [data-rs-ref]').allTextContents(), ['First week']);
      await page.keyboard.press('Control+Enter');
      assert.deepEqual(await submitted(run), {
        decision: 'revise', note: 'Move this up.', refs: [{ block: 'guide', item: 'section:1', label: 'First week' }],
      });
      /* a sent report leaves no draft behind */
      assert.equal(await page.evaluate((id) => localStorage.getItem('rs-draft:' + id), run.run_id), null);
    } finally { await ctx.close(); }
  });

  test('reload keeps focus and the caret inside a normal note', async () => {
    const run = show(load('review'));
    const { ctx, page } = await open(run);
    try {
      await page.click('#rs-note');
      await page.keyboard.type('Fix the second heading.');
      await page.$eval('#rs-note', (n) => n.setSelectionRange(4, 10));
      await page.reload();
      await ready(page);
      const kept = await page.evaluate(() => {
        const n = document.activeElement;
        return { id: n.id, start: n.selectionStart, end: n.selectionEnd, value: n.value };
      });
      assert.deepEqual(kept, { id: 'rs-note', start: 4, end: 10, value: 'Fix the second heading.' });
    } finally { await ctx.close(); }
  });

  test('a read note survives a reload open', async () => {
    const run = show(load('read'));
    const { ctx, page } = await open(run);
    try {
      await page.click('[data-rs-note-open]');
      await page.keyboard.type('Seen.');
      await page.reload();
      await ready(page);
      assert.equal(await page.isVisible('#rs-note'), true);
      assert.equal(await page.inputValue('#rs-note'), 'Seen.');
    } finally { await ctx.close(); }
  });

  test('exactly one primary (calm K1) in every state', async () => {
    for (const colorScheme of ['light', 'dark']) {
      const read = show(load('read'));
      let o = await open(read, { colorScheme });
      try {
        await oneCalmPrimary(o.page, colorScheme + ' read');
        await o.page.click('[data-rs-note-open]');
        await oneCalmPrimary(o.page, colorScheme + ' read with note');
      } finally { await o.ctx.close(); }
      await server.clearRuns();
      const review = show(load('approve'));
      o = await open(review, { colorScheme });
      try {
        await oneCalmPrimary(o.page, colorScheme + ' approve');
        await o.page.getByRole('button', { name: de.ask_request_changes, exact: true }).click();
        await oneCalmPrimary(o.page, colorScheme + ' request, empty');
        await o.page.keyboard.type('x');
        await oneCalmPrimary(o.page, colorScheme + ' request, written');
      } finally { await o.ctx.close(); }
      await server.clearRuns();
    }
  });

  test('a decided report shows the sent note and chips read-only and says what happened', async () => {
    const run = show(load('review'));
    const { ctx, page } = await open(run);
    try {
      await page.locator('[data-rs-block="guide"] [data-rs-reply-section="0"]').click();
      await page.getByRole('button', { name: de.ask_request_changes, exact: true }).click();
      await page.keyboard.type('Add a map.');
      await page.click('#rs-submit');
      await submitted(run);
      await page.waitForFunction(() => document.getElementById('rs-task').getAttribute('data-state') === 'decided');
      assert.equal(await page.textContent('#rs-task .rs-task__what'), fill('ask_done_revise', { bot: de.task_the_bot }));
      await page.reload();
      await ready(page);
      assert.equal(await page.inputValue('#rs-note'), 'Add a map.');
      assert.equal(await page.$eval('#rs-note', (n) => n.readOnly), true);
      assert.deepEqual(await page.locator('#rs-submitbar [data-rs-ref]').allTextContents(), ['First day']);
      assert.equal(await page.locator('#rs-submitbar [data-rs-ref] button').count(), 0, 'chips cannot be removed');
      assert.equal(await page.isVisible('#rs-submit'), false);
      assert.equal(await page.textContent('#rs-task .rs-task__what'), fill('ask_done_revise', { bot: de.task_the_bot }));
    } finally { await ctx.close(); }
  });

  test('a long why keeps three sentences in view and folds the rest', async () => {
    const why = 'Wir nehmen z. B. den Saal am Fluss.\nDer 1. Termin ist fix. Zwei. Drei folgt. Vier.';
    const run = show({ ...load('read'), why });
    const { ctx, page } = await open(run);
    try {
      assert.equal(await page.textContent('.rs-task__why'), 'Wir nehmen z. B. den Saal am Fluss.\nDer 1. Termin ist fix. Zwei.');
      assert.equal(await page.textContent('.rs-task__more > p'), 'Drei folgt. Vier.');
    } finally { await ctx.close(); }
  });
});
