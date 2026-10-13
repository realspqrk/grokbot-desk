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
      /* done reads Posted, Sent or Done from opts.mark; the map's posted
         value is the posting default. request_changes is the optional third
         choice when the payload allows it. */
      labels: { done: 'posted', skipped: 'skip', later: 'later', request_changes: 'request_changes' },
      secondary: ['skipped', 'request_changes'],
      items: { done: 'posted', skipped: 'skip', later: 'later' },
      discard: true,
      variants: ['footer_done', 'done_mark', 'sent_mark', 'request_changes', 'send_request', 'request_send', 'cancel']
    },
    approve_bot_acts: {
      primary: 'approve',
      labels: { approve: null, reject: 'choice_reject', request_changes: 'request_changes' },
      secondary: ['request_changes', 'reject'],
      items: { approve: 'choice_approve', reject: 'choice_reject', defer: 'choice_defer' },
      discard: true,
      variants: ['send_request', 'send_rejection', 'posted', 'submit', 'submit_mixed', 'request_send', 'cancel', 'send_decisions', 'send_decision_one']
    },
    pick: {
      primary: 'choose',
      /* request_changes is "None of these" (a required note, no pick) */
      labels: { choose: 'po_choose_idle', request_changes: 'po_none' },
      secondary: ['request_changes'],
      items: {},
      discard: true,
      variants: ['po_choose', 'request_send', 'cancel']
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
      labels: { approve: 'looks_good', request_changes: 'request_changes' },
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

  var MARK_DONE = { posted: 'posted', sent: 'sent_mark', done: 'done_mark' };

  /* the label key of a decision value.
     opts.item with opts.actor (and opts.content post|reply) for one decide-list
     item. opts.mark is posted, sent or done for a user action. opts.verb is
     the bot's approve (post, send or continue). */
  function labelKey(kind, value, opts) {
    var row = CTA[kind] || CTA.review;
    opts = opts || {};
    if (opts.item && opts.actor === 'user') {
      if (value === 'done') {
        if (opts.content === 'post' || opts.content === 'reply') return 'posted';
        return MARK_DONE[opts.mark] || 'done_mark';
      }
      if (value === 'skipped') return 'skip';
      if (value === 'later') return 'later';
      return null;
    }
    if (opts.item && opts.actor === 'bot') {
      var bot = CTA.approve_bot_acts.items;
      return Object.prototype.hasOwnProperty.call(bot, value) ? bot[value] : null;
    }
    var table = opts.item ? row.items : row.labels;
    if (!Object.prototype.hasOwnProperty.call(table, value)) return null;
    if (!opts.item && value === 'done' && (kind === 'post_yourself' || opts.mark)) {
      return MARK_DONE[opts.mark] || 'posted';
    }
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

  /* banner copy, as i18n keys. A user action that is not a post uses mark
     (done or sent) instead of the posting line. A mixed report has one line
     per actor (actorLines), open or decided; lineKey is null for that. A
     mixed preview's steps come from mixedSteps, not from stepsKey. */
  function lineKey(task, state) {
    var base = baseOf(task);
    if (state === 'cancelled' || state === 'expired') return 'task_' + state;
    if (task && task.parties && task.parties.length) return null;
    if (state === 'submitted') {
      if (task && task.mark === 'done') return 'task_done_do';
      if (task && task.mark === 'sent') return 'task_done_send';
      return 'task_done_' + base;
    }
    if (task && task.kind === 'blocking') return 'task_line_blocking';
    if (task && task.mark === 'done') return 'task_line_do';
    if (task && task.mark === 'sent') return 'task_line_send';
    if (base === 'approve_bot_acts') {
      var verb = APPROVE[task && task.verb] ? task.verb : 'continue';
      /* the payload's own approve label ({label}) leads the line */
      return (task && task.label ? 'task_line_label_' : 'task_line_approve_') + verb;
    }
    return 'task_line_' + base;
  }

  /* The default steps line, or null. Steps show only where they add what
     the task line and the buttons do not say: a list of replies, of other
     things the person does, or a mixed list, each to decide before the
     footer's {button}. A mixed preview's
     steps come from mixedSteps; a payload's task.steps always shows. */
  function stepsKey(task) {
    if (task && task.steps_for === 'replies') return 'task_steps_replies';
    if (task && task.steps_for === 'user_items') return 'task_steps_user_items';
    if (task && task.steps_for === 'mixed_items') return 'task_steps_mixed_items';
    return null;
  }

  function kindKey(task) {
    if (task && task.kind === 'blocking') return 'task_kind_blocking';
    if (task && task.mark === 'done') return 'task_kind_do';
    if (task && task.mark === 'sent') return 'task_kind_send';
    return 'task_kind_' + baseOf(task);
  }

  /* A mixed report (the person and the bot both act) gets one banner line
     per actor, the person first. parties are platforms ({id, role}) or items
     ({role, noun}); role manual, user_post or user is the person's, auto or
     bot the bot's. on: true (ticked, done, approved), false (left out:
     unticked, skipped, rejected, deferred), absent (not decided yet).
     Each line is {actor, key, names, dropped}: names are the parties the
     line lists, dropped the ones left out (while open). opts.verb is the
     bot's (post, send, continue); opts.decided switches to what happened;
     opts.changes means the person asked for changes, so nobody acts. */
  var PERSON_VERB = { manual: 'post', user_post: 'post', user: 'do' };
  var BOT_ROLES = { auto: true, bot: true };

  function actorLines(parties, opts) {
    opts = opts || {};
    var verb = Object.prototype.hasOwnProperty.call(APPROVE, opts.verb) ? opts.verb : 'continue';
    var past = opts.decided ? '_done' : '';
    var person = [];
    var bot = [];
    (parties || []).forEach(function (party) {
      if (!party) return;
      if (PERSON_VERB[party.role]) person.push(party);
      else if (BOT_ROLES[party.role]) bot.push(party);
    });
    function split(list) {
      if (opts.changes) return { names: [], dropped: [] };
      /* a blocked platform cannot be approved, so it is never planned and
         never described as merely unticked */
      var open = list.filter(function (party) { return !party.blocked; });
      return {
        names: open.filter(function (party) { return party.on !== false; }),
        dropped: opts.decided ? [] : open.filter(function (party) { return party.on === false; })
      };
    }
    var lines = [];
    if (person.length) {
      var doing = person.every(function (party) { return PERSON_VERB[party.role] === 'post'; }) ? 'post' : 'do';
      var mine = split(person);
      var key = opts.changes ? 'task_you_changes' + past
        : mine.names.length ? 'task_you_' + doing + past : 'task_you_none_' + doing + past;
      lines.push({ actor: 'user', key: key, names: mine.names, dropped: mine.dropped });
    }
    if (bot.length) {
      var theirs = split(bot);
      lines.push({
        actor: 'bot',
        key: theirs.names.length ? 'task_bot_' + verb + past : 'task_bot_none_' + verb,
        names: theirs.names,
        dropped: theirs.dropped
      });
    }
    return lines;
  }

  /* The steps of a mixed preview, one line: per role what is still open, in
     tab order ("LinkedIn: tick Approve · X: copy, post, Posted ✓"),
     then the footer as it reads now (tail then, before any
     tick; or, while something is left; now, once nothing is). A platform
     that cannot be approved (blocked) is never a step. */
  var STEP_KEYS = { auto: 'task_step_auto', manual: 'task_step_manual' };

  function mixedSteps(parties) {
    var segments = [];
    var byRole = {};
    var ticked = false;
    (parties || []).forEach(function (party) {
      if (!party || !STEP_KEYS[party.role]) return;
      if (party.on === true) ticked = true;
      if (party.on === true || party.blocked) return;
      if (!byRole[party.role]) {
        byRole[party.role] = { role: party.role, key: STEP_KEYS[party.role], names: [] };
        segments.push(byRole[party.role]);
      }
      byRole[party.role].names.push(party);
    });
    var tail = !segments.length ? 'task_steps_tail_now' : ticked ? 'task_steps_tail_or' : 'task_steps_tail_then';
    return { segments: segments, tail: tail };
  }

  /* reply, post or item: what a counted group of items is called */
  function nounOf(parties) {
    var first = parties.length ? parties[0].noun : 'item';
    return parties.every(function (party) { return party.noun === first; }) && first ? first : 'item';
  }

  /* Up to three names in full; more than that: the first two and "+n". */
  function shortList(labels) {
    if (labels.length <= 3) return { shown: labels.slice(), more: 0 };
    return { shown: labels.slice(0, 2), more: labels.length - 2 };
  }

  var ACTOR_KEYS = [
    'task_you_changes', 'task_you_changes_done', 'task_unticked', 'task_names_more',
    'task_steps_mixed_items', 'task_steps_changes', 'task_step_auto', 'task_step_manual',
    'task_steps_tail_then', 'task_steps_tail_or', 'task_steps_tail_now'
  ];
  ['post', 'do'].forEach(function (verb) {
    ['task_you_', 'task_you_none_'].forEach(function (stem) {
      ACTOR_KEYS.push(stem + verb, stem + verb + '_done');
    });
  });
  Object.keys(APPROVE).forEach(function (verb) {
    ACTOR_KEYS.push('task_bot_' + verb, 'task_bot_' + verb + '_done', 'task_bot_none_' + verb);
  });
  ['reply', 'post', 'item'].forEach(function (noun) {
    ACTOR_KEYS.push('task_noun_' + noun, 'task_noun_' + noun + '_one');
  });

  return {
    KINDS: KINDS,
    CTA: CTA,
    baseOf: baseOf,
    labelKey: labelKey,
    primaryKey: primaryKey,
    allowed: allowed,
    lineKey: lineKey,
    stepsKey: stepsKey,
    kindKey: kindKey,
    actorLines: actorLines,
    mixedSteps: mixedSteps,
    nounOf: nounOf,
    shortList: shortList,
    ACTOR_KEYS: ACTOR_KEYS
  };
});
