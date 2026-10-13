"""Command-line interface for report-shell."""
import argparse
import json
import math
import os
import shutil
import socket
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .check import check_template_details
from .envelope import EnvelopeError, MAX_PAYLOAD, validate_payload_bytes
from .identity import registry_warnings
from .jsonutil import JSONBoundaryError, dumps as json_dumps, loads as json_loads
from .launch_coordination import (
    clear_launch_pending,
    launch_is_pending,
    mark_launch_pending,
    release_launch_lock,
    try_acquire_launch_lock,
)
from .media import MediaError, replace_media
from .paths import ROOT, data_dir, data_dir_report, ensure_layout, load_config, selected_port
from .platform import (
    BrowserLaunchError,
    BrowserNotFound,
    focus_window,
    launch_server,
    launch_window,
)
from .platform_types import LaunchResult, WindowLaunchStatus
from .product import PRODUCT_NAME, RUNNER_ID
from .registry import ID_RE, RegistryError, scan_registry
from .runs import preview_post_summary
from .server import run_server
from .timeutil import iso_now, to_local
from .webhook import validate_webhook_url


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


def _ensure_server(base, port):
    hello = _hello(port)
    if hello:
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


def _load_show_payload(args, template, registry, used_ids=(), warnings=None):
    if args.data == "-":
        raw = sys.stdin.buffer.read(MAX_PAYLOAD + 1)
    else:
        raw = Path(args.data).read_bytes()
    if len(raw) > MAX_PAYLOAD:
        raise EnvelopeError("", "payload exceeds 2 MB")
    try:
        value = json_loads(raw.decode("utf-8-sig"))
    except JSONBoundaryError as exc:
        raise EnvelopeError(
            exc.pointer, f"invalid JSON: {exc.message}"
        ) from exc
    except (UnicodeDecodeError, ValueError) as exc:
        raise EnvelopeError("", f"invalid JSON: {exc}") from exc
    if isinstance(value, dict) and "schema" in value:
        payload = value
    else:
        payload = {
            "schema": "report-shell/payload@1",
            "template": template.id,
            "version": template.version,
            "bot": template.namespace if template.namespace != "global" else "operations-agent",
            "title": template.title_de,
            "created": iso_now(),
            "data": value,
        }
    explicit_run_id = "run_id" in payload
    if payload.get("template") != template.id:
        raise EnvelopeError("/template", f"must equal {template.id}")
    validated = validate_payload_bytes(
        json_dumps(payload, ensure_ascii=False).encode("utf-8"),
        registry,
        used_ids if explicit_run_id else (),
        warnings,
    )
    if not explicit_run_id:
        validated.pop("run_id")
    return validated


def command_show(args, base, port):
    try:
        registry = scan_registry(
            ROOT / "templates", Path(base) / "templates"
        )
        template = registry.get(args.template)
        if template is None:
            return error(f"unknown template: {args.template}", 2)
        used_ids = {
            path.stem
            for folder in ("runs", "results")
            for path in (Path(base) / folder).glob("*.json")
        }
        warnings = []
        payload = _load_show_payload(args, template, registry, used_ids, warnings)
        config = load_config(base)
        notify = payload.get("notify", {}).get("webhook_url")
        if notify:
            validate_webhook_url(notify, config)
        schema = json_loads(template.read_text("schema.json"))
        replace_media(
            payload["data"],
            schema,
            config.get("media_roots", []),
            {},
            template.path,
            template_identity=template.root_identity,
        )
    except (OSError, ValueError, EnvelopeError, RegistryError, MediaError) as exc:
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
    run_path = Path(base) / "runs" / f"{args.run_id}.json"
    result_path = Path(base) / "results" / f"{args.run_id}.json"
    if not run_path.exists() and not result_path.exists():
        return error(f"unknown run: {args.run_id}", 6)
    if getattr(args, "until_expiry", False) and args.timeout:
        return error("--until-expiry and --timeout exclude each other", 2)
    now = time.monotonic()
    deadline = now + args.timeout if args.timeout else None
    remaining = None if result_path.exists() else _seconds_until_expiry(run_path)
    expiry_deadline = None if remaining is None else now + max(0.0, remaining)
    while not result_path.exists():
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
    value = json_loads(result_path.read_text(encoding="utf-8"))
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


_LIST_CHOICES = ("approve", "reject", "defer", "done", "skipped", "later")


def _run_title(base, run_id):
    if not isinstance(run_id, str) or not run_id:
        return None
    try:
        record = json_loads((Path(base) / "runs" / f"{run_id}.json").read_text(encoding="utf-8"))
        title = record["payload"]["title"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return title if isinstance(title, str) and title.strip() else None


def _join_counts(counts, order):
    parts = [f"{counts[name]} {name}" for name in order if counts.get(name)]
    parts.extend(
        f"{counts[name]} {name}" for name in sorted(counts) if name not in order and counts[name]
    )
    return ", ".join(parts)


def _result_summary(value):
    """A one-line reading of a submitted decision, only when it is unambiguous."""
    if value.get("status") != "submitted" or not isinstance(value.get("data"), dict):
        return None
    data = value["data"]
    template = value.get("template")
    if template == "decide-list" and isinstance(data.get("items"), list):
        counts = {}
        for item in data["items"]:
            choice = item.get("choice") if isinstance(item, dict) else None
            if isinstance(choice, str) and choice:
                counts[choice] = counts.get(choice, 0) + 1
        text = _join_counts(counts, _LIST_CHOICES)
        return text or None
    if template == "preview-post":
        # Conservative: only the allowed mode/decision pairs, and only when
        # platforms lists exactly the auto approvals. A manual platform is
        # "posted by you" or "skipped", never "approved". Inconsistent and
        # legacy results (no per_platform) produce no summary. The summary
        # is not posting authority; read per_platform and post only auto+approved.
        return preview_post_summary(data)
    if template in ("approve-one", "review-doc") and isinstance(data.get("decision"), str):
        return data["decision"]
    if template == "pick-option" and isinstance(data.get("choice"), str) and data["choice"]:
        return data["choice"]
    return None


def _result_item(base, path, value):
    """What a one-line acknowledgement needs, plus a summary when it is cheap."""
    title = value.get("title")
    if not isinstance(title, str) or not title.strip():
        title = _run_title(base, value.get("run_id"))
    item = {
        "run_id": value.get("run_id"),
        "bot": value.get("bot"),
        "template": value.get("template"),
    }
    if isinstance(title, str) and title.strip():
        item["title"] = title
    item["status"] = value.get("status")
    item["decided"] = value.get("decided")
    item["result_path"] = str(path)
    summary = _result_summary(value)
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
        since = to_local(args.since).astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return error("--since must be ISO 8601 with an offset", 2)
    deadline = time.monotonic() + max(0.0, min(args.wait, 3600.0))
    skip = set(getattr(args, "seen", None) or ())
    while True:
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


def command_status(base, port):
    hello = _hello(port)
    if hello:
        output({
            "up": True,
            "port": port,
            "pid": hello["pid"],
            "open_runs": hello.get("open_runs", 0),
            "window_alive": hello.get("window_alive", False),
            "data_dir": str(Path(base)),
        })
    else:
        output({
            "up": False, "port": port, "pid": None, "open_runs": 0,
            "window_alive": False, "data_dir": str(Path(base)),
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
        value = _request(port, "/cancel", csrf=_csrf(port), body={"run_id": args.run_id})
        output({"status": "cancelled", "result_path": value["result_path"]})
        return 0
    except (RuntimeError, ValueError, OSError) as exc:
        return error(str(exc), 6)


def command_list():
    try:
        registry = scan_registry(
            ROOT / "templates", data_dir() / "templates"
        )
    except RegistryError as exc:
        return error(str(exc), 7)
    output([item.summary() for item in registry.values()])
    return 0


def command_templates(args):
    try:
        registry = scan_registry(
            ROOT / "templates", data_dir() / "templates"
        )
    except RegistryError as exc:
        return error(str(exc), 7)
    items = [
        template.listing(include_path=args.paths)
        for template in registry.values()
    ]
    if args.json or args.paths:
        output(items)
    else:
        print("ID\tSOURCE\tEXTENDS\tTITLE")
        for item in items:
            print(
                f"{item['id']}\t{item['source']}\t"
                f"{item['extends'] or '-'}\t{item['title']}"
            )
    return 0


def command_doctor():
    try:
        registry = scan_registry(
            ROOT / "templates", data_dir() / "templates"
        )
    except RegistryError as exc:
        return error(str(exc), 7)
    output({
        "ok": True,
        "templates": len(registry),
        "warnings": list(registry.warnings),
        "identity_warnings": registry_warnings(data_dir()),
    })
    return 0


def command_check(args):
    selected = "--all" if args.all else args.template
    details = check_template_details(
        selected, ROOT, data_dir_path=data_dir(), visual=args.visual
    )
    if details["findings"]:
        return error("; ".join(details["findings"]), 7)
    output({
        "ok": True,
        "template": selected,
        "visual": args.visual,
        "warnings": details["warnings"],
    })
    return 0


def command_new(args):
    if args.name.count("/") != 1 or "\\" in args.name:
        return error("new requires <namespace>/<name>", 7)
    namespace, name = args.name.split("/", 1)
    if not ID_RE.fullmatch(namespace) or not ID_RE.fullmatch(name):
        return error("invalid template name", 7)
    declared_data_root = Path(data_dir())
    target = None
    try:
        data_root = declared_data_root.resolve(strict=declared_data_root.exists())
        templates_path = declared_data_root / "templates"
        if templates_path.exists():
            templates_root = templates_path.resolve(strict=True)
            try:
                templates_root.relative_to(data_root)
            except ValueError:
                return error("templates root is outside data directory", 7)
        else:
            templates_root = data_root / "templates"
        target = templates_root / name
        if target.parent != templates_root:
            return error("invalid template name", 7)
        if os.path.lexists(target):
            return error(f"template already exists: {args.name}", 7)
        data_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        templates_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if (
            templates_root.resolve(strict=True) != templates_root
            or target.parent.resolve(strict=True) != templates_root
        ):
            return error("template destination is outside data directory", 7)
        shutil.copytree(ROOT / "templates" / "builtin" / "_starter", target)
        manifest_path = target / "template.json"
        manifest = json_loads(manifest_path.read_text(encoding="utf-8"))
        manifest["id"] = name
        manifest["namespace"] = namespace
        manifest["title_de"] = name.replace("-", " ").title()
        manifest_path.write_text(json_dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        output({"ok": True, "id": name, "path": str(target)})
        return 0
    except Exception as exc:
        if target is not None:
            try:
                target_stat = target.lstat()
                is_reparse = bool(
                    getattr(target_stat, "st_file_attributes", 0)
                    & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
                )
                if (
                    not is_reparse
                    and target.resolve(strict=True).parent == templates_root
                ):
                    shutil.rmtree(target, ignore_errors=True)
            except OSError:
                pass
        return error(str(exc), 7)


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


def build_parser():
    parser = argparse.ArgumentParser(prog=PRODUCT_NAME)
    parser.add_argument("--port", type=int)
    parser.add_argument("--version", action="version", version=f"{PRODUCT_NAME} {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    show = commands.add_parser("show")
    show.add_argument("template")
    show.add_argument("--data", required=True)
    show.add_argument("--focus", action="store_true")
    show.add_argument("--no-window", action="store_true")
    wait = commands.add_parser("wait")
    wait.add_argument("run_id")
    wait_limit = wait.add_mutually_exclusive_group()
    wait_limit.add_argument("--timeout", type=float, default=0)
    wait_limit.add_argument("--until-expiry", action="store_true")
    result = commands.add_parser("result")
    result.add_argument("run_id")
    results = commands.add_parser("results")
    results.add_argument("--since", required=True)
    results.add_argument("--bot")
    results.add_argument("--wait", type=float, default=0)
    results.add_argument("--seen", action="append", default=[])
    commands.add_parser("paths")
    commands.add_parser("status")
    commands.add_parser("open")
    cancel = commands.add_parser("cancel")
    cancel.add_argument("run_id")
    commands.add_parser("list")
    templates = commands.add_parser("templates")
    templates.add_argument("--json", action="store_true")
    templates.add_argument("--paths", action="store_true", help=argparse.SUPPRESS)
    commands.add_parser("doctor")
    check = commands.add_parser("check")
    group = check.add_mutually_exclusive_group(required=True)
    group.add_argument("template", nargs="?")
    group.add_argument("--all", action="store_true")
    check.add_argument("--visual", action="store_true")
    new = commands.add_parser("new")
    new.add_argument("name")
    commands.add_parser("serve")
    commands.add_parser("stop")
    return parser


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="ascii", errors="backslashreplace")
    argv = list(sys.argv[1:] if argv is None else argv)
    for index, item in enumerate(argv):
        if item == "--port" and index > 0 and index + 1 < len(argv):
            argv = ["--port", argv[index + 1], *argv[:index], *argv[index + 2:]]
            break
        if item.startswith("--port=") and index > 0:
            argv = [item, *argv[:index], *argv[index + 1:]]
            break
    args = build_parser().parse_args(argv)
    if args.command == "list":
        return command_list()
    if args.command == "templates":
        return command_templates(args)
    if args.command == "doctor":
        return command_doctor()
    if args.command == "check":
        return command_check(args)
    if args.command == "new":
        return command_new(args)
    base = ensure_layout(data_dir())
    try:
        config = load_config(base)
    except (OSError, UnicodeDecodeError, ValueError, RecursionError) as exc:
        return error(f"invalid config: {exc}", 2)
    port = selected_port(args.port, config)
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
    if args.command == "stop":
        return command_stop(base, port)
    if args.command == "serve":
        try:
            run_server(base, port, ROOT)
            return 0
        except OSError as exc:
            return error(f"cannot bind port {port}: {exc}", 4)
        except RegistryError as exc:
            return error(str(exc), 7)
    return error("unknown command", 2)
