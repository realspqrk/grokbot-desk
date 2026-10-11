// The task banner and the buttons per task kind, in the served shell
// (headless Edge, isolated server): the banner sits above the title of every
// report and says what to do and who acts next; the footer and per-item
// controls of every built-in follow the one CTA table in core/static/tasks.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 15;
if (PORT === 18742) throw new Error('refusing the product port');
const require = createRequire(import.meta.url);
const TASKS = require('../core/static/tasks.js');
const DIR = (id) => path.join(ROOT, 'templates', 'builtin', id);
const fixture = (id, name) => JSON.parse(readFileSync(path.join(DIR(id), 'fixtures', name + '.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(ROOT, 'core', 'i18n', 'de.json'), 'utf8'));
const t = (key, vars = {}) => de[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* what each built-in golden asks for when the payload names no task */
const GOLDENS = {
  'approve-one': { kind: 'approve_bot_acts', verb: 'continue' },
  'decide-list': { kind: 'approve_bot_acts', verb: 'continue' },
  'preview-post': { kind: 'approve_bot_acts', verb: 'post' },
  'pick-option': { kind: 'pick', verb: 'continue' },
  'review-doc': { kind: 'review', verb: 'continue' },
  _starter: { kind: 'review', verb: 'continue' },
};
/* kinds each built-in with an actor model can show (core/tasks.py APPLICABLE) */
const APPLICABLE = {
  'approve-one': ['approve_bot_acts', 'post_yourself', 'fyi', 'blocking'],
  'review-doc': ['review', 'approve_bot_acts', 'post_yourself', 'fyi', 'blocking'],
  'decide-list': ['approve_bot_acts', 'post_yourself', 'blocking'],
  'preview-post': ['approve_bot_acts', 'post_yourself', 'blocking'],
  'pick-option': ['pick', 'blocking'],
};

test('tasks.js knows the same kinds and applicable sets as core/tasks.py', () => {
  const source = readFileSync(path.join(ROOT, 'core', 'tasks.py'), 'utf8');
  const kinds = source.match(/^KINDS = \(([^)]*)\)/m)[1].match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(TASKS.KINDS, kinds);
  assert.deepEqual(Object.keys(TASKS.CTA).sort(), kinds.filter((k) => k !== 'blocking').sort());
  for (const [template, list] of Object.entries(APPLICABLE)) {
    const line = source.match(new RegExp(`"${template}": \\{([^}]*)\\}`))[1];
    assert.deepEqual(line.match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1)).sort(), [...list].sort(), template);
  }
});

test('the CTA table: every label key exists in English and German; information only has no discard', () => {
  const en = JSON.parse(readFileSync(path.join(ROOT, 'core', 'i18n', 'en.json'), 'utf8'));
  for (const kind of Object.keys(TASKS.CTA)) {
    const a = TASKS.allowed(kind, { verb: 'post' });
    for (const key of [...a.primary, ...a.secondary, ...a.items, ...a.variants]) {
      assert.ok(en[key] && de[key], `${kind}: ${key}`);
    }
    for (const key of [TASKS.lineKey({ kind }), TASKS.stepsKey({ kind }), TASKS.kindKey({ kind }), 'task_done_' + kind]) {
      assert.ok(en[key] && de[key], `${kind}: ${key}`);
    }
  }
  assert.equal(TASKS.CTA.fyi.discard, false);
  assert.equal(TASKS.labelKey('approve_bot_acts', 'approve', { verb: 'send' }), 'approve_send');
  assert.equal(TASKS.labelKey('post_yourself', 'done'), 'posted');
  assert.equal(TASKS.labelKey('review', 'request_changes'), 'changes');
  assert.equal(TASKS.baseOf({ kind: 'blocking', base: 'pick' }), 'pick');
  assert.equal(TASKS.lineKey({ kind: 'blocking', base: 'pick' }), 'task_line_blocking');
});

/* the data a golden needs so the server accepts the kind: a platform the
   golden names auto cannot be posted by hand */
function dataFor(template, kind) {
  const data = fixture(template, 'golden');
  if (template === 'preview-post' && kind === 'post_yourself') {
    data.platforms = data.platforms.map((entry) => (typeof entry === 'string' ? entry : entry.platform));
  }
  return data;
}

function verbFor(template, data) {
  if (template === 'preview-post') return 'post';
  if (['approve-one', 'review-doc'].includes(template) && ['post', 'send'].includes(data.action)) return data.action;
  return 'continue';
}

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('task banner and buttons per kind (served, headless Edge)', { skip }, () => {
  let server;
  let browser;

  before(async () => {
    server = await startServer({ port: PORT });
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally { if (server) await server.stop(); }
  });

  const show = (template, data, extra = {}) => server.show(data, { template, version: 1, title: `${template} report`, ...extra });

  async function open(query, opts = {}) {
    const ctx = await browser.newContext({
      viewport: opts.viewport || { width: 1280, height: 720 }, deviceScaleFactor: 1,
      colorScheme: opts.colorScheme || 'light', reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    if (opts.beforeGoto) await opts.beforeGoto(page);
    await page.goto(server.url(`?client=test${query}`));
    await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1', null, { timeout: 8000 });
    return { ctx, page, errors };
  }
  const openRun = (run, opts) => open(`&run=${run.run_id}`, opts);

  const banner = (page) => page.evaluate(() => {
    const box = document.getElementById('rs-task');
    const title = document.getElementById('rs-title').getBoundingClientRect();
    const rect = box.getBoundingClientRect();
    const text = (sel) => { const node = box.querySelector(sel); return node ? node.textContent : null; };
    return {
      hidden: box.hidden,
      kind: box.getAttribute('data-kind'),
      tone: box.getAttribute('data-tone'),
      state: box.getAttribute('data-state'),
      what: text('.rs-task__what'),
      meta: text('.rs-task__meta'),
      steps: text('.rs-task__steps'),
      why: text('.rs-task__why'),
      more: text('.rs-task__more > p'),
      above: rect.bottom <= title.top + 0.5,
      controls: [...box.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].length,
      summaries: box.querySelectorAll('summary').length,
      edge: getComputedStyle(box.querySelector('.rs-task__inner')).borderLeftColor,
    };
  });

  const footer = (page) => page.evaluate(() => {
    const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
    const submit = document.getElementById('rs-submit');
    const alt = document.getElementById('rs-alt');
    const discard = document.getElementById('rs-discard');
    return {
      primary: document.getElementById('rs-submit-label').textContent,
      disabled: submit.disabled,
      emphasis: submit.hasAttribute('data-rs-emphasis'),
      alt: shown(alt) ? alt.textContent : null,
      discard: shown(discard),
      rows: [...document.querySelectorAll('#rs-mount rs-action-row button')].filter(shown).map((b) => b.textContent),
      sectionComments: [...document.querySelectorAll('#rs-mount .rd__comment-open')].filter(shown).length,
    };
  });

  test('every built-in golden: the banner sits above the title with the line, steps and tone of its kind', async () => {
    for (const [template, want] of Object.entries(GOLDENS)) {
      await server.clearRuns();
      const run = show(template, fixture(template, 'golden'));
      const { ctx, page, errors } = await openRun(run);
      try {
        const view = await banner(page);
        const task = { kind: want.kind, base: want.kind, verb: want.verb };
        assert.equal(view.hidden, false, template);
        assert.equal(view.above, true, `${template}: above the title`);
        assert.equal(view.kind, want.kind, template);
        assert.equal(view.tone, want.kind, template);
        assert.equal(view.state, 'open', template);
        assert.equal(view.what, t(TASKS.lineKey(task)), template);
        assert.equal(view.steps, t(TASKS.stepsKey(task)), template);
        assert.equal(view.controls, 0, `${template}: no buttons in the banner`);
        assert.ok(view.summaries <= 1, template);
        assert.deepEqual(errors, [], template);
      } finally { await ctx.close(); }
    }
  });

  test('every built-in golden: the derived kind and the primary label agree', async () => {
    for (const [template, want] of Object.entries(GOLDENS)) {
      await server.clearRuns();
      const data = fixture(template, 'golden');
      const run = show(template, data);
      const { ctx, page } = await openRun(run);
      try {
        const bar = await footer(page);
        const key = TASKS.primaryKey(want.kind, { verb: want.verb });
        /* a payload may name the bot's approve itself (approve_label);
           templates without an actor model keep the shell's generic label */
        const expected = template === '_starter' ? de.submit
          : template === 'approve-one' && data.approve_label ? data.approve_label : t(key);
        assert.equal(bar.primary, expected, `${template} (${want.kind})`);
      } finally { await ctx.close(); }
    }
  });

  test('every built-in golden with every applicable kind: footer and item buttons follow the CTA table', async () => {
    for (const [template, kinds] of Object.entries(APPLICABLE)) {
      for (const kind of kinds) {
        await server.clearRuns();
        const data = dataFor(template, kind);
        const run = show(template, data, { task: { kind } });
        const { ctx, page, errors } = await openRun(run);
        const label = `${template} as ${kind}`;
        try {
          const view = await banner(page);
          const base = kind === 'blocking' ? GOLDENS[template].kind : kind;
          const verb = verbFor(template, data);
          const table = TASKS.allowed(base, { verb });
          const texts = (keys) => keys.map((key) => t(key, { name: '' }).trim());
          const custom = template === 'approve-one' && base === 'approve_bot_acts' && data.approve_label ? [data.approve_label] : [];
          const primaries = [...texts(table.primary), ...custom];
          const allowed = new Set([...primaries, ...texts(table.secondary), ...texts(table.items), ...texts(table.variants)]);
          const bar = await footer(page);
          assert.equal(view.kind, kind, label);
          assert.equal(view.tone, kind === 'blocking' ? 'urgent' : kind, label);
          assert.ok(
            primaries.includes(bar.primary) || (base === 'pick' && bar.primary === t('po_choose_idle')),
            `${label}: primary ${bar.primary} (allowed ${primaries.join(' | ')})`,
          );
          assert.equal(bar.emphasis, kind === 'blocking', `${label}: emphasis`);
          assert.equal(bar.discard, table.discard, `${label}: discard`);
          if (bar.alt !== null) assert.ok(texts(table.secondary).includes(bar.alt), `${label}: alternative ${bar.alt}`);
          /* pick: the items are the payload's options themselves */
          if (base === 'pick') assert.equal(bar.rows.length, data.options.length, label);
          else for (const text of bar.rows) assert.ok(allowed.has(text), `${label}: item button ${text}`);
          if (base === 'fyi') {
            assert.deepEqual([bar.alt, bar.rows, bar.sectionComments, bar.disabled], [null, [], 0, false], `${label}: only Got it`);
          }
          if (base === 'post_yourself') assert.ok(!bar.rows.includes(t('choice_approve')), label);
          assert.deepEqual(errors, [], label);
        } finally { await ctx.close(); }
      }
    }
  });

  test('information only: Got it sends at once and the decided banner turns neutral, saying what happened', async () => {
    await server.clearRuns();
    const data = { ...fixture('approve-one', 'golden'), allow_changes: false };
    const run = show('approve-one', data, { task: { kind: 'fyi', steps: 'Read the release notes.', eta_min: 2 } });
    const { ctx, page, errors } = await openRun(run);
    try {
      const open = await banner(page);
      assert.equal(open.what, t('task_line_fyi'));
      assert.equal(open.steps, 'Read the release notes.');
      assert.equal(open.meta, t('task_eta', { n: 2 }));
      assert.equal(open.why, data.summary);
      await page.click('#rs-submit');
      const deadline = Date.now() + 5000;
      while (!server.result(run.run_id) && Date.now() < deadline) await sleep(20);
      assert.deepEqual(server.result(run.run_id).data, { decision: 'acknowledged', comment: '' });
      await page.waitForFunction(() => document.getElementById('rs-task').getAttribute('data-state') === 'decided');
      const done = await banner(page);
      assert.deepEqual([done.tone, done.what, done.steps, done.meta, done.hidden], ['quiet', t('task_done_fyi'), null, null, false]);
      assert.equal(done.above, true);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('red only for blocking or a due date that is today or past', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const cases = [
      { task: { kind: 'review', due: today }, tone: 'urgent', meta: t('task_due_today_date') },
      { task: { kind: 'review', due: '2020-01-02' }, tone: 'urgent', meta: t('task_overdue', { when: '02.01.' }) },
      { task: { kind: 'review', due: '2099-03-04' }, tone: 'review', meta: t('due', { date: '04.03.' }) },
      { task: { kind: 'blocking', eta_min: 5 }, tone: 'urgent', meta: t('task_eta', { n: 5 }) },
    ];
    const edges = new Set();
    for (const item of cases) {
      await server.clearRuns();
      const run = show('review-doc', fixture('review-doc', 'golden'), { task: item.task });
      const { ctx, page } = await openRun(run);
      try {
        const view = await banner(page);
        assert.equal(view.tone, item.tone, JSON.stringify(item.task));
        assert.equal(view.meta, item.meta, JSON.stringify(item.task));
        if (item.task.kind === 'blocking') {
          assert.equal(view.what, t('task_line_blocking'));
          assert.equal((await footer(page)).emphasis, true);
          assert.equal((await footer(page)).primary, de.looks_good, 'blocking keeps the review buttons');
        }
        edges.add(`${view.tone}:${view.edge}`);
      } finally { await ctx.close(); }
    }
    assert.equal(new Set([...edges].filter((e) => e.startsWith('urgent:'))).size, 1, 'one red');
  });

  test('a long why keeps three sentences in view and folds the rest; the payload why replaces the template text', async () => {
    await server.clearRuns();
    const data = fixture('decide-list', 'golden');
    data.intro = 'One. Two. Three. Four is folded. Five too.';
    const long = show('decide-list', data);
    const opened = await openRun(long);
    try {
      const view = await banner(opened.page);
      assert.deepEqual([view.why, view.more, view.summaries, view.controls], ['One. Two. Three.', 'Four is folded. Five too.', 1, 0]);
      assert.equal(await opened.page.locator('[data-dl="intro"]').count(), 0);
    } finally { await opened.ctx.close(); }
    await server.clearRuns();
    const own = show('decide-list', fixture('decide-list', 'golden'), { task: { kind: 'approve_bot_acts', why: 'The budget closes Friday.' } });
    const second = await openRun(own);
    try {
      assert.equal((await banner(second.page)).why, 'The budget closes Friday.');
      assert.equal(await second.page.textContent('[data-dl="intro"]'), fixture('decide-list', 'golden').intro);
    } finally { await second.ctx.close(); }
  });

  test('light and dark: banner text and edge keep their contrast on every tint', async () => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    for (const colorScheme of ['light', 'dark']) {
      for (const kind of ['review', 'blocking']) {
        await server.clearRuns();
        const run = show('review-doc', fixture('review-doc', 'golden'), { task: { kind, eta_min: 3 } });
        const { ctx, page } = await openRun(run, { colorScheme });
        try {
          const colors = await page.evaluate(() => {
            const inner = document.querySelector('.rs-task__inner');
            const style = getComputedStyle(inner);
            return {
              bg: style.backgroundColor,
              edge: style.borderLeftColor,
              ink: getComputedStyle(inner.querySelector('.rs-task__what')).color,
              muted: getComputedStyle(inner.querySelector('.rs-task__meta')).color,
              paper: getComputedStyle(document.body).backgroundColor,
            };
          });
          assert.ok(ratio(colors.ink, colors.bg) >= 4.5, `${colorScheme} ${kind} ink ${JSON.stringify(colors)}`);
          assert.ok(ratio(colors.muted, colors.bg) >= 4.5, `${colorScheme} ${kind} muted`);
          assert.ok(ratio(colors.edge, colors.bg) >= 3, `${colorScheme} ${kind} edge`);
        } finally { await ctx.close(); }
      }
    }
  });

  test('with two open reports the strip stays on top and the banner sits below it', async () => {
    await server.clearRuns();
    const first = show('pick-option', fixture('pick-option', 'golden'));
    show('approve-one', fixture('approve-one', 'golden'));
    const { ctx, page } = await openRun(first);
    try {
      const layout = await page.evaluate(() => {
        const strip = document.getElementById('rs-strip-nav').getBoundingClientRect();
        const task = document.getElementById('rs-task').getBoundingClientRect();
        return { stripShown: !document.getElementById('rs-strip-nav').hidden, stripTop: strip.top, stripBottom: strip.bottom, taskTop: task.top };
      });
      assert.equal(layout.stripShown, true);
      assert.equal(layout.stripTop, 0);
      assert.ok(layout.taskTop >= layout.stripBottom - 0.5, JSON.stringify(layout));
    } finally { await ctx.close(); }
  });

  test('no report shown while some wait: the overview lists them with bot and kind; a row opens its report', async () => {
    await server.clearRuns();
    const pick = show('pick-option', fixture('pick-option', 'golden'), { title: 'Venue' });
    show('approve-one', fixture('approve-one', 'golden'), { title: 'Release', task: { kind: 'blocking' } });
    let failing = true;
    const { ctx, page, errors } = await open('', {
      beforeGoto: (p) => p.route('**/api/run/**', (route) => (failing ? route.abort() : route.continue())),
    });
    try {
      await page.waitForSelector('[data-rs-overview]');
      const rows = await page.$$eval('.rs-overview__item', (items) => items.map((b) => ({
        kind: b.getAttribute('data-kind'),
        title: b.querySelector('.rs-overview__title').textContent,
        label: b.querySelector('.rs-overview__kind').textContent,
      })));
      assert.deepEqual(rows.map((r) => [r.title, r.kind, r.label]).sort(), [
        ['Release', 'blocking', t('task_kind_blocking')],
        ['Venue', 'pick', t('task_kind_pick')],
      ]);
      assert.equal(await page.isHidden('#rs-task'), true);
      assert.equal(await page.textContent('.rs-overview__heading'), t('overview_title'));
      failing = false;
      await page.click(`.rs-overview__item:has-text("Venue")`);
      await page.waitForFunction((id) => new URL(location.href).searchParams.get('run') === id, pick.run_id);
      await page.waitForFunction(() => document.getElementById('rs-task').getAttribute('data-kind') === 'pick');
      assert.equal(await page.textContent('#rs-title'), 'Venue');
      assert.deepEqual(errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e)), []);
    } finally { await ctx.close(); }
  });

  test('no open report: the empty state stays one quiet line and no banner', async () => {
    await server.clearRuns();
    const { ctx, page } = await open('');
    try {
      assert.equal(await page.textContent('.rs-empty'), de.no_runs);
      assert.equal(await page.isHidden('#rs-task'), true);
    } finally { await ctx.close(); }
  });
});
