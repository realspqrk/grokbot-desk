/* grokbot-desk: the task a report asks for, and the buttons that say who
 * acts next. One table for the shell's task banner and for every built-in's
 * footer and per-item controls. Values are i18n keys.
 * UMD: in the browser it sets window.RS_TASKS; in Node it is module.exports
 * (load it with createRequire). The kinds and their derivation from template
 * and actor live in core/tasks.py; the page receives the derived task.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.RS_TASKS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = ['post_yourself', 'approve_bot_acts', 'pick', 'fyi', 'review', 'blocking'];
  var APPROVE = { post: 'approve_post', send: 'approve_send', 'continue': 'approve_continue' };

  /* Per kind: the decision value of the main path (`primary`), the label of
     each decision value in the footer, the quiet footer alternatives, the
     per-item choices (decide-list), whether Discard is offered, and the
     honest labels a primary may switch to for the state it would send
     (e.g. "Send request" once Request changes is chosen). */
  var CTA = {
    post_yourself: {
      primary: 'done',
      labels: { done: 'posted', skipped: 'skip', later: 'later' },
      secondary: ['skipped'],
      items: { done: 'posted', skipped: 'skip', later: 'later' },
      discard: true,
      variants: ['footer_done']
    },
    approve_bot_acts: {
      primary: 'approve',
      labels: { approve: null, reject: 'choice_reject', request_changes: 'request_changes' },
      secondary: ['request_changes', 'reject'],
      items: { approve: 'choice_approve', reject: 'choice_reject', defer: 'choice_defer' },
      discard: true,
      variants: ['send_request', 'send_rejection', 'posted', 'submit']
    },
    pick: {
      primary: 'choose',
      labels: { choose: 'po_choose_idle' },
      secondary: [],
      items: {},
      discard: true,
      variants: ['po_choose']
    },
    fyi: {
      primary: 'acknowledged',
      labels: { acknowledged: 'got_it' },
      secondary: [],
      items: {},
      discard: false,
      variants: []
    },
    review: {
      primary: 'approve',
      labels: { approve: 'looks_good', request_changes: 'changes' },
      secondary: ['request_changes'],
      items: {},
      discard: true,
      variants: ['send_request']
    }
  };

  /* blocking is the underlying kind's controls, emphasised */
  function baseOf(task) {
    if (!task) return 'review';
    var kind = task.kind === 'blocking' ? task.base : task.kind;
    return Object.prototype.hasOwnProperty.call(CTA, kind) ? kind : 'review';
  }

  function approveKey(verb) {
    return Object.prototype.hasOwnProperty.call(APPROVE, verb) ? APPROVE[verb] : APPROVE['continue'];
  }

  /* the label key of a decision value; opts.item for a per-item choice,
     opts.verb for the bot's approve (post, send or continue) */
  function labelKey(kind, value, opts) {
    var row = CTA[kind] || CTA.review;
    opts = opts || {};
    var table = opts.item ? row.items : row.labels;
    if (!Object.prototype.hasOwnProperty.call(table, value)) return null;
    if (!opts.item && kind === 'approve_bot_acts' && value === 'approve') return approveKey(opts.verb);
    return table[value];
  }

  function primaryKey(kind, opts) {
    var row = CTA[kind] || CTA.review;
    return labelKey(kind, row.primary, opts);
  }

  /* every label key a kind may show: primary, alternatives, item choices and
     the state variants; tests compare rendered buttons with this */
  function allowed(kind, opts) {
    var row = CTA[kind] || CTA.review;
    var primary = kind === 'approve_bot_acts'
      ? Object.keys(APPROVE).map(function (verb) { return APPROVE[verb]; })
      : [primaryKey(kind, opts)];
    return {
      primary: primary,
      secondary: row.secondary.map(function (value) { return labelKey(kind, value, opts); }),
      items: Object.keys(row.items).map(function (value) { return row.items[value]; }),
      variants: row.variants.slice(),
      discard: row.discard
    };
  }

  /* banner copy, as i18n keys */
  function lineKey(task, state) {
    var base = baseOf(task);
    if (state === 'cancelled' || state === 'expired') return 'task_' + state;
    if (state === 'submitted') return 'task_done_' + base;
    if (task && task.kind === 'blocking') return 'task_line_blocking';
    if (base === 'approve_bot_acts') return 'task_line_approve_' + (APPROVE[task && task.verb] ? task.verb : 'continue');
    return 'task_line_' + base;
  }

  function stepsKey(task) { return 'task_steps_' + baseOf(task); }

  function kindKey(task) { return 'task_kind_' + (task && task.kind === 'blocking' ? 'blocking' : baseOf(task)); }

  return {
    KINDS: KINDS,
    CTA: CTA,
    baseOf: baseOf,
    labelKey: labelKey,
    primaryKey: primaryKey,
    allowed: allowed,
    lineKey: lineKey,
    stepsKey: stepsKey,
    kindKey: kindKey
  };
});
