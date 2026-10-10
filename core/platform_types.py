"""Shared value and error types for native platform backends."""
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


# P8d: the default app window is a compact pop-up for one report: an
# 864x836 viewport (the 760 px column with its padding; every built-in golden
# but the long review-doc fits without scrolling) plus the measured Edge app
# frame of 16x84 px on Windows 11 (tools/dev/popup-measure.mjs --chrome).
DEFAULT_WINDOW_WIDTH = 880
DEFAULT_WINDOW_HEIGHT = 920


class PlatformError(RuntimeError):
    """A native platform operation failed."""


class ReparseEscape(OSError):
    """A path component is a symlink, junction, or other reparse point."""


class PathIdentityError(OSError):
    """The opened directory is not the directory whose identity was pinned."""


class BrowserNotFound(PlatformError):
    """No supported browser could be launched."""


class BrowserLaunchError(PlatformError):
    """A supported browser was found but could not be launched."""


class ClipboardError(PlatformError):
    """The clipboard operation failed."""


class ClipboardBusy(ClipboardError):
    """The clipboard is temporarily locked."""


class ClipboardUnavailable(ClipboardError):
    """The platform clipboard command or service is unavailable."""


class ClipboardTimeout(ClipboardError):
    """The clipboard operation did not finish within its bound."""


class WindowLaunchStatus(Enum):
    """Outcome of launch coordination after authoritative readiness checks."""

    LAUNCHED = "launched"
    PENDING = "pending"
    READY = "ready"


@dataclass(frozen=True)
class BrowserIdentity:
    """Evidence tying a browser process to the dedicated product profile."""

    kind: str
    executable: Path
    user_data_dir: Path
    pid: int | None = None
    started: str | None = None

    def to_state(self):
        value = {
            "kind": self.kind,
            "executable": str(self.executable),
            "user_data_dir": str(self.user_data_dir),
        }
        if self.pid is not None:
            value["pid"] = self.pid
        if self.started is not None:
            value["started"] = self.started
        return value

    @classmethod
    def from_state(cls, value):
        if not isinstance(value, dict):
            return None
        kind = value.get("kind")
        executable = value.get("executable")
        profile = value.get("user_data_dir")
        pid = value.get("pid")
        started = value.get("started")
        if (
            kind not in {"edge", "chrome"}
            or not isinstance(executable, str)
            or not executable
            or not isinstance(profile, str)
            or not profile
            or (pid is not None and (not isinstance(pid, int) or pid <= 0))
            or (started is not None and not isinstance(started, str))
        ):
            return None
        return cls(kind, Path(executable), Path(profile), pid, started)


@dataclass(frozen=True)
class LaunchResult:
    """How a browser was launched and, when safe, what this product owns."""

    mode: str
    identity: BrowserIdentity | None = None

    def __post_init__(self):
        if self.mode not in {"app", "default"}:
            raise ValueError("launch mode must be app or default")
        if self.mode == "default" and self.identity is not None:
            raise ValueError("default-browser mode cannot own a browser")

    def to_state(self):
        value = {"mode": self.mode}
        if self.identity is not None:
            value["identity"] = self.identity.to_state()
        return value

    @classmethod
    def from_state(cls, value):
        if not isinstance(value, dict) or value.get("mode") not in {
            "app",
            "default",
        }:
            return None
        identity = BrowserIdentity.from_state(value.get("identity"))
        if "identity" in value and identity is None:
            return None
        if value["mode"] == "default" and identity is not None:
            return None
        return cls(value["mode"], identity)
