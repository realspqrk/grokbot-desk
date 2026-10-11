"""A burst of reports from several bots opens exactly one window."""
import io
import json
import threading
import time
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import core.cli as cli_module
import core.launch_coordination as coordination
from conftest import ROOT
from core.platform_types import LaunchResult, WindowLaunchStatus

URL = "http://127.0.0.1:18921/?launch=x&run=x"


def test_six_concurrent_shows_from_two_bots_launch_one_window(tmp_path, monkeypatch):
    base = tmp_path / "data"
    base.mkdir()
    launches = []
    ready_at = []

    def launch(*args):
        launches.append(args)
        time.sleep(.2)  # the browser process starts
        ready_at.append(time.monotonic() + .5)  # the page connects later
        return LaunchResult("app")

    def window_ready(url):
        return bool(ready_at) and time.monotonic() >= ready_at[0]

    monkeypatch.setattr(cli_module, "launch_window", launch)
    monkeypatch.setattr(cli_module, "_window_is_ready", window_ready)
    start = threading.Barrier(6)
    results = []

    def show(i):
        start.wait(2)
        # a bot's show returns before the page connects: some see no window
        time.sleep(.05 * (i % 3))
        results.append(cli_module._launch_window_once(base, URL, {}))

    threads = [threading.Thread(target=show, args=(i,)) for i in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)

    assert len(launches) == 1
    assert sorted(r.name for r in results) == ["LAUNCHED"] + ["PENDING"] * 5


def test_a_show_during_a_slow_cold_start_does_not_launch_a_second_window(tmp_path, monkeypatch):
    """A fresh browser profile can take longer than a few seconds before its
    page connects (macOS first start). A report that arrives meanwhile must
    not launch a second window into the same profile."""
    base = tmp_path / "data"
    base.mkdir()
    launches = []
    clock = {"now": time.time()}

    fake_time = SimpleNamespace(
        time=lambda: clock["now"], monotonic=time.monotonic, sleep=time.sleep
    )
    monkeypatch.setattr(coordination, "time", fake_time)
    monkeypatch.setattr(cli_module, "launch_window", lambda *a: launches.append(a) or LaunchResult("app"))
    monkeypatch.setattr(cli_module, "_window_is_ready", lambda url: False)

    assert cli_module._launch_window_once(base, URL, {}) is WindowLaunchStatus.LAUNCHED
    for seconds in (3, 6, 12):
        clock["now"] += seconds - (clock.get("last", 0))
        clock["last"] = seconds
        assert cli_module._launch_window_once(base, URL, {}) is WindowLaunchStatus.PENDING, seconds
    assert len(launches) == 1
    # a launch whose page never connects does not block windows for good
    clock["now"] += coordination.LAUNCH_PENDING_SECONDS
    assert cli_module._launch_window_once(base, URL, {}) is WindowLaunchStatus.LAUNCHED
    assert len(launches) == 2


# ------------------------------------------------ bring forward once ----
from test_arrivals import live  # noqa: E402,F401  (the in-process server fixture)
from test_safety import valid_payload  # noqa: E402
import core.server as server_module  # noqa: E402

STARTER_DATA = ROOT / "templates" / "builtin" / "_starter" / "fixtures" / "golden.json"


def _show_args(focus):
    return SimpleNamespace(template="_starter", data=str(STARTER_DATA), no_window=False, focus=focus)


def test_the_push_answer_says_whether_this_push_brings_the_window_forward(live):
    with patch.object(server_module, "request_attention"), \
            patch.object(live.hub, "probe_window", return_value=True):
        answers = [live.push(dict(valid_payload(), title=f"R{i}"))[1] for i in range(3)]
    assert [a["attention"] for a in answers] == [True, False, False]


def test_a_window_launched_for_a_burst_is_its_one_bring_forward(live):
    """The first report of a burst opens the window (that brings it forward);
    the reports right after it must not flash or raise it again."""
    alive = iter([False] + [True] * 5)
    with patch.object(server_module, "request_attention") as attention, \
            patch.object(live.hub, "probe_window", side_effect=lambda: next(alive)):
        answers = [live.push(dict(valid_payload(), title=f"R{i}"))[1] for i in range(6)]
    assert attention.call_count == 0
    assert not any(a["attention"] for a in answers)


def test_show_focus_does_not_defeat_the_burst_throttle(live, tmp_path, monkeypatch):
    """`show --focus` from 2 bots, 6 times in a burst, with the window open:
    the CLI raises the window once (when the server says this push is due),
    not once per report."""
    base = Path(live.data_dir)
    (base / "state.json").write_text(
        json.dumps({"port": live.port, "token": live.token}), encoding="utf-8"
    )
    monkeypatch.setattr(cli_module, "launch_window", lambda *a: pytest.fail("no second window"))
    focused = []
    monkeypatch.setattr(cli_module, "focus_window", lambda *a: focused.append(a) or True)
    with patch.object(server_module, "request_attention"), \
            patch.object(live.hub, "probe_window", return_value=True), \
            redirect_stdout(io.StringIO()):
        for _ in range(6):
            assert cli_module.command_show(_show_args(True), base, live.port) == 0
    assert len(focused) == 1
