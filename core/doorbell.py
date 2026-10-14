"""The doorbell: after a decision the bot did not cause, POST one short
message to the webhook set up once per device, so the asking bot wakes up.

`<data_dir>/doorbell.json` holds {"url", "key"}. Only the desk writes it
(CLI `doorbell setup`, the setup page); it is read again for every ring, so
setup and `off` need no restart. The key goes out only in the Authorization
header: it is never logged, printed or returned."""
import os
import queue
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .jsonutil import dumps, loads
from .product import RUNNER_ID

FILE_NAME = "doorbell.json"
# Waits before attempt 2, 3, ... A shared webhook host rate-limits for about
# a minute at a time, so the last waits stay at a minute.
BACKOFF_S = (2, 4, 8, 16, 30, 60, 60, 60)
RETRY_STATUS = {408, 425, 429}
TIMEOUT_S = 10
MAX_URL = 2048
MAX_KEY = 4096


def path(data_dir):
    return Path(data_dir) / FILE_NAME


def check_url(url):
    """The webhook URL, or ValueError: https, a host, no credentials, no
    whitespace or control characters."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL:
        raise ValueError("the doorbell URL must be an https:// address")
    if any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in url):
        raise ValueError("the doorbell URL must not contain spaces or control characters")
    try:
        parts = urllib.parse.urlsplit(url)
        parts.port
    except ValueError:
        raise ValueError("the doorbell URL is not a valid address") from None
    if parts.scheme.lower() != "https" or not parts.hostname:
        raise ValueError("the doorbell URL must be an https:// address")
    if parts.username is not None or parts.password is not None:
        raise ValueError("the doorbell URL must not contain a user name or password")
    return url


class MissingKey(ValueError):
    pass


def check_key(key):
    """The key without surrounding whitespace, or ValueError."""
    key = key.strip() if isinstance(key, str) else ""
    if not key:
        raise MissingKey("the doorbell key is missing")
    if len(key) > MAX_KEY or any(ord(ch) < 33 or ord(ch) == 127 for ch in key):
        raise ValueError("the doorbell key must be one line without spaces")
    return key


_SAVE_LOCK = threading.Lock()


def save(data_dir, url, key):
    """Write doorbell.json atomically, readable by this user only (POSIX)."""
    url, key = check_url(url), check_key(key)
    with _SAVE_LOCK:
        return _save(data_dir, url, key)


def _replace(source, target):
    # Windows refuses to replace a file another thread reads at that moment
    for _ in range(50):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            time.sleep(.02)
    os.replace(source, target)


def _save(data_dir, url, key):
    target = path(data_dir)
    # a unique temporary file per save (mode 600): saves at once never collide
    descriptor, name = tempfile.mkstemp(prefix=f".{FILE_NAME}.", suffix=".tmp", dir=target.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(dumps({"url": url, "key": key}, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if os.name == "posix":
            os.chmod(temporary, 0o600)
        _replace(temporary, target)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise
    return load(data_dir)


def load(data_dir):
    """{"url", "key"} when the doorbell is on, else None (also for a file
    that is unreadable or no longer valid)."""
    try:
        value = loads(path(data_dir).read_text(encoding="utf-8"))
        return {"url": check_url(value["url"]), "key": check_key(value["key"])}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def remove(data_dir):
    try:
        path(data_dir).unlink()
        return True
    except FileNotFoundError:
        return False


def describe(data_dir):
    """What may be shown anywhere: on/off and the host, never the key."""
    config = load(data_dir)
    if config is None:
        return {"on": False, "host": None}
    return {"on": True, "host": urllib.parse.urlsplit(config["url"]).hostname}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is answered, not followed: the key never reaches another URL."""

    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def post(config, body, opener=None):
    """One POST. (http status, response text); network errors raise."""
    request = urllib.request.Request(
        config["url"],
        data=dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['key']}",
            "User-Agent": RUNNER_ID,
        },
        method="POST",
    )
    try:
        with (opener or _OPENER.open)(request, timeout=TIMEOUT_S) as response:
            return response.status, _text(response)
    except urllib.error.HTTPError as error:
        return error.code, _text(error)


def _text(response):
    try:
        return response.read(4096).decode("utf-8", "replace")
    except Exception:
        return ""


def retryable(status, text):
    """Worth another attempt: rate limits, timeouts and server errors. A
    shared host answers its rate limit with a plain 400 that says so."""
    return (
        status in RETRY_STATUS
        or 500 <= status <= 599
        or (status == 400 and "rate limit" in text.lower())
    )


def _error_text(error, key):
    text = str(getattr(error, "reason", None) or error) or type(error).__name__
    return text.replace(key, "***")[:200]


def category(status, text=""):
    """A stable reason for a failed ring, for the page and the CLI: no
    connection, address or key refused, busy (try again later), other."""
    if status is None:
        return "unreachable"
    if status in (401, 403, 404):
        return "refused"
    return "busy" if retryable(status, text) else "other"


def test_body(to=None):
    """A test ring: status only, or addressed to one Grok Bot name (`doorbell test --to`)."""
    return {"status": "test"} if to is None else {"status": "test", "bot_name": to}


class Doorbell:
    """Rings in order, one at a time, on one worker thread; retries with
    backoff. opener and sleep are the seams for tests; by default a backoff
    wait ends early when the desk stops (close)."""

    def __init__(self, data_dir, action_log, opener=None, sleep=None):
        self.data_dir = Path(data_dir)
        self.action_log = action_log
        self._open = opener
        self._closed = threading.Event()
        self._sleep = sleep or self._closed.wait
        self._queue = queue.Queue()
        self._lock = threading.Lock()
        self._worker = None

    def close(self, timeout=2):
        """Stop: no new rings, a waiting backoff ends, the worker drops what
        is still queued (join returns) and exits. Closing again is harmless."""
        with self._lock:
            first = not self._closed.is_set()
            self._closed.set()
            worker = self._worker
            if first and worker is not None:
                self._queue.put(None)  # wakes a worker waiting for work
        if worker is not None:
            worker.join(timeout)

    def ring(self, run_id, body):
        """Queue one ring; False (and nothing queued) while the doorbell is
        off or the desk stops."""
        if self._closed.is_set() or load(self.data_dir) is None:
            return False
        # accept and enqueue under the lock close() takes: a ring is either
        # queued before the stop (and drained) or refused
        with self._lock:
            if self._closed.is_set():
                return False
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._work, daemon=True, name="doorbell")
                self._worker.start()
            self._queue.put((run_id, body))
        return True

    def join(self):
        """Wait until every queued ring is delivered or given up."""
        self._queue.join()

    def test(self, to=None):
        """One synchronous POST with status "test", no retries."""
        config = load(self.data_dir)
        if config is None:
            return {"ok": False, "http_status": None, "category": "other", "error": "the doorbell is off"}
        return self._attempt(config, test_body(to))[1]

    def _attempt(self, config, body):
        """(retry?, outcome) of one POST."""
        try:
            status, text = post(config, body, self._open)
        except Exception as error:
            return True, {
                "ok": False, "http_status": None, "category": category(None),
                "error": _error_text(error, config["key"]),
            }
        if 200 <= status < 300:
            return False, {"ok": True, "http_status": status}
        return retryable(status, text), {
            "ok": False, "http_status": status, "category": category(status, text), "error": f"HTTP {status}",
        }

    def _work(self):
        while True:
            item = self._queue.get()
            if self._closed.is_set():
                self._queue.task_done()
                self._drain()
                return
            if item is None:
                self._queue.task_done()
                continue
            run_id, body = item
            try:
                self._deliver(run_id, body)
            except Exception:
                pass  # a ring never ends the worker
            finally:
                self._queue.task_done()

    def _drain(self):
        """At close: every item still queued (rings, the wake-up) is done."""
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return
            self._queue.task_done()

    def _deliver(self, run_id, body):
        outcome = None
        for attempt in range(1, len(BACKOFF_S) + 2):
            config = load(self.data_dir)
            if config is None or self._closed.is_set():
                return  # switched off or the desk stops meanwhile
            retry, outcome = self._attempt(config, body)
            if outcome["ok"]:
                self.action_log.write(run_id, "doorbell_ok", {"attempt": attempt})
                return
            if not retry or attempt > len(BACKOFF_S):
                break
            self._sleep(BACKOFF_S[attempt - 1])
        self.action_log.write(
            run_id, "doorbell_fail", {"error": outcome["error"], "attempts": attempt}
        )
