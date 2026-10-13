"""Built-in data rules that JSON Schema cannot state, checked after the schema
at `show` and by `check`. A rule raises SchemaError with the pointer of the
offending value, so the bot sees the same kind of error as a schema error."""
import json
from datetime import date
from pathlib import Path

from .schema import SchemaError, _pointer


I18N = Path(__file__).resolve().parent / "i18n"
DEFAULT_CHOICES = ("approve", "reject", "defer")


def _default_labels():
    """The shared choice labels in every UI language, per choice value."""
    labels = {value: set() for value in DEFAULT_CHOICES}
    for path in sorted(I18N.glob("*.json")):
        table = json.loads(path.read_text(encoding="utf-8"))
        for value in DEFAULT_CHOICES:
            text = table.get(f"choice_{value}")
            if isinstance(text, str):
                labels[value].add(_same(text))
    return labels


def _same(text):
    return " ".join(text.split()).casefold()


def _decide_list(data, pointer):
    """A due date is a real calendar day (every item). Per bot item, the
    labels it shows (its own, then the top-level ones, then the shared
    defaults in every UI language) differ, and no custom label reads like
    another choice's default label: a swap (approve shown as "Reject",
    reject as "Approve") records the opposite of what the person read.

    Runs on the final data (after task.kind set the actors). A template that
    extends decide-list owns its schema, so odd shapes are skipped or
    reported at their pointer, never crash."""
    defaults = _default_labels()
    top = data.get("labels")
    top = top if isinstance(top, dict) else {}
    items = data.get("items")
    for index, item in enumerate(items if isinstance(items, list) else []):
        here = _pointer(_pointer(pointer, "items"), index)
        if not isinstance(item, dict):
            continue
        due = item.get("due")
        if isinstance(due, str):
            try:
                date.fromisoformat(due)
            except ValueError as error:
                raise SchemaError(_pointer(here, "due"), "must be a real calendar date") from error
        if item.get("actor") == "user":
            continue
        own = item.get("labels")
        own = own if isinstance(own, dict) else {}
        choices = item.get("choices")
        shown = []
        for value in choices if isinstance(choices, list) else DEFAULT_CHOICES:
            if not isinstance(value, str) or value not in defaults:
                continue
            for source, where in ((own, _pointer(_pointer(here, "labels"), value)),
                                  (top, _pointer(_pointer(pointer, "labels"), value))):
                if value in source:
                    if not isinstance(source[value], str):
                        raise SchemaError(where, "must be a string")
                    shown.append((value, {_same(source[value])}, where))
                    break
            else:
                shown.append((value, defaults[value], None))
        for later, (value, labels, where) in enumerate(shown):
            for other, other_labels, other_where in shown[:later]:
                if labels & other_labels:
                    raise SchemaError(
                        where or other_where,
                        f"label repeats the {other if where else value} choice of this item",
                    )
            if where is None:
                continue
            for other in DEFAULT_CHOICES:
                if other != value and labels & defaults[other]:
                    raise SchemaError(where, f"label reads like the {other} choice")
    return data


RULES = {"decide-list": _decide_list}


def check_data(template_id, data, pointer=""):
    """Run the rules of a built-in (or a template that extends one)."""
    rule = RULES.get(template_id)
    if rule is not None and isinstance(data, dict):
        rule(data, pointer)
    return data
