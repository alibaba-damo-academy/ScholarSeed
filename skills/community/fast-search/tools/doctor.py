#!/usr/bin/env scholarseed-skill-python
"""Report local fast-search/Codex network readiness; optionally test APIs."""

import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import localconf  # noqa: E402
import cache as search_cache  # noqa: E402


def _codex_version():
    executable = shutil.which("codex")
    if not executable:
        return None
    try:
        result = subprocess.run(
            [executable, "--version"], check=False, capture_output=True,
            text=True, timeout=10,
        )
        return result.stdout.strip() or result.stderr.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _paperhub_live_check(search=None, max_attempts=2):
    """Run a tiny live check, retrying one transient transport failure."""
    if search is None:
        import paperhub  # noqa: E402
        search = paperhub.title_search
    result = {}
    attempts = 0
    for attempts in range(1, max_attempts + 1):
        result = search("Attention Is All You Need", limit=1)
        live_ok = not bool(result.get("error")) and bool(result.get("papers"))
        if live_ok or result.get("error_code") != "PAPERHUB_TRANSPORT_ERROR":
            break
    return result, attempts


def main():
    parser = argparse.ArgumentParser(description="Diagnose fast-search connectivity")
    parser.add_argument("--live", action="store_true", help="make a small PaperHub request")
    args = parser.parse_args()

    report = {
        "codex": {
            "version": _codex_version(),
            "hosted_web_search": (
                "the Veryfast Worker enables hosted web search primarily for the installed "
                "web-search skill's native profile; a successful direct call is accepted only "
                "as a compatibility result; this cannot be tested by this Python process"
            ),
        },
        "paperhub": {
            "config": localconf.config_source(),
            "url": os.environ.get(
                "PAPERHUB_URL", "https://scholarseed.damo.alibaba.com/paperhub"
            ),
            "proxy_mode": os.environ.get("PAPERHUB_PROXY_MODE", "auto"),
            "api_key_present": bool(os.environ.get("SCHOLARSEED_API_KEY")),
        },
        "query_cache": {
            "enabled": search_cache.enabled(),
            "directory_configured": bool(os.environ.get("SEARCH_CACHE_DIR")),
            "mode": os.environ.get("SEARCH_CACHE_MODE", "readwrite"),
            "replay_timing": search_cache.replay_timing(),
        },
        "proxy_environment": {
            key: bool(os.environ.get(key))
            for key in (
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                "http_proxy", "https_proxy", "all_proxy", "no_proxy",
            )
        },
    }

    live_ok = True
    if args.live:
        result, attempts = _paperhub_live_check()
        live_ok = not bool(result.get("error")) and bool(result.get("papers"))
        report["paperhub"]["live"] = {
            "ok": live_ok,
            "attempts": attempts,
            "count": result.get("count", 0),
            "error": result.get("error"),
            "error_code": result.get("error_code"),
            "status": result.get("status"),
        }

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0 if live_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
