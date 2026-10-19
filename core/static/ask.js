/* grokbot-desk: what a report asks for, as the footer and the banner say it.
 *
 * One table, the decision contract of payload@2 (one row per ask and input
 * block; core/payload.py decisions() is the server side of the same table):
 *
 *   read                    Got it                    -                       read
 *   review                  Looks good                Request changes         accept revise
 *   approve (action)        Approve & <action>/label  Reject, Request changes approve reject revise
 *   approve + decide        Send decisions            Request changes         submit revise
 *   approve + post (auto)   handle's label            Reject, Request changes approve reject revise
 *   do                      Done/Sent/Posted ✓        Skip, Request changes   done skipped revise
 *   do + decide             Done                      Request changes         submit revise
 *   do + post (manual)      Posted ✓                  Request changes         submit revise
 *   choose + pick           handle's label            None of these           choose revise
 *
 * Request changes and None of these switch the footer to a mode where the
 * composer note is required and the primary sends revise; Cancel returns.
 * Reject and Skip send at once. An input block reports through its handle:
 * {answer() -> object|null, progress() -> {done, total}, primaryLabel(),
 * hint?() -> {key, vars}|null}; a hint replaces the progress status while
 * the answer is incomplete (e.g. every post platform left out: the status
 * points to Request changes or Reject, so the footer never deadlocks).
 *
 * UMD: window.RSAsk in the page, module.exports in Node. Strings come from
 * use({t, date, zone}); rs.js sets them before the first render.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.RSAsk = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var env = {
    t: function (key) { return key; },
    date: function (iso) { return String(iso); },
    zone: undefined
  };
  var dayFmt = null;
  var clockFmt = null;

  function use(options) {
    Object.keys(options || {}).forEach(function (key) { env[key] = options[key]; });
    dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: env.zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    clockFmt = new Intl.DateTimeFormat('de-DE', { timeZone: env.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  function t(key, params) { return env.t(key, params); }

  var INPUT_TYPES = { decide: true, pick: true, post: true };
  var APPROVE = { post: 'ask_approve_post', send: 'ask_approve_send' };
  var MARK = { send: 'ask_sent', post: 'ask_posted' };
  var NAME_MAX = 24;

  function has(table, key) { return Object.prototype.hasOwnProperty.call(table, key); }

  /** The input block of a report: {id, type, block}, or null. */
  function inputOf(run) {
    var blocks = run && Array.isArray(run.blocks) ? run.blocks : [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block && has(INPUT_TYPES, block.type)) {
        return { id: typeof block.id === 'string' && block.id ? block.id : 'b' + i, type: block.type, block: block };
      }
    }
    return null;
  }

  /** The bot by its display name while it is one (not the bare id, at most 24 characters). */
  function botName(run) {
    if (!run) return '';
    var id = run.identity && typeof run.identity.name === 'string' && run.identity.name ? run.identity.name : run.bot_display || '';
    return id && id !== run.bot && Array.from(id).length <= NAME_MAX ? id : '';
  }
  function botOrDefault(run) { return botName(run) || t('task_the_bot'); }

  /* what the bot does once approved: the action, or posting for a post block */
  function verbOf(run) {
    if (run && (run.action === 'post' || run.action === 'send')) return run.action;
    var kind = inputOf(run);
    return kind && kind.type === 'post' ? 'post' : 'continue';
  }

  function requestAlt() { return { label: t('ask_request_changes'), decision: null, needsNote: false, mode: 'request' }; }
  function cancelAlt() { return { label: t('cancel'), decision: null, needsNote: false, mode: 'decide' }; }

  /* the primary and quiet alternatives of the decide mode */
  function decideRow(run, input, kind) {
    var ask = run.ask;
    if (!kind) {
      if (ask === 'read') return { primary: { key: 'ask_got_it', decision: 'read' }, alts: [] };
      if (ask === 'review') return { primary: { key: 'ask_looks_good', decision: 'accept' }, alts: [requestAlt()] };
      if (ask === 'approve') {
        var own = typeof run.label === 'string' && run.label ? run.label : null;
        return {
          primary: { key: has(APPROVE, run.action) ? APPROVE[run.action] : 'ask_approve_continue', text: own, decision: 'approve' },
          alts: [{ label: t('ask_reject'), decision: 'reject', needsNote: false }, requestAlt()]
        };
      }
      if (ask === 'do') {
        return {
          primary: { key: has(MARK, run.action) ? MARK[run.action] : 'ask_done', decision: 'done' },
          alts: [{ label: t('ask_skip'), decision: 'skipped', needsNote: false }, requestAlt()]
        };
      }
      return null;
    }
    var label = input && typeof input.primaryLabel === 'function' ? input.primaryLabel() : null;
    if (kind.type === 'decide') {
      return { primary: { key: ask === 'do' ? 'ask_done_items' : 'ask_send_decisions', decision: 'submit', answers: true }, alts: [requestAlt()] };
    }
    if (kind.type === 'post' && ask === 'approve') {
      return {
        primary: { key: 'ask_approve_post', text: label, decision: 'approve', answers: true },
        alts: [{ label: t('ask_reject'), decision: 'reject', needsNote: false }, requestAlt()]
      };
    }
    if (kind.type === 'post') return { primary: { key: 'ask_posted', decision: 'submit', answers: true }, alts: [requestAlt()] };
    if (kind.type === 'pick') {
      var alts = kind.block.allow_none === false ? [] : [{ label: t('ask_none_of_these'), decision: null, needsNote: false, mode: 'none-of-these' }];
      return { primary: { key: 'ask_choose', text: label, decision: 'choose', answers: true }, alts: alts };
    }
    return null;
  }

  /** The footer in a mode (decide | request | none-of-these):
      {status, primary: {label, decision, enabled, needsNote, answers}, alts:
      [{label, decision, needsNote, mode?}]}. An alternative with a mode
      switches the footer; one with a decision sends it at once.
      opts.note: the composer holds text. */
  function footer(run, input, mode, opts) {
    opts = opts || {};
    var kind = inputOf(run);
    var row = decideRow(run, input, kind);
    if (!row) row = { primary: { key: 'ask_got_it', decision: 'read' }, alts: [] };
    var canRequest = row.alts.some(function (alt) { return alt.mode === mode; });
    if ((mode === 'request' || mode === 'none-of-these') && canRequest) {
      var none = mode === 'none-of-these';
      return {
        status: opts.note ? '' : t(none ? 'ask_none_hint' : 'ask_request_hint'),
        primary: { label: t(none ? 'ask_send_none' : 'ask_send_request'), decision: 'revise', enabled: !!opts.note, needsNote: true, answers: false },
        alts: [cancelAlt()]
      };
    }
    var status = '';
    var enabled = true;
    if (kind) {
      var answer = input && typeof input.answer === 'function' ? input.answer() : null;
      enabled = answer !== null && answer !== undefined;
      if (!enabled) {
        var progress = input && typeof input.progress === 'function' ? input.progress() : null;
        /* the block may know why nothing can be approved (every platform
           left out or unpostable): its hint names the way out */
        var hint = input && typeof input.hint === 'function' ? input.hint() : null;
        if (hint && typeof hint.key === 'string') status = t(hint.key, hint.vars || {});
        else if (kind.type === 'pick') status = t('ask_pick_hint');
        else if (progress && progress.total) status = t('ask_progress', { done: progress.done, total: progress.total });
      }
    }
    var p = row.primary;
    return {
      status: status,
      primary: {
        label: p.text || t(p.key),
        decision: p.decision,
        enabled: enabled,
        needsNote: false,
        answers: !!p.answers
      },
      alts: row.alts
    };
  }

  /** Discard (the "…" menu) exists on every report that asks for something. */
  function discard(run) { return !!run && run.ask !== 'read'; }

  /* "due today 15:00", "due Oct 15 15:00", "overdue since 09:00"; urgent
     when the day is today (local time) or the moment has passed */
  function dueInfo(due, now) {
    if (typeof due !== 'string' || !due) return null;
    if (!dayFmt) use({});
    var dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due);
    var moment = new Date(dateOnly ? due + 'T12:00:00Z' : due);
    if (isNaN(moment.getTime())) return null;
    var today = dayFmt.format(now);
    var day = dateOnly ? due : dayFmt.format(moment);
    var clock = dateOnly ? '' : clockFmt.format(moment);
    var past = dateOnly ? day < today : moment.getTime() < now.getTime();
    var text;
    if (past) text = t('task_overdue', { when: [day === today ? '' : env.date(day), clock].filter(Boolean).join(' ') });
    else if (day === today) text = clock ? t('task_due_today', { time: clock }) : t('task_due_today_date');
    else text = clock ? t('task_due_on', { date: env.date(day), time: clock }) : t('due', { date: env.date(day) });
    return { text: text, urgent: past || day === today };
  }

  var TONES = { read: 'read', review: 'approve', approve: 'approve', choose: 'approve', 'do': 'do' };

  /* the banner's task line while the report is open */
  function lineOf(run) {
    var kind = inputOf(run);
    var bot = botOrDefault(run);
    var verb = verbOf(run);
    switch (run.ask) {
      case 'read': return t('ask_line_read');
      case 'review': return t('ask_line_review');
      case 'choose': return t('ask_line_choose');
      case 'do':
        if (kind && kind.type === 'decide') return t('ask_line_do_items');
        return t(run.action === 'send' ? 'ask_line_do_send' : run.action === 'post' || (kind && kind.type === 'post') ? 'ask_line_do_post' : 'ask_line_do');
      case 'approve':
        if (kind && kind.type === 'decide') return t('ask_line_decide', { bot: bot });
        if (kind && kind.type === 'post') return t('ask_line_approve_post', { bot: bot });
        if (typeof run.label === 'string' && run.label) return t('ask_line_label_' + verb, { label: run.label, bot: bot });
        return t('ask_line_approve_' + verb, { bot: bot });
      default: return '';
    }
  }

  /** The open report's banner: {tone: approve|do|read|urgent, lines:
      [task line, then meta: urgent, due]}. */
  function banner(run, now) {
    var due = dueInfo(run && run.due, now || new Date());
    var urgent = !!(run && run.urgent) || !!(due && due.urgent);
    var lines = [lineOf(run)];
    if (run && run.urgent) lines.push(t('ask_urgent'));
    if (due) lines.push(due.text);
    return { tone: urgent ? 'urgent' : (has(TONES, run && run.ask) ? TONES[run.ask] : 'read'), lines: lines };
  }

  /** The overview's word for a waiting report, and its tone. */
  function kindOf(run, now) {
    return { text: t('ask_kind_' + (has(TONES, run && run.ask) ? run.ask : 'read')), tone: banner(run, now).tone };
  }

  var DONE = {
    read: 'ask_done_read', accept: 'ask_done_accept', revise: 'ask_done_revise', reject: 'ask_done_reject',
    skipped: 'ask_done_skipped', submit: 'ask_done_submit', choose: 'ask_done_choose'
  };

  /** What happened, once the report is decided (the banner's line). */
  function decidedLine(run, result) {
    var bot = botOrDefault(run);
    if (run.state === 'cancelled' || run.state === 'expired') return t('ask_done_' + run.state, { bot: bot });
    var decision = result && typeof result.decision === 'string' ? result.decision : null;
    if (!decision) return t('ask_done_unknown', { bot: bot });
    if (decision === 'approve') return t('ask_done_approve_' + verbOf(run), { bot: bot });
    if (decision === 'done') return t(run.action === 'send' ? 'ask_done_sent' : run.action === 'post' ? 'ask_done_posted' : 'ask_done_done', { bot: bot });
    if (decision === 'revise' && run.ask === 'choose') return t('ask_done_none', { bot: bot });
    return has(DONE, decision) ? t(DONE[decision], { bot: bot }) : t('ask_done_unknown', { bot: bot });
  }

  return {
    use: use,
    inputOf: inputOf,
    botName: botName,
    footer: footer,
    discard: discard,
    banner: banner,
    kindOf: kindOf,
    decidedLine: decidedLine,
    dueInfo: dueInfo
  };
});
