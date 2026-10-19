// The decision contract of a report's footer (core/static/ask.js) without a
// browser: one row per ask (spec table "ask and the decision contract"),
// the request state, the input-block rows driven through the input handle,
// the banner tone and the decided line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const RSAsk = require('../core/static/ask.js');
const de = JSON.parse(readFileSync(new URL('../core/i18n/de.json', import.meta.url), 'utf8'));
const t = (key, vars = {}) => {
  assert.ok(Object.hasOwn(de, key), 'missing i18n key ' + key);
  return de[key].replace(/\{([a-z_]+)\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
};
RSAsk.use({ t, zone: 'Europe/Vienna', date: (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' });

const run = (ask, extra = {}) => ({ run_id: 'r', bot: 'b', bot_display: 'Office Bot', ask, blocks: [{ type: 'text', md: 'x' }], ...extra });
const shape = (f) => ({
  status: f.status,
  primary: [f.primary.label, f.primary.decision, f.primary.enabled],
  alts: f.alts.map((a) => [a.label, a.decision, a.mode || null]),
});

test('read: Got it sends read; no alternative', () => {
  assert.deepEqual(shape(RSAsk.footer(run('read'), null, 'decide')), {
    status: '', primary: [de.ask_got_it, 'read', true], alts: [],
  });
});

test('review: Looks good sends accept; Request changes enters the request state', () => {
  assert.deepEqual(shape(RSAsk.footer(run('review'), null, 'decide')), {
    status: '', primary: [de.ask_looks_good, 'accept', true], alts: [[de.ask_request_changes, null, 'request']],
  });
});

test('approve: the action names the primary; label overrides it; Reject sends at once', () => {
  const alts = [[de.ask_reject, 'reject', null], [de.ask_request_changes, null, 'request']];
  for (const [action, key] of [['post', 'ask_approve_post'], ['send', 'ask_approve_send'], ['deploy', 'ask_approve_continue']]) {
    assert.deepEqual(shape(RSAsk.footer(run('approve', { action }), null, 'decide')), {
      status: '', primary: [de[key], 'approve', true], alts,
    }, action);
  }
  assert.equal(RSAsk.footer(run('approve', { action: 'deploy', label: 'Deploy 4.2.0' }), null, 'decide').primary.label, 'Deploy 4.2.0');
});

test('do: Done, Sent or Posted by action; Skip sends at once', () => {
  const alts = [[de.ask_skip, 'skipped', null], [de.ask_request_changes, null, 'request']];
  for (const [action, key] of [[undefined, 'ask_done'], ['send', 'ask_sent'], ['post', 'ask_posted'], ['call', 'ask_done']]) {
    assert.deepEqual(shape(RSAsk.footer(run('do', { action }), null, 'decide')), {
      status: '', primary: [de[key], 'done', true], alts,
    }, String(action));
  }
  /* a payload label never renames a report-back */
  assert.equal(RSAsk.footer(run('do', { action: 'send', label: 'Go' }), null, 'decide').primary.label, de.ask_sent);
});

test('request state: Send request sends revise and needs a note; Cancel returns; never approve', () => {
  for (const r of [run('review'), run('approve', { action: 'post', label: 'Ship it' }), run('do', { action: 'send' })]) {
    const blank = RSAsk.footer(r, null, 'request', { note: false });
    assert.deepEqual(shape(blank), {
      status: de.ask_request_hint, primary: [de.ask_send_request, 'revise', false], alts: [[de.cancel, null, 'decide']],
    }, r.ask);
    assert.equal(blank.primary.needsNote, true);
    const written = RSAsk.footer(r, null, 'request', { note: true });
    assert.deepEqual([written.status, written.primary.enabled, written.primary.decision], ['', true, 'revise']);
  }
  /* read has no request state: the mode falls back to its one primary */
  assert.equal(RSAsk.footer(run('read'), null, 'request').primary.decision, 'read');
});

test('discard is offered on every ask but read', () => {
  assert.deepEqual(['read', 'review', 'approve', 'do', 'choose'].map((a) => RSAsk.discard(run(a))), [false, true, true, true, true]);
});

/* input rows through a fake handle (the shape Task 7's blocks return) */
function handle({ answer = null, done = 0, total = 2, label = null } = {}) {
  return {
    el: null,
    answer: () => answer,
    progress: () => ({ done, total }),
    primaryLabel: () => label,
    snapshot: () => ({}), restore() {}, lock() {},
  };
}
const withInput = (ask, block, extra = {}) => run(ask, { blocks: [{ type: 'stats', items: [] }, { id: 'in', ...block }], ...extra });

test('input rows: the primary waits for a complete answer; the status counts what is left', () => {
  const decide = withInput('approve', { type: 'decide', items: [] }, { action: 'post', label: 'Not used' });
  const open = RSAsk.footer(decide, handle({ done: 1, total: 2 }), 'decide');
  assert.deepEqual(shape(open), {
    status: t('ask_progress', { done: 1, total: 2 }),
    primary: [de.ask_send_decisions, 'submit', false],
    alts: [[de.ask_request_changes, null, 'request']],
  });
  assert.equal(open.primary.answers, true);
  const ready = RSAsk.footer(decide, handle({ answer: { items: [] }, done: 2, total: 2 }), 'decide');
  assert.deepEqual([ready.primary.enabled, ready.status], [true, '']);
  assert.equal(RSAsk.inputOf(decide).id, 'in');

  const doDecide = RSAsk.footer(withInput('do', { type: 'decide', items: [] }), handle({ answer: {} , done: 2, total: 2 }), 'decide');
  assert.deepEqual(shape(doDecide).primary, [de.ask_done_items, 'submit', true]);

  const auto = RSAsk.footer(withInput('approve', { type: 'post' }), handle({ answer: {}, label: 'Approve & post to X' }), 'decide');
  assert.deepEqual(shape(auto), {
    status: '', primary: ['Approve & post to X', 'approve', true],
    alts: [[de.ask_reject, 'reject', null], [de.ask_request_changes, null, 'request']],
  });
  const manual = RSAsk.footer(withInput('do', { type: 'post' }), handle({ answer: null, done: 0, total: 1 }), 'decide');
  assert.deepEqual(shape(manual).primary, [de.ask_posted, 'submit', false]);

  const pick = withInput('choose', { type: 'pick', options: [] });
  assert.deepEqual(shape(RSAsk.footer(pick, handle({ answer: null, done: 0, total: 1 }), 'decide')), {
    status: t('ask_pick_hint'), primary: [de.ask_choose, 'choose', false], alts: [[de.ask_none_of_these, null, 'none-of-these']],
  });
  assert.deepEqual(shape(RSAsk.footer(pick, handle({ answer: { choice: 'a' }, label: 'Choose Thursday' }), 'decide')).primary,
    ['Choose Thursday', 'choose', true]);
  const none = RSAsk.footer(pick, handle(), 'none-of-these', { note: false });
  assert.deepEqual(shape(none), {
    status: de.ask_none_hint, primary: [de.ask_send_none, 'revise', false], alts: [[de.cancel, null, 'decide']],
  });
  /* allow_none false: no way out but a pick */
  assert.deepEqual(RSAsk.footer(withInput('choose', { type: 'pick', allow_none: false }), handle(), 'decide').alts, []);
});

test('an input row without a handle yet keeps its primary disabled', () => {
  const f = RSAsk.footer(withInput('approve', { type: 'decide', items: [] }), null, 'decide');
  assert.deepEqual([f.primary.label, f.primary.enabled], [de.ask_send_decisions, false]);
});

test('banner tone by ask; urgent or due today or earlier turns it red', () => {
  const now = new Date('2026-10-19T10:00:00+02:00');
  const tone = (r) => RSAsk.banner(r, now).tone;
  assert.deepEqual(['read', 'review', 'approve', 'do', 'choose'].map((a) => tone(run(a, { action: 'post' }))),
    ['read', 'approve', 'approve', 'do', 'approve']);
  assert.equal(tone(run('read', { urgent: true })), 'urgent');
  assert.equal(tone(run('do', { due: '2026-10-19' })), 'urgent');
  assert.equal(tone(run('do', { due: '2026-10-18' })), 'urgent');
  assert.equal(tone(run('do', { due: '2026-10-19T09:00:00+02:00' })), 'urgent');
  assert.equal(tone(run('do', { due: '2026-10-20' })), 'do');
  const later = RSAsk.banner(run('approve', { action: 'send', due: '2099-03-04' }), now);
  assert.deepEqual(later.lines, [t('ask_line_approve_send', { bot: 'Office Bot' }), t('due', { date: '04.03.' })]);
  const today = RSAsk.banner(run('review', { due: '2026-10-19' }), now);
  assert.deepEqual(today.lines, [de.ask_line_review, de.task_due_today_date]);
  const urgent = RSAsk.banner(run('read', { urgent: true }), now);
  assert.deepEqual(urgent.lines, [de.ask_line_read, de.ask_urgent]);
  /* a bare bot id or a long name reads "the bot" */
  const anon = RSAsk.banner(run('approve', { action: 'post', bot_display: 'b' }), now);
  assert.equal(anon.lines[0], t('ask_line_approve_post', { bot: de.task_the_bot }));
  const labelled = RSAsk.banner(run('approve', { action: 'post', label: 'Ship it' }), now);
  assert.equal(labelled.lines[0], t('ask_line_label_post', { label: 'Ship it', bot: 'Office Bot' }));
});

test('decided line: what happened, by decision', () => {
  const line = (r, result, state = 'submitted') => RSAsk.decidedLine({ ...r, state }, result);
  assert.equal(line(run('read'), { decision: 'read' }), de.ask_done_read);
  assert.equal(line(run('review'), { decision: 'accept' }), t('ask_done_accept', { bot: 'Office Bot' }));
  assert.equal(line(run('review'), { decision: 'revise' }), t('ask_done_revise', { bot: 'Office Bot' }));
  assert.equal(line(run('approve', { action: 'send' }), { decision: 'approve' }), t('ask_done_approve_send', { bot: 'Office Bot' }));
  assert.equal(line(run('approve', { action: 'x' }), { decision: 'reject' }), t('ask_done_reject', { bot: 'Office Bot' }));
  assert.equal(line(run('do', { action: 'post' }), { decision: 'done' }), t('ask_done_posted'));
  assert.equal(line(run('do'), { decision: 'skipped' }), t('ask_done_skipped', { bot: 'Office Bot' }));
  assert.equal(line(withInput('approve', { type: 'decide', items: [] }), { decision: 'submit' }), t('ask_done_submit', { bot: 'Office Bot' }));
  assert.equal(line(withInput('choose', { type: 'pick' }), { decision: 'choose' }), t('ask_done_choose', { bot: 'Office Bot' }));
  assert.equal(line(withInput('choose', { type: 'pick' }), { decision: 'revise' }), t('ask_done_none', { bot: 'Office Bot' }));
  assert.equal(line(run('do'), null, 'cancelled'), t('ask_done_cancelled', { bot: 'Office Bot' }));
  assert.equal(line(run('do'), null, 'expired'), t('ask_done_expired', { bot: 'Office Bot' }));
  /* submitted, but the result is not known yet */
  assert.equal(line(run('do'), null), t('ask_done_unknown', { bot: 'Office Bot' }));
});
