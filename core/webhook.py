"""Optional allowlisted result webhook."""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .jsonutil import dumps
from .product import PRODUCT_NAME, RUNNER_ID

WEBHOOK_KEY_ENV = f"{PRODUCT_NAME.upper().replace('-', '_')}_WEBHOOK_KEY"
LEGACY_WEBHOOK_KEY_ENV = "SPQRK_REPORT_SHELL_WEBHOOK_KEY"


def _webhook_key():
    return os.environ.get(WEBHOOK_KEY_ENV) or os.environ.get(LEGACY_WEBHOOK_KEY_ENV)

def webhook_enabled(config):
    webhook = config.get("webhook", {})
    return bool(
        webhook.get("enabled")
        and webhook.get("allow_prefixes")
        and _webhook_key()
    )


def validate_webhook_url(url, config):
    if not isinstance(url, str) or urllib.parse.urlsplit(url).scheme.lower() != "https":
        raise ValueError("webhook URL must use HTTPS")
    prefixes = config.get("webhook", {}).get("allow_prefixes", [])
    if not any(url.startswith(prefix) for prefix in prefixes):
        raise ValueError("webhook URL is not allowlisted")
    return url


class WebhookRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, config):
        super().__init__()
        self.config = config

    def redirect_request(self, request, fp, code, message, headers, new_url):
        validate_webhook_url(new_url, self.config)
        return super().redirect_request(request, fp, code, message, headers, new_url)


def deliver(url, body, config, run_id, action_log, opener=None, sleeper=time.sleep):
    if not webhook_enabled(config):
        return False
    validate_webhook_url(url, config)
    key = _webhook_key()
    request = urllib.request.Request(
        url,
        data=dumps(body, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "User-Agent": RUNNER_ID,
        },
        method="POST",
    )
    if opener is None:
        open_request = urllib.request.build_opener(WebhookRedirectHandler(config)).open
    else:
        open_request = opener.open if hasattr(opener, "open") else opener
    last_error = "non-success response"
    for attempt, delay in enumerate((1, 2, 4), start=1):
        try:
            with open_request(request, timeout=5) as response:
                if 200 <= response.status < 300:
                    action_log.write(run_id, "webhook_ok", {"attempt": attempt})
                    return True
                last_error = f"HTTP {response.status}"
        except Exception as error:
            last_error = str(error)
        if attempt < 3:
            sleeper(delay)
    action_log.write(run_id, "webhook_fail", {"error": last_error[:200]})
    return False


def fire_after_result(url, body, result_path, config, run_id, action_log):
    if not url or not webhook_enabled(config) or not Path(result_path).is_file():
        return None
    thread = threading.Thread(
        target=deliver,
        args=(url, body, config, run_id, action_log),
        daemon=True,
        name=f"webhook-{run_id}",
    )
    thread.start()
    return thread
