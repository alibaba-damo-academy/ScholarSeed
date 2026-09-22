#!/usr/bin/env scholarseed-skill-python
"""Publish one official or visible-browser search result as an Invocation artifact."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Sequence

import browser
import official

OUTPUT_PATH = "web-search-result.json"
OUTPUT_ROLE = "final"
BRIDGE_COMMAND = "scholarseed-bridge"
BRIDGE_DIRECTORY_ENVIRONMENT = "SCHOLARSEED_BRIDGE_DIR"
PROVIDER_OFFICIAL = "official-api"
PROVIDER_BROWSER = "visible-browser"
PROVIDERS = (PROVIDER_OFFICIAL, PROVIDER_BROWSER)
JSON_ENCODING = "utf-8"
LOG_FORMAT = "%(message)s"
LOGGER = logging.getLogger("scholarseed.web_search.invoke")
SUCCESS_RESULT_STATUSES = frozenset({official.STATUS_COMPLETED, official.STATUS_EMPTY})


def _log(event: str, *, level: int = logging.INFO, **details: object) -> None:
    LOGGER.log(
        level,
        json.dumps(
            {"component": "web_search.invoke", "event": event, **details},
            ensure_ascii=False,
            sort_keys=True,
        ),
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run and publish one web search.")
    parser.add_argument("--provider", choices=PROVIDERS, required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=official.bounded_integer, default=official.DEFAULT_LIMIT)
    parser.add_argument("--headless", action="store_true")
    return parser.parse_args(argv)


def _run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    if args.provider == PROVIDER_OFFICIAL:
        return official.search(
            official.parse_args(["--query", args.query, "--limit", str(args.limit)])
        )
    browser_args = ["--query", args.query, "--limit", str(args.limit)]
    if args.headless:
        browser_args.append("--headless")
    return browser.search(browser.parse_args(browser_args))


def _bridge_command() -> str:
    directory = os.environ.get(BRIDGE_DIRECTORY_ENVIRONMENT, "").strip()
    if directory:
        resolved = shutil.which(BRIDGE_COMMAND, path=directory)
        if resolved:
            return resolved
    return shutil.which(BRIDGE_COMMAND) or BRIDGE_COMMAND


def publish(
    payload: dict[str, Any],
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    bridge_command: str | None = None,
) -> int:
    output = Path(OUTPUT_PATH)
    serialized = f"{json.dumps(payload, ensure_ascii=False, sort_keys=True)}\n"
    try:
        output.write_text(serialized, encoding=JSON_ENCODING)
    except OSError as exc:
        _log(
            "web_search_artifact_write_failed",
            level=logging.ERROR,
            error_type=type(exc).__name__,
        )
        raise
    candidates = payload.get("candidates")
    error = payload.get("error")
    _log(
        "web_search_artifact_written",
        provider=payload.get("provider"),
        status=payload.get("status"),
        error_code=error.get("code") if isinstance(error, dict) else None,
        candidate_count=len(candidates) if isinstance(candidates, list) else 0,
        artifact_bytes=len(serialized.encode(JSON_ENCODING)),
    )
    try:
        result = runner(
            [
                bridge_command or _bridge_command(),
                "artifact",
                "publish",
                "--json",
                json.dumps({"path": OUTPUT_PATH, "role": OUTPUT_ROLE}),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        _log(
            "web_search_artifact_publish_failed",
            level=logging.ERROR,
            error_type=type(exc).__name__,
        )
        raise
    _log(
        "web_search_artifact_publish_finished",
        level=logging.INFO if result.returncode == 0 else logging.WARNING,
        return_code=result.returncode,
        stderr_present=bool(result.stderr.strip()),
    )
    if result.returncode != 0:
        if result.stderr:
            print(result.stderr.strip(), file=sys.stderr)
        return result.returncode
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    args = parse_args(argv)
    _log(
        "web_search_provider_started",
        provider=args.provider,
        query_length=len(args.query.strip()),
        limit=args.limit,
        headless=args.headless,
    )
    payload, search_status = _run(args)
    publish_status = publish(payload)
    result_status = payload.get("status")
    _log(
        "web_search_provider_finished",
        level=(
            logging.INFO
            if publish_status == 0 and result_status in SUCCESS_RESULT_STATUSES
            else logging.WARNING
        ),
        provider=args.provider,
        search_exit_code=search_status,
        publish_exit_code=publish_status,
        result_status=result_status,
    )
    return publish_status


if __name__ == "__main__":
    raise SystemExit(main())
