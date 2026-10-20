// Content blocks on the served page: every block type of a report, markdown,
// tables and charts, and the read and review footers end to end.
// Isolated server on RS_E2E_PORT with a temp RS_DATA_DIR and a temp media
// root; headless Edge (or Chrome) via playwright-core.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT, PYTHON, png } from '../tools/dev/rs-server.mjs';
import { e2ePort } from '../tools/node-tests.mjs';

// tests use 18920-18939 only (AGENTS.md); never the product port
const PORT = e2ePort('blocks.e2e.test.mjs');
const de = JSON.parse(readFileSync(path.join(ROOT, 'core/i18n/de.json'), 'utf8'));
const AXE = path.join(ROOT, 'vendor/axe.min.js');
const FIXTURES = path.join(ROOT, 'tests/fixtures/payloads');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));
const fill = (key, vars) => de[key].replace(/\{([a-z_]+)\}/g, (m, k) => String(vars[k]));

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('content blocks (served, headless browser)', { skip }, () => {
  let server;
  let browser;
  let media;
  let seq = 0;

  before(async () => {
    media = mkdtempSync(path.join(tmpdir(), 'rs-blocks-media-'));
    for (const name of ['floor-plan.png', 'shop-floor.jpg', 'walkthrough.png']) {
      writeFileSync(path.join(media, name), png(480, 270));
    }
    /* not a playable video: the page must still render the block calmly */
    writeFileSync(path.join(media, 'walkthrough.webm'), Buffer.from('1a45dfa3', 'hex'));
    server = await startServer({ port: PORT, mediaRoots: [media] });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally {
      if (server) await server.stop();
      if (media) rmSync(media, { recursive: true, force: true });
    }
  });

  /* fixture media paths (/srv/media/...) point into the temp media root */
  function withMedia(value) {
    return JSON.parse(JSON.stringify(value), (key, v) => (
      typeof v === 'string' && v.startsWith('/srv/media/') ? path.join(media, path.basename(v)) : v
    ));
  }

  function show(payload) {
    seq += 1;
    const file = path.join(server.dataDir, `blocks-${process.pid}-${seq}.json`);
    const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(file, JSON.stringify({ ...payload, created, dedupe_key: undefined }), 'utf8');
    const out = spawnSync(PYTHON, [path.join(ROOT, 'report_shell.py'), '--port', String(PORT), 'show', '--data', file, '--no-window'], {
      cwd: ROOT, env: server.env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    });
    if (out.status !== 0) throw new Error(`show failed (${out.status}): ${out.stderr}`);
    return JSON.parse(out.stdout.trim().split('\n').pop());
  }

  async function open(run, { colorScheme = 'light', width = 1200, height = 900 } = {}) {
    const ctx = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const log = { errors: [] };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.errors.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    await page.goto(server.url('?client=test&run=' + encodeURIComponent(run.run_id)));
    await server.ready(page);
    return { ctx, page, log };
  }

  async function seriousViolations(page) {
    await page.addScriptTag({ path: AXE });
    return page.evaluate(async () => (await window.axe.run(document)).violations
      .filter((x) => x.impact === 'serious' || x.impact === 'critical')
      .map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target.join(' ')) })));
  }

  /* the result file (the page may move on to another open report) */
  async function submitted(run) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = server.result(run.run_id);
      if (result) return result.data;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no result for ' + run.run_id);
  }

  test('read fixture renders every content block, axe clean, both themes', async () => {
    const run = show(withMedia(load('report-long')));
    for (const colorScheme of ['light', 'dark']) {
      const { ctx, page, log } = await open(run, { colorScheme });
      try {
        const types = await page.$$eval('#rs-mount [data-rs-block-type]', (els) => [...new Set(els.map((e) => e.dataset.rsBlockType))].sort());
        assert.deepEqual(types, ['chart', 'checks', 'copy', 'facts', 'media', 'stats', 'table', 'text']);
        assert.equal(await page.locator('[data-rs-block="suppliers"]').count(), 1);
        /* stats: label, value, a signed delta with its direction glyph */
        const tile = page.locator('.rs-stat').first();
        assert.equal(await tile.locator('.rs-stat__label').textContent(), 'Revenue');
        assert.equal(await tile.locator('.rs-stat__value').textContent(), '48,200 EUR');
        assert.match(await tile.locator('.rs-stat__delta').textContent(), /^▲\s?\+6\.1 %/);
        /* checks: glyph and word, never a box */
        const states = await page.$$eval('.rs-check-item', (els) => els.map((e) => e.getAttribute('data-state')));
        assert.deepEqual(states.slice(0, 2), ['ok', 'fail']);
        assert.match(await page.locator('.rs-check-item[data-state="fail"]').first().textContent(), new RegExp('✕.*' + de.blk_state_fail));
        /* the image and the video, by media id */
        assert.match(await page.getAttribute('[data-rs-block-type="media"] img', 'src'), /^\/media\/m_[0-9a-f]{32}$/);
        assert.equal(await page.locator('[data-rs-block-type="media"] video').count(), 1);
        /* read: one primary, Got it */
        assert.equal(await page.textContent('#rs-submit-label'), de.ask_got_it);
        assert.equal(await page.isDisabled('#rs-submit'), false);
        assert.deepEqual(await seriousViolations(page), [], colorScheme);
        assert.deepEqual(log.errors, [], colorScheme);
      } finally { await ctx.close(); }
    }
  });

  test('task list in markdown shows status glyphs, no checkbox role or box', async () => {
    const run = show({
      schema: 'grokbot-desk/payload@2', bot: 'ops-bot', title: 'Launch list', ask: 'read',
      blocks: [{ type: 'text', md: '## Launch\n\n- [x] Shipped the build\n- [ ] Waiting for review\n- plain point' }],
    });
    const { ctx, page, log } = await open(run);
    try {
      assert.equal(await page.locator('#rs-mount [role="checkbox"], #rs-mount input').count(), 0);
      const glyphs = await page.$$eval('#rs-mount .rs-md__task', (items) => items.map((li) => {
        const mark = li.querySelector('.rs-md__mark');
        const style = getComputedStyle(mark);
        return {
          state: li.getAttribute('data-state'),
          glyph: mark.textContent,
          hidden: mark.getAttribute('aria-hidden'),
          border: style.borderTopWidth,
          background: style.backgroundColor,
          text: li.textContent,
        };
      }));
      assert.deepEqual(glyphs.map((g) => [g.state, g.glyph, g.hidden, g.border, g.background]), [
        ['done', '✓', 'true', '0px', 'rgba(0, 0, 0, 0)'],
        ['open', '○', 'true', '0px', 'rgba(0, 0, 0, 0)'],
      ]);
      assert.ok(glyphs[0].text.includes(de.blk_task_done), glyphs[0].text);
      assert.ok(glyphs[1].text.includes(de.blk_task_open), glyphs[1].text);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('table numbers right-aligned with tabular-nums; long table folds at 10', async () => {
    const states = ['ok', 'warn', 'fail', 'open'];
    const rows = Array.from({ length: 23 }, (_, i) => ({
      name: 'Item ' + (i + 1), qty: (i + 1) * 3, amount: (i + 1) * 10.5, change: i % 2 ? -0.5 : 1.5, status: states[i % 4],
    }));
    const run = show({
      schema: 'grokbot-desk/payload@2', bot: 'ops-bot', title: 'Stock', ask: 'read',
      blocks: [{
        type: 'table', id: 'stock', columns: [
          { key: 'name', label: 'Item' }, { key: 'qty', label: 'Units', type: 'number' },
          { key: 'amount', label: 'Value (EUR)', type: 'money' }, { key: 'change', label: 'Change', type: 'delta' },
          { key: 'status', label: 'State', type: 'status' },
        ], rows,
      }],
    });
    const { ctx, page, log } = await open(run);
    try {
      const cells = await page.$$eval('[data-rs-block="stock"] tbody tr:first-child td, [data-rs-block="stock"] thead th', (els) => els.map((e) => {
        const s = getComputedStyle(e);
        return { text: e.textContent, align: s.textAlign, nums: s.fontVariantNumeric, col: e.getAttribute('data-type') };
      }));
      for (const c of cells.filter((x) => ['number', 'money', 'delta'].includes(x.col))) {
        assert.equal(c.align, 'right', JSON.stringify(c));
        assert.match(c.nums, /tabular-nums/, JSON.stringify(c));
      }
      const body = cells.slice(5);
      assert.deepEqual(body.map((c) => c.text), ['Item 1', '3', '10,50', '▲ +1,5', '✓ ' + de.blk_state_ok]);
      const visible = () => page.locator('[data-rs-block="stock"] tbody tr:visible').count();
      assert.equal(await visible(), 10);
      const more = page.locator('[data-rs-block="stock"] [data-rs-show-rows]');
      assert.equal(await more.textContent(), fill('blk_show_rows', { n: 23 }));
      await more.click();
      assert.equal(await visible(), 23);
      assert.equal(await page.$eval('[data-rs-block="stock"] thead th', (th) => getComputedStyle(th).position), 'sticky');
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('table cells read only the row\'s own values, never inherited names like constructor', async () => {
    const run = show({
      schema: 'grokbot-desk/payload@2', bot: 'ops-bot', title: 'Odd keys', ask: 'read',
      blocks: [{
        type: 'table', id: 'odd', columns: [
          { key: 'name', label: 'Item' }, { key: 'constructor', label: 'Maker' }, { key: '__proto__', label: 'Note' },
        ], rows: [{ name: 'Desk' }, { name: 'Lamp', constructor: 'Acme' }],
        total: { name: 'Total' },
      }],
    });
    const { ctx, page, log } = await open(run);
    try {
      const rows = await page.$$eval('[data-rs-block="odd"] tbody tr, [data-rs-block="odd"] tfoot tr',
        (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
      assert.deepEqual(rows, [['Desk', '', ''], ['Lamp', 'Acme', ''], ['Total', '', '']]);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('checks: one status per row, a mark next to its word, no hollow circle; rows span the column', async () => {
    const run = show({
      schema: 'grokbot-desk/payload@2', bot: 'ops-bot', title: 'Nightly', ask: 'read',
      blocks: [
        { type: 'text', md: 'A paragraph long enough to reach the reading width of the column, so the edges can be compared with the list below it in this test.' },
        {
          type: 'checks', id: 'nightly', items: [
            { label: 'Backups', state: 'ok', detail: '7 of 7 nights' }, { label: 'Certificates', state: 'warn' },
            { label: 'Disk', state: 'fail' }, { label: 'Restore test', state: 'open' },
          ],
        },
      ],
    });
    const { ctx, page, log } = await open(run, { width: 1280 });
    try {
      const words = { ok: de.blk_state_ok, warn: de.blk_state_warn, fail: de.blk_state_fail, open: de.blk_state_open };
      const rows = await page.$$eval('[data-rs-block="nightly"] .rs-check-item', (items) => items.map((li) => {
        const status = li.querySelector('.rs-check-item__status');
        return { state: li.dataset.state, text: li.textContent, status: status ? status.textContent : null };
      }));
      for (const row of rows) {
        const word = words[row.state];
        assert.equal(row.text.split(word).length - 1, 1, 'the word once: ' + row.text);
        assert.ok(row.status && row.status.includes(word), 'the mark sits with its word: ' + JSON.stringify(row));
        assert.ok(!/[○◯◦⚪]/.test(row.text), 'no hollow circle: ' + row.text);
      }
      assert.equal(await page.locator('#rs-mount [role="checkbox"], #rs-mount [role="radio"], #rs-mount input').count(), 0);
      const edges = await page.evaluate(() => {
        const list = document.querySelector('[data-rs-block="nightly"] .rs-checks').getBoundingClientRect();
        const row = document.querySelector('[data-rs-block="nightly"] .rs-check-item').getBoundingClientRect();
        const column = document.querySelector('[data-rs-block="nightly"]').getBoundingClientRect();
        return { list: Math.round(list.right), row: Math.round(row.right), column: Math.round(column.right) };
      });
      assert.deepEqual([edges.list, edges.row], [edges.column, edges.column], JSON.stringify(edges));
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('chart has accessible name and a data table', async () => {
    const run = show(withMedia(load('report-long')));
    const { ctx, page, log } = await open(run);
    try {
      const charts = await page.$$eval('[data-rs-block-type="chart"]', (blocks) => blocks.map((b) => {
        const svg = b.querySelector('svg[role="img"]');
        const details = b.querySelector('details');
        return {
          label: svg && svg.getAttribute('aria-label'),
          open: details && details.open,
          summary: details && details.querySelector('summary').textContent,
          head: details ? [...details.querySelectorAll('thead th')].map((th) => th.textContent) : [],
          rows: details ? [...details.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent)) : [],
        };
      }));
      assert.equal(charts.length, 2);
      for (const c of charts) {
        assert.ok(c.label && c.label.length > 20, c.label);
        assert.equal(c.open, false);
        assert.equal(c.summary, de.blk_show_data);
        assert.equal(c.rows.length, 4);
      }
      assert.match(charts[0].label, /Revenue by month/);
      assert.match(charts[0].label, /48\.200/);
      assert.deepEqual(charts[0].rows[3], ['Sep', '48.200']);
      assert.deepEqual(charts[1].head.slice(1), ['Revenue', 'Costs']);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('review: Looks good sends {decision: accept, note: "", refs: []}', async () => {
    const run = show(withMedia(load('review')));
    const { ctx, page, log } = await open(run);
    try {
      assert.equal(await page.textContent('#rs-submit-label'), de.ask_looks_good);
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), { decision: 'accept', note: '', refs: [] });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('section reply chip lands in refs as section:0', async () => {
    const run = show(withMedia(load('review')));
    const { ctx, page, log } = await open(run);
    try {
      const heading = page.locator('[data-rs-block="guide"] [data-rs-section="0"]');
      assert.equal((await heading.textContent()).trim(), 'First day');
      await page.locator('[data-rs-block="guide"] [data-rs-reply-section="0"]').click();
      /* twice: chips de-duplicate */
      await page.locator('[data-rs-block="guide"] [data-rs-reply-section="0"]').click();
      const chips = page.locator('[data-rs-ref]');
      assert.equal(await chips.count(), 1);
      assert.match(await chips.first().textContent(), /First day/);
      await page.click('#rs-submit');
      assert.deepEqual(await submitted(run), {
        decision: 'accept', note: '', refs: [{ block: 'guide', item: 'section:0', label: 'First day' }],
      });
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });
  test('table deltas are coloured by the column good, neutral without it', async () => {
    const run = show({
      schema: 'grokbot-desk/payload@2', bot: 'ops-bot', title: 'Changes', ask: 'read',
      blocks: [{
        type: 'table', id: 'changes', columns: [
          { key: 'name', label: 'Line' }, { key: 'up', label: 'Revenue', type: 'delta', good: 'up' },
          { key: 'down', label: 'Costs', type: 'delta', good: 'down' }, { key: 'plain', label: 'Plain', type: 'delta' },
        ], rows: [{ name: 'Rise', up: 2, down: 2, plain: 2 }, { name: 'Fall', up: -2, down: -2, plain: -2 }],
      }],
    });
    const { ctx, page, log } = await open(run);
    try {
      const tones = await page.$$eval('[data-rs-block="changes"] tbody tr', (rows) => rows.map((tr) => (
        [...tr.querySelectorAll('.rs-delta')].map((d) => [d.getAttribute('data-tone'), getComputedStyle(d).color])
      )));
      assert.deepEqual(tones.map((row) => row.map((c) => c[0])), [['good', 'bad', 'neutral'], ['bad', 'good', 'neutral']]);
      const [good, bad, neutral] = tones[0].map((c) => c[1]);
      assert.notEqual(good, bad);
      assert.notEqual(good, neutral);
      assert.equal(tones[1][1][1], good);
      /* the meaning is in words too, never colour alone */
      assert.match(await page.locator('[data-rs-block="changes"] tbody tr').first().locator('.rs-delta').first().textContent(), new RegExp(de.blk_delta_better));
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('sparklines carry their values in a table for assistive technology', async () => {
    const run = show(withMedia(load('report-long')));
    const { ctx, page, log } = await open(run);
    try {
      const spark = await page.$eval('.rs-stat', (tile) => {
        const table = tile.querySelector('table');
        return {
          name: tile.querySelector('svg.rs-spark').getAttribute('aria-label'),
          hidden: table && getComputedStyle(table.closest('.rs-vh') || table).clipPath,
          caption: table && table.querySelector('caption').textContent,
          values: table ? [...table.querySelectorAll('tbody td')].map((td) => td.textContent) : [],
        };
      });
      assert.ok(spark.name);
      assert.equal(spark.caption, 'Revenue');
      assert.deepEqual(spark.values, ['41.000', '43.500', '45.400', '48.200']);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  test('chart axes take their precision from the step; data keeps the source precision', async () => {
    const run = show({
      schema: 'grokbot-desk/payload@2', bot: 'ops-bot', title: 'Small numbers', ask: 'read',
      blocks: [
        { type: 'chart', id: 'units', kind: 'line', labels: ['a', 'b'], series: [{ name: 'Units', values: [1, 2] }] },
        { type: 'chart', id: 'rate', kind: 'line', labels: ['a', 'b'], series: [{ name: 'Rate', values: [0.001, 0.002] }] },
      ],
    });
    const { ctx, page, log } = await open(run);
    try {
      for (const id of ['units', 'rate']) {
        const axis = await page.$$eval(`[data-rs-block="${id}"] svg .rs-chart__text--muted`, (els) => els.map((e) => e.textContent));
        const ticks = axis.filter((x) => /^[0-9.,]+$/.test(x));
        assert.ok(ticks.length >= 3, `${id}: ${axis}`);
        assert.equal(new Set(ticks).size, ticks.length, `${id}: ${ticks}`);
      }
      const data = await page.$$eval('[data-rs-block="rate"] details tbody td', (tds) => tds.map((td) => td.textContent));
      assert.deepEqual(data, ['0,001', '0,002']);
      assert.match(await page.getAttribute('[data-rs-block="rate"] svg[role="img"]', 'aria-label'), /0,001.*0,002/);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
  });

  /* every text of every chart on the page: pairs whose boxes overlap,
     after the chart has been redrawn at its column width */
  async function overlappingTexts(page) {
    await page.waitForFunction(() => [...document.querySelectorAll('.rs-chartbox')].every((box) => {
      const svg = box.querySelector('svg');
      return svg && Math.abs(Number(svg.getAttribute('width')) - Math.max(280, Math.round(box.clientWidth))) <= 1;
    }), null, { timeout: 5000 });
    return page.$$eval('.rs-chartbox svg', (svgs) => svgs.flatMap((svg, n) => {
      const boxes = [...svg.querySelectorAll('text')].map((t) => ({ text: t.textContent, b: t.getBBox() }));
      const hits = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const p = boxes[i].b;
          const q = boxes[j].b;
          if (p.x + 0.5 < q.x + q.width && q.x + 0.5 < p.x + p.width && p.y + 0.5 < q.y + q.height && q.y + 0.5 < p.y + p.height) {
            hits.push(`chart ${n}: "${boxes[i].text}" x "${boxes[j].text}"`);
          }
        }
      }
      return hits;
    }));
  }

  test('chart texts never overlap: value, target, category and axis labels', async () => {
    const chart = (id, extra) => ({ type: 'chart', id, kind: 'bar', ...extra });
    const run = show({
      schema: 'grokbot-desk/payload@2', bot: 'ops-bot', title: 'Crowded charts', ask: 'read',
      blocks: [
        chart('long-values', { labels: ['A', 'B'], series: [{ name: 'S', values: [123456789.012345, 123456789.022345] }], target: 123456789.022345 }),
        chart('negative', { labels: ['A', 'B'], series: [{ name: 'S', values: [-90, -100] }], target: -100 }),
        chart('mixed', { labels: ['Alpha', 'Beta', 'Gamma'], series: [{ name: 'S', values: [-90, 40, 75] }], target: 50 }),
        chart('sideways', { orientation: 'horizontal', labels: ['Alpha', 'Beta'], series: [{ name: 'S', values: [-90, 40] }], target: -50 }),
        chart('grouped', { labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'This year', values: [12, -4, 30] }, { name: 'Last year', values: [10, 6, 28] }], target: 25 }),
      ],
    });
    const long = show(withMedia(load('report-long')));
    /* column widths 280 and 640 (the mount pads 32px each side), the window widths 1200 and 390 */
    for (const [r, width] of [[run, 344], [run, 704], [run, 1200], [run, 390], [long, 1200], [long, 390]]) {
      for (const colorScheme of r === long ? ['dark'] : ['light']) {
        const { ctx, page, log } = await open(r, { width, colorScheme });
        try {
          assert.deepEqual(await overlappingTexts(page), [], `window ${width}`);
          assert.deepEqual(log.errors, []);
        } finally { await ctx.close(); }
      }
    }
  });
});
