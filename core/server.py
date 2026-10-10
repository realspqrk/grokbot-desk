"""Local guarded HTTP server for grokbot-desk."""
import json
import os
import queue
import re
import secrets
import select
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__
from .actionlog import ActionLog
from .check import contract_findings
from .envelope import EnvelopeError, MAX_PAYLOAD, validate_payload_bytes
from .identity import SHIPPED_REGISTRY, display_names, load_registry
from .jsonutil import JSONBoundaryError, dumps as json_dumps, loads as json_loads
from .launch_coordination import (
    clear_launch_pending_coordinated,
    pending_launch_generation,
)
from .media import MediaError, open_validated_media
from .page import build_page
from .paths import ensure_layout, load_config
from .platform import (
    ALLOW_REUSE_ADDRESS,
    ClipboardBusy,
    ClipboardError,
    ClipboardTimeout,
    ClipboardUnavailable,
    install_signal_handlers,
    request_attention,
    reveal_file,
    utf16_units,
    write_clipboard,
)
from .platform_types import LaunchResult
from .product import RUNNER_ID
from .registry import RegistryError, scan_registry
from .runs import AlreadyDecided, RunIdAlreadyUsed, RunStore, UnknownRun
from .schema import SchemaError
from .webhook import validate_webhook_url


CSP = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
)
STATIC_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}
SID_RE = re.compile(r"^[0-9a-f]{32}$")
AVATAR_RE = re.compile(r"^[0-9a-f]{64}$")
GENERATED_RUN_ID_ATTEMPTS = 8


def retain_recent(data_dir, days=30):
    cutoff = time.time() - days * 86400
    for folder_name in ("runs", "results", "log"):
        folder = Path(data_dir) / folder_name
        for path in folder.glob("*"):
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                pass


class SSEHub:
    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers = {}
        self._page_generations = {}
        # P8d fix2: launch generation -> the one sid that owns its app window
        self._app_owners = {}
        self._next_id = 0

    def subscribe(
        self,
        test_client,
        sid=None,
        writer=None,
        sock=None,
        launch_generation=None,
    ):
        with self._lock:
            if not test_client and sid is not None:
                launch_generation = self._page_generations.setdefault(
                    sid, launch_generation
                )
            self._next_id += 1
            subscriber = {
                "queue": queue.Queue(),
                "test": test_client,
                "last_write": 0.0,
                "sid": sid,
                "writer": writer,
                "socket": sock,
                "closed": threading.Event(),
                "launch_generation": launch_generation,
            }
            self._subscribers[self._next_id] = subscriber
            return self._next_id, subscriber

    def claim_app_window(self, sid, token, launch_generation, previous=None):
        """P8d fix2: a launch's app window belongs to exactly one page. The
        first stream presenting the pending launch's token claims it under
        the hub lock, before any page is told; the same page (sid)
        reconnecting keeps it. A new page in the app window (a reload)
        names the page it replaces (`previous`, kept in that window only)
        and takes over once that page's streams are gone; a live owner is
        never displaced. Every other page is refused."""
        if (
            sid is None
            or not isinstance(token, str)
            or SID_RE.fullmatch(token) is None
        ):
            return False
        if not isinstance(previous, str) or SID_RE.fullmatch(previous) is None:
            previous = None
        with self._lock:
            owner = self._app_owners.get(token)
        if owner is not None and owner != sid and owner == previous:
            # the replaced page's stream may not have been noticed gone yet
            self._probe_sid(owner)
        with self._lock:
            owner = self._app_owners.get(token)
            if owner is None:
                if not (
                    isinstance(launch_generation, str)
                    and secrets.compare_digest(token, launch_generation)
                ):
                    return False
            elif not secrets.compare_digest(owner, sid):
                if previous is None or not secrets.compare_digest(owner, previous):
                    return False
                if any(item["sid"] == owner for item in self._subscribers.values()):
                    return False
            self._app_owners[token] = sid
            return True

    def _drop_locked(self, subscriber_id):
        subscriber = self._subscribers.pop(subscriber_id, None)
        if subscriber is not None:
            subscriber["closed"].set()
            subscriber["queue"].put(None)

    def remove(self, subscriber_id):
        with self._lock:
            self._drop_locked(subscriber_id)

    def bye(self, sid):
        with self._lock:
            matched = False
            launch_generation = None
            for subscriber_id, subscriber in list(self._subscribers.items()):
                if subscriber["sid"] == sid:
                    if not matched:
                        launch_generation = subscriber["launch_generation"]
                    matched = True
                    self._drop_locked(subscriber_id)
            return matched, launch_generation

    def mark_write(self, subscriber_id):
        with self._lock:
            if subscriber_id in self._subscribers:
                self._subscribers[subscriber_id]["last_write"] = time.monotonic()

    def broadcast(self, event, data):
        encoded = f"event: {event}\ndata: {json_dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"
        with self._lock:
            for subscriber in self._subscribers.values():
                subscriber["queue"].put(encoded)

    def window_alive(self):
        now = time.monotonic()
        with self._lock:
            return any(
                not item["test"] and now - item["last_write"] < 20
                for item in self._subscribers.values()
            )

    def _probe(self, subscriber_id, subscriber):
        peer = subscriber["socket"]
        if peer is not None:
            try:
                if select.select([peer], [], [], 0)[0] and not peer.recv(
                    1, socket.MSG_PEEK
                ):
                    self.remove(subscriber_id)
                    return
            except (ConnectionResetError, OSError, ValueError):
                self.remove(subscriber_id)
                return
        try:
            subscriber["writer"](": ping\n\n")
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            self.remove(subscriber_id)
        else:
            self.mark_write(subscriber_id)

    def _probe_sid(self, sid):
        with self._lock:
            subscribers = [
                item for item in self._subscribers.items() if item[1]["sid"] == sid
            ]
        for subscriber_id, subscriber in subscribers:
            if subscriber["writer"] is not None:
                self._probe(subscriber_id, subscriber)

    def probe_window(self):
        with self._lock:
            subscribers = list(self._subscribers.items())
        for subscriber_id, subscriber in subscribers:
            if subscriber["test"] or subscriber["writer"] is None:
                continue
            self._probe(subscriber_id, subscriber)
        return self.window_alive()

    def has_subscribers(self):
        with self._lock:
            return bool(self._subscribers)


class ReportHTTPServer(ThreadingHTTPServer):
    # Darwin permits rapid rebinding after TIME_WAIT; a live exact-address
    # listener still fails. Neither backend enables SO_REUSEPORT.
    allow_reuse_address = ALLOW_REUSE_ADDRESS
    daemon_threads = True
    # a page opens its stylesheets, scripts, events and API in parallel; with
    # socketserver's backlog of 5 Windows resets the surplus connections
    request_queue_size = 128

    def server_bind(self):
        # HTTPServer.server_bind calls socket.getfqdn(), which can stall
        # for ~35 s on macOS before listen(); the name is never used.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def __init__(self, address, handler, data_dir, registry, config):
        if registry:
            repo_root = registry.templates_root.parent
            findings = contract_findings(registry, repo_root)
            if findings:
                raise RegistryError("; ".join(findings))
        super().__init__(address, handler)
        self.data_dir = Path(data_dir)
        self.registry = registry
        self.config = config
        self.port = address[1]
        self.token = secrets.token_urlsafe(32)
        self.csrf = secrets.token_urlsafe(32)
        # display names of the shipped registry (runs carry their resolved identity)
        self.bots = display_names(load_registry(SHIPPED_REGISTRY, "shipped")[0])
        self.action_log = ActionLog(data_dir)
        self.runs = RunStore(data_dir, registry, config, self.action_log)
        self.hub = SSEHub()
        self.window_title = None
        self.page = build_page(registry, self.csrf, self.port).encode("utf-8")
        self.static_dir = Path(__file__).parent / "static"
        # relative posix names ("rs.js", "icons/icon.svg"): a request can only
        # reach a file listed here
        self.static_files = {
            path.relative_to(self.static_dir).as_posix(): path
            for path in self.static_dir.rglob("*") if path.is_file()
        }
        self.stopping = threading.Event()
        self.last_activity = time.monotonic()
        self.idle_since = (
            self.last_activity if self.runs.open_count() == 0 else None
        )

    def touch(self):
        self.last_activity = time.monotonic()

    def broadcast_runs(self, run_id=None, state=None):
        self.hub.broadcast("runs", {"runs": self.runs.summaries(self.bots)})
        if run_id:
            self.hub.broadcast("run", {"run_id": run_id, "state": state})


class Handler(BaseHTTPRequestHandler):
    server_version = "report-shell"
    sys_version = ""

    def log_message(self, format, *args):
        return

    def _headers(self, status, content_type="application/json; charset=utf-8", length=None, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, status, value):
        body = (json_dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self._headers(status, length=len(body))
        self.wfile.write(body)

    def _host_ok(self):
        return self.headers.get("Host") in {
            f"127.0.0.1:{self.server.port}", f"localhost:{self.server.port}"
        }

    def _require_host(self):
        if not self._host_ok():
            self._json(403, {"error": "forbidden_host"})
            return False
        return True

    def _require_csrf(self):
        if self.headers.get("X-RS-CSRF") != self.server.csrf:
            self._json(403, {"error": "csrf"})
            return False
        return True

    def _require_origin(self):
        if self.headers.get("Origin") != f"http://127.0.0.1:{self.server.port}":
            self._json(403, {"error": "origin"})
            return False
        return True

    def _require_token(self):
        if self.headers.get("X-RS-Token") != self.server.token:
            self._json(403, {"error": "token"})
            return False
        return True

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "invalid_content_length"})
            return None
        if length > MAX_PAYLOAD:
            remaining = min(length, MAX_PAYLOAD + 1)
            while remaining:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._json(413, {"error": "body_too_large"})
            return None
        raw = self.rfile.read(length)
        try:
            return raw, json_loads(raw or b"{}")
        except JSONBoundaryError as error:
            self._json(
                400,
                {
                    "error": "invalid_json",
                    "pointer": error.pointer,
                },
            )
            return None
        except (UnicodeDecodeError, ValueError):
            self._json(400, {"error": "invalid_json"})
            return None

    def _action_body(self, value, required, optional=None):
        optional = optional or {}
        if not isinstance(value, dict):
            self._json(400, {"error": "body_must_be_object", "pointer": "/"})
            return False
        allowed = {**required, **optional}
        for name in required:
            if name not in value:
                self._json(400, {"error": "required_field", "pointer": f"/{name}"})
                return False
        for name in value:
            if name not in allowed:
                self._json(400, {"error": "unknown_field", "pointer": f"/{name}"})
                return False
            expected = allowed[name]
            if expected is not None and not isinstance(value[name], expected):
                self._json(400, {"error": "invalid_field_type", "pointer": f"/{name}"})
                return False
        return True

    def _log_invalid_media(self, media_id, run_id=None):
        self.server.action_log.write(
            run_id or self.server.runs.media_run_id(media_id),
            "error",
            {"what": "invalid_media", "media_id": media_id},
        )

    def do_GET(self):
        if not self._require_host():
            return
        self.server.touch()
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/":
            self._headers(200, "text/html; charset=utf-8", len(self.server.page))
            self.wfile.write(self.server.page)
        elif path == "/hello":
            self._json(200, {
                "runner": RUNNER_ID,
                "version": __version__,
                "pid": os.getpid(),
                "port": self.server.port,
                "open_runs": self.server.runs.open_count(),
                "window_alive": self.server.hub.probe_window(),
                "window_title": self.server.window_title,
            })
        elif path == "/events":
            query = parse_qs(parsed.query, keep_blank_values=True)
            self._events(
                "test" in query.get("client", []),
                query.get("sid", [None])[-1],
                query.get("app", [None])[-1],
                query.get("prev", [None])[-1],
            )
        elif path == "/api/runs":
            if self._require_csrf():
                self._json(200, {"runs": self.server.runs.summaries(self.server.bots)})
        elif path.startswith("/api/run/"):
            if not self._require_csrf():
                return
            run_id = unquote(path.removeprefix("/api/run/"))
            try:
                self._json(200, self.server.runs.detail(run_id, self.server.bots))
            except UnknownRun:
                self._json(404, {"error": "unknown_run"})
        elif path.startswith("/media/"):
            media_id = unquote(path.removeprefix("/media/"))
            entry = self.server.runs.media.get(media_id)
            if not entry:
                self._json(404, {"error": "unknown_media"})
                return
            try:
                with open_validated_media(
                    entry, self.server.runs.media_roots(media_id)
                ) as (handle, _):
                    body = handle.read()
            except MediaError:
                self._log_invalid_media(media_id)
                self._json(404, {"error": "invalid_media"})
                return
            self._headers(200, entry.content_type, len(body))
            self.wfile.write(body)
        elif path.startswith("/avatar/"):
            sha = path.removeprefix("/avatar/")
            avatar = self.server.runs.avatars.get(sha) if AVATAR_RE.fullmatch(sha) else None
            if avatar is None:
                self._json(404, {"error": "unknown_avatar"})
                return
            body, content_type = avatar
            # content-addressed: the rail re-renders without refetching
            self._headers(200, content_type, len(body), cache="private, max-age=86400, immutable")
            self.wfile.write(body)
        elif path.startswith("/static/") or path == "/favicon.ico":
            name = "icons/favicon.ico" if path == "/favicon.ico" else unquote(path.removeprefix("/static/"))
            source = self.server.static_files.get(name) if "\\" not in name else None
            if source is None:
                self._json(404, {"error": "not_found"})
                return
            body = source.read_bytes()
            self._headers(200, STATIC_TYPES.get(source.suffix, "application/octet-stream"), len(body))
            self.wfile.write(body)
        else:
            self._json(404, {"error": "not_found"})

    def _events(self, test_client, sid, app_token=None, previous=None):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        write_lock = threading.Lock()

        def write_message(message):
            with write_lock:
                self.wfile.write(message.encode("utf-8"))
                self.wfile.flush()

        launch_generation = (
            None
            if test_client
            else pending_launch_generation(self.server.data_dir)
        )
        subscriber_id, subscriber = self.server.hub.subscribe(
            test_client,
            sid=sid if isinstance(sid, str) and SID_RE.fullmatch(sid) else None,
            writer=write_message,
            sock=self.connection,
            launch_generation=launch_generation,
        )
        launch_generation = subscriber["launch_generation"]
        # P8d: the page the CLI launched with --app presents that launch's
        # one-time token (?app=); only it may close itself after its last
        # decision. The first page presenting it claims it (hub, atomic); a
        # reload in that window names the page it replaces (?prev=).
        app_window = not test_client and self.server.hub.claim_app_window(
            subscriber["sid"], app_token, launch_generation, previous
        )
        initial = (
            "retry: 1000\n"
            + ('event: window\ndata: {"app":true}\n\n' if app_window else "")
            + f"event: runs\ndata: {json_dumps({'runs': self.server.runs.summaries(self.server.bots)}, separators=(',', ':'))}\n\n"
        )
        try:
            write_message(initial)
            self.server.hub.mark_write(subscriber_id)
            if not test_client:
                _clear_browser_launch_pending(
                    self.server.data_dir, launch_generation
                )
            while not self.server.stopping.is_set():
                try:
                    message = subscriber["queue"].get(timeout=15)
                except queue.Empty:
                    message = ": hb\n\n"
                if message is None or subscriber["closed"].is_set():
                    break
                write_message(message)
                self.server.hub.mark_write(subscriber_id)
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            pass
        finally:
            self.close_connection = True
            self.server.hub.remove(subscriber_id)
            if not test_client:
                _clear_browser_launch_pending(
                    self.server.data_dir, launch_generation
                )

    def do_POST(self):
        if not self._require_host():
            return
        path = urlsplit(self.path).path
        token_route = path in {"/push", "/stop"}
        if token_route:
            if not self._require_token():
                return
        elif not self._require_origin() or not self._require_csrf():
            return
        body = self._body()
        if body is None:
            return
        raw, value = body
        self.server.touch()
        if path == "/push":
            self._push(raw, value)
        elif path == "/stop":
            if not self._action_body(value, {}):
                return
            self._json(200, {"ok": True})
            self.server.stopping.set()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        elif path == "/copy":
            if not self._action_body(value, {"text": str}, {"run_id": str}):
                return
            self._copy(value)
        elif path == "/submit":
            if not self._action_body(value, {"run_id": str, "data": None}):
                return
            self._decide(value, "submitted")
        elif path == "/cancel":
            if not self._action_body(value, {"run_id": str}):
                return
            self._decide(value, "cancelled")
        elif path == "/read":
            if not self._action_body(value, {"run_id": str}):
                return
            try:
                self.server.runs.mark_read(value.get("run_id"))
                self._json(200, {"ok": True})
            except UnknownRun:
                self._json(404, {"error": "unknown_run"})
        elif path == "/bye":
            if not self._action_body(value, {"sid": str}):
                return
            if SID_RE.fullmatch(value["sid"]) is None:
                self._json(400, {"error": "invalid_sid", "pointer": "/sid"})
            else:
                matched, launch_generation = self.server.hub.bye(
                    value["sid"]
                )
                if matched:
                    _clear_browser_launch_pending(
                        self.server.data_dir, launch_generation
                    )
                self._json(200, {"ok": True})
        elif path == "/title":
            if not self._action_body(value, {"title": str}):
                return
            if not 1 <= len(value["title"]) <= 300:
                self._json(400, {"error": "invalid_title", "pointer": "/title"})
            else:
                self.server.window_title = value["title"]
                self._json(200, {"ok": True})
        elif path == "/log":
            if not self._action_body(
                value, {"run_id": str, "event": str, "detail": dict}
            ):
                return
            detail = value["detail"]
            invalid_detail = next(
                (
                    key
                    for key, item in detail.items()
                    if key not in {"item", "choice"}
                    or not isinstance(item, str)
                    or len(item) > 200
                ),
                None,
            )
            if invalid_detail is not None:
                self._json(
                    400,
                    {"error": "invalid_log_detail", "pointer": f"/detail/{invalid_detail}"},
                )
            elif value["event"] != "choice" or not self.server.runs.has(value["run_id"]):
                self._json(400, {"error": "invalid_log_event"})
            else:
                safe_detail = {
                    key: detail[key] for key in ("item", "choice") if key in detail
                }
                self.server.action_log.write(value["run_id"], "choice", safe_detail)
                self._json(200, {"ok": True})
        elif path == "/reveal":
            if not self._action_body(value, {"run_id": str, "media_id": str}):
                return
            entry = self.server.runs.media.get(value.get("media_id"))
            if not entry or not self.server.runs.has(value.get("run_id")):
                self._json(404, {"error": "unknown_media"})
            else:
                try:
                    with open_validated_media(
                        entry, self.server.runs.media_roots(value["media_id"])
                    ) as (_, final_path):
                        reveal_path = final_path
                except MediaError:
                    self._log_invalid_media(
                        value["media_id"], value["run_id"]
                    )
                    self._json(
                        400, {"error": "invalid_media", "pointer": "/media_id"}
                    )
                else:
                    try:
                        reveal_file(reveal_path)
                    except OSError:
                        self._json(500, {"error": "reveal_failed"})
                    else:
                        self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not_found"})

    def _push(self, raw, value):
        explicit_run_id = isinstance(value, dict) and "run_id" in value
        attempts = 1 if explicit_run_id else GENERATED_RUN_ID_ATTEMPTS
        try:
            for attempt in range(attempts):
                used_ids = self.server.runs.ids() if explicit_run_id else ()
                payload = validate_payload_bytes(
                    raw, self.server.registry, used_ids
                )
                notify = payload.get("notify", {}).get("webhook_url")
                if notify:
                    validate_webhook_url(notify, self.server.config)
                try:
                    self.server.runs.register(payload)
                except RunIdAlreadyUsed:
                    if attempt == attempts - 1:
                        raise
                else:
                    break
        except (EnvelopeError, MediaError, ValueError) as error:
            self._json(400, {"error": str(error), "pointer": getattr(error, "pointer", "")})
            return
        alive = self.server.hub.probe_window()
        self.server.broadcast_runs(payload["run_id"], "open")
        if alive:
            state = _read_state(self.server.data_dir)
            request_attention(
                _browser_identity(state), self.server.window_title
            )
        result_path = self.server.runs.results_dir / f"{payload['run_id']}.json"
        self._json(200, {
            "run_id": payload["run_id"],
            "url": f"http://127.0.0.1:{self.server.port}/?run={payload['run_id']}",
            "result_path": str(result_path),
            "window_alive": alive,
            "window_title": self.server.window_title,
        })

    def _copy(self, value):
        text = value.get("text")
        if not isinstance(text, str):
            self._json(400, {"error": "text_required"})
            return
        if utf16_units(text) > 100000:
            self._json(413, {"error": "copy_too_large"})
            return
        run_id = value.get("run_id")
        try:
            write_clipboard(text)
        except ClipboardBusy:
            self._json(423, {"error": "clipboard_busy"})
            return
        except ClipboardUnavailable:
            self._json(503, {"error": "clipboard_unavailable"})
            return
        except ClipboardTimeout:
            self._json(504, {"error": "clipboard_timeout"})
            return
        except ClipboardError:
            self._json(500, {"error": "clipboard_failed"})
            return
        self.server.action_log.write(run_id, "copy", {"text": text})
        self._json(200, {"ok": True})

    def _decide(self, value, status):
        run_id = value.get("run_id")
        try:
            path = self.server.runs.decide(run_id, status, value.get("data"))
        except UnknownRun:
            self._json(404, {"error": "unknown_run"})
        except AlreadyDecided:
            self._json(409, {"error": "already_decided"})
        except SchemaError as error:
            self._json(400, {"error": error.message, "pointer": error.pointer})
        else:
            self.server.broadcast_runs(run_id, status)
            self._json(200, {"ok": True, "result_path": str(path)})


def _read_state(data_dir):
    try:
        return json_loads((Path(data_dir) / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _clear_browser_launch_pending(data_dir, generation):
    clear_launch_pending_coordinated(data_dir, generation)


def _browser_identity(state):
    result = LaunchResult.from_state(state.get("browser"))
    if result is not None:
        return result.identity
    return state.get("browser_pid")


def _write_state(server):
    path = server.data_dir / "state.json"
    old = _read_state(server.data_dir)
    state = {
        "token": server.token,
        "pid": os.getpid(),
        "port": server.port,
        "data_dir": str(server.data_dir.resolve()),
    }
    measurement_owner = os.environ.get("RS_MEASUREMENT_OWNER")
    if measurement_owner:
        state["measurement_owner"] = measurement_owner
    if "browser" in old:
        state["browser"] = old["browser"]
    elif "browser_pid" in old:
        state["browser_pid"] = old["browser_pid"]
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json_dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _maintenance_tick(server, now=None):
    now = time.monotonic() if now is None else now
    expired = server.runs.expire_due()
    for run_id in expired:
        server.broadcast_runs(run_id, "expired")
    if server.runs.open_count() or server.hub.has_subscribers():
        server.idle_since = None
        return False
    if server.idle_since is None:
        server.idle_since = now
        return False
    if now - server.idle_since < 1800:
        return False
    server.stopping.set()
    server.shutdown()
    return True


def _maintenance(server):
    while not server.stopping.wait(1):
        try:
            if _maintenance_tick(server):
                return
        except Exception as error:
            try:
                server.action_log.write(
                    None,
                    "error",
                    {
                        "what": "maintenance_failed",
                        "error": type(error).__name__,
                    },
                )
            except Exception:
                pass


def run_server(data_dir, port, repo_root):
    data_dir = ensure_layout(data_dir)
    retain_recent(data_dir)
    registry = scan_registry(
        Path(repo_root) / "templates", Path(data_dir) / "templates"
    )
    config = load_config(data_dir)
    server = ReportHTTPServer(("127.0.0.1", port), Handler, data_dir, registry, config)
    _write_state(server)
    maintenance = threading.Thread(target=_maintenance, args=(server,), daemon=True)
    maintenance.start()
    restore_signals = install_signal_handlers(server)
    try:
        server.serve_forever(poll_interval=.2)
    finally:
        restore_signals()
        server.stopping.set()
        server.server_close()
        state = _read_state(data_dir)
        if state.get("pid") == os.getpid():
            try:
                (Path(data_dir) / "state.json").unlink()
            except FileNotFoundError:
                pass
