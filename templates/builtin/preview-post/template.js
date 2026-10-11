/* preview-post (built-in, calm UI). Body of function (RS, root): RS API and
   plain DOM only, block comments only (the template lint reads a double
   slash as a URL). Every visible string comes from RS.t or the payload.

   One platform at a time: a tablist (arrow keys move, each tab carries its
   approval state: tick, blocked dot, accessible name) over one large
   preview (only the selected panel is in the document). Approve = the core
   primary button; "Request changes" is the footer's quiet alternative and
   opens a comment (posting yourself: "Skip"). The decision mode is part of the draft, so a reload never
   turns a change request into an approval.

   The checkboxes hold the decision: restored from the draft, or from the
   submitted result on a decided report. Instagram's image state only blocks
   a NEW approval on an open form; it never unticks a restored or sent one.
   An approved Instagram whose image is not (yet) loaded holds Send with a
   status line instead of silently sending fewer platforms.

   Mode per platform (payload: a plain id is auto; {platform, mode}):
   auto, the bot posts after "Approve & post"; manual, the reviewer posts it
   by hand: copies first (text, hashtags, comment, image or video path,
   the target link, folder), the note
   "You post this yourself." and "Posted". A video replaces the image.
   An optional target is a quote card under the body, or a reply line
   plus the parent card above the post; its URL is not part of the text,
   so X does not count it. A ticked manual platform is
   `done`; an unticked one is `skipped`. The primary stays disabled until
   a platform is ticked. When every platform is manual, the footer's
   alternative is "Skip": it reports every platform as skipped (and
   `platforms` is empty). The result lists only auto
   approvals in `platforms` (what the bot may post) and every platform
   with its mode and decision in `per_platform`. */
var data = RS.data;
var ORDER = ['x', 'linkedin', 'instagram', 'facebook'];
var NAMES = {
  x: RS.t('platform_x'), linkedin: RS.t('platform_linkedin'),
  instagram: RS.t('platform_instagram'), facebook: RS.t('platform_facebook')
};
var flags = data.flag || [];
var entries = data.platforms.map(function (e) {
  return typeof e === 'string' ? { platform: e, mode: 'auto' } : { platform: e.platform, mode: e.mode || 'auto' };
});
var platforms = entries.map(function (e) { return e.platform; });
var modes = {};
entries.forEach(function (e) { modes[e.platform] = e.mode; });
function manual(p) { return modes[p] === 'manual'; }
var anyManual = platforms.some(manual);
var tags = data.hashtags || [];
var tagLine = tags.map(function (h) { return '#' + h; }).join(' ');
var append = (data.hashtag_mode || 'append') === 'append' && tags.length > 0;
var image = data.image || null;
var video = data.video || null;
var hasVisual = !!(image || video);
var target = data.target || null;
var author = data.author;
var panels = part('panels');
var tablist = part('tabs');
var inputs = {};
var tabs = {};
var ticks = {};
var cols = {};
var fixedBlock = {};
var imageState = {};

function part(name, el) { return (el || root).querySelector('[data-pp="' + name + '"]'); }

/* Composed text: T = variants[p].text ?? text, plus a blank line and the hashtags
   when hashtag_mode is append. NFC once here, because rs-post-frame shows the
   NFC text and RS.count counts it: shown = copied = counted. */
function composed(p) {
  var variant = data.variants && data.variants[p];
  var text = variant ? variant.text : data.text;
  if (append) text += '\n\n' + tagLine;
  return text.normalize('NFC');
}

function slot(tag, name, text) {
  var el = document.createElement(tag);
  el.setAttribute('slot', name);
  if (text !== undefined) el.textContent = text;
  return el;
}

/* Host only: the quoted URL stays out of the composed text, so X's weighted
   count never includes it. A URL written in the post text still counts. */
function quoteDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function badge(box, variant, text) {
  var b = document.createElement('rs-badge');
  b.setAttribute('variant', variant);
  b.textContent = text;
  box.appendChild(b);
  return b;
}

/* ---- agent note; persona and post id (when given) are quiet lines in the
   overflow, next to "Show in folder" ---- */
if (data.notes && RS.task.why_from !== 'notes') part('notes').textContent = data.notes;
else part('notes').remove();
if (data.persona) RS.addMenuMeta(RS.t('meta_persona', { persona: data.persona }));
if (data.post_id) RS.addMenuMeta(RS.t('meta_post_id', { id: data.post_id }));
if (image) RS.addMenuItem(RS.t('reveal'), function () { RS.reveal(image.path); });
else if (video) RS.addMenuItem(RS.t('reveal'), function () { RS.reveal(video.path); });

/* ---- one panel per platform, in payload order ---- */
ORDER.forEach(function (p) {
  if (platforms.indexOf(p) < 0) panels.querySelector('[data-platform="' + p + '"]').remove();
});

platforms.forEach(function (p) {
  var col = panels.querySelector('[data-platform="' + p + '"]');
  var text = composed(p);
  var name = NAMES[p];
  panels.appendChild(col);
  col.id = 'panel-' + p;

  /* the tab: platform name + approval state (tick / blocked dot + spoken text) */
  var tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'pp__tab';
  tab.id = 'tab-' + p;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('data-platform', p);
  var label = document.createElement('span');
  label.textContent = name;
  if (manual(p)) {
    /* the mode, quietly, as part of the name: "X · manual" */
    var modeText = document.createElement('span');
    modeText.className = 'pp__mode';
    modeText.textContent = ' · ' + RS.t('mode_manual');
    label.appendChild(modeText);
  }
  tab.appendChild(label);
  var tick = document.createElement('span');
  tick.className = 'pp__state';
  tick.setAttribute('data-rs-status', 'open');
  tick.appendChild(RS.icon('check'));
  var tickText = document.createElement('span');
  tickText.className = 'rs-vh';
  tab.appendChild(tick);
  tab.appendChild(tickText);
  tablist.appendChild(tab);
  col.setAttribute('aria-labelledby', tab.id);
  tabs[p] = tab;
  ticks[p] = { box: tick, text: tickText };
  tab.addEventListener('click', function () { select(p, false); saveSelection(); });

  /* Preview: slots are built complete and appended in one go, so the frame
     renders once with everything in place. A link card only shows without an
     image or a video, as on the platforms themselves. */
  var frame = part('frame', col);
  frame.id = 'pf-' + p;
  if (hasVisual) frame.setAttribute('ratio', (video || image).ratio);
  var slots = document.createDocumentFragment();
  if (author.avatar) {
    var avatar = slot('img', 'avatar');
    avatar.src = RS.media(author.avatar);
    avatar.alt = '';
    slots.appendChild(avatar);
  }
  slots.appendChild(slot('span', 'name', author.name));
  if (p === 'x') slots.appendChild(slot('span', 'handle', RS.t('pf_handle', { handle: author.handle })));
  if (p === 'instagram') slots.appendChild(slot('span', 'handle', author.handle));
  if (p === 'linkedin' && author.headline) slots.appendChild(slot('span', 'headline', author.headline));
  slots.appendChild(slot('div', 'text', text));
  var img = null;
  var vid = null;
  if (video) {
    vid = slot('video', 'video');
    vid.controls = true;
    vid.preload = 'metadata';
    vid.autoplay = false;
    vid.muted = false;
    vid.poster = RS.media(video.poster);
    vid.src = RS.media(video.path);
    vid.setAttribute('aria-label', video.alt);
    slots.appendChild(vid);
  } else if (image) {
    img = slot('img', 'image');
    img.src = RS.media(image.path);
    img.alt = image.alt;
    slots.appendChild(img);
  } else if (data.link && p !== 'instagram') {
    slots.appendChild(slot('span', 'link-domain', data.link.domain));
    slots.appendChild(slot('span', 'link-title', data.link.title));
  }
  /* Instagram has no quote or reply chrome. A quote sits under the body.
     On X a reply puts the parent card above the post. The reply type is its
     own slot, so a missing handle does not turn it into a quote. X names
     the handle, the author name, or a generic line. LinkedIn and Facebook
     keep the reshare card and still show that reply line. */
  if (target && p !== 'instagram') {
    slots.appendChild(slot('span', 'target-type', target.type));
    if (target.type === 'reply') {
      var replyAuthor = target.author || {};
      var replyText = replyAuthor.handle
        ? RS.t('replying_to', { handle: replyAuthor.handle })
        : (replyAuthor.name
          ? RS.t('replying_to_name', { name: replyAuthor.name })
          : RS.t('replying_to_post'));
      slots.appendChild(slot('span', 'reply', replyText));
    }
    if (target.author && target.author.name) slots.appendChild(slot('span', 'quote-name', target.author.name));
    if (target.author && target.author.handle) {
      slots.appendChild(slot('span', 'quote-handle', RS.t('pf_handle', { handle: target.author.handle })));
    }
    if (target.excerpt) slots.appendChild(slot('div', 'quote-excerpt', target.excerpt));
    slots.appendChild(slot('span', 'quote-domain', quoteDomain(target.url)));
    slots.appendChild(slot('span', 'quote-url', target.url));
  }
  frame.appendChild(slots);

  /* Counters count exactly the composed text. */
  col.querySelectorAll('rs-counter[platform="' + p + '"]').forEach(function (c) { c.text = text; });
  var commentCounter = col.querySelector('rs-counter[platform="linkedin_comment"]');
  if (commentCounter) {
    if (data.first_comment) commentCounter.text = data.first_comment;
    else commentCounter.remove();
  }

  /* Copy icons. Text and (appended) hashtags are visible in the preview, so
     their value is hidden; the first comment shows its full text. */
  var copyText = part('copy-text', col);
  copyText.setAttribute('label', RS.t('copy_text'));
  copyText.text = text;
  var copyTags = part('copy-hashtags', col);
  if (tags.length) {
    copyTags.setAttribute('label', RS.t('copy_hashtags'));
    copyTags.text = tagLine;
    if (append) copyTags.setAttribute('no-value', '');
  } else {
    copyTags.remove();
  }
  var copyComment = part('copy-comment', col);
  if (data.first_comment) {
    copyComment.setAttribute('label', RS.t('copy_comment'));
    copyComment.text = data.first_comment;
  } else {
    copyComment.remove();
  }

  /* Manual: the reviewer posts by hand, so copying comes first (in the DOM,
     hence the Tab order, as on screen), with the image as a picture and its
     folder. Auto keeps today's panel. */
  var manualNote = part('manual-note', col);
  var copyImage = part('copy-image', col);
  var copyVideo = part('copy-video', col);
  var copyLink = part('copy-link', col);
  var revealButton = part('reveal', col);
  col.setAttribute('data-mode', modes[p]);
  if (manual(p)) {
    manualNote.textContent = RS.t('manual_note');
    if (video) {
      copyImage.remove();
      copyVideo.setAttribute('label', RS.t('copy_path'));
      copyVideo.setAttribute('media', video.path);
      copyVideo.setAttribute('media-copy', 'path');
      part('reveal-label', revealButton).textContent = RS.t('reveal');
      revealButton.addEventListener('click', function () { RS.reveal(video.path); });
    } else if (image) {
      copyVideo.remove();
      copyImage.setAttribute('label', RS.t('copy_image'));
      copyImage.setAttribute('media', image.path);
      part('reveal-label', revealButton).textContent = RS.t('reveal');
      revealButton.addEventListener('click', function () { RS.reveal(image.path); });
    } else {
      copyImage.remove();
      copyVideo.remove();
      revealButton.remove();
    }
    if (target) {
      copyLink.setAttribute('label', RS.t('copy_link'));
      copyLink.text = target.url;
    } else {
      copyLink.remove();
    }
    manualNote.parentNode.insertBefore(col.querySelector('.pp__copies'), manualNote.nextSibling);
  } else {
    manualNote.remove();
    copyImage.remove();
    copyVideo.remove();
    copyLink.remove();
    revealButton.remove();
  }

  /* Lints and blocking: over the limit (incl. more than 30 Instagram
     hashtags) and Instagram without an image block approving. */
  var badges = part('badges', col);
  var checked = text + '\n' + (data.first_comment || '').normalize('NFC');
  var res = RS.count(text, p);
  var blocked = null;
  var blockedBy = null;
  if (res.count > res.limit) blocked = RS.t('over_limit_blocks');
  if (p === 'instagram' && res.hashtags > res.hashtagLimit) {
    badge(badges, 'danger', RS.t('lint_over_hashtags', { n: res.hashtags - res.hashtagLimit }));
    blocked = RS.t('over_limit_blocks');
  }
  if (p === 'instagram' && !hasVisual) {
    blockedBy = badge(badges, 'danger', RS.t('lint_ig_needs_image'));
    blockedBy.id = 'lint-image-' + p;
  } else if (p === 'instagram' && hasVisual) {
    blockedBy = badge(badges, 'danger', RS.t('lint_ig_needs_image'));
    blockedBy.id = 'lint-image-' + p;
  }
  /* the payload's own style flags (characters or words to avoid) */
  flags.forEach(function (f) {
    if (checked.indexOf(f.normalize('NFC')) >= 0) badge(badges, 'warn', RS.t('lint_found', { text: f }));
  });

  var input = part('approve', col);
  part('approve-label', col).textContent = RS.t(manual(p) ? 'posted' : 'approve_for', { platform: name });
  var reason = part('blocked', col);
  if (blocked) {
    part('blocked-text', reason).textContent = blocked;
    reason.hidden = false;
    input.setAttribute('aria-describedby', reason.id);
  } else if (blockedBy) {
    input.setAttribute('aria-describedby', blockedBy.id);
  }
  /* over the limit, or Instagram without any image: never approvable */
  fixedBlock[p] = !!(blocked || (blockedBy && !hasVisual));
  if (fixedBlock[p]) {
    input.disabled = true;
    input.setAttribute('data-rs-blocked', '');
    col.setAttribute('data-blocked', '');
  }
  inputs[p] = input;
  cols[p] = col;

  /* Instagram needs its image. Only the selected panel is mounted, so until
     its frame reports a state the image element itself tells. */
  if (p === 'instagram' && hasVisual) {
    var visual = vid || img;
    imageState[p] = function () {
      var known = frame.getAttribute('data-image-state');
      if (known) return known;
      if (visual.tagName === 'VIDEO') {
        if (visual.getAttribute('preload') === 'none') return 'poster';
        if (visual.error) return 'unavailable';
        return visual.readyState >= 1 ? 'loaded' : 'loading';
      }
      if (!visual.complete) return 'loading';
      return visual.naturalWidth > 0 ? 'loaded' : 'error';
    };
    var onImage = function () { syncControl(p); update(false); };
    frame.addEventListener('rs-image-state', onImage);
    if (vid) {
      vid.addEventListener('loadedmetadata', onImage);
      vid.addEventListener('error', onImage);
    } else {
      img.addEventListener('load', onImage);
      img.addEventListener('error', onImage);
    }
  }
});

function decided() { return RS.run.state !== 'open' || root.hasAttribute('data-rs-locked'); }

/* Without a loaded image only a NEW approval is blocked: an approved
   Instagram stays ticked (and can still be removed on an open form). */
function syncControl(p) {
  if (!imageState[p]) return;
  var input = inputs[p];
  var col = cols[p];
  var note = part('badges', col).querySelector('#lint-image-' + p);
  var visualState = imageState[p]();
  var loaded = visualState === 'loaded';
  /* A clip that cannot be previewed is not missing media. */
  var previewFailed = visualState === 'error' || visualState === 'unavailable';
  note.hidden = loaded || previewFailed || (decided() && input.checked);
  if (fixedBlock[p]) return;
  if (!loaded && !input.checked) {
    input.disabled = true;
    input.setAttribute('data-rs-blocked', '');
    input.setAttribute('aria-describedby', note.id);
    col.setAttribute('data-blocked', '');
    return;
  }
  input.disabled = decided() || root.hasAttribute('data-rs-pending');
  input.removeAttribute('data-rs-blocked');
  if (loaded) input.removeAttribute('aria-describedby');
  else input.setAttribute('aria-describedby', note.id);
  col.removeAttribute('data-blocked');
}

/* an approval that may be sent now: Instagram only with its image loaded */
function confirmed(p) { return !imageState[p] || imageState[p]() === 'loaded'; }

/* ---- tabs: one selected, roving tabindex, arrows/Home/End ---- */
var selected = null;
function select(p, focus) {
  selected = p;
  platforms.forEach(function (q) {
    var on = q === p;
    tabs[q].setAttribute('aria-selected', on ? 'true' : 'false');
    tabs[q].tabIndex = on ? 0 : -1;
    /* one panel in the document at a time; the tab controls its preview */
    if (on) {
      cols[q].hidden = false;
      if (!cols[q].isConnected) panels.appendChild(cols[q]);
      tabs[q].setAttribute('aria-controls', cols[q].id);
    } else {
      if (cols[q].isConnected) cols[q].remove();
      /* the panel of an unselected tab is not mounted: no dangling reference */
      tabs[q].removeAttribute('aria-controls');
    }
  });
  if (focus) tabs[p].focus();
}
tablist.addEventListener('keydown', function (e) {
  var i = platforms.indexOf(selected);
  var n = platforms.length;
  var j = -1;
  if (e.key === 'ArrowRight') j = (i + 1) % n;
  else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = n - 1;
  if (j < 0) return;
  e.preventDefault();
  select(platforms[j], true);
  saveSelection();
});

/* ---- decision: Approve = the core primary (Ctrl/Cmd+Enter);
   "Request changes" = the footer's quiet alternative, needs a comment ---- */
var comment = root.querySelector('#pp-comment');
var requestBox = part('request');
var requesting = false;

/* blocked = a new approval is not possible (limit, Instagram image); a
   locked decided report keeps its approvals though every checkbox is disabled */
function isBlocked(p) { return inputs[p].hasAttribute('data-rs-blocked'); }

/* the decision as ticked: what the draft keeps and the result sends */
function approved() {
  return platforms.filter(function (p) { return inputs[p].checked && !fixedBlock[p]; });
}

function renderTicks() {
  platforms.forEach(function (p) {
    var on = inputs[p].checked;
    var state = on ? 'approved' : isBlocked(p) ? 'blocked' : 'open';
    var box = ticks[p].box;
    if (box.getAttribute('data-rs-status') !== state || !box.firstChild) {
      box.textContent = '';
      box.appendChild(RS.icon(state === 'blocked' ? 'dot' : 'check'));
    }
    box.setAttribute('data-rs-status', state);
    tabs[p].setAttribute('data-rs-approval-state', on ? 'approved' : 'pending');
    var spoken = state === 'blocked' ? 'blocked'
      : manual(p) ? (state === 'open' ? 'skip' : 'posted')
      : (state === 'open' ? 'not_approved' : 'approved');
    ticks[p].text.textContent = RS.t(spoken);
  });
}

/* Per platform: its mode and what was decided; a change request applies to
   every platform with the comment as its note. */
function perPlatform(list, note) {
  var out = {};
  platforms.forEach(function (p) {
    var entry = { mode: modes[p] };
    if (note !== undefined) {
      entry.decision = 'changes_requested';
      entry.note = note;
    } else if (list.indexOf(p) >= 0) {
      entry.decision = manual(p) ? 'done' : 'approved';
    } else {
      entry.decision = manual(p) ? 'skipped' : 'not_approved';
    }
    out[p] = entry;
  });
  return out;
}

/* The task kind says who acts next (RS.cta, the shell's table). Every
   platform manual: you post yourself, "Posted ✓" once one is ticked, "Skip"
   reports every platform as skipped. Any auto platform: "Approve & post"
   (the bot posts what is ticked; "Posted ✓" when only manual ones are
   ticked), "Request changes" as the alternative. A mix names neither actor
   while both act ("Submit"); before any tick every approvable platform is
   the plan. */
var selfPost = RS.task.base === 'post_yourself';
var mixed = anyManual && platforms.some(function (p) { return !manual(p); });
function submitLabel(list) {
  if (selfPost) return RS.cta('done');
  var plan = list.length || !mixed ? list : platforms.filter(function (p) { return !fixedBlock[p]; });
  var auto = plan.some(function (p) { return !manual(p); });
  var hand = plan.some(manual);
  if (auto && hand) return RS.t('submit_mixed');
  return hand ? RS.t('posted') : RS.cta('approve');
}
/* "1 approved · 1 posted": what goes to the bot and what you report */
function splitCount(list) {
  var hand = list.filter(manual).length;
  var parts = [];
  if (list.length > hand) parts.push(RS.t('mixed_approved_count', { n: list.length - hand }));
  if (hand) parts.push(RS.t('mixed_posted_count', { n: hand }));
  return parts.join(' ' + RS.t('sep') + ' ');
}
function skipAll() {
  RS.setResult({ decision: 'approve', platforms: [], comment: '', per_platform: perPlatform([]) });
  RS.submit();
}

function saveSelection() { if (RS.run.state === 'open') update(true); }

function update(save) {
  var list = approved();
  if (save && RS.run.state === 'open') RS.draft.set({ approve: list, comment: comment.value, requesting: requesting, selected: selected });
  renderTicks();
  refreshBanner(list);
  if (requesting) {
    var text = comment.value.trim();
    RS.setSubmitLabel(RS.t('send_request'));
    RS.setAlternative(null);
    RS.setResult(text ? {
      decision: 'request_changes', platforms: [], comment: comment.value,
      per_platform: perPlatform(list, comment.value)
    } : null);
    RS.setStatus(text ? null : RS.t('comment_required'));
    return;
  }
  /* an approval never carries the (hidden) change-request text */
  RS.setSubmitLabel(submitLabel(list));
  if (selfPost) RS.setAlternative(RS.cta('skipped'), skipAll);
  else RS.setAlternative(RS.cta('request_changes'), function () { setRequesting(true, true); });
  var waiting = list.filter(function (p) { return !confirmed(p); })[0];
  if (waiting) {
    RS.setResult(null);
    var waitingVideo = !!video;
    var waitingState = imageState[waiting]();
    var failed = waitingState === 'error' || waitingState === 'unavailable';
    var waitingKey = waitingVideo
      ? (failed ? 'approval_video_failed' : 'approval_waits_video')
      : (failed ? 'approval_image_failed' : 'approval_waits_image');
    RS.setStatus(RS.t(waitingKey, { platform: NAMES[waiting] }));
    return;
  }
  /* only auto approvals are the bot's to post; a manual one never is.
     Nothing ticked: stay disabled (posting yourself, "Skip" reports every
     skip). */
  if (list.length) {
    RS.setResult({
      decision: 'approve', platforms: list.filter(function (p) { return !manual(p); }), comment: '',
      per_platform: perPlatform(list)
    });
    RS.setStatus(mixed ? splitCount(list)
      : RS.t(anyManual ? 'decided_count' : 'approve_count', { n: list.length, total: platforms.length }));
  } else {
    RS.setResult(null);
    RS.setStatus(RS.t(anyManual ? 'select_platform_manual' : 'select_platform'));
  }
}

/* A mix gets one banner line per actor. Until something is ticked every
   platform is the plan; after that an unticked one is out (the bot does not
   post it, or you report it skipped), and a change request means nobody
   posts. The decided banner words the same state in the past. The steps
   say per actor what is still open, then the footer as it reads now. */
function refreshBanner(list) {
  if (!anyManual || selfPost || typeof RS.setTaskLive !== 'function') return;
  var picked = list.length > 0;
  var chosen = picked ? list : platforms;
  var hasAuto = chosen.some(function (p) { return !manual(p); });
  RS.setTaskLive({
    parties: platforms.map(function (p) {
      var party = { id: p, role: manual(p) ? 'manual' : 'auto' };
      if (picked) party.on = list.indexOf(p) >= 0;
      if (fixedBlock[p]) party.blocked = true;
      return party;
    }),
    changes: requesting,
    stepsFor: requesting ? null : 'mixed_platforms',
    stepsKey: requesting ? 'task_steps_changes' : null,
    stepsButton: requesting ? RS.t('send_request') : submitLabel(list),
    tone: requesting || hasAuto ? 'approve_bot_acts' : 'post_yourself'
  });
}

function setRequesting(on, focus) {
  requesting = on;
  requestBox.hidden = !on;
  update(true);
  if (focus) (on ? comment : tabs[selected]).focus();
}
part('request-cancel').addEventListener('click', function () { setRequesting(false, true); });

/* restore a draft (reload) or show what a submitted report sent */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
/* a sent result ticks what it decided: per_platform when present (approved
   or posted by hand), else its platforms */
function sentTicks(result) {
  if (!result.per_platform) return result.platforms || [];
  return platforms.filter(function (p) {
    var entry = result.per_platform[p];
    return !!entry && (entry.decision === 'approved' || entry.decision === 'done');
  });
}
var draft = sent ? { approve: sentTicks(sent), comment: sent.comment || '', requesting: sent.decision === 'request_changes' }
  : (RS.run.state === 'open' ? RS.draft.get() : null);
if (draft) {
  /* a sent result is shown as sent; a draft never revives a fixed block */
  (draft.approve || []).forEach(function (p) {
    if (inputs[p] && (sent || !fixedBlock[p])) inputs[p].checked = true;
  });
  if (typeof draft.comment === 'string') comment.value = draft.comment;
  if (draft.requesting === true) {
    requesting = true;
    requestBox.hidden = false;
  }
}
platforms.forEach(syncControl);
/* back to the platform being reviewed */
select(draft && platforms.indexOf(draft.selected) >= 0 ? draft.selected : platforms[0], false);

platforms.forEach(function (p) {
  inputs[p].addEventListener('change', function () { syncControl(p); update(true); });
});
comment.addEventListener('input', function () { update(true); });

update(false);
if (draft && !sent) (requesting ? comment : tabs[selected]).focus();
