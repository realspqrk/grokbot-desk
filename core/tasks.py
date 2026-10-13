"""The task a report asks for: which kind, who acts next, and why.

A payload may carry `task` = {kind, steps?, eta_min?, due?, why?}. Without it
the kind follows from the template and its actor fields. A given kind on a
built-in with an actor model also sets that actor when the payload leaves it
out, so the template's controls, the result and the summary all agree.
"""
import copy
import re
from datetime import date

from .timeutil import to_local

KINDS = ("post_yourself", "approve_bot_acts", "pick", "fyi", "review", "blocking")
TASK_FIELDS = {"kind", "steps", "eta_min", "due", "why"}
USER_CHOICES = ("done", "skipped", "later")
MAX_STEPS = 140
MAX_WHY = 360
MAX_WHY_SENTENCES = 3

# Kinds each built-in can show (blocking wraps the derived kind). Templates
# without an actor model accept review or blocking only and keep their own controls.
APPLICABLE = {
    "approve-one": {"approve_bot_acts", "post_yourself", "fyi", "blocking"},
    "review-doc": {"review", "approve_bot_acts", "post_yourself", "fyi", "blocking"},
    "decide-list": {"approve_bot_acts", "post_yourself", "blocking"},
    "preview-post": {"approve_bot_acts", "post_yourself", "blocking"},
    "pick-option": {"pick", "blocking"},
}

# Where the default why comes from when the payload has none.
WHY_SOURCES = {
    "approve-one": "summary",
    "review-doc": "summary",
    "decide-list": "intro",
    "pick-option": "context",
    "preview-post": "notes",
}

# After . ! ? or an ellipsis (and any closing quote or bracket), the
# whitespace before the next sentence; or a line break anywhere.
CLOSERS = "\"'“”»)]"
SENTENCE_GAP = re.compile(r"(?<=[.!?…])[\"'“”»)\]]*\s+(?=\S)|\s*\n\s*(?=\S)")
# the word before a full stop, after any opening quote or bracket
ABBREV_TAIL = re.compile(r"(?:^|[\s(\[\"'„“«])([^\s(\[\"'„“«]+)\.$")
ABBREVIATIONS = frozenset(
    "ca nr dr prof bzw vgl ggf inkl exkl evtl mio mrd tsd st str tel abs art hr fr jh mr mrs ms vs "
    "approx no resp min max sog zzgl abzgl".split()
)
MAYBE_END = frozenset({"usw", "etc"})
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
# What Edge parses: a calendar date, or an extended timestamp with Z or ±HH:MM.
# Basic ISO, week dates and odd separators parse in Python and then vanish in the browser.
EXTENDED_DUE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}"
    r"(?::[0-9]{2}(?:\.[0-9]{1,3})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})$"
)
URL_RE = re.compile(r"https?://", re.IGNORECASE)
# A template with no actor model can show the generic review banner, or blocking
# (the shell emphasises its existing primary). It cannot promise any other kind.
SHELL_KINDS = frozenset({"review", "blocking"})


class TaskError(ValueError):
    def __init__(self, pointer, message):
        self.pointer = pointer
        self.message = message
        super().__init__(f"{pointer}: {message}")


def _boundaries(text):
    """Where one sentence ends and the next starts: (end, start) pairs.

    A line break always ends a sentence. A full stop does not when it closes
    an abbreviation (z. B., ca., Nr., Dr., d. h., u. a., bzw., e.g.) or an
    ordinal or date ("1. Schritt", "15. Mai"); usw. and etc. end one only
    when a capital follows.
    """
    for match in SENTENCE_GAP.finditer(text):
        gap = match.group(0)
        end = match.start() + len(gap) - len(gap.lstrip(CLOSERS))
        start = match.end()
        if "\n" not in gap and text[end - 1] == "." and _abbreviation(text[:end], text[start:]):
            continue
        yield end, start


def _abbreviation(head, tail):
    word = ABBREV_TAIL.search(head)
    if not word:
        return False
    token = word.group(1).lower()
    if token.isdigit() or (len(token) == 1 and token.isalpha()) or "." in token:
        return True
    if token in MAYBE_END:
        return not tail[:1].isupper()
    return token in ABBREVIATIONS


def sentences(text):
    text = (text or "").strip()
    if not text:
        return []
    parts, at = [], 0
    for end, start in _boundaries(text):
        parts.append(text[at:end])
        at = start
    parts.append(text[at:])
    return [part for part in parts if part]


def split_why(text):
    """The first three sentences, and the rest (shown folded). Line breaks
    inside the shown part stay as written."""
    text = (text or "").strip()
    for index, (end, start) in enumerate(_boundaries(text), 1):
        if index == MAX_WHY_SENTENCES:
            return text[:end], text[start:]
    return text, ""


def present_why(text):
    """Three sentences on show, the rest folded. A run longer than 360
    characters is cut at the last word boundary before that, marked with an
    ellipsis, and the cut-off is folded rather than dropped."""
    shown, more = split_why(text or "")
    if len(shown) > MAX_WHY:
        cut = max(shown.rfind(" ", 0, MAX_WHY), shown.rfind("\n", 0, MAX_WHY))
        if cut <= 0:
            cut = MAX_WHY
        extra = shown[cut:].strip()
        shown = shown[:cut].rstrip() + "…"
        more = " ".join(part for part in (extra, more) if part)
    return shown, more


def fits_banner(text):
    """True when the text shows whole in the banner (three sentences, 360 characters)."""
    shown, more = present_why(text)
    return not more


def why_warnings(why):
    """Notes for a why the banner will fold. Empty when the text is within both limits."""
    if not isinstance(why, str):
        return []
    notes = []
    if len(sentences(why)) > MAX_WHY_SENTENCES:
        notes.append(
            f"/task/why: longer than {MAX_WHY_SENTENCES} sentences; "
            "the banner shows the first three and folds the rest"
        )
    if len(why) > MAX_WHY:
        notes.append(
            f"/task/why: longer than {MAX_WHY} characters; "
            "the banner shows the start and folds the rest"
        )
    return notes


def _actor(value):
    return value if value in ("user", "none") else "bot"


def _platform_modes(data):
    modes = []
    for entry in data.get("platforms") or []:
        if isinstance(entry, dict):
            modes.append(entry.get("mode", "auto"))
        else:
            modes.append("auto")
    return modes


def derive_kind(template_id, data):
    """The kind a report asks for when the payload names none."""
    data = data if isinstance(data, dict) else {}
    if template_id == "preview-post":
        modes = _platform_modes(data)
        return "post_yourself" if modes and all(mode == "manual" for mode in modes) else "approve_bot_acts"
    if template_id == "decide-list":
        items = [item for item in data.get("items") or [] if isinstance(item, dict)]
        return "post_yourself" if items and all(item.get("actor") == "user" for item in items) else "approve_bot_acts"
    if template_id == "pick-option":
        return "pick"
    if template_id in ("approve-one", "review-doc"):
        actor = _actor(data.get("actor"))
        if actor == "none":
            return "fyi"
        if actor == "user":
            return "post_yourself"
        if template_id == "review-doc" and not data.get("action"):
            return "review"
        return "approve_bot_acts"
    return "review"


def approve_verb(template_id, data):
    """post, send or continue: what the bot does after Approve."""
    if template_id == "preview-post":
        return "post"
    action = data.get("action") if isinstance(data, dict) else None
    return action if action in ("post", "send") else "continue"


def validate_task(value):
    if not isinstance(value, dict):
        raise TaskError("/task", "must be an object")
    for field in value:
        if field not in TASK_FIELDS:
            raise TaskError(f"/task/{field}", "unknown field (allowed: kind, steps, eta_min, due, why)")
    if "kind" not in value:
        raise TaskError("/task/kind", "required field is missing")
    if value["kind"] not in KINDS:
        raise TaskError("/task/kind", "must be one of " + ", ".join(KINDS))
    steps = value.get("steps")
    if "steps" in value and (
        not isinstance(steps, str)
        or not 1 <= len(steps) <= MAX_STEPS
        or any(ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in steps)
    ):
        raise TaskError("/task/steps", f"must be one line of 1-{MAX_STEPS} characters")
    eta = value.get("eta_min")
    if "eta_min" in value and (type(eta) is not int or not 1 <= eta <= 120):
        raise TaskError("/task/eta_min", "must be an integer from 1 to 120")
    if "due" in value:
        _validate_due(value["due"])
    why = value.get("why")
    if "why" in value and (not isinstance(why, str) or not why.strip()):
        raise TaskError("/task/why", "must be a non-empty string")


def _validate_due(due):
    try:
        if not isinstance(due, str):
            raise ValueError
        if DATE_RE.fullmatch(due):
            date.fromisoformat(due)
        elif EXTENDED_DUE.fullmatch(due):
            to_local(due)
        else:
            raise ValueError
    except (TypeError, ValueError, OverflowError) as error:
        raise TaskError(
            "/task/due",
            "must be YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]]Z or with a ±HH:MM offset",
        ) from error


def apply_kind(template_id, data, kind):
    """The data with the actor the kind implies; raises TaskError on a clash.

    Only built-ins with an actor model are touched. The input is not changed.
    """
    allowed = APPLICABLE.get(template_id)
    if allowed is None:
        if kind not in SHELL_KINDS:
            raise TaskError(
                "/task/kind",
                f"{template_id} cannot show {kind} (allowed: {', '.join(sorted(SHELL_KINDS))})",
            )
        return data
    if kind not in allowed:
        raise TaskError(
            "/task/kind",
            f"{template_id} cannot show {kind} (allowed: {', '.join(sorted(allowed))})",
        )
    derived = derive_kind(template_id, data)
    if kind in ("blocking", derived):
        return data
    data = copy.deepcopy(data)
    if template_id in ("approve-one", "review-doc"):
        want = {"post_yourself": "user", "fyi": "none"}.get(kind, "bot")
        if "actor" in data and data["actor"] != want:
            raise TaskError("/data/actor", f"is {data['actor']}, but task.kind {kind} needs {want}")
        if want == "bot":
            if kind == "review" and data.get("action"):
                raise TaskError("/data/action", "task.kind review takes no action verb; use approve_bot_acts")
            if kind == "approve_bot_acts" and not data.get("action"):
                data["action"] = "continue"
        else:
            data["actor"] = want
        return data
    if template_id == "decide-list":
        items = data.get("items") or []
        if kind == "post_yourself":
            for index, item in enumerate(items):
                if item.get("actor", "user") != "user":
                    raise TaskError(f"/data/items/{index}/actor", "is bot, but task.kind post_yourself needs user")
                if "actor" not in item:
                    # a bot item turned into the person's own: bot choices and labels do not apply
                    if any(choice not in USER_CHOICES for choice in item.get("choices") or []):
                        item.pop("choices", None)
                    item.pop("labels", None)
                item["actor"] = "user"
            return data
        raise TaskError("/data/items", "every item has actor user; task.kind approve_bot_acts needs a bot item")
    if template_id == "preview-post":
        entries = data.get("platforms") or []
        if kind == "post_yourself":
            converted = []
            for index, entry in enumerate(entries):
                if isinstance(entry, dict):
                    if entry.get("mode", "manual") != "manual":
                        raise TaskError(
                            f"/data/platforms/{index}/mode",
                            "is auto, but task.kind post_yourself needs manual",
                        )
                    converted.append(dict(entry, mode="manual"))
                else:
                    converted.append({"platform": entry, "mode": "manual"})
            data["platforms"] = converted
            return data
        raise TaskError("/data/platforms", "every platform is manual; task.kind approve_bot_acts needs an auto platform")
    return data


def base_template(template_id, registry):
    template = registry.get(template_id) if registry is not None else None
    if template is not None and template.extends:
        return template.extends
    return template_id


def default_why(template_id, data):
    """(text, source field) for the banner, or ("", None).

    Text with a link stays in the template, where the link can be opened.
    """
    field = WHY_SOURCES.get(template_id)
    text = data.get(field) if field and isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or URL_RE.search(text):
        return "", None
    return text.strip(), field


def _publishes(item):
    return item.get("content") in ("post", "reply")


def report_shape(template_id, data, task):
    """How the person reports a user action, and a mixed actor list.

    `mark` is posted, sent or done. `parties` lists both sides of a mixed
    report, one entry per platform ({id, role}) or item ({role, noun}), so the
    banner can give each actor its own line. `steps_for` picks a steps line
    (replies, user_items, mixed_platforms, mixed_items) when the kind's default would
    describe the wrong work.
    """
    data = data if isinstance(data, dict) else {}
    explicit = task.get("kind") if isinstance(task, dict) else None
    mark = "posted" if explicit == "post_yourself" else None
    parties = []
    steps_for = None
    if template_id == "preview-post":
        entries = []
        for entry in data.get("platforms") or []:
            if isinstance(entry, dict):
                platform, mode = entry.get("platform"), entry.get("mode", "auto")
            else:
                platform, mode = entry, "auto"
            if isinstance(platform, str):
                entries.append({"id": platform, "role": "manual" if mode == "manual" else "auto"})
        roles = {entry["role"] for entry in entries}
        if mark is None and roles == {"manual"}:
            mark = "posted"
        elif len(roles) > 1:
            parties = entries
            steps_for = "mixed_platforms"
    elif template_id in ("approve-one", "review-doc"):
        if mark is None and _actor(data.get("actor")) == "user":
            mark = "sent" if data.get("action") == "send" else "done"
    elif template_id == "decide-list":
        shaped = []
        items = [item for item in data.get("items") or [] if isinstance(item, dict)]
        for item in items:
            if item.get("actor") == "user":
                role = "user_post" if _publishes(item) else "user"
            else:
                role = "bot"
            shaped.append({"role": role, "noun": item.get("content") if _publishes(item) else "item"})
        roles = {entry["role"] for entry in shaped}
        if roles & {"user", "user_post"} and "bot" in roles:
            parties = shaped
            steps_for = "mixed_items"
        elif mark is None and roles == {"user_post"}:
            mark = "posted"
        elif mark is None and roles and roles <= {"user", "user_post"}:
            mark = "done"
        if roles <= {"user", "user_post"} and items:
            steps_for = "replies" if all(item.get("content") == "reply" for item in items) else "user_items"
    return mark, parties, steps_for


def task_view(payload, registry):
    """The task the page shows above the report."""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    template_id = base_template(payload.get("template"), registry)
    task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
    derived = derive_kind(template_id, data)
    kind = task.get("kind") if task.get("kind") in KINDS else derived
    view = {
        "kind": kind,
        "base": derived if kind == "blocking" else kind,
        "verb": approve_verb(template_id, data),
    }
    mark, parties, steps_for = report_shape(template_id, data, task)
    if mark:
        view["mark"] = mark
    if parties:
        view["parties"] = parties
    if steps_for:
        view["steps_for"] = steps_for
    for field in ("steps", "eta_min", "due"):
        if field in task:
            view[field] = task[field]
    label = data.get("approve_label")
    if template_id == "decide-list":
        labels = data.get("labels")
        label = labels.get("approve") if isinstance(labels, dict) else None
    if (
        template_id in ("approve-one", "decide-list")
        and view["base"] == "approve_bot_acts"
        and isinstance(label, str)
        and label.strip()
    ):
        view["label"] = label.strip()
    if isinstance(task.get("why"), str):
        text, source = task["why"].strip(), None
    else:
        text, source = default_why(template_id, data)
        # a template text moves into the banner only when it shows whole there
        if source and not fits_banner(text):
            text, source = "", None
    view["why"], view["why_more"] = present_why(text)
    view["why_from"] = source
    return view


def task_brief(payload, registry):
    """kind and base only, for the run list. mark rides along when the
    completion wording is not the kind's own."""
    view = task_view(payload, registry)
    brief = {"kind": view["kind"], "base": view["base"]}
    if view.get("mark"):
        brief["mark"] = view["mark"]
    return brief
