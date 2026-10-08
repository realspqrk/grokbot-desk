import json
import re

from core.cli import build_parser
from core.page import build_page


def test_cli_uses_published_product_name():
    assert build_parser().prog == "grokbot-desk"


def test_page_uses_product_name_for_brand_and_empty_title():
    page = build_page({}, "csrf", 18920)
    match = re.search(
        r'<script id="rs-boot" type="application/json">(.*?)</script>',
        page,
        re.DOTALL,
    )
    strings = json.loads(match.group(1))["strings"]

    assert strings["app_name"] == "grokbot-desk"
    assert strings["window_title_empty"] == "grokbot-desk · keine offenen Berichte"
    assert "<title>grokbot-desk · keine offenen Berichte</title>" in page
