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
    """Per bot item, the labels it shows (its own, then the top-level ones,
    then the shared defaults in every UI language) differ; a due date is a
    real calendar day."""
    defaults = _default_labels()
    top = data.get("labels") or {}
    for index, item in enumerate(data.get("items") or []):
        here = _pointer(_pointer(pointer, "items"), index)
        due = item.get("due")
        if isinstance(due, str):
            try:
                date.fromisoformat(due)
            except ValueError as error:
                raise SchemaError(_pointer(here, "due"), "must be a real calendar date") from error
        if item.get("actor") == "user":
            continue
        own = item.get("labels") or {}
        shown = []
        for value in item.get("choices") or DEFAULT_CHOICES:
            if value in own:
                shown.append((value, {_same(own[value])}, _pointer(_pointer(here, "labels"), value)))
            elif value in top:
                shown.append((value, {_same(top[value])}, _pointer(_pointer(pointer, "labels"), value)))
            else:
                shown.append((value, defaults[value], None))
        for later, (value, labels, where) in enumerate(shown):
            for other, other_labels, other_where in shown[:later]:
                if labels & other_labels:
                    raise SchemaError(
                        where or other_where,
                        f"label repeats the {other if where else value} choice of this item",
                    )
    return data


RULES = {"decide-list": _decide_list}


def check_data(template_id, data, pointer=""):
    """Run the rules of a built-in (or a template that extends one)."""
    rule = RULES.get(template_id)
    if rule is not None and isinstance(data, dict):
        rule(data, pointer)
    return data
