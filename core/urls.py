"""http(s) URLs a report may open in the system browser.

A URL is allowed only when it occurs in that run's payload data: either a
string that is itself an openable URL, or a URL extracted from a longer
text. The check is exact. A shorter prefix of a longer URL is not allowed
on its own. Credentials in the authority, control characters, a missing
hostname, a port that is not 0-65535, other schemes, and anything longer
than 2048 characters are rejected even when the payload contains them.
One malformed string does not discard the other URLs in the same payload.
"""
import ipaddress
import re
from urllib.parse import urlsplit


MAX_URL_LENGTH = 2048
_URL = re.compile(r"https?://[^\s<>\"'\\]+", re.IGNORECASE)
_TRAILING = ".,;:!?"
_SCHEME = re.compile(r"https?://", re.IGNORECASE)
# ASCII letters, digits and hyphens in dot-separated labels (an IDN must be
# given as punycode); the same rule as RS.externalLink and the decide block's
# item url pattern (tests/fixtures/url_vectors.json)
_HOST = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?\Z")
_PORT = re.compile(r"[0-9]{1,5}\Z")


def _control(text):
    return any(ord(char) < 32 or 0x7F <= ord(char) <= 0x9F for char in text)


def openable(url):
    """True for an http(s) URL with a hostname, a valid port and no credentials.
    The raw authority is checked before any normalization."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        return False
    if _control(url) or any(char.isspace() for char in url) or "\\" in url:
        return False
    scheme = _SCHEME.match(url)
    if not scheme:
        return False
    rest = url[scheme.end():]
    cut = re.search(r"[/?#]", rest)
    authority = rest[:cut.start()] if cut else rest
    if "@" in authority:
        return False
    host, raw_port = authority, None
    if host.startswith("["):
        end = host.find("]")
        if end < 0 or "%" in host[:end]:
            return False
        try:
            ipaddress.IPv6Address(host[1:end])
        except ValueError:
            return False
        tail = host[end + 1:]
        if tail:
            if not tail.startswith(":"):
                return False
            raw_port = tail[1:]
    else:
        if ":" in host:
            host, raw_port = host.split(":", 1)
        if not _HOST.match(host):
            return False
    if raw_port is not None and (not _PORT.match(raw_port) or int(raw_port) > 65535):
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    if port is not None and not 0 <= port <= 65535:
        return False
    if parts.scheme not in {"http", "https"}:
        return False
    if parts.username is not None or parts.password is not None:
        return False
    if not parts.hostname:
        return False
    if parts.netloc.endswith(":"):
        return False
    prefix = parts.scheme + "://"
    if url[: len(prefix)].lower() != prefix:
        return False
    return True


def _trim(url):
    while url and url[-1] in _TRAILING:
        url = url[:-1]
    while url.endswith(")") and url.count("(") < url.count(")"):
        url = url[:-1]
    while url.endswith("]") and url.count("[") < url.count("]"):
        url = url[:-1]
    return url


def _from_string(text, found):
    try:
        if openable(text):
            found.add(text)
        for match in _URL.finditer(text):
            trimmed = _trim(match.group(0))
            if openable(trimmed):
                found.add(trimmed)
    except ValueError:
        return


def urls_in(value):
    """Every openable URL that occurs in the strings under value."""
    found = set()

    def walk(item):
        if isinstance(item, str):
            _from_string(item, found)
        elif isinstance(item, dict):
            for child in item.values():
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    return found


def url_allowed(url, data):
    try:
        return openable(url) and url in urls_in(data)
    except ValueError:
        return False
