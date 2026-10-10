"""Persistent run registry and result transitions."""
import json
import os
import threading
from datetime import timedelta, timezone
import base64
from pathlib import Path

from .identity import public_identity, resolve_identity
from .jsonutil import MAX_JSON_DEPTH, dumps, loads
from .media import (
    MediaEntry,
    MediaError,
    _path_is_inside_directory,
    open_validated_media,
    replace_media,
)
from .platform import directory_identity
from .results import ResultExists, write_result
from .schema import SchemaError, validate
from .timeutil import format_vienna, iso_now, to_vienna, vienna_now
from .webhook import fire_after_result


def _identity_parts(value):
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 2:
        raise MediaError("invalid media identity")
    parts = []
    for part in value:
        if isinstance(part, bool) or not isinstance(part, (int, str)):
            raise MediaError("invalid media identity")
        if isinstance(part, str):
            if not part.isascii() or not part.isdigit() or not part:
                raise MediaError("invalid media identity")
            parts.append(int(part))
        else:
            parts.append(part)
    return tuple(parts)


def _stored_media(entry):
    # File indexes are 64-bit. JSON numbers are not exact past 2^53, so the
    # identity is stored as decimal strings.
    item = {"path": str(entry.path), "content_type": entry.content_type}
    if entry.allowed_roots:
        item["roots"] = [str(root) for root in entry.allowed_roots]
    if entry.file_identity is not None:
        item["file_identity"] = [str(part) for part in entry.file_identity]
    if entry.root_identity is not None:
        item["root_identity"] = [str(part) for part in entry.root_identity]
    return item


def _media_entry(media_id, item, template=None):
    path = Path(item["path"])
    file_identity = _identity_parts(item.get("file_identity"))
    root_identity = _identity_parts(item.get("root_identity"))
    roots = tuple(Path(root) for root in item.get("roots") or ())
    template_path = None if template is None else template.path
    inside_template = (
        template_path is not None
        and _path_is_inside_directory(path, template_path)
    )
    # Missing identity fields must not turn template media into an unpinned
    # open. A path inside the template, or a record that carries only one of
    # the two pins, stays on the registry identity check.
    if file_identity is not None or root_identity is not None or inside_template:
        pinned = None if template is None else template.root_identity
        if (
            file_identity is None
            or root_identity is None
            or pinned is None
            or tuple(root_identity) != tuple(pinned)
        ):
            raise MediaError("media path is outside configured roots")
        if not roots:
            roots = (template_path,)
        return MediaEntry(
            media_id,
            path,
            item["content_type"],
            roots,
            file_identity,
            tuple(pinned),
        )
    # Unpinned media does not keep the roots stored in the run file.
    return MediaEntry(
        media_id,
        path,
        item["content_type"],
    )


class UnknownRun(KeyError):
    pass


class AlreadyDecided(RuntimeError):
    pass


class RunIdAlreadyUsed(ValueError):
    pointer = "/run_id"


class RunStore:
    def __init__(self, data_dir, registry, config, action_log):
        self.data_dir = Path(data_dir)
        self.registry = registry
        self.config = config
        self.action_log = action_log
        self.runs_dir = self.data_dir / "runs"
        self.results_dir = self.data_dir / "results"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._runs = {}
        self.media = {}
        self.avatars = {}  # sha256 -> (bytes, content type), served at /avatar/<sha256>
        # Test seam. Production leaves this None. A callable runs after the
        # schema has been read and before media registration: the window where
        # the template directory used to be resolved a second time.
        self.before_media_registration = None
        self._load()

    def _load(self):
        for path in self.runs_dir.glob("*.json"):
            try:
                record = loads(
                    path.read_text(encoding="utf-8"),
                    max_depth=MAX_JSON_DEPTH + 1,
                )
                if record["payload"]["template"] not in self.registry:
                    raise KeyError("unknown template")
                if (self.results_dir / f"{record['payload']['run_id']}.json").exists():
                    record["state"] = loads(
                        (self.results_dir / f"{record['payload']['run_id']}.json").read_text(encoding="utf-8")
                    )["status"]
                if not isinstance(record.get("identity"), dict):
                    # Older runs resolve identity from registries without rewriting storage.
                    record["identity"] = self._resolve_identity(record["payload"])
                self._remember_avatar(record["identity"])
                self._runs[record["payload"]["run_id"]] = record
                for media_id, item in record.get("media", {}).items():
                    try:
                        entry = _media_entry(
                            media_id,
                            item,
                            self.registry.get(record["payload"]["template"]),
                        )
                        with open_validated_media(
                            entry, self._media_roots_for_record(record)
                        ):
                            pass
                    except (KeyError, TypeError, MediaError):
                        self.action_log.write(
                            record["payload"]["run_id"],
                            "error",
                            {"what": "invalid_media", "media_id": media_id},
                        )
                        continue
                    self.media[media_id] = entry
            except (OSError, TypeError, ValueError, KeyError) as error:
                self.action_log.write(
                    path.stem,
                    "error",
                    {
                        "what": "run_load_failed",
                        "error": type(error).__name__,
                    },
                )

    def ids(self):
        return set(self._runs)

    def _resolve_identity(self, payload):
        template = self.registry.get(payload["template"])
        return resolve_identity(
            payload["bot"],
            payload.get("identity"),
            template_root=template.path if template is not None else None,
            template_identity=(
                template.root_identity if template is not None else None
            ),
            data_dir=self.data_dir,
            has_payload_identity="identity" in payload,
        )

    def _remember_avatar(self, identity):
        avatar = identity.get("avatar")
        if avatar:
            self.avatars[avatar["sha256"]] = (base64.b64decode(avatar["data"]), avatar["type"])

    def _log_identity(self, run_id, identity):
        for warning in identity.get("warnings", []):
            if warning["source"] == "accent":
                detail = {
                    "what": "accent_fallback",
                    "theme": warning["theme"],
                    "failed": warning["failed"],
                }
            else:
                detail = {
                    "what": "identity_invalid",
                    "source": warning["source"],
                    "field": warning["field"],
                    "reason": warning["reason"],
                }
            self.action_log.write(run_id, "warning", detail)

    def _save(self, record):
        run_id = record["payload"]["run_id"]
        target = self.runs_dir / f"{run_id}.json"
        temporary = target.with_suffix(".json.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(dumps(record, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)

    def register(self, payload):
        with self._lock:
            run_id = payload["run_id"]
            if run_id in self._runs or (self.results_dir / f"{run_id}.json").exists():
                raise RunIdAlreadyUsed("run id is already used")
            template = self.registry[payload["template"]]
            schema = loads(template.read_text("schema.json"))
            if self.before_media_registration is not None:
                self.before_media_registration(template)
            new_media = {}
            transformed = dict(payload)
            identity = self._resolve_identity(payload)
            transformed.pop("identity", None)
            transformed["data"] = replace_media(
                payload["data"],
                schema,
                self.config.get("media_roots", []),
                new_media,
                template.path,
                template_identity=template.root_identity,
            )
            created_utc = to_vienna(payload["created"]).astimezone(timezone.utc)
            expires = to_vienna(
                created_utc + timedelta(minutes=payload["expires_minutes"])
            )
            record = {
                "payload": transformed,
                "identity": identity,
                "state": "open",
                "unread": True,
                "expires": expires.isoformat(timespec="seconds"),
                "media": {
                    media_id: _stored_media(entry)
                    for media_id, entry in new_media.items()
                },
            }
            self._save(record)
            self._runs[run_id] = record
            self.media.update(new_media)
            self._remember_avatar(identity)
            self.action_log.write(run_id, "shown")
            self._log_identity(run_id, identity)
            return self.detail(run_id)

    def _display_bot(self, record, bots):
        identity = record.get("identity")
        if isinstance(identity, dict) and identity.get("name"):
            return identity["name"]
        slug = record["payload"]["bot"]
        return bots.get(slug, slug)

    def summaries(self, bots):
        with self._lock:
            records = [record for record in self._runs.values() if record["state"] == "open"]
            records.sort(
                key=lambda item: to_vienna(item["payload"]["created"]).astimezone(
                    timezone.utc
                ),
                reverse=True,
            )
            return [
                {
                    "run_id": item["payload"]["run_id"],
                    "template": item["payload"]["template"],
                    "title": item["payload"]["title"],
                    "bot": item["payload"]["bot"],
                    "bot_display": self._display_bot(item, bots),
                    "identity": public_identity(item["identity"], with_accent=False),
                    "created": to_vienna(item["payload"]["created"]).isoformat(timespec="seconds"),
                    "created_display": format_vienna(item["payload"]["created"]),
                    "state": item["state"],
                    "unread": item["unread"],
                }
                for item in records[:12]
            ]

    def detail(self, run_id, bots=None):
        with self._lock:
            try:
                record = self._runs[run_id]
            except KeyError as error:
                raise UnknownRun(run_id) from error
            payload = record["payload"]
            bots = bots or {}
            return {
                "run_id": run_id,
                "template": payload["template"],
                "template_version": payload["version"],
                "title": payload["title"],
                "bot": payload["bot"],
                "bot_display": self._display_bot(record, bots),
                "identity": public_identity(record["identity"], with_accent=True),
                "created": to_vienna(payload["created"]).isoformat(timespec="seconds"),
                "created_display": format_vienna(payload["created"]),
                "expires": record["expires"],
                "state": record["state"],
                "data": payload["data"],
                "result": self._submitted_data(run_id, record),
            }

    def _submitted_data(self, run_id, record):
        """Return the immutable submitted data for a read-only reopened run."""
        if record["state"] != "submitted":
            return None
        try:
            envelope = loads(
                (self.results_dir / f"{run_id}.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return None
        return envelope.get("data")

    def mark_read(self, run_id):
        with self._lock:
            if run_id not in self._runs:
                raise UnknownRun(run_id)
            self._runs[run_id]["unread"] = False
            self._save(self._runs[run_id])

    def decide(self, run_id, status, data=None):
        with self._lock:
            try:
                record = self._runs[run_id]
            except KeyError as error:
                raise UnknownRun(run_id) from error
            if record["state"] != "open" or (self.results_dir / f"{run_id}.json").exists():
                raise AlreadyDecided(run_id)
            payload = record["payload"]
            if status == "submitted":
                schema = loads(
                    self.registry[payload["template"]]
                    .read_text("result.schema.json")
                )
                validate(data, schema, "/data")
            decided = vienna_now()
            created = to_vienna(payload["created"])
            envelope = {
                "schema": "report-shell/result@1",
                "run_id": run_id,
                "template": payload["template"],
                "template_version": payload["version"],
                "bot": payload["bot"],
                "status": status,
                "created": created.isoformat(timespec="seconds"),
                "decided": decided.isoformat(timespec="seconds"),
                "duration_s": max(
                    0,
                    int(
                        (
                            decided.astimezone(timezone.utc)
                            - created.astimezone(timezone.utc)
                        ).total_seconds()
                    ),
                ),
                "log": str(self.action_log.path()),
            }
            if status == "submitted":
                envelope["data"] = data
            identity = record.get("identity") or {}
            if identity.get("accent_fallback") or identity.get("warnings"):
                # visible to the bot author: what the page could not use
                envelope["identity"] = {
                    "name": identity.get("name"),
                    "accent_fallback": list(identity.get("accent_fallback", [])),
                    "warnings": [
                        {key: value for key, value in warning.items() if key != "failed"}
                        for warning in identity.get("warnings", [])
                    ],
                }
            result_path = write_result(self.results_dir, run_id, envelope)
            record["state"] = status
            self._save(record)
            event = {"submitted": "submit", "cancelled": "cancel", "expired": "expire"}[status]
            self.action_log.write(run_id, event)
            notify = payload.get("notify", {}).get("webhook_url")
            body = {
                "run_id": run_id,
                "status": status,
                "template": payload["template"],
                "bot": payload["bot"],
                "result_path": str(result_path),
            }
            fire_after_result(notify, body, result_path, self.config, run_id, self.action_log)
            return result_path

    def expire_due(self):
        expired = []
        with self._lock:
            now = vienna_now()
            for run_id, record in list(self._runs.items()):
                if (
                    record["state"] == "open"
                    and to_vienna(record["expires"]).astimezone(timezone.utc)
                    <= now.astimezone(timezone.utc)
                ):
                    try:
                        self.decide(run_id, "expired")
                        expired.append(run_id)
                    except (AlreadyDecided, ResultExists):
                        pass
                    except Exception as error:
                        try:
                            self.action_log.write(
                                run_id,
                                "error",
                                {
                                    "what": "expire_failed",
                                    "error": type(error).__name__,
                                },
                            )
                        except Exception:
                            pass
        return expired

    def open_count(self):
        return sum(record["state"] == "open" for record in self._runs.values())

    def has(self, run_id):
        return run_id in self._runs

    def _current_template_root(self, template):
        """Registry template directory, only while it is still the pinned one.

        A junction or a different real directory at the same path is not a
        current root. resolve() would follow it and authorize whatever it
        points at.
        """
        if template is None or template.root_identity is None:
            return None
        try:
            current = directory_identity(template.path)
        except OSError:
            return None
        if tuple(current) != tuple(template.root_identity):
            return None
        return template.path

    def _media_roots_for_record(self, record):
        roots = list(self.config.get("media_roots", []))
        template = self.registry.get(record["payload"]["template"])
        current = self._current_template_root(template)
        if current is not None:
            roots.append(current)
        return roots

    def media_roots(self, media_id):
        run_id = self.media_run_id(media_id)
        record = self._runs.get(run_id)
        return (
            self._media_roots_for_record(record)
            if record is not None
            else list(self.config.get("media_roots", []))
        )

    def media_run_id(self, media_id):
        for run_id, record in self._runs.items():
            if media_id in record.get("media", {}):
                return run_id
        return None
