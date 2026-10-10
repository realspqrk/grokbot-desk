"""Darwin implementation of the small native platform facade.

Contained opens use POSIX no-follow calls (openat + O_NOFOLLOW, identity
st_dev + st_ino). Those are the macOS and Linux mechanism; this module is
the product's POSIX backend.
"""
import errno
import os
import signal
import stat
import subprocess
import sys
import threading
from pathlib import Path

from .platform_types import (
    DEFAULT_WINDOW_HEIGHT,
    DEFAULT_WINDOW_WIDTH,
    BrowserIdentity,
    BrowserLaunchError,
    ClipboardError,
    ClipboardTimeout,
    ClipboardUnavailable,
    LaunchResult,
    PathIdentityError,
    ReparseEscape,
)


ALLOW_REUSE_ADDRESS = True
F_GETPATH = 50
_CLIPBOARD_TIMEOUT = 2
_owned_processes = {}


def default_data_dir(product_name):
    override = os.environ.get("RS_DATA_DIR")
    if override:
        return Path(override).resolve()
    return Path.home() / "Library" / "Application Support" / product_name


def _browser_candidates():
    home = Path.home()
    return [
        (
            "edge",
            home
            / "Applications"
            / "Microsoft Edge.app"
            / "Contents"
            / "MacOS"
            / "Microsoft Edge",
        ),
        (
            "edge",
            Path(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            ),
        ),
        (
            "chrome",
            home
            / "Applications"
            / "Google Chrome.app"
            / "Contents"
            / "MacOS"
            / "Google Chrome",
        ),
        (
            "chrome",
            Path(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            ),
        ),
    ]


def discover_browser():
    for kind, executable in _browser_candidates():
        if executable.is_file() and os.access(executable, os.X_OK):
            return kind, executable
    return None


def _geometry(config):
    window = config.get("window", config) if isinstance(config, dict) else {}

    def integer(name, default):
        try:
            return int(window.get(name, default))
        except (TypeError, ValueError):
            return default

    width = integer("width", DEFAULT_WINDOW_WIDTH)
    height = integer("height", DEFAULT_WINDOW_HEIGHT)
    return (
        integer("x", 0),
        integer("y", 0),
        width if width > 0 else DEFAULT_WINDOW_WIDTH,
        height if height > 0 else DEFAULT_WINDOW_HEIGHT,
    )


def _posix_popen(args, env=None):
    options = {
        "shell": False,
        "start_new_session": True,
        "close_fds": True,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if env is not None:
        options["env"] = env
    return subprocess.Popen(args, **options)


def _ps_value(pid, field):
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    try:
        result = subprocess.run(
            ["/bin/ps", "-ww", "-p", str(pid), "-o", f"{field}="],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
            timeout=2,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode or result.stderr.strip():
        return None
    value = result.stdout.strip()
    return value or None


def _process_start(pid):
    return _ps_value(pid, "lstart")


def launch_server(script, port, data_dir):
    env = dict(os.environ)
    env["RS_DATA_DIR"] = str(Path(data_dir))
    return _posix_popen(
        [sys.executable, str(script), "--port", str(port), "serve"], env=env
    ).pid


def _browser_arguments(url, profile, geometry):
    x, y, width, height = _geometry(geometry)
    return [
        f"--app={url}",
        f"--user-data-dir={profile}",
        f"--window-size={width},{height}",
        f"--window-position={x},{y}",
        "--no-first-run",
        "--no-default-browser-check",
    ]


def launch_window(url, data_dir, geometry):
    found = discover_browser()
    if found is not None:
        kind, executable = found
        profile = (
            Path(data_dir)
            / ("edge-profile" if kind == "edge" else "chrome-profile")
        ).resolve()
        try:
            process = _posix_popen(
                [str(executable), *_browser_arguments(url, profile, geometry)]
            )
        except OSError as error:
            raise BrowserLaunchError(
                f"could not launch {kind} app window"
            ) from error
        identity = BrowserIdentity(
            kind,
            executable.resolve(),
            profile,
            process.pid,
            _process_start(process.pid),
        )
        _owned_processes[process.pid] = (identity, process)
        return LaunchResult("app", identity)

    for kind, executable in _browser_candidates():
        bundle = executable.parents[2]
        if bundle.is_dir():
            profile = (
                Path(data_dir)
                / ("edge-profile" if kind == "edge" else "chrome-profile")
            ).resolve()
            try:
                _posix_popen(
                    [
                        "/usr/bin/open",
                        "-na",
                        str(bundle),
                        "--args",
                        *_browser_arguments(url, profile, geometry),
                    ]
                )
            except OSError as error:
                raise BrowserLaunchError(
                    f"could not launch {kind} app window"
                ) from error
            return LaunchResult("app")

    try:
        _posix_popen(["/usr/bin/open", url])
    except OSError as error:
        raise BrowserLaunchError(
            "could not launch the default browser"
        ) from error
    return LaunchResult("default")


def _clipboard_environment():
    env = dict(os.environ)
    env.update(
        {"LC_ALL": "", "LC_CTYPE": "UTF-8", "LANG": "en_US.UTF-8"}
    )
    return env


def _clipboard_run(args, *, data=None):
    try:
        result = subprocess.run(
            args,
            input=data,
            capture_output=True,
            shell=False,
            timeout=_CLIPBOARD_TIMEOUT,
            env=_clipboard_environment(),
        )
    except OSError as error:
        raise ClipboardUnavailable("clipboard command is unavailable") from error
    except subprocess.TimeoutExpired as error:
        raise ClipboardTimeout("clipboard command timed out") from error
    if result.returncode:
        raise ClipboardError(
            f"clipboard command failed with status {result.returncode}"
        )
    return result.stdout


def write_clipboard(text):
    encoded = text.encode("utf-8")
    _clipboard_run(["/usr/bin/pbcopy"], data=encoded)
    pasted = _clipboard_run(["/usr/bin/pbpaste"])
    if pasted != encoded:
        raise ClipboardError("clipboard did not preserve the submitted text")


def request_attention(browser_identity, title):
    return False


def focus_window(browser_identity, title):
    return False


def reveal_file(path):
    try:
        result = subprocess.run(
            ["/usr/bin/open", "-R", str(Path(path))],
            capture_output=True,
            shell=False,
            timeout=5,
        )
    except subprocess.TimeoutExpired as error:
        raise OSError("Finder reveal timed out") from error
    if result.returncode:
        raise OSError(result.returncode, "Finder reveal failed")


def _path_from_fd(fd):
    """F_GETPATH on a raw descriptor.

    Directory descriptors must not be wrapped in a file object: CPython
    FileIO rejects them with IsADirectoryError before F_GETPATH can run.
    """
    import fcntl

    raw = fcntl.fcntl(fd, F_GETPATH, bytes(1024))
    value = bytes(raw).split(b"\0", 1)[0]
    if not value:
        raise OSError("F_GETPATH returned no path")
    return Path(os.fsdecode(value))


def final_path_for_handle(handle):
    return _path_from_fd(handle.fileno())


def _final_path_fd(fd):
    duped = os.dup(fd)
    try:
        return _path_from_fd(duped)
    finally:
        os.close(duped)


def _component_name(name):
    if (
        not isinstance(name, str)
        or not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or "\0" in name
    ):
        raise OSError(f"invalid path component: {name!r}")


def _open_nofollow(path, directory, dir_fd=None):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    if directory:
        flags |= os.O_DIRECTORY
    try:
        if dir_fd is None:
            return os.open(path, flags)
        return os.open(path, flags, dir_fd=dir_fd)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ReparseEscape(str(path)) from error
        raise


def directory_identity(path):
    """st_dev and st_ino of a directory, without following a symlink."""
    fd = _open_nofollow(path, directory=True)
    try:
        info = os.fstat(fd)
        if stat.S_ISLNK(info.st_mode):
            raise ReparseEscape(str(path))
        return (info.st_dev, info.st_ino)
    finally:
        os.close(fd)


def open_contained(root, parts, expected_identity=None):
    """Open root/parts without following a symlink.

    Returns (binary file, root final path, root identity, file identity).
    The caller closes the file. Identity is (st_dev, st_ino). Linux uses
    the same openat/O_NOFOLLOW walk; a mount or symlink swapped in for the
    registry directory fails the identity or no-follow check.
    """
    parts = tuple(parts)
    for part in parts:
        _component_name(part)
    if not parts:
        raise OSError("contained path is empty")
    root_fd = _open_nofollow(root, directory=True)
    file_fd = None
    directories = []
    try:
        root_stat = os.fstat(root_fd)
        if stat.S_ISLNK(root_stat.st_mode):
            raise ReparseEscape(str(root))
        root_identity = (root_stat.st_dev, root_stat.st_ino)
        if expected_identity is not None and root_identity != tuple(expected_identity):
            raise PathIdentityError(str(root))
        current = root_fd
        for index, part in enumerate(parts):
            info = os.stat(part, dir_fd=current, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                raise ReparseEscape(part)
            last = index == len(parts) - 1
            opened = _open_nofollow(part, directory=not last, dir_fd=current)
            if last:
                file_fd = opened
            else:
                directories.append(opened)
                current = opened
        file_stat = os.fstat(file_fd)
        if not stat.S_ISREG(file_stat.st_mode):
            raise OSError("contained path is not a regular file")
        root_final = _final_path_fd(root_fd)
        owned = file_fd
        file_fd = None
        try:
            opened_file = os.fdopen(owned, "rb")
        except Exception:
            os.close(owned)
            raise
        return opened_file, root_final, root_identity, (file_stat.st_dev, file_stat.st_ino)
    finally:
        if file_fd is not None:
            os.close(file_fd)
        for fd in directories:
            os.close(fd)
        os.close(root_fd)


def query_owned_browser(identity):
    if not isinstance(identity, BrowserIdentity) or identity.pid is None:
        return None
    retained = _owned_processes.get(identity.pid)
    if retained is None or retained[0] != identity:
        return None
    if retained[1].poll() is not None:
        return False
    if identity.started is None:
        return None
    uid = _ps_value(identity.pid, "uid")
    started = _process_start(identity.pid)
    command = _ps_value(identity.pid, "comm")
    if uid is None or started is None or command is None:
        return None
    try:
        same_user = int(uid) == os.getuid()
    except ValueError:
        return None
    try:
        same_executable = Path(command).resolve() == identity.executable.resolve()
    except OSError:
        return None
    if not same_user or started != identity.started or not same_executable:
        return None
    return True


def terminate_owned_browser(identity, timeout):
    owned = query_owned_browser(identity)
    if owned is not True:
        return owned
    process = _owned_processes[identity.pid][1]
    process.terminate()
    try:
        process.wait(timeout=max(0, timeout))
    except subprocess.TimeoutExpired:
        if query_owned_browser(identity) is not True:
            return False
        process.kill()
        process.wait(timeout=max(1, timeout))
    finally:
        _owned_processes.pop(identity.pid, None)
    return True


def install_signal_handlers(server):
    if threading.current_thread() is not threading.main_thread():
        return lambda: None
    previous = signal.getsignal(signal.SIGTERM)

    def stop(signum, frame):
        server.stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)

    def restore():
        signal.signal(signal.SIGTERM, previous)

    return restore
