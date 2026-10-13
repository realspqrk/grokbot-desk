// The task banner and the buttons per task kind, in the served shell
// (headless Edge, isolated server): the banner sits under the title of every
// report and says what to do and who acts next; the footer and per-item
// controls of every built-in follow the one CTA table in core/static/tasks.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { browserChannel, startServer, loadChromium, ROOT } from '../tools/dev/rs-server.mjs';
import { calmEvaluator, judgeCalmFacts, CALM_THRESHOLDS } from '../tools/calm.mjs';

const PORT = Number(process.env.RS_E2E_PORT || 18900) + 15;
if (PORT === 18742) throw new Error('refusing the product port');
const require = createRequire(import.meta.url);
const TASKS = require('../core/static/tasks.js');
const DIR = (id) => path.join(ROOT, 'templates', 'builtin', id);
const fixture = (id, name) => JSON.parse(readFileSync(path.join(DIR(id), 'fixtures', name + '.json'), 'utf8'));
const de = JSON.parse(readFileSync(path.join(ROOT, 'core', 'i18n', 'de.json'), 'utf8'));
const en = JSON.parse(readFileSync(path.join(ROOT, 'core', 'i18n', 'en.json'), 'utf8'));
const tIn = (table) => (key, vars = {}) => table[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
const t = tIn(de);
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
    for (const key of [TASKS.lineKey({ kind }), TASKS.kindKey({ kind }), 'task_done_' + kind]) {
      assert.ok(en[key] && de[key], `${kind}: ${key}`);
    }
    /* a one-step task says it in its line and its buttons: no steps line */
    assert.equal(TASKS.stepsKey({ kind }), null, kind);
  }
  for (const verb of ['post', 'send', 'continue']) {
    const key = TASKS.lineKey({ kind: 'approve_bot_acts', base: 'approve_bot_acts', verb, label: 'Deploy' });
    assert.equal(key, 'task_line_label_' + verb);
    assert.ok(en[key].includes('{label}') && de[key].includes('{label}'), key);
  }
  for (const steps of ['replies', 'mixed_items']) {
    const key = TASKS.stepsKey({ kind: 'post_yourself', steps_for: steps });
    assert.ok(en[key].includes('{button}') && de[key].includes('{button}'), `${key} names the live button`);
  }
  assert.equal(TASKS.CTA.fyi.discard, false);
  assert.equal(TASKS.labelKey('approve_bot_acts', 'approve', { verb: 'send' }), 'approve_send');
  assert.equal(TASKS.labelKey('post_yourself', 'done'), 'posted');
  assert.equal(TASKS.labelKey('post_yourself', 'done', { mark: 'done' }), 'done_mark');
  assert.equal(TASKS.labelKey('post_yourself', 'done', { mark: 'sent' }), 'sent_mark');
  assert.equal(TASKS.labelKey('approve_bot_acts', 'done', { item: true, actor: 'user', content: 'reply' }), 'posted');
  assert.equal(TASKS.labelKey('approve_bot_acts', 'done', { item: true, actor: 'user' }), 'done_mark');
  assert.equal(TASKS.labelKey('post_yourself', 'approve', { item: true, actor: 'bot' }), 'choice_approve');
  assert.equal(TASKS.lineKey({ kind: 'post_yourself', base: 'post_yourself', mark: 'done' }), 'task_line_do');
  assert.equal(TASKS.stepsKey({ kind: 'post_yourself', steps_for: 'replies' }), 'task_steps_replies');
  assert.equal(TASKS.labelKey('review', 'request_changes'), 'request_changes', 'the alternative says what it does');
  assert.equal(TASKS.baseOf({ kind: 'blocking', base: 'pick' }), 'pick');
  assert.equal(TASKS.lineKey({ kind: 'blocking', base: 'pick' }), 'task_line_blocking');
  assert.ok(TASKS.allowed('post_yourself').variants.includes('send_request'),
    'a user change request submits with Send request');
});

test('per-actor lines: the person first, the bot by its verb, nothing once every one is out, past tense once decided', () => {
  const parties = [{ id: 'linkedin', role: 'auto' }, { id: 'x', role: 'manual' }];
  const keys = (lines) => lines.map((line) => [line.actor, line.key, line.names.map((p) => p.id || p.noun)]);
  assert.deepEqual(keys(TASKS.actorLines(parties, { verb: 'post' })), [
    ['user', 'task_you_post', ['x']],
    ['bot', 'task_bot_post', ['linkedin']],
  ]);
  const xOnly = [{ id: 'linkedin', role: 'auto', on: false }, { id: 'x', role: 'manual', on: true }];
  const open = TASKS.actorLines(xOnly, { verb: 'post' });
  assert.deepEqual(keys(open), [['user', 'task_you_post', ['x']], ['bot', 'task_bot_none_post', []]]);
  assert.deepEqual(open[1].dropped.map((p) => p.id), ['linkedin']);
  assert.deepEqual(keys(TASKS.actorLines(xOnly, { verb: 'post', decided: true })), [
    ['user', 'task_you_post_done', ['x']],
    ['bot', 'task_bot_none_post', []],
  ]);
  assert.deepEqual(keys(TASKS.actorLines(parties, { verb: 'post', changes: true, decided: true })), [
    ['user', 'task_you_changes_done', []],
    ['bot', 'task_bot_none_post', []],
  ]);
  const items = [{ role: 'user_post', noun: 'reply' }, { role: 'user', noun: 'item' }, { role: 'bot', noun: 'item', on: false }];
  assert.deepEqual(keys(TASKS.actorLines(items, { verb: 'send' })), [
    ['user', 'task_you_do', ['reply', 'item']],
    ['bot', 'task_bot_none_send', []],
  ]);
  const blocked = [
    { id: 'x', role: 'manual' },
    { id: 'linkedin', role: 'auto' },
    { id: 'instagram', role: 'auto', blocked: true },
  ];
  assert.deepEqual(keys(TASKS.actorLines(blocked, { verb: 'post' })), [
    ['user', 'task_you_post', ['x']],
    ['bot', 'task_bot_post', ['linkedin']],
  ], 'a blocked platform is not planned before any tick');
  assert.deepEqual(TASKS.actorLines(blocked, { verb: 'post' }).flatMap((line) => line.dropped), [],
    'a blocked platform is not described as unticked');
  const over = [{ id: 'x', role: 'manual', blocked: true, on: false }, { id: 'linkedin', role: 'auto', on: true }];
  const overLines = TASKS.actorLines(over, { verb: 'post' });
  assert.deepEqual(keys(overLines), [
    ['user', 'task_you_none_post', []],
    ['bot', 'task_bot_post', ['linkedin']],
  ]);
  assert.deepEqual(overLines.flatMap((line) => line.names.concat(line.dropped)).map((party) => party.id), ['linkedin']);
  assert.deepEqual(TASKS.nounOf([{ noun: 'reply' }, { noun: 'reply' }]), 'reply');
  assert.deepEqual(TASKS.nounOf([{ noun: 'reply' }, { noun: 'post' }]), 'item');
  assert.deepEqual(TASKS.shortList(['LinkedIn', 'Instagram', 'Facebook']), { shown: ['LinkedIn', 'Instagram', 'Facebook'], more: 0 });
  assert.deepEqual(TASKS.shortList(['LinkedIn', 'Mastodon', 'Instagram', 'Facebook']), { shown: ['LinkedIn', 'Mastodon'], more: 2 });
  for (const table of [en, de]) {
    for (const key of TASKS.ACTOR_KEYS) assert.ok(table[key], key);
  }
});

test('mixed steps: what is left per actor in tab order, then the footer as it reads now', () => {
  const plan = (parties) => {
    const steps = TASKS.mixedSteps(parties);
    return [steps.segments.map((s) => [s.key, s.names.map((p) => p.id)]), steps.tail];
  };
  const li = { id: 'linkedin', role: 'auto' };
  const x = { id: 'x', role: 'manual' };
  assert.deepEqual(plan([li, x]), [[['task_step_auto', ['linkedin']], ['task_step_manual', ['x']]], 'task_steps_tail_then']);
  assert.deepEqual(plan([{ ...li, on: true }, { ...x, on: false }]), [[['task_step_manual', ['x']]], 'task_steps_tail_or']);
  assert.deepEqual(plan([{ ...li, on: false }, { ...x, on: true }]), [[['task_step_auto', ['linkedin']]], 'task_steps_tail_or']);
  assert.deepEqual(plan([{ ...li, on: true }, { ...x, on: true }]), [[], 'task_steps_tail_now']);
  const golden = [x, li, { id: 'instagram', role: 'auto', blocked: true }, { id: 'facebook', role: 'auto' }];
  assert.deepEqual(plan(golden), [[['task_step_manual', ['x']], ['task_step_auto', ['linkedin', 'facebook']]], 'task_steps_tail_then'],
    'a platform that cannot be approved is not a step');
  for (const table of [en, de]) {
    for (const key of ['task_step_auto', 'task_step_manual', 'task_steps_tail_then', 'task_steps_tail_or', 'task_steps_tail_now',
      'submit_mixed', 'mixed_approved_count', 'mixed_posted_count']) assert.ok(table[key], key);
  }
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
  let serverEn;
  let browser;

  before(async () => {
    [server, serverEn] = await Promise.all([
      startServer({ port: PORT }),
      startServer({ port: PORT + 31, env: { RS_LANG: 'en' } }),
    ]);
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    try { if (browser) await browser.close(); } finally {
      try { if (serverEn) await serverEn.stop(); } finally { if (server) await server.stop(); }
    }
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
    // diagnostics for a rare net::ERR_NO_BUFFER_SPACE on Windows runners: which request failed
    page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && console.error(`[requestfailed] ${r.method()} ${new URL(r.url()).pathname} range=${r.headers().range || '-'} type=${r.resourceType()} ${r.failure()?.errorText}`));
    if (opts.beforeGoto) await opts.beforeGoto(page);
    await page.goto((opts.server || server).url(`?client=test${query}`));
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
      actors: [...box.querySelectorAll('.rs-task__actor')].map((node) => [node.getAttribute('data-actor'), node.textContent]),
      meta: text('.rs-task__meta'),
      steps: text('.rs-task__steps'),
      why: text('.rs-task__why'),
      more: text('.rs-task__more > p'),
      below: rect.top >= title.bottom - 0.5,
      controls: [...box.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].length,
      summaries: box.querySelectorAll('summary').length,
      edge: getComputedStyle(box.querySelector('.rs-task__inner')).borderLeftColor,
    };
  });

  async function assertReading(page) {
    const facts = await page.evaluate(calmEvaluator, { thresholds: CALM_THRESHOLDS });
    const judged = judgeCalmFacts(facts);
    const wide = (facts.K7.wide_text || [])
      .map((item) => `${item.identity} ${Math.round(item.width)}>${Math.round(item.max_width)}`)
      .join('; ');
    assert.equal(judged.items.K6.pass, true, (judged.items.K6.reasons || []).join('; '));
    assert.equal(judged.items.K7.pass, true, wide || (judged.items.K7.reasons || []).join('; '));
  }

  const footer = (page) => page.evaluate(() => {
    const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
    const submit = document.getElementById('rs-submit');
    const alt = document.getElementById('rs-alt');
    const discard = document.getElementById('rs-discard');
    const alts = [...document.querySelectorAll('#rs-submitbar .rs-btn--quiet')].filter(shown);
    return {
      primary: document.getElementById('rs-submit-label').textContent,
      disabled: submit.disabled,
      emphasis: submit.hasAttribute('data-rs-emphasis'),
      alt: shown(alt) ? alt.textContent : null,
      discard: !discard.hidden && !!discard.closest('#rs-more-panel'),
      quiet: alts.length,
      rows: [...document.querySelectorAll('#rs-mount rs-action-row button')].filter(shown).map((b) => b.textContent),
      sectionComments: [...document.querySelectorAll('#rs-mount .rd__comment-open')].filter(shown).length,
    };
  });

  test('every built-in golden: the banner sits under the title with the line and tone of its kind, steps only when they add something', async () => {
    for (const [template, want] of Object.entries(GOLDENS)) {
      await server.clearRuns();
      const run = show(template, fixture(template, 'golden'));
      const { ctx, page, errors } = await openRun(run);
      try {
        const view = await banner(page);
        const task = { kind: want.kind, base: want.kind, verb: want.verb };
        assert.equal(view.hidden, false, template);
        assert.equal(view.below, true, `${template}: under the title`);
        assert.equal(view.kind, want.kind, template);
        assert.equal(view.tone, want.kind, template);
        assert.equal(view.state, 'open', template);
        if (template === 'preview-post') {
          /* the golden: X by hand, LinkedIn, Instagram and Facebook by the bot */
          assert.deepEqual(view.actors.map(([actor]) => actor), ['user', 'bot'], template);
          assert.equal(view.steps, [
            t('task_step_manual', { names: 'X' }), t('task_step_auto', { names: 'LinkedIn, Instagram, Facebook' }),
            t('task_steps_tail_then', { button: t('submit_mixed') }),
          ].join(' · '), template);
        } else {
          const data = fixture(template, 'golden');
          const label = template === 'approve-one' && data.approve_label ? data.approve_label : '';
          assert.equal(view.what, t(TASKS.lineKey({ ...task, label }), { label }), template);
          assert.equal(view.steps, null, `${template}: no steps that repeat the line`);
        }
        const bar = await footer(page);
        assert.equal(bar.quiet <= 2, true, `${template}: at most two quiet alternatives`);
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
           templates without an actor model keep the shell's generic label;
           the preview golden is mixed (you post X, the bot the rest) */
        const expected = template === '_starter' ? de.submit
          : template === 'approve-one' && data.approve_label ? data.approve_label
            : template === 'preview-post' ? t('submit_mixed')
              : template === 'decide-list' ? t('send_decisions') : t(key);
        if (template === 'preview-post') assert.ok(TASKS.allowed(want.kind, { verb: want.verb }).variants.includes('submit_mixed'));
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
          const userFooter = template === 'decide-list' && base === 'post_yourself' && bar.primary === t('footer_done');
          /* a list sends every decision at once, never a blanket approve */
          const listFooter = template === 'decide-list' && base === 'approve_bot_acts' && bar.primary === t('send_decisions');
          /* a mixed preview at rest plans both actors: the neutral send */
          const mixedFooter = template === 'preview-post' && base === 'approve_bot_acts' && bar.primary === t('submit_mixed');
          assert.ok(
            primaries.includes(bar.primary) || (base === 'pick' && bar.primary === t('po_choose_idle')) || userFooter || listFooter || mixedFooter,
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
      assert.equal(done.below, true);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('red only for blocking or a due date that is today or past', async () => {
    /* the test server pins Europe/Vienna (RS_TZ) */
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

  test('a long why keeps three sentences in view and folds the rest; a long template text stays in the body', async () => {
    await server.clearRuns();
    const data = fixture('decide-list', 'golden');
    data.intro = 'One. Two. Three. Four stays. Five too.';
    const long = show('decide-list', data);
    const opened = await openRun(long);
    try {
      const view = await banner(opened.page);
      assert.deepEqual([view.why, view.more, view.summaries], [null, null, 0]);
      assert.equal(await opened.page.textContent('[data-dl="intro"]'), data.intro, 'never folded away');
    } finally { await opened.ctx.close(); }
    await server.clearRuns();
    const why = 'Wir nehmen z. B. den Saal am Fluss.\nDer 1. Termin ist fix. Zwei. Drei folgt. Vier.';
    const folding = show('decide-list', fixture('decide-list', 'golden'), { task: { kind: 'approve_bot_acts', why } });
    const folded = await openRun(folding);
    try {
      const view = await banner(folded.page);
      assert.deepEqual([view.why, view.more, view.summaries, view.controls],
        ['Wir nehmen z. B. den Saal am Fluss.\nDer 1. Termin ist fix. Zwei.', 'Drei folgt. Vier.', 1, 0]);
      const lines = await folded.page.$eval('.rs-task__why', (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      assert.equal(lines, 2, 'the line break shows');
    } finally { await folded.ctx.close(); }
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

  test('a user action says Done, a send says Sent, and an explicit post says Posted', async () => {
    await server.clearRuns();
    const summary = 'Email the signed form back today.';
    const generic = show('approve-one', { summary, actor: 'user', allow_changes: true });
    const { ctx, page } = await openRun(generic);
    try {
      const view = await banner(page);
      assert.equal(view.what, t('task_line_do'));
      assert.equal(view.steps, null, 'the line and the Done button say it all');
      assert.equal(await page.textContent('#rs-status'), '', 'the buttons say it: no hint that repeats them');
      assert.equal(await page.textContent('#rs-submit-label'), t('done_mark'));
      const labels = await page.$$eval('#rs-submitbar .rs-btn--quiet', (buttons) => buttons.filter((b) => !b.hidden).map((b) => b.textContent));
      assert.deepEqual(labels, [t('skip'), t('request_changes')]);
      await page.locator('#rs-submitbar .rs-btn--quiet', { hasText: t('request_changes') }).click();
      assert.equal(await page.isDisabled('#rs-submit'), true, 'a change request still needs a comment');
      await page.fill('#ao-comment', 'Use the new address.');
      const table = TASKS.allowed('post_yourself', { verb: 'continue' });
      const texts = (keys) => keys.map((key) => t(key, { name: '' }).trim());
      const allowed = new Set([...texts(table.primary), ...texts(table.secondary), ...texts(table.items), ...texts(table.variants)]);
      assert.ok(allowed.has(await page.textContent('#rs-submit-label')), [...allowed].join(' | '));
      await page.click('#rs-submit');
      const deadline = Date.now() + 5000;
      while (!server.result(generic.run_id) && Date.now() < deadline) await sleep(20);
      assert.deepEqual(server.result(generic.run_id).data, { decision: 'request_changes', comment: 'Use the new address.' });
    } finally { await ctx.close(); }
    const sent = show('review-doc', { ...fixture('review-doc', 'golden'), actor: 'user', action: 'send' });
    const sentPage = await openRun(sent);
    try {
      assert.equal((await banner(sentPage.page)).what, t('task_line_send'));
      assert.equal(await sentPage.page.textContent('#rs-submit-label'), t('sent_mark'));
    } finally { await sentPage.ctx.close(); }
    const posted = show('approve-one', { summary, actor: 'user' }, { task: { kind: 'post_yourself' } });
    const postedPage = await openRun(posted);
    try {
      assert.equal((await banner(postedPage.page)).what, t('task_line_post_yourself'));
      assert.equal(await postedPage.page.textContent('#rs-submit-label'), t('posted'));
    } finally { await postedPage.ctx.close(); }
  });

  test('information only keeps one collapsed note and no second action', async () => {
    await server.clearRuns();
    const run = show('approve-one', { ...fixture('approve-one', 'golden'), actor: 'none' });
    const { ctx, page } = await openRun(run);
    try {
      const summary = page.locator('#rs-mount summary', { hasText: t('add_a_note') });
      assert.equal(await summary.count(), 1);
      assert.equal(await summary.evaluate((el) => el.parentElement.open), false);
      assert.equal(await page.locator('#rs-mount rs-action-row').count(), 0);
      assert.equal(await page.isHidden('#rs-discard'), true);
      await page.click('#rs-submit');
      const deadline = Date.now() + 5000;
      while (!server.result(run.run_id) && Date.now() < deadline) await sleep(20);
      assert.deepEqual(server.result(run.run_id).data, { decision: 'acknowledged', comment: '' });
    } finally { await ctx.close(); }
  });

  /* mixed reports: one banner line per actor, the person first, the bot by
     its display name; true in every state and once decided (en and de) */
  const mixedPost = fixture('preview-post', 'mixed-image');
  const reply = (id) => ({ id, title: `Reply ${id}`, actor: 'user', content: 'reply', url: `https://example.com/post/${id}` });
  const mixedList = {
    action: 'send',
    items: [reply('ferry'), reply('market'),
      { id: 'flour', title: 'Pay the flour invoice', actor: 'bot' },
      { id: 'power', title: 'Pay the power bill', actor: 'bot' },
      { id: 'boxes', title: 'Pay for the boxes', actor: 'bot' }],
  };
  const decided = (page) => page.waitForFunction(() => document.getElementById('rs-task').getAttribute('data-state') === 'decided');

  for (const lang of ['de', 'en']) {
    const tl = lang === 'en' ? tIn(en) : t;
    const on = () => (lang === 'en' ? serverEn : server);

    test(`${lang}: a mixed preview names you first and the bot by name, in every tick state and once decided`, async () => {
      const srv = on();
      await srv.clearRuns();
      const bot = 'Research Agent';
      const run = srv.show(mixedPost, { template: 'preview-post', version: 1, title: 'Bread course', bot: 'research-agent', identity: { name: bot } });
      const { ctx, page, errors } = await open(`&run=${run.run_id}`, { server: srv, viewport: { width: 864, height: 836 } });
      const lines = async () => (await banner(page)).actors;
      const you = tl('task_you_post', { names: 'X' });
      const botPosts = tl('task_bot_post', { bot, names: 'LinkedIn' });
      const steps = (segments, tail, button) => [
        ...segments.map(([key, names]) => tl(key, { names })), tl(tail, { button: tl(button) }),
      ].join(' · ');
      const bar = () => page.evaluate(() => ({
        label: document.getElementById('rs-submit-label').textContent,
        disabled: document.getElementById('rs-submit').disabled,
        status: document.getElementById('rs-status').textContent,
      }));
      try {
        assert.deepEqual(await lines(), [['user', you], ['bot', botPosts]], 'initial');
        assert.equal((await banner(page)).steps,
          steps([['task_step_auto', 'LinkedIn'], ['task_step_manual', 'X']], 'task_steps_tail_then', 'submit_mixed'), 'initial');
        assert.deepEqual(await bar(), { label: tl('submit_mixed'), disabled: true, status: tl('select_platform_manual') }, 'initial');
        const stepsRows = await page.$eval('.rs-task__steps', (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
        assert.equal(stepsRows, 1, 'the two-platform steps stay on one line inside the measure');
        await assertReading(page);

        await page.check('#approve-linkedin');
        assert.deepEqual(await lines(), [
          ['user', tl('task_unticked', { line: tl('task_you_none_post'), names: 'X' })], ['bot', botPosts],
        ], 'only LinkedIn');
        assert.equal((await banner(page)).steps, steps([['task_step_manual', 'X']], 'task_steps_tail_or', 'approve_post'), 'only LinkedIn');
        assert.deepEqual(await bar(), { label: tl('approve_post'), disabled: false, status: tl('mixed_approved_count', { n: 1 }) }, 'only LinkedIn');

        await page.uncheck('#approve-linkedin');
        await page.click('#tab-x');
        /* the X tab: the copies (text, hashtags, image) and the Posted ✓ tick; the folder is in the menu */
        const side = await page.$$eval('#panel-x .pp__side button, #panel-x .pp__side input', (els) => els.map((e) => e.id || e.closest('[data-copy-id]')?.dataset.copyId));
        assert.deepEqual(side, ['x-text', 'x-hashtags', 'x-image', 'approve-x']);
        assert.equal(await page.textContent('#panel-x [data-pp="approve-label"]'), tl('posted'));
        assert.equal(await page.textContent('#panel-x [data-pp="manual-note"]'), tl('manual_note'));
        await page.check('#approve-x');
        assert.deepEqual(await lines(), [
          ['user', you], ['bot', tl('task_unticked', { line: tl('task_bot_none_post', { bot }), names: 'LinkedIn' })],
        ], 'only X');
        assert.equal((await banner(page)).steps, steps([['task_step_auto', 'LinkedIn']], 'task_steps_tail_or', 'posted'), 'only X');
        assert.deepEqual(await bar(), { label: tl('posted'), disabled: false, status: tl('mixed_posted_count', { n: 1 }) }, 'only X');

        await page.click('#tab-linkedin');
        await page.check('#approve-linkedin');
        assert.deepEqual(await lines(), [['user', you], ['bot', botPosts]], 'both');
        assert.equal((await banner(page)).steps, steps([], 'task_steps_tail_now', 'submit_mixed'), 'both');
        assert.deepEqual(await bar(), {
          label: tl('submit_mixed'), disabled: false,
          status: `${tl('mixed_approved_count', { n: 1 })} · ${tl('mixed_posted_count', { n: 1 })}`,
        }, 'both');

        await page.click('#rs-submit');
        await decided(page);
        assert.deepEqual(srv.result(run.run_id).data, {
          decision: 'approve', platforms: ['linkedin'], comment: '',
          per_platform: { linkedin: { mode: 'auto', decision: 'approved' }, x: { mode: 'manual', decision: 'done' } },
        }, 'the result is unchanged by the label');
        const done = [['user', tl('task_you_post_done', { names: 'X' })], ['bot', tl('task_bot_post_done', { bot, names: 'LinkedIn' })]];
        assert.deepEqual(await lines(), done, 'decided');
        await page.reload();
        await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
        await decided(page);
        assert.deepEqual(await lines(), done, 'decided, reloaded');
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });

    test(`${lang}: a mixed preview that asks for changes says nobody posts`, async () => {
      const srv = on();
      await srv.clearRuns();
      const bot = 'Research Agent';
      const run = srv.show(mixedPost, { template: 'preview-post', version: 1, title: 'Bread course', bot: 'research-agent', identity: { name: bot } });
      const { ctx, page, errors } = await open(`&run=${run.run_id}`, { server: srv });
      try {
        await page.click('#rs-alt');
        await page.fill('#pp-comment', 'Use the new date.');
        assert.deepEqual((await banner(page)).actors, [['user', tl('task_you_changes')], ['bot', tl('task_bot_none_post', { bot })]]);
        assert.equal((await banner(page)).steps, tl('task_steps_changes', { button: tl('send_request') }));
        await assertReading(page);
        await page.click('#rs-submit');
        await decided(page);
        assert.deepEqual((await banner(page)).actors, [['user', tl('task_you_changes_done')], ['bot', tl('task_bot_none_post', { bot })]]);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });

    test(`${lang}: a mixed decide-list counts what you post and what the bot sends, as you decide and once decided`, async () => {
      const srv = on();
      await srv.clearRuns();
      /* no identity in the payload: the name comes from the shipped registry */
      const bot = 'Inbox Agent';
      const run = srv.show(mixedList, { template: 'decide-list', version: 1, title: 'Replies and invoices', bot: 'inbox-agent' });
      const { ctx, page, errors } = await open(`&run=${run.run_id}`, { server: srv, viewport: { width: 864, height: 836 } });
      const lines = async () => (await banner(page)).actors;
      const pick = (value) => page.click(`[data-rs-item][data-current] rs-action-row button[value="${value}"]`);
      try {
        assert.deepEqual(await lines(), [
          ['user', tl('task_you_post', { names: tl('task_noun_reply', { n: 2 }) })],
          ['bot', tl('task_bot_send', { bot, names: tl('task_noun_item', { n: 3 }) })],
        ], 'initial');
        assert.equal((await banner(page)).steps, tl('task_steps_mixed_items', { button: tl('send_decisions') }));
        assert.equal(await page.textContent('#rs-submit-label'), tl('send_decisions'));
        await pick('done');
        await pick('skipped');
        assert.deepEqual(await lines(), [
          ['user', tl('task_you_post', { names: tl('task_noun_reply_one') })],
          ['bot', tl('task_bot_send', { bot, names: tl('task_noun_item', { n: 3 }) })],
        ], 'one reply skipped');
        await pick('reject');
        await pick('reject');
        await pick('reject');
        assert.deepEqual(await lines(), [
          ['user', tl('task_you_post', { names: tl('task_noun_reply_one') })],
          ['bot', tl('task_bot_none_send', { bot })],
        ], 'every bot item rejected');
        assert.equal((await banner(page)).steps, tl('task_steps_mixed_items', { button: tl('send_decisions') }));
        await page.click('[data-item-id="flour"] .dl-row');
        await pick('approve');
        assert.deepEqual((await lines())[1], ['bot', tl('task_bot_send', { bot, names: tl('task_noun_item_one') })], 'one approved');
        await page.click('#rs-submit');
        await decided(page);
        assert.deepEqual(await lines(), [
          ['user', tl('task_you_post_done', { names: tl('task_noun_reply_one') })],
          ['bot', tl('task_bot_send_done', { bot, names: tl('task_noun_item_one') })],
        ], 'decided');
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });

    test(`${lang}: an explicit steps line stays while actor lines and the footer update`, async () => {
      const srv = on();
      const bot = 'Research Agent';
      const previewSteps = lang === 'de'
        ? 'Vor Freigabe die Kurstermine mit dem Besitzer absprechen.'
        : 'Confirm the workshop dates with the owner before approving.';
      const listSteps = lang === 'de'
        ? 'Vor Freigabe die Rechnungssummen mit der Buchhaltung abgleichen.'
        : 'Confirm the invoice totals with accounting before approving.';
      await srv.clearRuns();
      const preview = srv.show(mixedPost, {
        template: 'preview-post', version: 1, title: 'Bread course',
        bot: 'research-agent', identity: { name: bot },
        task: { kind: 'approve_bot_acts', steps: previewSteps },
      });
      const opened = await open(`&run=${preview.run_id}`, { server: srv, viewport: { width: 864, height: 836 } });
      try {
        assert.equal((await banner(opened.page)).steps, previewSteps, 'preview initial');
        await opened.page.check('#approve-linkedin');
        const ticked = await banner(opened.page);
        assert.equal(ticked.steps, previewSteps, 'preview ticked');
        assert.equal(ticked.actors[1][1], tl('task_bot_post', { bot, names: 'LinkedIn' }));
        assert.equal(await opened.page.textContent('#rs-submit-label'), tl('approve_post'));
        await opened.page.click('#rs-alt');
        await opened.page.fill('#pp-comment', 'Use the new date.');
        const changes = await banner(opened.page);
        assert.equal(changes.steps, previewSteps, 'preview changes');
        assert.equal(changes.actors[0][1], tl('task_you_changes'));
        await opened.page.reload();
        await opened.page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
        const reloaded = await banner(opened.page);
        assert.equal(reloaded.steps, previewSteps, 'preview reloaded');
        assert.equal(reloaded.actors[0][1], tl('task_you_changes'));
        assert.deepEqual(opened.errors, []);
      } finally { await opened.ctx.close(); }

      const list = srv.show(mixedList, {
        template: 'decide-list', version: 1, title: 'Replies and invoices', bot: 'inbox-agent',
        task: { kind: 'approve_bot_acts', steps: listSteps },
      });
      const listed = await open(`&run=${list.run_id}`, { server: srv });
      try {
        assert.equal((await banner(listed.page)).steps, listSteps, 'list initial');
        await listed.page.click('[data-rs-item][data-current] rs-action-row button[value="done"]');
        await listed.page.click('[data-rs-item][data-current] rs-action-row button[value="skipped"]');
        const chosen = await banner(listed.page);
        assert.equal(chosen.steps, listSteps, 'list chosen');
        assert.equal(chosen.actors[0][1], tl('task_you_post', { names: tl('task_noun_reply_one') }));
        assert.equal(await listed.page.textContent('#rs-submit-label'), tl('send_decisions'));
        await listed.page.reload();
        await listed.page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
        assert.equal((await banner(listed.page)).steps, listSteps, 'list reloaded');
        assert.equal((await banner(listed.page)).actors[0][1], tl('task_you_post', { names: tl('task_noun_reply_one') }));
        assert.deepEqual(listed.errors, []);
      } finally { await listed.ctx.close(); }
    });

    test(`${lang}: a blocked platform is left out of the initial plan`, async () => {
      const srv = on();
      const bot = 'Research Agent';
      const meta = { template: 'preview-post', version: 1, title: 'Bread course', bot: 'research-agent', identity: { name: bot } };
      await srv.clearRuns();
      const missing = srv.show({
        author: mixedPost.author, text: mixedPost.text, hashtags: mixedPost.hashtags,
        platforms: [
          { platform: 'x', mode: 'manual' },
          { platform: 'linkedin', mode: 'auto' },
          { platform: 'instagram', mode: 'auto' },
        ],
      }, meta);
      const noImage = await open(`&run=${missing.run_id}`, { server: srv, viewport: { width: 864, height: 836 } });
      try {
        const view = await banner(noImage.page);
        const planned = view.actors.map((entry) => entry[1]).join(' | ');
        assert.equal(planned.includes('Instagram'), false, planned);
        assert.match(planned, /X/);
        assert.match(planned, /LinkedIn/);
        assert.equal(view.steps.includes('Instagram'), false, view.steps);
        assert.equal(await noImage.page.textContent('#rs-submit-label'), tl('submit_mixed'));
        assert.deepEqual(noImage.errors, []);
      } finally { await noImage.ctx.close(); }

      /* X (auto) is past the long-post limit; a manual platform is never blocked */
      const limitData = fixture('preview-post', 'edge-x-limit');
      limitData.platforms = [{ platform: 'x', mode: 'auto' }, { platform: 'linkedin', mode: 'manual' }];
      const limited = srv.show(limitData, meta);
      const over = await open(`&run=${limited.run_id}`, { server: srv });
      try {
        const view = await banner(over.page);
        assert.match(view.actors[0][1], /LinkedIn/);
        assert.equal(`${view.actors[0][1]} ${view.actors[1][1]} ${view.steps}`.includes('X'), false);
        assert.equal(await over.page.textContent('#rs-submit-label'), tl('posted'));
        assert.deepEqual(over.errors, []);
      } finally { await over.ctx.close(); }
    });

    test(`${lang}: a longer mixed steps list wraps inside the reading measure`, async () => {
      const srv = on();
      await srv.clearRuns();
      const run = srv.show(fixture('preview-post', 'golden'), {
        template: 'preview-post', version: 1, title: 'Autumn menu',
        bot: 'research-agent', identity: { name: 'Research Agent' },
      });
      const { ctx, page, errors } = await open(`&run=${run.run_id}`, { server: srv, viewport: { width: 864, height: 836 } });
      try {
        const fit = await page.$eval('.rs-task__steps', (el) => {
          const style = getComputedStyle(el);
          return {
            rows: Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight)),
            overflow: el.scrollWidth - el.clientWidth,
          };
        });
        assert.ok(fit.overflow <= 1, JSON.stringify(fit));
        if (lang === 'de') assert.ok(fit.rows >= 2, `the longer German list wraps (${JSON.stringify(fit)})`);
        await assertReading(page);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });

    test(`${lang}: a user send hint names Sent, and Send request stays in the user table`, async () => {
      const srv = on();
      await srv.clearRuns();
      const summary = lang === 'de' ? 'Schick das Formular an die Werkstatt.' : 'Send the form to the workshop.';
      const sent = srv.show({ summary, actor: 'user', action: 'send' }, {
        template: 'approve-one', version: 1, title: 'Send the form',
      });
      const sentPage = await open(`&run=${sent.run_id}`, { server: srv });
      try {
        assert.equal(await sentPage.page.textContent('#rs-status'), '');
        assert.equal(await sentPage.page.textContent('#rs-submit-label'), tl('sent_mark'));
        assert.equal(await sentPage.page.textContent('#rs-alt'), tl('skip'));
        assert.deepEqual(sentPage.errors, []);
      } finally { await sentPage.ctx.close(); }

      const changes = srv.show({ summary, actor: 'user', allow_changes: true }, {
        template: 'approve-one', version: 1, title: 'Correct the form',
      });
      const changesPage = await open(`&run=${changes.run_id}`, { server: srv });
      try {
        await changesPage.page.locator('#rs-submitbar .rs-btn--quiet', { hasText: tl('request_changes') }).click();
        assert.equal(await changesPage.page.isDisabled('#rs-submit'), true);
        await changesPage.page.fill('#ao-comment', 'Use the new address.');
        const table = TASKS.allowed('post_yourself', { verb: 'continue' });
        const texts = (keys) => keys.map((key) => tl(key, { name: '' }).trim());
        const allowed = new Set([...texts(table.primary), ...texts(table.secondary), ...texts(table.items), ...texts(table.variants)]);
        assert.ok(allowed.has(await changesPage.page.textContent('#rs-submit-label')), [...allowed].join(' | '));
        await changesPage.page.click('#rs-submit');
        const deadline = Date.now() + 5000;
        while (!srv.result(changes.run_id) && Date.now() < deadline) await sleep(20);
        assert.deepEqual(srv.result(changes.run_id).data, { decision: 'request_changes', comment: 'Use the new address.' });
        assert.deepEqual(changesPage.errors, []);
      } finally { await changesPage.ctx.close(); }
    });

    test(`${lang}: an information note survives reload and switching runs`, async () => {
      const srv = on();
      const note = 'Please keep the old backup too.';
      await srv.clearRuns();
      const run = srv.show(
        { actor: 'none', summary: lang === 'de' ? 'Das Backup ist fertig.' : 'The backup is complete.' },
        { template: 'approve-one', version: 1, title: 'Read the backup report', bot: 'research-agent', identity: { name: 'Research Agent' } },
      );
      const other = srv.show(fixture('pick-option', 'golden'), {
        template: 'pick-option', version: 1, title: 'Venue', bot: 'inbox-agent', identity: { name: 'Inbox Agent' },
      });
      const { ctx, page, errors } = await open(`&run=${run.run_id}`, { server: srv });
      try {
        await page.click('#rs-mount summary');
        await page.fill('#ao-comment', note);
        await page.reload();
        await page.waitForFunction(() => document.documentElement.dataset.rsReady === '1');
        assert.equal(await page.inputValue('#ao-comment'), note, 'reload');
        await page.click(`.rs-strip__run[data-run-id="${other.run_id}"]`);
        await page.waitForFunction((id) => new URL(location.href).searchParams.get('run') === id, other.run_id);
        await page.click(`.rs-strip__run[data-run-id="${run.run_id}"]`);
        await page.waitForFunction((id) => new URL(location.href).searchParams.get('run') === id, run.run_id);
        assert.equal(await page.inputValue('#ao-comment'), note, 'switched back');
        await page.click('#rs-submit');
        const deadline = Date.now() + 5000;
        while (!srv.result(run.run_id) && Date.now() < deadline) await sleep(20);
        assert.deepEqual(srv.result(run.run_id).data, { decision: 'acknowledged', comment: note });
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });
  }

  test('an extended due stays urgent in the browser; a basic timestamp is rejected', async () => {
    await server.clearRuns();
    const data = { summary: 'The ferry invoice is due.' };
    const run = show('approve-one', data, { task: { kind: 'approve_bot_acts', due: '2020-01-15T15:00:00+01:00' } });
    const { ctx, page } = await openRun(run);
    try {
      const view = await banner(page);
      assert.equal(view.tone, 'urgent');
      assert.ok(view.meta && view.meta.length > 0, 'the due text is on the banner');
    } finally { await ctx.close(); }
    assert.throws(
      () => show('approve-one', data, { task: { kind: 'approve_bot_acts', due: '20201015T15:00:00+01:00' } }),
      /due|show failed/u,
    );
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
