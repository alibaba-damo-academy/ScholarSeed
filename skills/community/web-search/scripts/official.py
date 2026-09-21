#!/usr/bin/env scholarseed-skill-python
"""Call ScholarSeed's official bounded public-web search API."""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Callable, Mapping, Sequence

from providers import candidate_from_result

SCHEMA = "scholarseed.web_search.v1"
PROVIDER = "official-api"
API_KEY_ENVIRONMENT = "SCHOLARSEED_API_KEY"
API_SCHEME = "https"
API_HOST = "scholarseed.damo.alibaba.com"
API_PATH = "/paperhub/generalsearch/"
API_URL = f"{API_SCHEME}://{API_HOST}{API_PATH}"
API_TIMEOUT_SECONDS = 30
MAXIMUM_RESPONSE_BYTES = 2_000_000
DEFAULT_LIMIT = 20
MINIMUM_LIMIT = 1
MAXIMUM_LIMIT = 20
STATUS_COMPLETED = "completed"
STATUS_EMPTY = "empty"
STATUS_UNAVAILABLE = "unavailable"
STATUS_FAILED = "failed"
ERROR_INVALID_QUERY = "invalid_query"
ERROR_CREDENTIAL_UNAVAILABLE = "credential_unavailable"
ERROR_AUTHORIZATION = "official_api_authorization_failed"
ERROR_REQUEST = "official_api_request_failed"
ERROR_RESPONSE = "official_api_response_invalid"
HTTP_OK = 200
HTTP_UNAUTHORIZED = frozenset({401, 403})
MILLISECONDS_PER_SECOND = 1_000
UTC_OFFSET = "+00:00"
UTC_SUFFIX = "Z"
TIMESTAMP_TIMESPEC = "milliseconds"
LOG_FORMAT = "%(message)s"
LOGGER = logging.getLogger("scholarseed.web_search.official")
DIAGNOSTIC_PHASE_VALIDATION = "validation"
DIAGNOSTIC_PHASE_CREDENTIAL = "credential"
DIAGNOSTIC_PHASE_REQUEST = "request"
DIAGNOSTIC_PHASE_RESPONSE = "response"
DIAGNOSTIC_PHASE_DECODING = "decoding"


def bounded_integer(value: str) -> int:
    number = int(value)
    if not MINIMUM_LIMIT <= number <= MAXIMUM_LIMIT:
        raise argparse.ArgumentTypeError(f"must be between {MINIMUM_LIMIT} and {MAXIMUM_LIMIT}")
    return number


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search through the official ScholarSeed API.")
    parser.add_argument("--query", required=True, help="Public-web search query.")
    parser.add_argument("--limit", type=bounded_integer, default=DEFAULT_LIMIT)
    return parser.parse_args(argv)


def _utc_timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec=TIMESTAMP_TIMESPEC)
        .replace(UTC_OFFSET, UTC_SUFFIX)
    )


def _error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _log(event: str, *, level: int = logging.INFO, **details: object) -> None:
    LOGGER.log(
        level,
        json.dumps(
            {"component": "web_search.official", "event": event, **details},
            ensure_ascii=False,
            sort_keys=True,
        ),
    )


def _payload(
    *,
    started_at: str,
    started_tick: float,
    status: str,
    query: str,
    candidates: list[dict[str, str]],
    error: dict[str, str] | None,
    diagnostics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "status": status,
        "provider": PROVIDER,
        "query": query,
        "started_at": started_at,
        "completed_at": _utc_timestamp(),
        "duration_ms": max(0, round((monotonic() - started_tick) * MILLISECONDS_PER_SECOND)),
        "candidates": candidates,
        "error": error,
        "diagnostics": diagnostics,
    }


def _result(payload: dict[str, Any], exit_code: int) -> tuple[dict[str, Any], int]:
    error = payload.get("error")
    error_code = error.get("code") if isinstance(error, Mapping) else None
    candidates = payload.get("candidates")
    candidate_count = len(candidates) if isinstance(candidates, list) else 0
    status = payload.get("status")
    _log(
        "official_search_finished",
        level=(logging.INFO if status in {STATUS_COMPLETED, STATUS_EMPTY} else logging.WARNING),
        status=status,
        error_code=error_code,
        candidate_count=candidate_count,
        duration_ms=payload.get("duration_ms"),
        exit_code=exit_code,
    )
    return payload, exit_code


def _candidate(item: object) -> dict[str, str] | None:
    if not isinstance(item, Mapping):
        return None
    title = item.get("title")
    url = item.get("url", item.get("link"))
    description = item.get("brief", item.get("description", item.get("snippet")))
    candidate = candidate_from_result(
        title if isinstance(title, str) else None,
        url if isinstance(url, str) else None,
        description if isinstance(description, str) else None,
    )
    if candidate is None or not candidate.description:
        return None
    return candidate.to_dict()


def search(
    args: argparse.Namespace,
    *,
    environment: Mapping[str, str] = os.environ,
    connection_factory: Callable[..., http.client.HTTPConnection] = http.client.HTTPSConnection,
) -> tuple[dict[str, Any], int]:
    started_at = _utc_timestamp()
    started_tick = monotonic()
    query = args.query.strip()
    _log(
        "official_search_started",
        query_length=len(query),
        limit=args.limit,
    )
    if not query:
        return _result(
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query="",
                candidates=[],
                error=_error(ERROR_INVALID_QUERY, "Search query cannot be empty."),
                diagnostics={"phase": DIAGNOSTIC_PHASE_VALIDATION},
            ),
            1,
        )
    api_key = environment.get(API_KEY_ENVIRONMENT, "").strip()
    _log("official_search_credential_checked", credential_available=bool(api_key))
    if not api_key:
        return _result(
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_UNAVAILABLE,
                query=query,
                candidates=[],
                error=_error(
                    ERROR_CREDENTIAL_UNAVAILABLE,
                    "SCHOLARSEED_API_KEY is not available for official search.",
                ),
                diagnostics={"phase": DIAGNOSTIC_PHASE_CREDENTIAL},
            ),
            0,
        )
    body = json.dumps({"q": query, "num": args.limit}, ensure_ascii=False).encode("utf-8")
    _log(
        "official_search_request_started",
        method="POST",
        host=API_HOST,
        path=API_PATH,
        num=args.limit,
        timeout_seconds=API_TIMEOUT_SECONDS,
        request_bytes=len(body),
    )
    connection = connection_factory(API_HOST, timeout=API_TIMEOUT_SECONDS)
    try:
        connection.request(
            "POST",
            API_PATH,
            body=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        response = connection.getresponse()
        raw = response.read(MAXIMUM_RESPONSE_BYTES + 1)
        _log(
            "official_search_response_received",
            http_status=response.status,
            response_bytes=len(raw),
            response_oversized=len(raw) > MAXIMUM_RESPONSE_BYTES,
        )
    except (OSError, TimeoutError, http.client.HTTPException) as exc:
        _log(
            "official_search_request_failed",
            level=logging.WARNING,
            error_type=type(exc).__name__,
        )
        return _result(
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query=query,
                candidates=[],
                error=_error(ERROR_REQUEST, "The official search request failed."),
                diagnostics={
                    "phase": DIAGNOSTIC_PHASE_REQUEST,
                    "error_type": type(exc).__name__,
                },
            ),
            1,
        )
    finally:
        connection.close()
    if response.status in HTTP_UNAUTHORIZED:
        return _result(
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query=query,
                candidates=[],
                error=_error(
                    ERROR_AUTHORIZATION, "The official search API rejected authorization."
                ),
                diagnostics={
                    "phase": DIAGNOSTIC_PHASE_RESPONSE,
                    "upstream_http_status": response.status,
                    "response_bytes": len(raw),
                    "response_oversized": len(raw) > MAXIMUM_RESPONSE_BYTES,
                },
            ),
            1,
        )
    if response.status != HTTP_OK or len(raw) > MAXIMUM_RESPONSE_BYTES:
        return _result(
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query=query,
                candidates=[],
                error=_error(
                    ERROR_RESPONSE, "The official search API returned an invalid response."
                ),
                diagnostics={
                    "phase": DIAGNOSTIC_PHASE_RESPONSE,
                    "upstream_http_status": response.status,
                    "response_bytes": len(raw),
                    "response_oversized": len(raw) > MAXIMUM_RESPONSE_BYTES,
                },
            ),
            1,
        )
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        decoded = None
    data = decoded.get("data") if isinstance(decoded, Mapping) else None
    _log(
        "official_search_response_decoded",
        json_object=isinstance(decoded, Mapping),
        success=isinstance(decoded, Mapping) and decoded.get("success") is True,
        data_is_list=isinstance(data, list),
        data_item_count=len(data) if isinstance(data, list) else None,
    )
    if (
        not isinstance(decoded, Mapping)
        or decoded.get("success") is not True
        or not isinstance(data, list)
    ):
        return _result(
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query=query,
                candidates=[],
                error=_error(
                    ERROR_RESPONSE, "The official search API returned an invalid response."
                ),
                diagnostics={
                    "phase": DIAGNOSTIC_PHASE_DECODING,
                    "upstream_http_status": response.status,
                    "response_bytes": len(raw),
                    "response_oversized": False,
                },
            ),
            1,
        )
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    rejected_count = 0
    duplicate_count = 0
    for item in data:
        candidate = _candidate(item)
        if candidate is None:
            rejected_count += 1
            continue
        if candidate["url"] in seen:
            duplicate_count += 1
            continue
        seen.add(candidate["url"])
        candidates.append(candidate)
        if len(candidates) >= args.limit:
            break
    _log(
        "official_search_candidates_normalized",
        source_count=len(data),
        candidate_count=len(candidates),
        rejected_count=rejected_count,
        duplicate_count=duplicate_count,
    )
    return _result(
        _payload(
            started_at=started_at,
            started_tick=started_tick,
            status=STATUS_COMPLETED if candidates else STATUS_EMPTY,
            query=query,
            candidates=candidates,
            error=None,
        ),
        0,
    )


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    payload, exit_code = search(parse_args(argv))
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
