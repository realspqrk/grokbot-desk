"""Persistent run registry and result transitions."""
import json
import os
import threading
from datetime import timedelta, timezone
from pathlib import Path

from .jsonutil import MAX_JSON_DEPTH, dumps, loads
from .media import MediaEntry, MediaError, open_validated_media, replace_media
from .results import ResultExists, write_result
from .schema import SchemaError, validate
from .timeutil import format_vienna, iso_now, to_vienna, vienna_now
from .webhook import fire_after_result


class UnknownRun(KeyError):
    pass


class AlreadyDecided(RuntimeError):
    pass


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
                self._runs[record["payload"]["run_id"]] = record
                for media_id, item in record.get("media", {}).items():
                    try:
                        entry = MediaEntry(
                            media_id, Path(item["path"]), item["content_type"]
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
                raise ValueError("run id is already used")
            template = self.registry[payload["template"]]
            schema = loads((template.path / "schema.json").read_text(encoding="utf-8"))
            new_media = {}
            transformed = dict(payload)
            transformed["data"] = replace_media(
                payload["data"], schema, self.config.get("media_roots", []), new_media, template.path
            )
            created_utc = to_vienna(payload["created"]).astimezone(timezone.utc)
            expires = to_vienna(
                created_utc + timedelta(minutes=payload["expires_minutes"])
            )
            record = {
                "payload": transformed,
                "state": "open",
                "unread": True,
                "expires": expires.isoformat(timespec="seconds"),
                "media": {
                    media_id: {"path": str(entry.path), "content_type": entry.content_type}
                    for media_id, entry in new_media.items()
                },
            }
            self._save(record)
            self._runs[run_id] = record
            self.media.update(new_media)
            self.action_log.write(run_id, "shown")
            return self.detail(run_id)

    def _display_bot(self, slug, bots):
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
                    "bot_display": self._display_bot(item["payload"]["bot"], bots),
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
                "bot_display": self._display_bot(payload["bot"], bots),
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
                    (self.registry[payload["template"]].path / "result.schema.json").read_text(encoding="utf-8")
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

    def _media_roots_for_record(self, record):
        roots = list(self.config.get("media_roots", []))
        template = self.registry.get(record["payload"]["template"])
        if template is not None:
            roots.append(template.path)
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
