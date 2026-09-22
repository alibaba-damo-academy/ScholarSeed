#!/usr/bin/env scholarseed-skill-python
"""Query PaperHub while keeping full records out of agent tool output."""

from __future__ import annotations

import argparse
import errno
import ssl
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent
SEARCH_DIR = TOOLS_DIR.parent
sys.path.insert(0, str(TOOLS_DIR))
sys.path.insert(0, str(SEARCH_DIR))

from normalize import normalize_paper  # noqa: E402
from state import safe_endpoint  # noqa: E402


DEFAULT_BASE_URL = "https://scholarseed.damo.alibaba.com/paperhub/"
DEFAULT_TIMEOUT = 60
MAX_RETRIES = 3
TRUSTED_PAPERHUB_HOST = "scholarseed.damo.alibaba.com"


def validate_target(url: str) -> str:
    """Keep bearer credentials confined to the configured trusted HTTPS service."""
    parsed = urllib.parse.urlsplit(url)
    if (any(char.isspace() for char in url) or "\\" in url
            or parsed.scheme != "https" or parsed.hostname != TRUSTED_PAPERHUB_HOST
            or parsed.port not in {None, 443} or parsed.username or parsed.password
            or parsed.query or parsed.fragment
            or parsed.path.rstrip("/") not in {"/papersearch", "/paperhub/papersearch"}):
        raise ValueError("PaperHub target must be the trusted PaperHub HTTPS search endpoint")
    return url


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PaperHubRequestError(
            "PaperHub redirect refused; configure the final trusted HTTPS endpoint",
            status="execution_blocked", http_status=code,
        )


def _open_request(request, timeout):
    # Do not install a process-global opener or inherit redirect handlers.
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)


class PaperHubRequestError(RuntimeError):
    """A request failure with a machine-readable execution/transport status."""

    def __init__(
        self,
        message: str,
        *,
        status: str,
        http_status: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.http_status = http_status
        self.retryable = retryable


def _error_chain(error: BaseException) -> list[BaseException]:
    pending = [error]
    result: list[BaseException] = []
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        result.append(current)
        # Traverse the current wrapped failure before historical context.
        for nested in (current.__context__, current.__cause__):
            if isinstance(nested, BaseException):
                pending.append(nested)
        if isinstance(current, urllib.error.URLError) and isinstance(current.reason, BaseException):
            pending.append(current.reason)
    return result


def classify_request_failure(error: BaseException) -> str:
    """Distinguish execution-policy denial from a real transport failure."""
    permission_errnos = {errno.EPERM, errno.EACCES}
    permission_markers = ("operation not permitted", "permission denied")
    chain = _error_chain(error)
    # SSL error numbers belong to OpenSSL, not the operating-system errno
    # namespace (SSL_ERROR_SSL == EPERM == 1).
    for current in chain:
        if isinstance(current, ssl.SSLError):
            return "transport_error"
        if isinstance(current, PermissionError):
            return "execution_blocked"
        if getattr(current, "errno", None) in permission_errnos:
            return "execution_blocked"
        if any(marker in str(current).casefold() for marker in permission_markers):
            return "execution_blocked"
    return "transport_error"


def _base_url(override: str | None = None) -> str:
    value = (
        override
        or os.environ.get("PAPERHUB_SEARCH_URL")
        or DEFAULT_BASE_URL
    ).rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("PaperHub search URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("PaperHub search URL must not contain credentials, query, or fragment")
    path = parsed.path.rstrip("/")
    if path not in {"", "/papersearch", "/paperhub", "/paperhub/papersearch"}:
        raise ValueError("PaperHub search URL path must be /papersearch or /paperhub[/papersearch]")
    base_path = "/paperhub" if path.startswith("/paperhub") else ""
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, base_path, "", ""))


def _papersearch_url(base_url: str) -> str:
    if urllib.parse.urlsplit(base_url).path.rstrip("/") == "/paperhub":
        return f"{base_url.rstrip('/')}/papersearch"
    return f"{base_url.rstrip('/')}/papersearch/"


def paperhub_bearer_token(override: str | None = None) -> str:
    """Return the API token without placing it in URLs or diagnostics."""
    value = override if override is not None else os.environ.get("SCHOLARSEED_API_KEY")
    token = value.strip() if isinstance(value, str) else ""
    if not token:
        raise PaperHubRequestError(
            "PaperHub authentication is not configured: SCHOLARSEED_API_KEY is not set",
            status="authentication_error",
        )
    return token


def _timeout() -> int:
    value = os.environ.get("PAPERHUB_SEARCH_TIMEOUT", str(DEFAULT_TIMEOUT))
    try:
        timeout = int(value)
    except ValueError as exc:
        raise ValueError("PAPERHUB_SEARCH_TIMEOUT must be an integer") from exc
    if timeout < 1:
        raise ValueError("PAPERHUB_SEARCH_TIMEOUT must be positive")
    return timeout


def post_json(
    url: str,
    payload: dict[str, Any],
    timeout: int | None = None,
    bearer_token: str | None = None,
    max_retries: int | None = None,
) -> dict[str, Any]:
    validate_target(url)  # Validate at the credential sink, including direct callers.
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    token = paperhub_bearer_token(bearer_token)
    last_error: BaseException | None = None
    attempts = MAX_RETRIES if max_retries is None else int(max_retries)
    if attempts < 1:
        raise ValueError("max_retries must be positive")
    retryable_http = {429, 500, 502, 503, 504}
    internally_retried_http = (
        {500, 502, 503, 504} if max_retries is None else retryable_http
    )
    last_http_status: int | None = None
    for attempt in range(attempts):
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with _open_request(request, timeout=timeout or _timeout()) as response:
                value = json.loads(response.read())
                if not isinstance(value, dict):
                    raise RuntimeError("PaperHub response must be a JSON object")
                return value
        except json.JSONDecodeError as exc:
            raise RuntimeError("PaperHub returned invalid JSON") from exc
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_error = exc
            status = classify_request_failure(exc)
            if status == "execution_blocked":
                raise PaperHubRequestError(
                    f"PaperHub request failed: {exc}", status=status
                ) from exc
            if isinstance(exc, urllib.error.HTTPError) and exc.code in {401, 403}:
                raise PaperHubRequestError(
                    f"PaperHub authentication failed: HTTP {exc.code}",
                    status="authentication_error",
                    http_status=exc.code,
                ) from exc
            if isinstance(exc, urllib.error.HTTPError):
                last_http_status = exc.code
            if (
                isinstance(exc, urllib.error.HTTPError)
                and exc.code not in internally_retried_http
            ):
                break
            if attempt + 1 < attempts:
                time.sleep(0.5 * (2**attempt))
    raise PaperHubRequestError(
        f"PaperHub request failed: {last_error}",
        status="transport_error",
        http_status=last_http_status,
        retryable=(
            last_http_status in retryable_http
            or not isinstance(last_error, urllib.error.HTTPError)
        ),
    ) from last_error


def _papersearch_data(
    payload: dict[str, Any],
    base_url: str,
    *,
    max_retries: int | None = None,
) -> list[Any]:
    if max_retries is None:
        body = post_json(_papersearch_url(base_url), payload)
    else:
        body = post_json(
            _papersearch_url(base_url), payload, max_retries=max_retries
        )
    if body.get("success") is not True:
        raise RuntimeError(
            f"PaperHub search reported an error: {body.get('message') or 'unknown error'}"
        )
    data = body.get("data")
    if not isinstance(data, list):
        raise RuntimeError("PaperHub search data must be an array")
    return data


def _normalize_records(records: list[Any]) -> list[dict[str, Any]]:
    papers: list[dict[str, Any]] = []
    for raw in records:
        if not isinstance(raw, dict):
            continue
        paper = normalize_paper(raw, source="paperhub")
        if paper is not None:
            papers.append(paper)
    return papers


def _search(
    payload: dict[str, Any],
    base_url: str,
    *,
    max_retries: int | None = None,
) -> list[dict[str, Any]]:
    return _normalize_records(
        _papersearch_data(payload, base_url, max_retries=max_retries)
    )


def keyword_search(
    query: str,
    limit: int,
    base_url: str,
    *,
    year_start: int | None = None,
    year_end: int | None = None,
    max_retries: int | None = None,
) -> dict[str, Any]:
    payload = {"query": query, "limit": limit, "ensure_abstract": True}
    if year_start is not None:
        payload["year_start"] = year_start
    if year_end is not None:
        payload["year_end"] = year_end
    papers = _search(
        payload, base_url, max_retries=max_retries,
    )
    return {"papers": papers, "count": len(papers), "query": query, "mode": "keyword"}


def title_search(
    query: str,
    limit: int,
    base_url: str,
    *,
    year_start: int | None = None,
    year_end: int | None = None,
    max_retries: int | None = None,
) -> dict[str, Any]:
    payload = {"title": query, "limit": limit, "ensure_abstract": True}
    if year_start is not None:
        payload["year_start"] = year_start
    if year_end is not None:
        payload["year_end"] = year_end
    papers = _search(
        payload, base_url, max_retries=max_retries,
    )
    return {"papers": papers, "count": len(papers), "query": query, "mode": "title"}


def get_papers(
    ids: list[str],
    base_url: str,
    *,
    max_retries: int | None = None,
) -> dict[str, Any]:
    if not ids:
        raise ValueError("PaperHub papers mode requires at least one id")
    papers = _normalize_records(
        _papersearch_data({"ids": ids}, base_url, max_retries=max_retries)
    )
    return {"papers": papers, "count": len(papers), "mode": "papers"}


def get_references(
    ids: list[str],
    base_url: str,
    *,
    max_retries: int | None = None,
) -> dict[str, Any]:
    if not ids:
        raise ValueError("PaperHub references mode requires at least one id")
    references: dict[str, list[str]] = {str(value): [] for value in ids}
    for item in _papersearch_data(
        {"cited_by": ids}, base_url, max_retries=max_retries
    ):
        if not isinstance(item, dict):
            continue
        seed = item.get("cited_by")
        raw_ids = item.get("ids")
        if seed is None or not isinstance(raw_ids, list):
            continue
        seed_id = str(seed)
        if seed_id in references:
            references[seed_id] = [str(value) for value in raw_ids]
    return {
        "references": references,
        "count": len(references),
        "mode": "references",
        "warning": (
            None if any(references.values()) else
            "PaperHub returned no reference IDs for the requested seed papers."
        ),
    }


def _write_output(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["keyword", "title", "references", "papers"])
    parser.add_argument("query_or_ids")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--year-start", type=int)
    parser.add_argument("--year-end", type=int)
    parser.add_argument("--url")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--summary-only", action="store_true")
    parser.add_argument(
        "--single-attempt",
        action="store_true",
        help="disable internal retries for the batch runner",
    )
    args = parser.parse_args()
    base_url: str | None = None
    try:
        base_url = _base_url(args.url)
        if args.year_start is not None and not 1800 <= args.year_start <= 2100:
            raise ValueError("--year-start must be between 1800 and 2100")
        if args.year_end is not None and not 1800 <= args.year_end <= 2100:
            raise ValueError("--year-end must be between 1800 and 2100")
        if (
            args.year_start is not None and args.year_end is not None
            and args.year_start > args.year_end
        ):
            raise ValueError("--year-start cannot be greater than --year-end")
        retry_options = {"max_retries": 1} if args.single_attempt else {}
        search_options = {
            "year_start": args.year_start,
            "year_end": args.year_end,
            **retry_options,
        }
        if args.mode == "keyword":
            result = keyword_search(
                args.query_or_ids, args.limit, base_url, **search_options
            )
        elif args.mode == "title":
            result = title_search(
                args.query_or_ids, args.limit, base_url, **search_options
            )
        else:
            ids = [value.strip() for value in args.query_or_ids.split(",") if value.strip()]
            result = (
                get_references(ids, base_url, **retry_options)
                if args.mode == "references"
                else get_papers(ids, base_url, **retry_options)
            )
        endpoint = safe_endpoint(_papersearch_url(base_url))
        result["endpoint"] = endpoint
        if args.output:
            _write_output(args.output, result)
        if args.summary_only:
            summary = {
                "status": "ok", "mode": args.mode, "count": result.get("count", 0),
                "output": str(args.output) if args.output else None,
                "warning": result.get("warning"),
                "endpoint": endpoint,
            }
            print(json.dumps(summary, ensure_ascii=False))
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except PaperHubRequestError as exc:
        failure = {
            "status": exc.status,
            "mode": args.mode,
            "error": str(exc),
            "retryable": exc.retryable,
        }
        if exc.http_status is not None:
            failure["http_status"] = exc.http_status
        if base_url:
            failure["endpoint"] = safe_endpoint(_papersearch_url(base_url))
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        return 2
    except (OSError, ValueError, RuntimeError) as exc:
        print(json.dumps({"status": "error", "mode": args.mode, "error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
