// The post block: one faithful preview per platform tab. Auto (ask
// approve): every platform included by default, a quiet "Leave out" per
// platform, one primary that names where the bot posts; an over-limit or
// unpostable platform is left out with its reason. Manual (ask do): an
// unset Posted | Skip per platform; limits are advice, never a block.
// Isolated server on RS_E2E_PORT with a temp RS_DATA_DIR and media root;
// headless Edge (or Chrome) via playwright-core.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
const list = (names) => new Intl.ListFormat('de', { style: 'long', type: 'conjunction' }).format(names);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('post block: auto and manual platforms (served, headless browser)', { skip }, () => {
  let server;
  let browser;
  let media;
  let seq = 0;

  before(async () => {
    media = mkdtempSync(path.join(tmpdir(), 'rs-post-media-'));
    for (const name of ['opening-hours.png', 'chain-poster.jpg']) writeFileSync(path.join(media, name), PNG);
    writeFileSync(path.join(media, 'chain.mp4'), Buffer.from('00000018667479706d703432', 'hex'));
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
    const file = path.join(server.dataDir, `post-${process.pid}-${seq}.json`);
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

  const tab = (p) => `[role="tab"][data-platform="${p}"]`;
  const tabState = (page) => page.$$eval('[role="tab"][data-platform]', (els) => els.map((t) => [t.getAttribute('data-platform'), t.getAttribute('data-state')]));

  async function seriousViolations(page) {
    await page.addScriptTag({ path: AXE });
    return page.evaluate(async () => (await window.axe.run(document)).violations
      .filter((x) => x.impact === 'serious' || x.impact === 'critical')
      .map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target.join(' ')) })));
  }

  test('post auto: one click approves all included platforms', async () => {
    const run = show(load('approve-post'));
    for (const colorScheme of ['light', 'dark']) {
      const { ctx, page, log } = await open(run, { colorScheme });
      try {
        assert.deepEqual(await tabState(page), [['x', 'included'], ['linkedin', 'included']]);
        assert.equal(await page.getAttribute(tab('x'), 'aria-selected'), 'true');
        /* one preview at a time, as wide as a real post */
        const frames = await page.$$eval('#rs-mount rs-post-frame', (els) => els.map((e) => [e.getAttribute('skin'), Math.round(e.getBoundingClientRect().width)]));
        assert.equal(frames.length, 1);
        assert.equal(frames[0][0], 'x');
        assert.ok(frames[0][1] >= 480, 'mockup width ' + frames[0][1]);
        const f = await footer(page);
        assert.equal(f.primary, fill('inp_approve_post_to', { platforms: list(['X', 'LinkedIn']) }));
        assert.equal(f.primaryEnabled, true);
        assert.deepEqual(f.buttons, [de.ask_reject, de.ask_request_changes, f.primary]);
        assert.equal(await page.locator('#rs-mount [role="checkbox"], #rs-mount input[type="checkbox"]').count(), 0);
        assert.deepEqual(await seriousViolations(page), [], colorScheme);
        const judged = judgeCalmFacts(await page.evaluate(calmEvaluator, { thresholds: CALM_THRESHOLDS }));
        assert.equal(judged.items.K1.pass, true, (judged.items.K1.reasons || []).join('; '));
        assert.deepEqual(log.errors, [], colorScheme);
        if (colorScheme === 'dark') {
          await page.click('#rs-submit');
          assert.deepEqual(await submitted(run), {
            decision: 'approve', note: '', refs: [],
            blocks: { post: { platforms: [{ platform: 'x', included: true }, { platform: 'linkedin', included: true }] } },
          });
        }
      } finally { await ctx.close(); }
    }
    /* Leave out one: the primary names the rest; Include brings it back; the tab says it */
    const second = show(load('approve-post'));
    const o = await open(second);
    try {
      await o.page.click(tab('linkedin'));
      assert.equal(await o.page.locator('#rs-mount rs-post-frame').getAttribute('skin'), 'linkedin');
      await o.page.click('[data-rs-leave-out]');
      assert.deepEqual(await tabState(o.page), [['x', 'included'], ['linkedin', 'left-out']]);
      assert.equal((await footer(o.page)).primary, fill('inp_approve_post_to', { platforms: 'X' }));
      assert.equal(await o.page.textContent('[data-rs-leave-out]'), fill('inp_include', { platform: 'LinkedIn' }));
      await o.page.click('[data-rs-leave-out]');
      assert.equal((await footer(o.page)).primary, fill('inp_approve_post_to', { platforms: list(['X', 'LinkedIn']) }));
      await o.page.click('[data-rs-leave-out]');
      /* arrows move along the tabs; R quotes the platform */
      await o.page.focus(tab('linkedin'));
      await o.page.keyboard.press('ArrowLeft');
      assert.equal(await o.page.getAttribute(tab('x'), 'aria-selected'), 'true');
      await o.page.keyboard.press('r');
      assert.deepEqual(await o.page.locator('#rs-submitbar [data-rs-ref]').allTextContents(), [fill('inp_post_ref', { platform: 'X' })]);
      await o.page.keyboard.type('Shorter, please.');
      /* the draft keeps the left-out platform */
      await o.page.reload();
      await ready(o.page);
      assert.deepEqual(await tabState(o.page), [['x', 'included'], ['linkedin', 'left-out']]);
      await o.page.click('#rs-submit');
      assert.deepEqual(await submitted(second), {
        decision: 'approve', note: 'Shorter, please.', refs: [{ block: 'post', item: 'x', label: fill('inp_post_ref', { platform: 'X' }) }],
        blocks: { post: { platforms: [{ platform: 'x', included: true }, { platform: 'linkedin', included: false }] } },
      });
    } finally { await o.ctx.close(); }
  });

  test('post: leaving every platform out points to Request changes/Reject', async () => {
    const run = show(load('approve-post'));
    const { ctx, page } = await open(run);
    try {
      await page.click('[data-rs-leave-out]');
      await page.click(tab('linkedin'));
      await page.click('[data-rs-leave-out]');
      const f = await footer(page);
      assert.equal(f.primaryEnabled, false);
      assert.equal(f.status, de.ask_hint_all_left_out);
      assert.deepEqual(f.buttons.slice(0, 2), [de.ask_reject, de.ask_request_changes]);
      await page.getByRole('button', { name: de.ask_reject, exact: true }).click();
      assert.deepEqual(await submitted(run), { decision: 'reject', note: '', refs: [] });
    } finally { await ctx.close(); }
    /* Instagram (auto) without an image or a video cannot be posted */
    const payload = load('approve-post');
    const block = payload.blocks[0];
    delete block.image;
    block.platforms = ['instagram'];
    delete block.variants;
    const second = show(payload);
    const o = await open(second);
    try {
      assert.deepEqual(await tabState(o.page), [['instagram', 'blocked']]);
      assert.equal(await o.page.textContent('.rs-post__reason'), de.lint_ig_needs_image);
      assert.equal(await o.page.locator('[data-rs-leave-out]').count(), 0, 'nothing to leave out');
      const f = await footer(o.page);
      assert.equal(f.primaryEnabled, false);
      assert.equal(f.status, de.ask_hint_none_postable);
    } finally { await o.ctx.close(); }
  });

  test('post: over-limit X auto is left out with reason; manual X over limit stays allowed', async () => {
    /* 12,600 wide characters weigh 25,200 on X, plus the appended
       "

#bakery #autumn" (17): 217 over its 25,000 */
    const long = 'あ'.repeat(12600);
    const payload = load('approve-post');
    payload.blocks[0].variants = { ...payload.blocks[0].variants, x: { text: long } };
    const run = show(payload);
    const { ctx, page, log } = await open(run);
    try {
      assert.deepEqual(await tabState(page), [['x', 'blocked'], ['linkedin', 'included']]);
      await page.click(tab('x'));
      assert.equal(await page.textContent('.rs-post__reason'), fill('shorten_to_approve', { n: '217' }));
      assert.equal(await page.locator('[data-rs-leave-out]').count(), 0);
      const f = await footer(page);
      assert.equal(f.primary, fill('inp_approve_post_to', { platforms: 'LinkedIn' }));
      await page.click('#rs-submit');
      assert.deepEqual((await submitted(run)).blocks.post.platforms, [
        { platform: 'x', included: false }, { platform: 'linkedin', included: true },
      ]);
      assert.deepEqual(log.errors, []);
    } finally { await ctx.close(); }
    /* the same text to post by hand: advice, and Posted stays possible */
    const manual = load('do-post');
    manual.blocks[0].platforms = ['x', 'facebook'];
    manual.blocks[0].text = long;
    const second = show(manual);
    const o = await open(second);
    try {
      assert.deepEqual(await tabState(o.page), [['x', 'open'], ['facebook', 'open']]);
      assert.match(await o.page.textContent('.rs-post__reason'), new RegExp(fill('manual_over_limit', { limit: '25.000', platform: 'X' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      let f = await footer(o.page);
      assert.equal(f.primary, de.ask_posted);
      assert.equal(f.primaryEnabled, false);
      assert.equal(f.status, fill('ask_progress', { done: 0, total: 2 }));
      const segs = await o.page.$$eval('rs-segmented[data-item="x"] > button', (els) => els.map((b) => [b.value, b.getAttribute('aria-checked')]));
      assert.deepEqual(segs, [['posted', 'false'], ['skipped', 'false']]);
      /* manual copies: text, hashtags, the video path, the reply link */
      assert.ok(await o.page.locator('#rs-mount rs-copy[media-copy="path"]').count() === 1);
      assert.equal(await o.page.locator('#rs-mount [data-rs-reveal]').count(), 1);
      await o.page.click('rs-segmented[data-item="x"] > button[value="posted"]');
      assert.deepEqual(await tabState(o.page), [['x', 'posted'], ['facebook', 'open']]);
      await o.page.click(tab('facebook'));
      await o.page.click('rs-segmented[data-item="facebook"] > button[value="skipped"]');
      f = await footer(o.page);
      assert.equal(f.primaryEnabled, true);
      await o.page.click('#rs-submit');
      assert.deepEqual(await submitted(second), {
        decision: 'submit', note: '', refs: [],
        blocks: { b1: { platforms: [{ platform: 'x', choice: 'posted' }, { platform: 'facebook', choice: 'skipped' }] } },
      });
    } finally { await o.ctx.close(); }
  });
});
