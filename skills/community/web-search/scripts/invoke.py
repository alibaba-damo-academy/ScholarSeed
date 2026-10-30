#!/usr/bin/env scholarseed-skill-python
"""Write one official or visible-browser search result as an Invocation artifact."""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any, Sequence

import browser
import official

OUTPUT_PATH = "web-search-result.json"
ARTIFACT_PATH_MAX_CHARS = 128
PROVIDER_OFFICIAL = "official-api"
PROVIDER_BROWSER = "visible-browser"
PROVIDERS = (PROVIDER_OFFICIAL, PROVIDER_BROWSER)
JSON_ENCODING = "utf-8"
LOG_FORMAT = "%(message)s"
LOGGER = logging.getLogger("scholarseed.web_search.invoke")
SUCCESS_RESULT_STATUSES = frozenset({official.STATUS_COMPLETED, official.STATUS_EMPTY})
RECEIPT_PREFIX = "SCHOLARSEED_SEARCH_RECEIPT="
RECEIPT_MAX_BYTES = 12000
RECEIPT_EXCERPT_CHARACTERS = 256
RECEIPT_TITLE_CHARACTERS = 128
RECEIPT_QUERY_CHARACTERS = 512


def source_receipt(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    receipt: dict[str, Any] = {
        "schema": official.SCHEMA,
        "provider": payload.get("provider"),
        "status": payload.get("status"),
        "query": str(payload.get("query") or "")[:RECEIPT_QUERY_CHARACTERS],
        "candidates": [],
        "truncated": len(candidates) > official.MAXIMUM_LIMIT,
    }
    for candidate in candidates[: official.MAXIMUM_LIMIT]:
        row = {
            "url": candidate["url"],
            "title": str(candidate.get("title") or "")[:RECEIPT_TITLE_CHARACTERS],
            "description": str(candidate.get("description") or "")[:RECEIPT_EXCERPT_CHARACTERS],
        }
        receipt["candidates"].append(row)
        if len(json.dumps(receipt, ensure_ascii=True).encode(JSON_ENCODING)) > RECEIPT_MAX_BYTES:
            receipt["candidates"].pop()
            receipt["truncated"] = True
            break
    return RECEIPT_PREFIX + json.dumps(receipt, ensure_ascii=True, separators=(",", ":"))


def bounded_artifact_path(value: str) -> str:
    path = Path(value.strip())
    if (
        not value.strip()
        or len(value) > ARTIFACT_PATH_MAX_CHARS
        or path.name != value.strip()
        or path.suffix != ".json"
        or path.name in {".", ".."}
    ):
        raise argparse.ArgumentTypeError("artifact path must be a relative JSON filename")
    return path.name


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
    parser = argparse.ArgumentParser(description="Run and write one web search result.")
    parser.add_argument("--provider", choices=PROVIDERS, required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=official.bounded_integer, default=official.DEFAULT_LIMIT)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--bridge-response")
    parser.add_argument("--artifact-path", type=bounded_artifact_path, default=OUTPUT_PATH)
    parser.add_argument(
        "--result-policy",
        choices=(browser.ResultPolicy.RESOURCE_SESSION.value,),
        default=browser.ResultPolicy.RESOURCE_SESSION.value,
    )
    return parser.parse_args(argv)


def _run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    if args.provider == PROVIDER_OFFICIAL:
        return official.search(
            official.parse_args(["--query", args.query, "--limit", str(args.limit)])
        )
    browser_args = [
        "--query",
        args.query,
        "--limit",
        str(args.limit),
        "--result-policy",
        args.result_policy,
    ]
    if args.headless:
        browser_args.append("--headless")
    if args.bridge_response:
        browser_args.extend(["--bridge-response", args.bridge_response])
    return browser.search(browser.parse_args(browser_args))


def write_result(payload: dict[str, Any], *, artifact_path: str = OUTPUT_PATH) -> int:
    output = Path(bounded_artifact_path(artifact_path))
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
        capture=payload.get("capture"),
    )
    if payload.get("status") in SUCCESS_RESULT_STATUSES:
        print(source_receipt(payload), flush=True)
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
        artifact_path=args.artifact_path,
    )
    payload, search_status = _run(args)
    write_status = write_result(payload, artifact_path=args.artifact_path)
    result_status = payload.get("status")
    _log(
        "web_search_provider_finished",
        level=(
            logging.INFO
            if write_status == 0 and result_status in SUCCESS_RESULT_STATUSES
            else logging.WARNING
        ),
        provider=args.provider,
        search_exit_code=search_status,
        write_exit_code=write_status,
        result_status=result_status,
        artifact_path=args.artifact_path,
    )
    return write_status


if __name__ == "__main__":
    raise SystemExit(main())
