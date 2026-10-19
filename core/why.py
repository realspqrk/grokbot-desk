"""The why line of a report: sentence splitting and the banner's limits.

The banner shows up to three sentences and 360 characters; the rest folds.
A longer why is valid, it only earns a warning at `show`.
"""
import re

MAX_WHY = 360
MAX_WHY_SENTENCES = 3

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


def _boundaries(text):
    """Where one sentence ends and the next starts: (end, start) pairs.

    A line break always ends a sentence. A full stop does not when it closes
    an abbreviation (z. B., ca., Nr., Dr., d. h., u. a., bzw., e.g.) or an
    ordinal, a day or a date ("1. Schritt", "15. Mai", "Zum 100.", "Am
    31.12."); usw. and etc. end one only when a capital follows. "..." and
    "…" end one, and so does a year ("im Jahr 2026.").

    Accepted limitation: any other number or version before a full stop
    never ends a sentence, so "Es sind 12. Nicht deployen." and "Version
    2.4. Danach" stay one sentence. Telling a count from an ordinal needs
    context the text does not give; one long sentence only folds later.
    """
    for match in SENTENCE_GAP.finditer(text):
        gap = match.group(0)
        end = match.start() + len(gap) - len(gap.lstrip(CLOSERS))
        start = match.end()
        if "\n" not in gap and text[end - 1] == "." and _abbreviation(text[:end], text[start:]):
            continue
        yield end, start


# z.B., d.h., u.a., e.g., i.e.: single letters joined by dots
DOTTED_LETTERS = re.compile(r"^(?:[^\W\d_]\.)+[^\W\d_]$")
# digits and dots: an ordinal, a day or a date ("1.", "100.", "31.12.", "2.4.")
NUMBER = re.compile(r"^[0-9][0-9.]*$")
# a year ends a sentence: "im Jahr 2026."
YEAR = re.compile(r"^(?:19|20)[0-9]{2}$")


def _abbreviation(head, tail):
    if head.endswith("..."):
        return False  # an ASCII ellipsis ends a sentence like "…"
    word = ABBREV_TAIL.search(head)
    if not word:
        return False
    token = word.group(1).lower()
    if NUMBER.fullmatch(token):
        return not YEAR.fullmatch(token)
    if (len(token) == 1 and token.isalpha()) or DOTTED_LETTERS.fullmatch(token):
        return True
    if token in MAYBE_END:
        return not tail[:1].isupper()
    # any dotted word (example.com.) ends the sentence
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
            f"/why: longer than {MAX_WHY_SENTENCES} sentences; "
            "the banner shows the first three and folds the rest"
        )
    if len(why) > MAX_WHY:
        notes.append(
            f"/why: longer than {MAX_WHY} characters; "
            "the banner shows the start and folds the rest"
        )
    return notes
