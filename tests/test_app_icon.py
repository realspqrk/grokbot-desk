"""App icon, web manifest and release version (1.0.0-beta.1)."""
import http.client
import json
import re
import struct
import subprocess
import sys
import threading
import tomllib
from html.parser import HTMLParser
from pathlib import Path

import pytest

from conftest import free_port
from core import VERSION, __version__
from core.cli import build_parser
from core.paths import ensure_layout, load_config
from core.registry import scan_registry
from core.server import Handler, ReportHTTPServer


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "core" / "static"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    data_dir = ensure_layout(tmp_path_factory.mktemp("icon") / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", free_port()), Handler, data_dir,
        scan_registry(ROOT / "templates"), load_config(data_dir),
    )
    server.port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def get(server, path):
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    connection.request("GET", path, headers={"Host": f"127.0.0.1:{server.port}"})
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response, body


def png_size(body):
    assert body[:8] == PNG_MAGIC
    return struct.unpack(">II", body[16:24])


@pytest.mark.parametrize("path, content_type", [
    ("/static/icons/icon.svg", "image/svg+xml"),
    ("/static/icons/icon-32.png", "image/png"),
    ("/static/icons/icon-192.png", "image/png"),
    ("/static/icons/icon-512.png", "image/png"),
    ("/static/icons/favicon.ico", "image/x-icon"),
    ("/favicon.ico", "image/x-icon"),
    ("/static/manifest.webmanifest", "application/manifest+json"),
])
def test_icon_routes_serve_same_origin_files_with_their_types(server, path, content_type):
    response, body = get(server, path)
    assert response.status == 200
    assert response.getheader("Content-Type") == content_type
    assert response.getheader("X-Content-Type-Options") == "nosniff"
    assert "default-src 'self'" in response.getheader("Content-Security-Policy")
    assert body and int(response.getheader("Content-Length")) == len(body)


@pytest.mark.parametrize("size", [32, 192, 512])
def test_png_icons_have_their_size(server, size):
    _, body = get(server, f"/static/icons/icon-{size}.png")
    assert png_size(body) == (size, size)


def test_favicon_ico_holds_16_32_and_48_px_entries(server):
    _, body = get(server, "/favicon.ico")
    assert body == (STATIC / "icons" / "favicon.ico").read_bytes()
    reserved, kind, count = struct.unpack("<HHH", body[:6])
    assert (reserved, kind) == (0, 1)
    sizes = []
    for index in range(count):
        width, height, _, _, _, _, length, offset = struct.unpack(
            "<BBBBHHII", body[6 + 16 * index:22 + 16 * index]
        )
        assert offset + length <= len(body)
        assert png_size(body[offset:offset + length]) == (width, height)
        sizes.append(width)
    assert sorted(sizes) == [16, 32, 48]


def test_svg_icon_is_a_self_contained_square(server):
    _, body = get(server, "/static/icons/icon.svg")
    svg = body.decode("utf-8")
    assert 'viewBox="0 0 64 64"' in svg
    # nothing loaded from elsewhere, no script
    assert "<script" not in svg and "href" not in svg
    assert re.findall(r"\b[a-z][a-z0-9+.-]*://", svg) == ["http://"]


def test_static_lookup_stays_inside_the_listed_files(server):
    for path in (
        "/static/icons/../shell.html", "/static/icons%2F..%2Fshell.html",
        "/static/icons\\favicon.ico", "/static/icons/missing.png", "/static/icons",
    ):
        assert get(server, path)[0].status == 404, path


def tokens(block):
    css = (STATIC / "tokens.css").read_text(encoding="utf-8")
    body = re.search(block, css).group(1)
    return dict(re.findall(r"(--rs-[a-z0-9-]+):\s*(#[0-9a-f]{6})\b", body, re.I))


def test_manifest_names_the_app_and_uses_token_colours(server):
    _, body = get(server, "/static/manifest.webmanifest")
    manifest = json.loads(body)
    light = tokens(r":root\s*\{([^}]*)\}")
    assert manifest["name"] == "grokbot-desk"
    assert manifest["short_name"]
    assert manifest["display"] == "standalone"
    assert manifest["theme_color"] == light["--rs-paper"]
    assert manifest["background_color"] == light["--rs-paper"]
    icons = {icon["sizes"]: icon for icon in manifest["icons"]}
    for size in (192, 512):
        icon = icons[f"{size}x{size}"]
        assert icon["type"] == "image/png"
        response, png = get(server, icon["src"])
        assert response.status == 200 and png_size(png) == (size, size)
    assert all(icon["src"].startswith("/static/") for icon in manifest["icons"])


def test_svg_icon_is_the_shipped_blob_avatar_shape():
    shapes = json.loads((STATIC / "avatar-shapes.json").read_text(encoding="utf-8"))
    outline = shapes["shapes"]["blob"].split("Z")[0] + "Z"
    for name in ("icon.svg", "icon-small.svg"):
        svg = (STATIC / "icons" / name).read_text(encoding="utf-8")
        assert outline in svg, name
        assert svg.count("<ellipse") == 2, name  # two eyes, no badge


class _Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "link":
            self.links.append(dict(attrs))


def test_shell_html_references_the_icons_and_manifest():
    parser = _Links()
    parser.feed((STATIC / "shell.html").read_text(encoding="utf-8"))
    links = [(link["rel"], link["href"], link.get("type")) for link in parser.links]
    assert ("icon", "/static/icons/icon.svg", "image/svg+xml") in links
    assert ("icon", "/static/icons/icon-32.png", "image/png") in links
    assert ("apple-touch-icon", "/static/icons/icon-192.png", None) in links
    assert ("manifest", "/static/manifest.webmanifest", None) in links
    for _, href, _ in links:
        assert (STATIC / href.removeprefix("/static/")).is_file(), href


def test_served_page_carries_the_icon_links(server):
    _, body = get(server, "/")
    assert b'<link rel="icon" href="/static/icons/icon.svg" type="image/svg+xml">' in body
    assert b'<link rel="manifest" href="/static/manifest.webmanifest">' in body


def test_version_has_one_source_and_pyproject_matches():
    assert __version__ == "1.0.0-beta.1"
    assert VERSION == 1
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == __version__
    assert f"## {__version__}" in (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")


def test_version_flag_prints_product_and_version(capsys):
    with pytest.raises(SystemExit) as exit_info:
        build_parser().parse_args(["--version"])
    assert exit_info.value.code == 0
    assert capsys.readouterr().out == "grokbot-desk 1.0.0-beta.1\n"


def test_report_shell_script_prints_the_version():
    result = subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "--version"],
        capture_output=True, text=True, timeout=30, cwd=ROOT,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "grokbot-desk 1.0.0-beta.1"


def test_hello_reports_the_version(server):
    _, body = get(server, "/hello")
    assert json.loads(body)["version"] == __version__
