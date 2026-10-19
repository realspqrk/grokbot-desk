// Input blocks where the control is the decision: decide rows with a
// labelled segmented control (unset by default, never a checkbox), keyboard
// triage, and a pick of 2-4 option cards. The footer only sends.
// Isolated server on RS_E2E_PORT with a temp RS_DATA_DIR; headless Edge (or
// Chrome) via playwright-core.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT, PYTHON } from '../tools/dev/rs-server.mjs';
import { calmEvaluator, judgeCalmFacts, CALM_THRESHOLDS } from '../tools/calm.mjs';

// tests use 18920-18939 only (AGENTS.md); never the product port
const PORT = Number(process.env.RS_E2E_PORT || 18921);
if (!Number.isInteger(PORT) || PORT < 18920 || PORT > 18939) throw new Error(`RS_E2E_PORT ${PORT} is outside 18920-18939`);
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const AXE = path.join(ROOT, 'vendor/axe.min.js');
const FIXTURES = path.join(ROOT, 'tests/fixtures/payloads');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));
const fill = (key, vars = {}) => de[key].replace(/\{([a-z_]+)\}/g, (m, k) => String(vars[k]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('input blocks: decide and pick (served, headless browser)', { skip }, () => {
  let server;
  let browser;
  let seq = 0;

  before(async () => {
    server = await startServer({ port: PORT });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally {
      if (server) await server.stop();
    }
  });

  beforeEach(async () => { if (server) await server.clearRuns(); });

  function show(payload) {
    seq += 1;
    const file = path.join(server.dataDir, `inputs-${process.pid}-${seq}.json`);
    const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(file, JSON.stringify({ ...payload, created, due: undefined, dedupe_key: undefined, dedupe_hours: undefined }), 'utf8');
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

  const footer = (page) => page.evaluate(() => {
    const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
    const bar = document.getElementById('rs-submitbar');
    const buttons = [...bar.querySelectorAll('button')].filter(shown).filter((b) => !b.closest('[data-rs-ref]'));
    return {
      buttons: buttons.map((b) => b.textContent.trim()),
      primary: document.getElementById('rs-submit-label').textContent,
      primaryEnabled: !document.getElementById('rs-submit').disabled,
      status: document.getElementById('rs-status').textContent,
    };
  });

  /* the segments of a decide row: [value, label, aria-checked] */
  const segments = (page, item) => page.$$eval(`rs-segmented[data-item="${item}"] > button`,
    (els) => els.map((b) => [b.value, b.querySelector('.rs-seg__label').textContent, b.getAttribute('aria-checked')]));
  const seg = (item, value) => `rs-segmented[data-item="${item}"] > button[value="${value}"]`;
  const focusedItem = (page) => page.evaluate(() => {
    const row = document.activeElement && document.activeElement.closest('[data-item-id]');
    return row ? row.getAttribute('data-item-id') : null;
  });

  async function seriousViolations(page) {
    await page.addScriptTag({ path: AXE });
    return page.evaluate(async () => (await window.axe.run(document)).violations
      .filter((x) => x.impact === 'serious' || x.impact === 'critical')
      .map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target.join(' ')) })));
  }

  test('decide: Send decisions disabled until every row answered; status counts', async () => {
    const run = show(load('approve-decide'));
    const { ctx, page, log } = await open(run);
    try {
      /* the payload's labels; the item's own label; an item's choices subset */
      assert.deepEqual(await segments(page, 'hosting'), [
        ['approve', 'Pay', 'false'], ['reject', "Don't pay", 'false'], ['later', de.choice_spaeter, 'false'],
      ]);
      assert.deepEqual((await segments(page, 'toner')).map((s) => s[1]), ['Pay', "Don't pay", 'Next week']);
      assert.deepEqual((await segments(page, 'parking')).map((s) => s[0]), ['approve', 'reject']);
      let f = await footer(page);
      assert.equal(f.primary, de.ask_send_decisions);
      assert.equal(f.primaryEnabled, false);
      assert.equal(f.status, fill('ask_progress', { done: 0, total: 3 }));
      assert.deepEqual(f.buttons, [de.ask_request_changes, de.ask_send_decisions]);
      await page.click(seg('hosting', 'approve'));
      f = await footer(page);
      assert.equal(f.status, fill('ask_progress', { done: 1, total: 3 }));
      assert.equal(f.primaryEnabled, false);
      await page.click(seg('toner', 'later'));
      /* changing a mind is one click on another segment */
      await page.click(seg('hosting', 'reject'));
      assert.deepEqual((await segments(page, 'hosting')).map((s) => s[2]), ['false', 'true', 'false']);
      f = await footer(page);
      assert.equal(f.status, fill('ask_progress', { done: 2, total: 3 }));
      await page.click(seg('parking', 'approve'));
      f = await footer(page);
      assert.equal(f.primaryEnabled, true);
      assert.equal(f.status, '');
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), {
        decision: 'submit', note: '', refs: [],
        blocks: { invoices: { items: [
          { id: 'hosting', choice: 'reject' }, { id: 'toner', choice: 'later' }, { id: 'parking', choice: 'approve' },
        ] } },
      });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('decide keyboard triage A/X/L moves to next undecided', async () => {
    const run = show(load('approve-decide'));
    const { ctx, page } = await open(run);
    try {
      await page.focus(seg('hosting', 'approve'));
      await page.keyboard.press('a');
      assert.equal(await page.getAttribute(seg('hosting', 'approve'), 'aria-checked'), 'true');
      assert.equal(await focusedItem(page), 'toner');
      await page.keyboard.press('l');
      assert.equal(await page.getAttribute(seg('toner', 'later'), 'aria-checked'), 'true');
      assert.equal(await focusedItem(page), 'parking');
      /* parking offers no later: L does nothing there */
      await page.keyboard.press('l');
      assert.equal(await page.getAttribute('[data-item-id="parking"]', 'data-state'), 'open');
      await page.keyboard.press('x');
      assert.equal(await page.getAttribute(seg('parking', 'reject'), 'aria-checked'), 'true');
      /* the last row: focus stays on its decision */
      assert.equal(await focusedItem(page), 'parking');
      /* back on an answered row, a key changes its answer and jumps to the next undecided (none: stays) */
      await page.focus(seg('hosting', 'approve'));
      await page.keyboard.press('Shift+X');
      assert.equal(await page.getAttribute(seg('hosting', 'reject'), 'aria-checked'), 'true');
      assert.equal((await footer(page)).primaryEnabled, true);
      /* R quotes the row as a chip and moves to the note */
      await page.focus(seg('toner', 'later'));
      await page.keyboard.press('r');
      assert.deepEqual(await page.locator('#rs-submitbar [data-rs-ref]').allTextContents(), ['Toner, 132.90 EUR']);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note');
      /* typing in the note never decides: a, x, l are letters there */
      await page.keyboard.type('alx');
      assert.equal(await page.getAttribute(seg('toner', 'later'), 'aria-checked'), 'true');
      await page.keyboard.press('Control+Enter');
      const data = await submitted(run);
      assert.deepEqual(data.refs, [{ block: 'invoices', item: 'toner', label: 'Toner, 132.90 EUR' }]);
      assert.equal(data.note, 'alx');
      assert.deepEqual(data.blocks.invoices.items.map((i) => i.choice), ['reject', 'later', 'reject']);
    } finally { await ctx.close(); }
    /* under ask do the same keys mean done / skipped / later */
    const doRun = show(load('do-decide'));
    const o = await open(doRun);
    try {
      assert.deepEqual((await o.page.$$eval('rs-segmented[data-item="reply-1"] > button', (els) => els.map((b) => b.value))), ['done', 'skipped', 'later']);
      await o.page.focus(seg('reply-1', 'done'));
      await o.page.keyboard.press('a');
      await o.page.keyboard.press('x');
      await o.page.keyboard.press('l');
      const f = await footer(o.page);
      assert.equal(f.primary, de.ask_done_items);
      assert.equal(f.primaryEnabled, true);
      await o.page.click('#rs-submit');
      assert.deepEqual((await submitted(doRun)).blocks.replies.items, [
        { id: 'reply-1', choice: 'done' }, { id: 'reply-2', choice: 'skipped' }, { id: 'reply-3', choice: 'later' },
      ]);
    } finally { await o.ctx.close(); }
  });

  test('decide rows never use checkbox role', async () => {
    const run = show(load('approve-decide'));
    for (const colorScheme of ['light', 'dark']) {
      const { ctx, page, log } = await open(run, { colorScheme });
      try {
        assert.equal(await page.locator('#rs-mount [role="checkbox"], #rs-mount input[type="checkbox"]').count(), 0);
        /* one labelled radiogroup per row, unset by default */
        const groups = await page.$$eval('#rs-mount rs-segmented', (els) => els.map((g) => ({
          role: g.getAttribute('role'), label: g.getAttribute('aria-label'),
          radios: [...g.children].map((b) => b.getAttribute('role')),
          checked: [...g.children].filter((b) => b.getAttribute('aria-checked') === 'true').length,
        })));
        assert.equal(groups.length, 3);
        for (const g of groups) {
          assert.equal(g.role, 'radiogroup');
          assert.ok(g.radios.every((r) => r === 'radio'));
          assert.equal(g.checked, 0);
        }
        assert.equal(groups[0].label, fill('choice_group_label', { what: 'Hosting, October' }));
        /* each segment is named by its label alone */
        assert.equal(await page.getByRole('radio', { name: 'Pay', exact: true }).count(), 3);
        assert.equal(await page.getByRole('radio', { name: 'Next week', exact: true }).count(), 1);
        /* undecided looks different from any decision: outlined vs filled with an icon */
        await page.click(seg('hosting', 'approve'));
        await page.click(seg('toner', 'reject'));
        const look = (sel) => page.$eval(sel, (b) => {
          const s = getComputedStyle(b);
          return { bg: s.backgroundColor, border: s.borderTopStyle + ' ' + s.borderTopColor, icon: !!b.querySelector('.rs-seg__icon svg') && getComputedStyle(b.querySelector('.rs-seg__icon')).display !== 'none' };
        });
        const open = await look(seg('parking', 'approve'));
        const approved = await look(seg('hosting', 'approve'));
        const rejected = await look(seg('toner', 'reject'));
        assert.equal(open.bg, 'rgba(0, 0, 0, 0)', 'undecided is outlined, not filled');
        assert.equal(open.icon, false);
        assert.notEqual(approved.bg, open.bg);
        assert.notEqual(rejected.bg, approved.bg, 'approve and reject differ');
        assert.equal(approved.icon, true);
        assert.equal(rejected.icon, true);
        assert.deepEqual(await page.$$eval('[data-item-id]', (rows) => rows.map((r) => r.getAttribute('data-state'))), ['approve', 'reject', 'open']);
        /* the row keeps its link and its copy */
        assert.equal(await page.getAttribute('[data-item-id="hosting"] a.rs-ext', 'href'), 'https://billing.example.com/invoices/1043');
        assert.equal(await page.locator('[data-item-id="hosting"] rs-copy').count(), 1);
        assert.deepEqual(await seriousViolations(page), [], colorScheme);
        const judged = judgeCalmFacts(await page.evaluate(calmEvaluator, { thresholds: CALM_THRESHOLDS }));
        assert.equal(judged.items.K1.pass, true, (judged.items.K1.reasons || []).join('; '));
        assert.deepEqual(log.errors, [], colorScheme);
      } finally { await ctx.close(); }
    }
  });

  test('decide: twelve rows stay one line each at 880 and wrap calmly at 600', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: 'row-' + (i + 1), title: 'Invoice ' + (i + 1) + ' for the office', meta: (i + 1) * 10 + ' EUR' }));
    const run = show({ schema: 'grokbot-desk/payload@2', bot: 'office-bot', title: 'Twelve invoices', ask: 'approve', blocks: [{ type: 'decide', id: 'many', items }] });
    for (const width of [880, 600]) {
      const { ctx, page, log } = await open(run, { width });
      try {
        const rows = await page.$$eval('[data-item-id]', (els) => els.map((r) => {
          const box = r.getBoundingClientRect();
          const title = r.querySelector('.rs-drow__title').getBoundingClientRect();
          const control = r.querySelector('rs-segmented').getBoundingClientRect();
          return { h: box.height, side: control.left >= title.right - 1, overflow: r.scrollWidth > r.clientWidth + 1 };
        }));
        assert.equal(rows.length, 12);
        for (const r of rows) assert.equal(r.overflow, false, width + ': no horizontal overflow');
        if (width === 880) for (const r of rows) assert.equal(r.side, true, 'control beside the title at 880');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + ': no page scroll');
        assert.deepEqual(log.errors, []);
      } finally { await ctx.close(); }
    }
  });

  test('pick: primary names the option; none-of-these needs note → revise', async () => {
    const payload = load('choose');
    delete payload.blocks[1].allow_none;
    const run = show(payload);
    const { ctx, page, log } = await open(run);
    try {
      const cards = 'rs-segmented[data-rs-pick] > button[value]';
      assert.deepEqual(await page.$$eval(cards, (els) => els.map((b) => [b.value, b.getAttribute('role'), b.getAttribute('aria-checked')])),
        [['thu', 'radio', 'false'], ['fri', 'radio', 'false']]);
      /* the suggestion is marked, never preselected */
      assert.equal(await page.locator(`${cards}[value="thu"] .rs-pick__suggested`).textContent(), de.inp_suggested);
      assert.equal(await page.locator(`${cards}[value="fri"] .rs-pick__suggested`).count(), 0);
      let f = await footer(page);
      assert.equal(f.primaryEnabled, false);
      assert.equal(f.status, de.ask_pick_hint);
      assert.deepEqual(f.buttons, [de.ask_none_of_these, de.ask_choose]);
      await page.click(`${cards}[value="fri"]`);
      f = await footer(page);
      assert.equal(f.primary, fill('inp_choose_named', { name: 'Friday' }));
      assert.equal(f.primaryEnabled, true);
      /* None of these: the note is required, the pick is not sent */
      await page.getByRole('button', { name: de.ask_none_of_these, exact: true }).click();
      f = await footer(page);
      assert.equal(f.primary, de.ask_send_none);
      assert.equal(f.primaryEnabled, false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rs-note');
      await page.keyboard.type('Neither day works; try next week.');
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), { decision: 'revise', note: 'Neither day works; try next week.', refs: [] });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    /* the keyboard: arrows move between cards, Space picks, R quotes an option */
    const second = show(load('choose'));
    const o = await open(second);
    try {
      assert.deepEqual((await footer(o.page)).buttons, [de.ask_choose], 'allow_none false: no None of these');
      await o.page.focus('rs-segmented[data-rs-pick] > button[value="thu"]');
      await o.page.keyboard.press('ArrowRight');
      assert.equal(await o.page.evaluate(() => document.activeElement.value), 'fri');
      assert.equal(await o.page.getAttribute('rs-segmented[data-rs-pick] > button[value="fri"]', 'aria-checked'), 'false');
      await o.page.keyboard.press('Space');
      assert.equal(await o.page.getAttribute('rs-segmented[data-rs-pick] > button[value="fri"]', 'aria-checked'), 'true');
      await o.page.click('.rs-reply[data-rs-reply-item="thu"]');
      assert.deepEqual(await o.page.locator('#rs-submitbar [data-rs-ref]').allTextContents(), ['Thursday']);
      await o.page.click('#rs-submit');
      assert.deepEqual(await submitted(second), {
        decision: 'choose', note: '', refs: [{ block: 'date', item: 'thu', label: 'Thursday' }], blocks: { date: { choice: 'fri' } },
      });
    } finally { await o.ctx.close(); }
  });

  test('half-done decide + chips survive reload, send, reopen read-only', async () => {
    const run = show(load('approve-decide'));
    const { ctx, page, log } = await open(run);
    try {
      await page.click(seg('hosting', 'approve'));
      await page.click('.rs-reply[data-rs-reply-item="toner"]');
      await page.keyboard.type('Ask for a cheaper vendor first.');
      await page.reload();
      await ready(page);
      assert.equal(await page.getAttribute(seg('hosting', 'approve'), 'aria-checked'), 'true');
      assert.equal(await page.getAttribute('[data-item-id="toner"]', 'data-state'), 'open');
      assert.deepEqual(await page.locator('#rs-submitbar [data-rs-ref]').allTextContents(), ['Toner, 132.90 EUR']);
      assert.equal(await page.inputValue('#rs-note'), 'Ask for a cheaper vendor first.');
      assert.equal((await footer(page)).status, fill('ask_progress', { done: 1, total: 3 }));
      await page.click(seg('toner', 'later'));
      await page.click(seg('parking', 'approve'));
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), {
        decision: 'submit', note: 'Ask for a cheaper vendor first.',
        refs: [{ block: 'invoices', item: 'toner', label: 'Toner, 132.90 EUR' }],
        blocks: { invoices: { items: [
          { id: 'hosting', choice: 'approve' }, { id: 'toner', choice: 'later' }, { id: 'parking', choice: 'approve' },
        ] } },
      });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    /* reopened: what was sent, read-only */
    const o = await open(run);
    try {
      assert.deepEqual(await o.page.$$eval('[data-item-id]', (rows) => rows.map((r) => r.getAttribute('data-state'))), ['approve', 'later', 'approve']);
      assert.equal(await o.page.isDisabled(seg('toner', 'reject')), true);
      assert.equal(await o.page.locator('#rs-mount .rs-reply').count(), 0, 'no reply on a decided report');
      assert.deepEqual(await o.page.locator('#rs-submitbar [data-rs-ref]').allTextContents(), ['Toner, 132.90 EUR']);
      assert.equal(await o.page.isVisible('#rs-submit'), false);
      /* keys do nothing on a decided report */
      await o.page.focus('[data-item-id="toner"] a, [data-item-id="toner"] rs-copy button, [data-item-id="toner"]').catch(() => {});
      await o.page.keyboard.press('a');
      assert.equal(await o.page.getAttribute('[data-item-id="toner"]', 'data-state'), 'later');
      assert.deepEqual(o.log.errors, []);
    } finally { await o.ctx.close(); }
  });
});
