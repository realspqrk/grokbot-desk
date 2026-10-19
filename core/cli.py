"""Command-line interface for grokbot-desk."""
import argparse
import codecs
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import __version__, doorbell
from .envelope import SCHEMA, EnvelopeError, MAX_PAYLOAD, validate_payload
from .identity import registry_warnings
from .jsonutil import JSONBoundaryError, dumps as json_dumps, loads as json_loads
from .launch_coordination import (
    clear_launch_pending,
    launch_is_pending,
    mark_launch_pending,
    release_launch_lock,
    try_acquire_launch_lock,
)
from .media import MediaError, replace_block_media
from .paths import (
    ROOT,
    data_dir,
    data_dir_report,
    ensure_layout,
    follow_migration,
    load_config,
    migration_advice,
    selected_port,
)
from .migrate import DataDirBusy, MigrationRefused, migrate
from .platform import (
    BrowserLaunchError,
    BrowserNotFound,
    focus_window,
    launch_server,
    launch_window,
)
from .platform_types import LaunchResult, WindowLaunchStatus
from .product import PRODUCT_NAME, RUNNER_ID
from .payload import BLOCK_SCHEMAS, result_summary
from .server import run_server
from .timeutil import to_local


def output(value):
    print(json_dumps(value, ensure_ascii=True, separators=(",", ":")))


def error(message, code):
    print(f"report-shell: {message}", file=sys.stderr)
    return code


def _http_timeout(default):
    raw = os.environ.get("RS_CLI_HTTP_TIMEOUT")
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return min(value, 60.0) if math.isfinite(value) and value > 0 else default


def _server_start_timeout_seconds(default=10):
    raw = os.environ.get("RS_SERVER_START_TIMEOUT_MS")
    if raw is None:
        return default
    try:
        value = float(raw) / 1000
    except ValueError:
        return default
    return (
        min(max(value, 1.0), 120.0)
        if math.isfinite(value) and value > 0
        else default
    )


def _hello(port, timeout=.35):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/hello", timeout=timeout) as response:
            value = json.load(response)
        return value if value.get("runner") == RUNNER_ID else None
    except Exception:
        return None


def _port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=.2):
            return True
    except OSError:
        return False


def _state(base):
    try:
        return json_loads((Path(base) / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _browser_identity(state):
    result = LaunchResult.from_state(state.get("browser"))
    if result is not None:
        return result.identity
    return state.get("browser_pid")


def _write_browser_state(base, state):
    (Path(base) / "state.json").write_text(
        json_dumps(state, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def _save_browser_result(base, result):
    state = _state(base)
    if isinstance(result, LaunchResult):
        state["browser"] = result.to_state()
        state.pop("browser_pid", None)
    else:
        # Compatibility for test doubles and state written by older versions.
        state["browser_pid"] = result
    state.pop("browser_launch_pending_until", None)
    _write_browser_state(base, state)


def _launch_is_pending(base, state):
    return launch_is_pending(base, state)


def _mark_launch_pending(base):
    return mark_launch_pending(base)


def _clear_launch_pending(base, generation):
    clear_launch_pending(base, generation)
    state = _state(base)
    if "browser_launch_pending_until" in state:
        state.pop("browser_launch_pending_until", None)
        _write_browser_state(base, state)


def _window_is_ready(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.hostname not in {"127.0.0.1", "localhost"}:
            return False
        hello = _hello(parsed.port)
    except (TypeError, ValueError):
        return False
    return bool(hello and hello.get("window_alive"))


def _launch_window_once(base, url, config):
    descriptor = try_acquire_launch_lock(base)
    if descriptor is None:
        return WindowLaunchStatus.PENDING
    try:
        if _window_is_ready(url):
            return WindowLaunchStatus.READY
        state = _state(base)
        if _launch_is_pending(base, state):
            return WindowLaunchStatus.PENDING
        generation = _mark_launch_pending(base)
        try:
            # the one-time app token: only the page this launch opens may
            # close itself after its last decision (server: event window)
            separator = "&" if urllib.parse.urlsplit(url).query else "?"
            launched = launch_window(f"{url}{separator}app={generation}", base, config)
        except Exception:
            _clear_launch_pending(base, generation)
            raise
        _save_browser_result(base, launched)
        return WindowLaunchStatus.LAUNCHED
    finally:
        release_launch_lock(base, descriptor)


def _started_by_us(base, port, launched_at):
    """state.json for this port written since this show spawned the server.

    The spawned pid is not compared: a venv launcher on Windows (and a
    pythonw shim) re-spawns the real interpreter under another pid."""
    path = Path(base) / "state.json"
    try:
        written = path.stat().st_mtime
    except OSError:
        return False
    return _state(base).get("port") == port and written >= launched_at - 1


# The server binds its socket and then writes state.json. A port that opened
# just as the start timeout ran out may be ours with the state not written yet,
# so a listening port waits this long for our state before it counts as foreign.
STATE_GRACE_S = 2.0


def _await_own_state(base, port, launched_at):
    if not _port_open(port):
        return False
    until = time.monotonic() + STATE_GRACE_S
    while time.monotonic() < until:
        if _started_by_us(base, port, launched_at):
            return True
        time.sleep(.05)
    return _started_by_us(base, port, launched_at)


def _replace_outdated(base, port, hello):
    """After an update, stop an idle desk that still runs the older code.
    One with open desks keeps running until they are decided. Returns
    whether it is gone."""
    if hello.get("version") == __version__ or hello.get("open_runs"):
        return False
    try:
        _request(port, "/stop", token=_state(base).get("token"))
    except (OSError, ValueError):
        return False
    until = time.monotonic() + 5
    while _port_open(port) and time.monotonic() < until:
        time.sleep(.05)
    return not _port_open(port)


def _ensure_server(base, port):
    hello = _hello(port)
    if hello and not _replace_outdated(base, port, hello):
        return hello
    if _port_open(port):
        raise RuntimeError("port is held by a foreign process")
    launched_at = time.time()
    launch_server(ROOT / "report_shell.py", port, base)
    startup_timeout = _server_start_timeout_seconds()
    # A cold start (first run, virus scan, cold disk) can take seconds before
    # the new server listens and more before it answers. A listening port is
    # only foreign when no state.json of ours appeared for it: the server
    # binds first and writes state.json right after.
    deadline = time.monotonic() + startup_timeout
    while time.monotonic() < deadline:
        hello = _hello(port, timeout=1)
        if hello:
            return hello
        time.sleep(.05)
    if _started_by_us(base, port, launched_at) or _await_own_state(base, port, launched_at):
        # ours, listening but still busy: one more grace period to answer
        grace = time.monotonic() + startup_timeout
        while time.monotonic() < grace:
            hello = _hello(port, timeout=1)
            if hello:
                return hello
            time.sleep(.1)
        raise RuntimeError(
            f"server started but did not answer within {2 * startup_timeout:g} seconds"
        )
    if _port_open(port):
        raise RuntimeError("port is held by a foreign process")
    raise RuntimeError(
        f"server did not start within {startup_timeout:g} seconds"
    )


def _request(port, path, token=None, csrf=None, body=None, timeout=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-RS-Token"] = token
    if csrf:
        headers["X-RS-CSRF"] = csrf
        headers["Origin"] = f"http://127.0.0.1:{port}"
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json_dumps(body or {}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=_http_timeout(3) if timeout is None else timeout,
        ) as response:
            return json.load(response)
    except urllib.error.HTTPError as response:
        try:
            detail = json.load(response)
        except Exception:
            detail = {"error": response.reason}
        raise ValueError(detail.get("error", response.reason)) from None


def _csrf(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
        page = response.read().decode("utf-8")
    marker = '<script id="rs-boot" type="application/json">'
    start = page.index(marker) + len(marker)
    return json_loads(page[start:page.index("</script>", start)])["csrf"]


def _read_payload(source):
    """The payload JSON from a file, or from stdin for "-"; raises EnvelopeError."""
    if source == "-":
        raw = sys.stdin.buffer.read(MAX_PAYLOAD + 1)
    else:
        raw = Path(source).read_bytes()
    if len(raw) > MAX_PAYLOAD:
        raise EnvelopeError("", "payload exceeds 2 MB")
    try:
        return json_loads(raw.decode("utf-8-sig"))
    except JSONBoundaryError as exc:
        raise EnvelopeError(exc.pointer, f"invalid JSON: {exc.message}") from exc
    except (UnicodeDecodeError, ValueError) as exc:
        raise EnvelopeError("", f"invalid JSON: {exc}") from exc


def _load_show_payload(args, used_ids=(), warnings=None):
    payload = _read_payload(args.data)
    explicit_run_id = isinstance(payload, dict) and "run_id" in payload
    validated = validate_payload(payload, used_ids if explicit_run_id else (), warnings)
    if not explicit_run_id:
        # the desk names the run; a run_id made here could already be taken there
        validated.pop("run_id")
    return validated


def command_show(args, base, port):
    if args.template is not None:
        return error(
            "show takes no template since payload@2: show --data payload.json "
            "(the payload says what it asks for; see SKILL.md)", 2
        )
    try:
        used_ids = {
            path.stem
            for folder in ("runs", "results")
            for path in (Path(base) / folder).glob("*.json")
        }
        warnings = []
        payload = _load_show_payload(args, used_ids, warnings)
        config = load_config(base)
        # media errors before the desk starts: the same check the desk makes
        replace_block_media(payload["blocks"], BLOCK_SCHEMAS, config.get("media_roots", []), {})
    except (OSError, ValueError, EnvelopeError, MediaError) as exc:
        return error(str(exc), 2)
    try:
        _ensure_server(base, port)
        state = _state(base)
        raw = json_dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/push",
            data=raw,
            method="POST",
            headers={"Content-Type": "application/json", "X-RS-Token": state["token"]},
        )
        with urllib.request.urlopen(
            request, timeout=_http_timeout(3)
        ) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            try:
                detail = json.load(exc)
                message = detail.get("error", "invalid payload")
            except Exception:
                message = "invalid payload"
            return error(message, 2)
        return error(str(exc), 4)
    except (RuntimeError, OSError, KeyError, urllib.error.URLError) as exc:
        return error(str(exc), 4)
    settled = result.get("deduped") and result.get("state") != "open"
    if not args.no_window and not settled:
        try:
            if result.get("window_alive"):
                # --focus raises the window once per burst, as the
                # server's answer says (an older server sends no "attention")
                if args.focus and result.get("attention", True):
                    focus_window(
                        _browser_identity(state),
                        result.get("window_title"),
                    )
            else:
                _launch_window_once(
                    base,
                    f"http://127.0.0.1:{port}/?launch={result['run_id']}&run={result['run_id']}",
                    load_config(base),
                )
        except (BrowserNotFound, BrowserLaunchError) as exc:
            return error(str(exc).removeprefix("report-shell: "), 3)
    answer = {key: result[key] for key in ("run_id", "url", "result_path")}
    if result.get("deduped"):
        answer["deduped"] = True
        answer["state"] = result.get("state")
    warnings = warnings + [w for w in result.get("warnings", []) if w not in warnings]
    if warnings:
        answer["warnings"] = warnings
    answer["data_dir"] = str(Path(base))
    advice = migration_advice(base)
    if advice:
        answer["data_dir_warning"] = advice
    output(answer)
    return 0


# How long `wait` keeps going past a run's expiry. The server writes the
# expired result itself; past this grace nobody will (the server is gone).
WAIT_EXPIRY_GRACE_S = 120


def _seconds_until_expiry(run_path):
    """Seconds from now until the run's expiry plus grace, or None when the
    run file has no readable expiry (an old or a damaged record)."""
    try:
        record = json_loads(run_path.read_text(encoding="utf-8"))
        expires = to_local(record["expires"]).astimezone(timezone.utc)
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        return None
    return (expires - datetime.now(timezone.utc)).total_seconds() + WAIT_EXPIRY_GRACE_S


def command_wait(args, base):
    """Block until the run has a result. Exit 5 at --timeout; exit 7 once the
    run's expiry plus grace has passed with no result written (nothing will
    answer it any more), so a waiter never blocks forever."""
    base = follow_migration(base)
    run_path = Path(base) / "runs" / f"{args.run_id}.json"
    result_path = Path(base) / "results" / f"{args.run_id}.json"
    if not run_path.exists() and not result_path.exists():
        # `migrate` may have moved the default folder after it was resolved
        moved = follow_migration(base)
        if moved != Path(base):
            base = moved
            run_path = base / "runs" / f"{args.run_id}.json"
            result_path = base / "results" / f"{args.run_id}.json"
        if not run_path.exists() and not result_path.exists():
            return error(f"unknown run: {args.run_id}", 6)
    if getattr(args, "until_expiry", False) and args.timeout:
        return error("--until-expiry and --timeout exclude each other", 2)
    now = time.monotonic()
    deadline = now + args.timeout if args.timeout else None
    remaining = None if result_path.exists() else _seconds_until_expiry(run_path)
    expiry_deadline = None if remaining is None else now + max(0.0, remaining)
    while not result_path.exists():
        moved = follow_migration(base)
        if moved != Path(base):
            # `migrate` moved the default folder while this wait ran
            base = moved
            run_path = base / "runs" / f"{args.run_id}.json"
            result_path = base / "results" / f"{args.run_id}.json"
            continue
        current = time.monotonic()
        if deadline is not None and current >= deadline and (
            expiry_deadline is None or deadline <= expiry_deadline
        ):
            return error(f"timeout waiting for run: {args.run_id}", 5)
        if expiry_deadline is not None and current >= expiry_deadline:
            if result_path.exists():
                break
            return error(
                f"run expired without a result: {args.run_id} (data dir {Path(base)})", 7
            )
        time.sleep(.2)
    try:
        text = result_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        # `migrate` moved the folder between seeing the result and reading it
        moved = follow_migration(base)
        if moved == Path(base):
            raise
        base = moved
        result_path = base / "results" / f"{args.run_id}.json"
        text = result_path.read_text(encoding="utf-8")
    value = json_loads(text)
    output({"status": value["status"], "result_path": str(result_path), "data_dir": str(Path(base))})
    return 0


def command_result(args, base):
    path = Path(base) / "results" / f"{args.run_id}.json"
    if not path.is_file():
        return error(
            f"unknown run or result not ready: {args.run_id} (data dir {Path(base)})", 6
        )
    value = json_loads(path.read_bytes())
    if isinstance(value, dict):
        # CLI output only: which data dir answered (the file is unchanged)
        value["data_dir"] = str(Path(base))
    output(value)
    return 0


def _decided_after(value, since):
    # inclusive: `decided` has whole seconds, so two decisions can share the
    # cursor's second; the caller drops the ones it saw by run_id (--seen)
    try:
        return to_local(value["decided"]).astimezone(timezone.utc) >= since
    except (KeyError, TypeError, ValueError):
        return False


def _run_payload(base, run_id):
    """The stored payload@2 of a run, or None (unknown, unreadable, older)."""
    if not isinstance(run_id, str) or not run_id:
        return None
    try:
        record = json_loads((Path(base) / "runs" / f"{run_id}.json").read_text(encoding="utf-8"))
        payload = record["payload"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def _run_title(payload):
    title = payload.get("title") if payload else None
    return title if isinstance(title, str) and title.strip() else None


def _result_summary(value, payload):
    """A one-line reading of a submitted decision ("submit · 2 approve,
    1 later", "choose thu"), only for a result that answers its payload@2.
    It is a reading, never posting authority: act on data.blocks."""
    if value.get("status") != "submitted" or not payload or payload.get("schema") != SCHEMA:
        return None
    try:
        return result_summary(payload, value.get("data"))
    except (KeyError, TypeError, ValueError):
        return None


def _result_item(base, path, value):
    """What a one-line acknowledgement needs, plus a summary when it is cheap."""
    payload = _run_payload(base, value.get("run_id"))
    title = value.get("title")
    if not isinstance(title, str) or not title.strip():
        title = _run_title(payload)
    item = {
        "run_id": value.get("run_id"),
        "bot": value.get("bot"),
    }
    if isinstance(title, str) and title.strip():
        item["title"] = title
    item["status"] = value.get("status")
    item["decided"] = value.get("decided")
    item["result_path"] = str(path)
    summary = _result_summary(value, payload)
    if summary:
        item["summary"] = summary
    return item


def _results_since(base, since, bot=None):
    """Every result decided at or after since (one per run id), oldest first."""
    items, listed = [], set()
    for path in (Path(base) / "results").glob("*.json"):
        try:
            value = json_loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(value, dict) or not _decided_after(value, since):
            continue
        if bot and value.get("bot") != bot:
            continue
        if value.get("run_id") in listed:
            continue
        listed.add(value.get("run_id"))
        items.append(_result_item(base, path, value))
    items.sort(key=lambda item: (to_local(item["decided"]).astimezone(timezone.utc), item["run_id"] or ""))
    return items


def command_results(args, base):
    """Results decided at or after --since, oldest first, minus the run ids
    given with --seen; with --wait the command blocks up to that many seconds
    until at least one new one arrives. The answer always carries `cursor`
    (the newest `decided` so far) and `seen` (every run id decided in that
    second, including ones seen before), so passing both back as-is next time
    neither loses nor repeats a decision."""
    try:
        # whole seconds, like the stored `decided`: a cursor with a fraction
        # must not skip a result decided earlier in the same second
        since = to_local(args.since).astimezone(timezone.utc).replace(microsecond=0)
    except (TypeError, ValueError, OverflowError):
        return error("--since must be ISO 8601 with an offset", 2)
    deadline = time.monotonic() + max(0.0, min(args.wait, 3600.0))
    skip = set(getattr(args, "seen", None) or ())
    while True:
        base = follow_migration(base)
        every = _results_since(base, since, args.bot)
        if follow_migration(base) != Path(base):
            # `migrate` moved the folder while the results were read
            base = follow_migration(base)
            every = _results_since(base, since, args.bot)
        items = [item for item in every if item["run_id"] not in skip]
        if items or time.monotonic() >= deadline:
            break
        time.sleep(.5)
    answer = {"data_dir": str(Path(base)), "results": items}
    if every:
        answer["cursor"] = every[-1]["decided"]
        newest = to_local(every[-1]["decided"]).astimezone(timezone.utc)
        answer["seen"] = [
            item["run_id"] for item in every
            if to_local(item["decided"]).astimezone(timezone.utc) == newest
        ]
    else:
        answer["cursor"], answer["seen"] = args.since, sorted(skip)
    output(answer)
    return 0


def command_paths(base):
    """The data directory in use and why, so a bot never guesses it."""
    output(data_dir_report(base))
    return 0


def command_migrate():
    """Move the older Windows data folder to the product name, explicitly,
    while no desk runs. RS_DATA_DIR and macOS are never migrated."""
    local = os.environ.get("LOCALAPPDATA")
    if os.environ.get("RS_DATA_DIR"):
        output({"migrated": False, "reason": "RS_DATA_DIR is set; it is never migrated"})
        return 0
    if sys.platform != "win32" or not local:
        output({"migrated": False, "reason": "nothing to migrate on this system"})
        return 0
    try:
        output(migrate(local))
    except MigrationRefused as exc:
        return error(f"migrate: {exc}", exc.code)
    except OSError as exc:
        return error(
            f"migrate: nothing was moved, the old folder stays in use: {exc.strerror or exc}", 7
        )
    return 0


def command_status(base, port):
    hello = _hello(port)
    if hello:
        output({
            "up": True,
            "port": port,
            "version": hello.get("version"),
            "pid": hello["pid"],
            "open_runs": hello.get("open_runs", 0),
            "window_alive": hello.get("window_alive", False),
            "data_dir": str(Path(base)),
            "doorbell": _doorbell_word(base),
        })
    else:
        output({
            "up": False, "port": port, "version": None, "pid": None, "open_runs": 0,
            "window_alive": False, "data_dir": str(Path(base)),
            "doorbell": _doorbell_word(base),
        })
    return 0


def command_open(base, port):
    try:
        hello = _ensure_server(base, port)
        if not hello.get("open_runs"):
            output({"ok": True, "opened": False})
            return 0
        state = _state(base)
        if hello.get("window_alive"):
            focus_window(
                _browser_identity(state), hello.get("window_title")
            )
            output({"ok": True, "opened": False})
        else:
            launch_status = _launch_window_once(
                base, f"http://127.0.0.1:{port}/", load_config(base)
            )
            output({
                "ok": True,
                "opened": launch_status is WindowLaunchStatus.LAUNCHED,
                "pending": launch_status is WindowLaunchStatus.PENDING,
            })
        return 0
    except (BrowserNotFound, BrowserLaunchError) as exc:
        return error(str(exc).removeprefix("report-shell: "), 3)
    except RuntimeError as exc:
        return error(str(exc), 4)


def command_cancel(args, base, port):
    if not (Path(base) / "runs" / f"{args.run_id}.json").exists():
        return error(f"unknown run: {args.run_id}", 6)
    try:
        _ensure_server(base, port)
        csrf = _csrf(port)
        try:
            # by: bot, so the bot's own cancel rings no doorbell
            value = _request(port, "/cancel", csrf=csrf, body={"run_id": args.run_id, "by": "bot"})
        except ValueError as exc:
            if "unknown_field" not in str(exc):
                raise
            # a desk from before the doorbell, still busy with open reports
            value = _request(port, "/cancel", csrf=csrf, body={"run_id": args.run_id})
        output({"status": "cancelled", "result_path": value["result_path"]})
        return 0
    except (RuntimeError, ValueError, OSError) as exc:
        return error(str(exc), 6)


def _doorbell_word(base):
    return "on" if doorbell.describe(base)["on"] else "off"


def _doorbell_state(base):
    state = doorbell.describe(base)
    return {"doorbell": "on" if state["on"] else "off", "host": state["host"]}


def command_doorbell(args, base, port):
    """Bare: on/off and the host. setup: the setup page in the desk window,
    or headless with --url and --key-stdin. test: one POST now. off: delete
    the file. The key is never printed."""
    action = args.action
    if action is None:
        output(_doorbell_state(base))
        return 0
    if action == "off":
        doorbell.remove(base)
        output(_doorbell_state(base))
        return 0
    if action == "test":
        if not doorbell.describe(base)["on"]:
            return error("the doorbell is off; set it up with: doorbell setup", 2)
        outcome = doorbell.Doorbell(base, None).test(args.to)
        output({**outcome, "host": doorbell.describe(base)["host"]})
        return 0 if outcome["ok"] else 4
    if args.url is None and args.key_stdin:
        return error("--key-stdin needs --url", 2)
    if args.url is not None:
        if not args.key_stdin:
            return error("--url needs --key-stdin (the key is read from stdin, never an argument)", 2)
        lines = sys.stdin.read(doorbell.MAX_KEY + 2).splitlines()
        if len([line for line in lines if line.strip()]) != 1:
            return error("stdin must hold the key on one line", 2)
        try:
            doorbell.save(base, args.url, next(line for line in lines if line.strip()))
        except ValueError as exc:
            return error(str(exc), 2)
        except OSError as exc:
            return error(f"cannot write the doorbell file: {exc.strerror or exc}", 7)
        output(_doorbell_state(base))
        return 0
    # one desk window: an open one switches to the setup page; else the
    # server keeps the page for the window that connects next (this launch,
    # or one already starting), and the normal launch opens it there
    url = f"http://127.0.0.1:{port}/?page=doorbell"
    try:
        _ensure_server(base, port)
        state = _state(base)
        shown = _request(port, "/doorbell/show", token=state.get("token"))
        if shown.get("shown"):
            focus_window(_browser_identity(state), shown.get("window_title"))
            launch_status = None
        else:
            launch_status = _launch_window_once(base, url, load_config(base))
    except (BrowserNotFound, BrowserLaunchError) as exc:
        return error(str(exc).removeprefix("report-shell: "), 3)
    except (RuntimeError, OSError, ValueError) as exc:
        return error(str(exc), 4)
    output({
        "ok": True,
        "opened": launch_status is WindowLaunchStatus.LAUNCHED,
        "pending": launch_status is WindowLaunchStatus.PENDING,
        "url": url,
        **_doorbell_state(base),
    })
    return 0


def command_doctor():
    output({
        "ok": True,
        "identity_warnings": registry_warnings(data_dir()),
        "doorbell": _doorbell_word(data_dir()),
        **({"data_dir_warning": advice} if (advice := migration_advice(data_dir())) else {}),
    })
    return 0


def command_check(args):
    """Validate a payload the way `show` does, without a desk: `ok`, or the
    first problem as `pointer: message` (exit 2). Warnings go to stderr."""
    warnings = []
    try:
        validate_payload(_read_payload(args.file), (), warnings)
    except EnvelopeError as exc:
        print(f"{exc.pointer or '/'}: {exc.message}")
        return 2
    except OSError as exc:
        return error(f"cannot read {args.file}: {exc.strerror or exc}", 2)
    print("ok")
    for warning in warnings:
        print(f"warning {warning}", file=sys.stderr)
    return 0


GIT_TIMEOUT_S = 120


def _git(root, *args):
    return subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=GIT_TIMEOUT_S,
    )


def _clone_version(root):
    text = (Path(root) / "core" / "__init__.py").read_text(encoding="utf-8")
    found = re.search(r'^__version__\s*=\s*"([^"]+)"', text, re.M)
    return found.group(1) if found else None


def command_update(root=ROOT):
    """Fast-forward this clone to its upstream branch. Refuses local changes;
    names what is left to do (stop and migrate) afterwards."""
    try:
        return _update(Path(root))
    except OSError as exc:
        return error(f"update needs git: {exc}", 7)
    except subprocess.TimeoutExpired as exc:
        return error(f"git did not answer within {GIT_TIMEOUT_S} seconds ({' '.join(exc.cmd)})", 7)


def _update(root):
    inside = _git(root, "rev-parse", "--show-toplevel")
    if inside.returncode or Path(inside.stdout.strip()).resolve() != root.resolve():
        return error(f"{root} is not a git clone; update it the way you installed it", 7)
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if branch == "HEAD":
        return error("this clone is on a fixed tag; check out main (git checkout main), then update", 7)
    if _git(root, "status", "--porcelain", "--untracked-files=no").stdout.strip():
        return error("this clone has local changes; commit or discard them, then update", 7)
    before = _clone_version(root)
    head = _git(root, "rev-parse", "HEAD").stdout.strip()
    pulled = _git(root, "pull", "--ff-only", "--quiet")
    if pulled.returncode:
        detail = (pulled.stderr or pulled.stdout).strip().splitlines()
        return error(f"git pull failed: {detail[-1] if detail else pulled.returncode}", 7)
    steps = []
    if migration_advice(data_dir()):
        steps.append("the older data folder is in use: decide or discard open reports, run stop, then migrate")
    output({
        "updated": _git(root, "rev-parse", "HEAD").stdout.strip() != head,
        "from": before,
        "to": _clone_version(root),
        "branch": branch,
        "next": steps,
    })
    return 0


def command_stop(base, port):
    hello = _hello(port)
    if not hello:
        output({"ok": True, "stopped": False})
        return 0
    try:
        _request(port, "/stop", token=_state(base).get("token"))
        output({"ok": True, "stopped": True})
        return 0
    except (OSError, ValueError) as exc:
        return error(str(exc), 4)


HELP_EPILOG = """typical flow:
  check payload.json                     validate a payload (ok, or pointer: message)
  show --data payload.json               open a report, prints run_id
  wait RUN_ID --timeout 60               wait for the decision
  result RUN_ID                          print the result JSON

Output is JSON on stdout. Bots: skills/grokbot-desk/SKILL.md.
"""


def build_parser():
    parser = argparse.ArgumentParser(
        prog=PRODUCT_NAME,
        description="A local desk where you decide and read what your bots send.",
        epilog=HELP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--port", type=int, help="desk port (default: config.json, else 18742)")
    parser.add_argument("--version", action="version", version=f"{PRODUCT_NAME} {__version__}")
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")

    def command(name, text):
        return commands.add_parser(name, help=text, description=text)

    show = command("show", "open a report on the desk from a payload")
    # payload@1 took a template id here; kept only to explain the change
    show.add_argument("template", nargs="?", help=argparse.SUPPRESS)
    show.add_argument("--data", required=True, help="payload JSON file, or - for stdin")
    show.add_argument("--focus", action="store_true", help="bring the window to the front (Windows)")
    show.add_argument("--no-window", action="store_true", help="register the report without opening a window")
    wait = command("wait", "wait until a report has a result")
    wait.add_argument("run_id", help="the run_id that show printed")
    wait_limit = wait.add_mutually_exclusive_group()
    wait_limit.add_argument("--timeout", type=float, default=0, help="seconds to wait (exit 5 when still open)")
    wait_limit.add_argument("--until-expiry", action="store_true", help="wait until the report expires")
    result = command("result", "print the result of a decided report")
    result.add_argument("run_id", help="the run_id that show printed")
    results = command("results", "list results decided since a time, oldest first")
    results.add_argument("--since", required=True, help="ISO 8601 time with offset, or the cursor from last time")
    results.add_argument("--bot", help="only this bot id")
    results.add_argument("--wait", type=float, default=0, help="seconds to wait for a first new result")
    results.add_argument("--seen", action="append", default=[], help="run_id already handled (repeat it)")
    command("paths", "print the data folder in use and why")
    command("status", "print whether the desk runs, its version and open reports")
    command("open", "open the window for the reports that are open")
    cancel = command("cancel", "discard an open report (the result is cancelled)")
    cancel.add_argument("run_id", help="the run_id that show printed")
    bell = command("doorbell", "show, set up, test or switch off the doorbell that wakes a bot after a decision")
    bell_actions = bell.add_subparsers(dest="action", metavar="<action>")
    setup = bell_actions.add_parser(
        "setup", help="open the setup page in the desk window, or save --url and the key from stdin",
        description="Open the setup page in the desk window, or save --url and the key from stdin.",
    )
    setup.add_argument("--url", help="the webhook's POST address (https only)")
    setup.add_argument("--key-stdin", action="store_true", help="read the key as one line from stdin")
    bell_test = bell_actions.add_parser(
        "test", help="ring once now (status test) and print the HTTP status and why it failed",
        description="Ring once now (status test), no retries, and print the HTTP status; "
        "a failure names its category: unreachable, refused, busy or other.",
    )
    bell_test.add_argument("--to", metavar="NAME", help="the exact Grok Bot name the test ring is for")
    bell_actions.add_parser("off", help="switch the doorbell off (deletes its file)",
                            description="Switch the doorbell off (deletes its file).")
    command("doctor", "check bot identities and the data folder")
    check = command("check", "validate a payload without opening it (ok, or pointer: message)")
    check.add_argument("file", help="payload JSON file, or - for stdin")
    command("serve", "run the desk in this terminal (when a runtime ends child processes)")
    command("stop", "stop the desk server")
    command("migrate", "move the older Windows data folder to the new name (desk stopped)")
    command("update", "pull the newest version into this clone (git pull --ff-only)")
    return parser


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            # A UTF-8 stream (macOS, a Windows console) prints text as is; any
            # other (a Windows pipe) stays ASCII. JSON output is ASCII anyway.
            utf8 = codecs.lookup(stream.encoding or "ascii").name == "utf-8"
            stream.reconfigure(encoding="utf-8" if utf8 else "ascii", errors="backslashreplace")
    argv = list(sys.argv[1:] if argv is None else argv)
    for index, item in enumerate(argv):
        if item == "--port" and index > 0 and index + 1 < len(argv):
            argv = ["--port", argv[index + 1], *argv[:index], *argv[index + 2:]]
            break
        if item.startswith("--port=") and index > 0:
            argv = [item, *argv[:index], *argv[index + 1:]]
            break
    args = build_parser().parse_args(argv)
    if args.command == "doctor":
        return command_doctor()
    if args.command == "check":
        return command_check(args)
    if args.command == "update":
        return command_update()
    if args.command == "migrate":
        return command_migrate()
    # serve checks and lays out its folder itself (it refuses a migrated one)
    base = data_dir() if args.command == "serve" else ensure_layout(data_dir())
    try:
        config = load_config(base)
        port = selected_port(args.port, config)
    except (OSError, UnicodeDecodeError, ValueError, TypeError, RecursionError) as exc:
        return error(f"invalid config: {exc}", 2)
    if not 1 <= port <= 65535:
        return error("port must be between 1 and 65535", 2)
    if args.command == "show":
        return command_show(args, base, port)
    if args.command == "wait":
        return command_wait(args, base)
    if args.command == "result":
        return command_result(args, base)
    if args.command == "results":
        return command_results(args, base)
    if args.command == "paths":
        return command_paths(base)
    if args.command == "status":
        return command_status(base, port)
    if args.command == "open":
        return command_open(base, port)
    if args.command == "cancel":
        return command_cancel(args, base, port)
    if args.command == "doorbell":
        return command_doorbell(args, base, port)
    if args.command == "stop":
        return command_stop(base, port)
    if args.command == "serve":
        try:
            run_server(base, port)
            return 0
        except OSError as exc:
            return error(f"cannot bind port {port}: {exc}", 4)
        except DataDirBusy as exc:
            return error(str(exc), 4)
    return error("unknown command", 2)
