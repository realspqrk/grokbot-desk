"""Persistent report store and result transitions."""
import base64
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .doorbell import Doorbell
from .envelope import SCHEMA
from .identity import IdentityIssue, public_identity, resolve_identity, validate_name
from .jsonutil import MAX_JSON_DEPTH, dumps, loads
from .media import MediaEntry, MediaError, open_validated_media, replace_block_media
from .payload import BLOCK_SCHEMAS, ResultError, validate_result
from .results import ResultExists, write_result
from .timeutil import format_local, to_local, local_now


RESULT_SCHEMA = "grokbot-desk/result@2"
# payload fields the page never needs (the store's own bookkeeping)
INTERNAL = ("schema", "identity", "run_id", "expires_minutes", "dedupe_key", "dedupe_hours")


def _payload_name(payload):
    identity = payload.get("identity")
    try:
        return validate_name(identity.get("name")) if isinstance(identity, dict) else None
    except IdentityIssue:
        return None


def _stored_media(entry):
    return {"path": str(entry.path), "content_type": entry.content_type}


def _media_entry(media_id, item):
    # a pinned record (template media of a desk before payload@2) is not
    # served: there is no template directory to check it against any more
    if "file_identity" in item or "root_identity" in item:
        raise MediaError("media path is outside configured roots")
    return MediaEntry(media_id, Path(item["path"]), item["content_type"])


class UnknownRun(KeyError):
    pass


class AlreadyDecided(RuntimeError):
    pass


class RunIdAlreadyUsed(ValueError):
    pointer = "/run_id"


def read_record(path):
    """A stored run record. The one reader: the store and cleanup share it,
    so a payload at the accepted depth (record depth + 1) parses in both."""
    return loads(Path(path).read_text(encoding="utf-8"), max_depth=MAX_JSON_DEPTH + 1)


class RunStore:
    def __init__(self, data_dir, config, action_log):
        self.data_dir = Path(data_dir)
        self.config = config
        self.action_log = action_log
        self.doorbell = Doorbell(self.data_dir, action_log)
        self.runs_dir = self.data_dir / "runs"
        self.results_dir = self.data_dir / "results"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._runs = {}
        self._legacy = []  # open payload@1 records, expired by expire_legacy
        self.media = {}
        self.avatars = {}  # sha256 -> (bytes, content type), served at /avatar/<sha256>
        self._load()

    def _load(self):
        for path in self.runs_dir.glob("*.json"):
            try:
                record = read_record(path)
                if not isinstance(record["payload"], dict):
                    raise TypeError("payload is not an object")
                if record["payload"].get("schema") != SCHEMA:
                    # a report from before payload@2: its result file (if
                    # any) stays readable; the store does not serve it
                    self.action_log.write(
                        path.stem, "warning", {"what": "run_skipped", "reason": "payload@1"}
                    )
                    if record.get("state") == "open" and isinstance(record["payload"].get("run_id"), str):
                        self._legacy.append(record)
                    continue
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
                        entry = _media_entry(media_id, item)
                        with open_validated_media(entry, self.media_roots()):
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
        self._migrate_legacy_seq()

    def _valid_seq(self, record):
        seq = record.get("seq")
        return isinstance(seq, int) and not isinstance(seq, bool)

    def _migrate_legacy_seq(self):
        """Number records saved before seq existed, in created order.

        Those numbers come first, so a later registration stays after them.
        Records that already have a seq keep their order after that cohort.
        """
        legacy = []
        sequenced = []
        for record in self._runs.values():
            if self._valid_seq(record):
                sequenced.append(record)
            else:
                legacy.append(record)
        if not legacy:
            return

        def created_key(record):
            payload = record.get("payload") or {}
            try:
                created = to_local(payload["created"]).astimezone(timezone.utc)
            except (TypeError, ValueError, OverflowError, KeyError):
                created = datetime.max.replace(tzinfo=timezone.utc)
            return (created, str(payload.get("run_id") or ""))

        legacy.sort(key=created_key)
        sequenced.sort(key=lambda record: record["seq"])
        for index, record in enumerate([*legacy, *sequenced], start=1):
            if record.get("seq") != index:
                record["seq"] = index
                self._save(record)

    def ids(self):
        return set(self._runs)

    def _resolve_identity(self, payload):
        return resolve_identity(
            payload["bot"],
            payload.get("identity"),
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

    def find_duplicate(self, payload):
        """An earlier run of the same bot with the same dedupe_key that is
        still open, or was submitted or dismissed within dedupe_hours (an
        expired run was never answered, so it does not count)."""
        key = payload.get("dedupe_key")
        if not key:
            return None
        hours = payload.get("dedupe_hours", 24)
        since = local_now().astimezone(timezone.utc) - timedelta(hours=hours)
        with self._lock:
            best = None
            for run_id, record in self._runs.items():
                earlier = record["payload"]
                if earlier.get("dedupe_key") != key or earlier["bot"] != payload["bot"]:
                    continue
                if record["state"] == "open":
                    return run_id
                if record["state"] not in ("submitted", "cancelled"):
                    continue
                try:
                    decided = to_local(loads(
                        (self.results_dir / f"{run_id}.json").read_text(encoding="utf-8")
                    )["decided"]).astimezone(timezone.utc)
                except (OSError, ValueError, KeyError, TypeError):
                    continue
                if decided >= since and (best is None or decided > best[1]):
                    best = (run_id, decided)
            return best[0] if best else None

    def register(self, payload):
        with self._lock:
            run_id = payload["run_id"]
            if (
                run_id in self._runs
                or (self.results_dir / f"{run_id}.json").exists()
                or (self.runs_dir / f"{run_id}.json").exists()
            ):
                raise RunIdAlreadyUsed("run id is already used")
            new_media = {}
            transformed = dict(payload)
            identity = self._resolve_identity(payload)
            transformed.pop("identity", None)
            transformed["blocks"] = replace_block_media(
                payload["blocks"], BLOCK_SCHEMAS, self.media_roots(), new_media
            )
            # Registration order. The page seeds the strip from this because
            # a bot's created stamp can be skewed. A record saved before seq
            # existed is numbered on load, in created order, ahead of these.
            created_utc = to_local(payload["created"]).astimezone(timezone.utc)
            expires = to_local(
                created_utc + timedelta(minutes=payload["expires_minutes"])
            )
            record = {
                "payload": transformed,
                "identity": identity,
                "state": "open",
                "unread": True,
                "seq": self._next_seq(),
                # the doorbell names the bot as its payload did (the Grok Bot
                # name), never a registry display name
                "bot_name": _payload_name(payload),
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
                key=lambda item: to_local(item["payload"]["created"]).astimezone(
                    timezone.utc
                ),
                reverse=True,
            )
            listed = []
            for item in records[:12]:
                payload = item["payload"]
                summary = {
                    "run_id": payload["run_id"],
                    "title": payload["title"],
                    "ask": payload["ask"],
                    "urgent": payload.get("urgent", False),
                    "due": payload.get("due"),
                    "bot": payload["bot"],
                    "bot_display": self._display_bot(item, bots),
                    "identity": public_identity(item["identity"], with_accent=False),
                    "created": to_local(payload["created"]).isoformat(timespec="seconds"),
                    "created_display": format_local(payload["created"]),
                    "state": item["state"],
                    "unread": item["unread"],
                }
                seq = item.get("seq")
                if isinstance(seq, int) and not isinstance(seq, bool):
                    summary["seq"] = seq
                listed.append(summary)
            return listed

    def detail(self, run_id, bots=None):
        with self._lock:
            try:
                record = self._runs[run_id]
            except KeyError as error:
                raise UnknownRun(run_id) from error
            payload = record["payload"]
            bots = bots or {}
            detail = {"run_id": run_id}
            detail.update((key, value) for key, value in payload.items() if key not in INTERNAL)
            detail.update({
                "created": to_local(payload["created"]).isoformat(timespec="seconds"),
                "created_display": format_local(payload["created"]),
                "bot_display": self._display_bot(record, bots),
                "identity": public_identity(record["identity"], with_accent=True),
                "state": record["state"],
                "expires": record["expires"],
                # the page draws a media id as an image or a video
                "media_types": {
                    media_id: item.get("content_type", "")
                    for media_id, item in record.get("media", {}).items()
                },
            })
            result = self._submitted_data(run_id, record)
            if result is not None:
                detail["result"] = result
            return detail

    def payload(self, run_id):
        """The stored payload (media paths replaced by media ids)."""
        with self._lock:
            try:
                return self._runs[run_id]["payload"]
            except KeyError as error:
                raise UnknownRun(run_id) from error

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
            # every focus of a window posts /read; an already read run is not
            # rewritten, so a burst of focus events does not queue fsyncs
            # under the lock every API read waits on
            if self._runs[run_id].get("unread") is False:
                return
            self._runs[run_id]["unread"] = False
            self._save(self._runs[run_id])

    def decide(self, run_id, status, data=None, by_bot=False, reason=None):
        """Write the result. Every end the bot did not cause itself (its own
        `cancel` is by_bot) rings the doorbell."""
        with self._lock:
            try:
                record = self._runs[run_id]
            except KeyError as error:
                raise UnknownRun(run_id) from error
            if record["state"] != "open" or (self.results_dir / f"{run_id}.json").exists():
                raise AlreadyDecided(run_id)
            payload = record["payload"]
            if status == "submitted":
                try:
                    data = validate_result(payload, data)
                except ResultError as error:
                    raise ResultError("/data" + error.pointer, error.message) from error
            decided = local_now()
            created = to_local(payload["created"])
            envelope = {
                "schema": RESULT_SCHEMA,
                "run_id": run_id,
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
            self._finish(record, status, by_bot, reason)
            return result_path

    def _finish(self, record, status, by_bot=False, reason=None):
        """After the result file exists: save the state, log, ring the doorbell."""
        payload = record["payload"]
        run_id = payload["run_id"]
        record["state"] = status
        self._save(record)
        event = {"submitted": "submit", "cancelled": "cancel", "expired": "expire"}[status]
        self.action_log.write(run_id, event, {"reason": reason} if reason else None)
        if not by_bot:
            body = {
                "bot": payload["bot"],
                "bot_name": record.get("bot_name") or payload["bot"],
                "run_id": run_id,
                "status": status,
                "title": payload["title"],
            }
            self.doorbell.ring(run_id, body)

    def expire_legacy(self):
        """Expire every open payload@1 report once (reason "upgrade") so its
        bot asks again. Idempotent: a restart after a crash between the
        result file and the saved record finishes the job without a second
        result. Returns the run ids it wrote a result for."""
        expired = []
        with self._lock:
            pending, self._legacy = self._legacy, []
            for record in pending:
                run_id = record["payload"]["run_id"]
                try:
                    result = self.results_dir / f"{run_id}.json"
                    if result.exists():
                        # an interrupted earlier try: keep its result as is
                        status = loads(result.read_text(encoding="utf-8"))["status"]
                        self._finish(record, status, reason="upgrade")
                        continue
                    # decide() writes the same result as any expiry
                    self._runs[run_id] = record
                    try:
                        self.decide(run_id, "expired", reason="upgrade")
                    finally:
                        self._runs.pop(run_id, None)
                    expired.append(run_id)
                except (AlreadyDecided, ResultExists):
                    pass
                except Exception as error:
                    self._legacy.append(record)
                    self.action_log.write(
                        run_id, "error", {"what": "upgrade_failed", "error": type(error).__name__}
                    )
        return expired

    def expire_due(self):
        expired = []
        with self._lock:
            now = local_now()
            for run_id, record in list(self._runs.items()):
                if (
                    record["state"] == "open"
                    and to_local(record["expires"]).astimezone(timezone.utc)
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

    def media_roots(self, media_id=None):
        """The media roots configured now (a saved run's roots are not an allowlist)."""
        return list(self.config.get("media_roots", []))

    def _next_seq(self):
        best = 0
        for record in self._runs.values():
            seq = record.get("seq")
            if isinstance(seq, int) and not isinstance(seq, bool) and seq > best:
                best = seq
        return best + 1

    def has_media(self, run_id, media_id):
        record = self._runs.get(run_id)
        return record is not None and media_id in record.get("media", {})

    def media_run_id(self, media_id):
        for run_id, record in self._runs.items():
            if media_id in record.get("media", {}):
                return run_id
        return None
