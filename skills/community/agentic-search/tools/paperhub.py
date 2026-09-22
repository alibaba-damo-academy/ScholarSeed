#!/usr/bin/env scholarseed-skill-python
"""PaperHub search tool - keyword/title search, citation lookup, paper details.

Usage:
    scholarseed-skill-python paperhub.py keyword "reinforcement learning search agent" --limit 20
    scholarseed-skill-python paperhub.py title "Attention Is All You Need"
    scholarseed-skill-python paperhub.py references 257767360,12345
    scholarseed-skill-python paperhub.py papers 257767360,12345
"""

import argparse
from contextlib import contextmanager
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import localconf  # noqa: E402,F401  (self-configures env on import: PAPERHUB_URL, no_proxy, cache)
import cache  # noqa: E402  (local module, tools/cache.py)


def _papersearch_url(value):
    """Accept either a PaperHub base URL or the full /papersearch endpoint."""
    base = localconf._canonical_paperhub_url((value or "").strip()).rstrip("/")
    if not base:
        base = "https://scholarseed.damo.alibaba.com/paperhub"
    if urllib.parse.urlparse(base).path.rstrip("/").endswith("/papersearch"):
        return base + "/"
    return base + "/papersearch/"


_BASE = os.environ.get(
    "PAPERHUB_URL", "https://scholarseed.damo.alibaba.com/paperhub"
)
PAPERSEARCH_URL = _papersearch_url(_BASE)

# A shared API key can exhaust the service's short token bucket even when one
# agent uses a single worker. Three attempts (1s + 2s) are too short for that
# bucket to refill, so retain the fast path but give retryable failures a
# bounded 1s/2s/4s/8s/10s recovery window.
MAX_RETRIES = 6
TIMEOUT = 60
_CLEAN_POST_MODE = "_clean-post"
_RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}


def _api_key():
    return os.environ.get("SCHOLARSEED_API_KEY", "").strip()


def _request_headers():
    key = _api_key()
    if not key:
        return None
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _proxy_mode():
    mode = os.environ.get("PAPERHUB_PROXY_MODE", "auto").strip().lower()
    return mode if mode in ("auto", "inherit", "direct") else "auto"


@contextmanager
def _without_proxy_environment():
    """Temporarily hide proxy URLs for one direct request, then restore them."""
    keys = (
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy",
    )
    saved = {key: os.environ[key] for key in keys if key in os.environ}
    try:
        for key in keys:
            os.environ.pop(key, None)
        yield
    finally:
        os.environ.update(saved)


def _direct_open(req):
    # Some Codex runtimes inject a loopback proxy below urllib's ProxyHandler.
    # Clearing the proxy variables only for this call avoids carrying that
    # sandbox-local endpoint into an approved command running outside sandbox.
    with _without_proxy_environment():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(req, timeout=TIMEOUT)


def _open(req):
    """Open through inherited proxies, with a direct transport fallback.

    Codex sandboxes may inject a loopback proxy that is valid only inside the
    sandbox. If an approved command is rerun outside it, inheriting that stale
    proxy can produce EBADF. `auto` preserves working corporate/Codex proxies
    first, then retries the same request directly on transport/proxy failures.
    """
    mode = _proxy_mode()
    if mode == "direct":
        return _direct_open(req)
    try:
        return urllib.request.urlopen(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as exc:
        # Authentication failures must not be mistaken for proxy failures.
        if mode == "auto" and exc.code in (407, 502):
            return _direct_open(req)
        raise
    except (urllib.error.URLError, TimeoutError, OSError):
        if mode == "auto":
            return _direct_open(req)
        raise


def _clean_post_subprocess(url, payload):
    """Retry a POST in a child launched without inherited proxy variables.

    A few managed Codex runtimes bind their loopback proxy at process startup,
    so changing os.environ in the current process is too late. The child is a
    narrow fallback used only after the normal proxy/direct transports fail.
    """
    env = os.environ.copy()
    for key in (
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy",
    ):
        env.pop(key, None)
    env["PAPERHUB_PROXY_MODE"] = "direct"
    try:
        proc = subprocess.run(
            [sys.executable, os.path.abspath(__file__), _CLEAN_POST_MODE, url],
            input=json.dumps(payload), capture_output=True, text=True,
            env=env, timeout=TIMEOUT + 5, check=False,
        )
        result = json.loads(proc.stdout)
        if proc.returncode == 0 and "body" in result:
            return result["body"], result.get("elapsed", 0)
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def _run_clean_post(url):
    """Hidden child-process entry point for `_clean_post_subprocess`."""
    try:
        payload = json.load(sys.stdin)
        data = json.dumps(payload).encode("utf-8")
        headers = _request_headers()
        if headers is None:
            raise ValueError("SCHOLARSEED_API_KEY is not set")
        req = urllib.request.Request(url, data=data, headers=headers)
        t0 = time.time()
        with _direct_open(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        json.dump({"body": body, "elapsed": round(time.time() - t0, 2)}, sys.stdout)
        print()
        return 0
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as exc:
        json.dump({"error": str(exc)}, sys.stdout)
        print()
        return 1


def _http_error(exc):
    """Convert urllib HTTPError to a stable, non-secret error object."""
    detail = ""
    try:
        raw = exc.read().decode("utf-8", errors="replace")[:2000]
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            detail = str(parsed.get("detail") or parsed.get("message") or parsed.get("error") or "")
        elif raw:
            detail = raw
    except (OSError, ValueError):
        detail = ""
    message = f"PaperHub HTTP {exc.code}"
    if detail:
        message += f": {detail}"
    return {
        "error": message,
        "error_code": f"PAPERHUB_HTTP_{exc.code}",
        "status": exc.code,
    }


def _http_post(url, payload):
    """Live HTTP POST with retries. Returns (body, elapsed)."""
    headers = _request_headers()
    if headers is None:
        return {
            "error": "SCHOLARSEED_API_KEY is not set",
            "error_code": "PAPERHUB_AUTH_MISSING",
        }, 0
    data = json.dumps(payload).encode("utf-8")
    clean_fallback_attempted = False
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            t0 = time.time()
            with _open(req) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                elapsed = round(time.time() - t0, 2)
                return body, elapsed
        except urllib.error.HTTPError as exc:
            error = _http_error(exc)
            if exc.code not in _RETRYABLE_HTTP_STATUS or attempt == MAX_RETRIES - 1:
                return error, 0
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            try:
                delay = (
                    min(float(retry_after), 30.0)
                    if retry_after else min(2 ** attempt, 10.0)
                )
            except (TypeError, ValueError):
                delay = min(2 ** attempt, 10.0)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if _proxy_mode() in ("auto", "direct") and not clean_fallback_attempted:
                clean_fallback_attempted = True
                clean_result = _clean_post_subprocess(url, payload)
                if clean_result is not None:
                    return clean_result
            if attempt < MAX_RETRIES - 1:
                time.sleep(1 * (attempt + 1))
                continue
            return {
                "error": str(exc),
                "error_code": "PAPERHUB_TRANSPORT_ERROR",
            }, 0
        except (ValueError, json.JSONDecodeError) as exc:
            return {
                "error": f"Invalid PaperHub JSON response: {exc}",
                "error_code": "PAPERHUB_INVALID_RESPONSE",
            }, 0


def _post(url, payload):
    """Cache-wrapped POST. Namespace is the URL *path* (host-agnostic) so the
    cache is portable between the SSH tunnel and direct-backend access."""
    ns = "paperhub-v2" + urllib.parse.urlparse(url).path
    entry = cache.get_entry(ns, payload)
    if entry is not None:
        recorded_wall = cache.recorded_wall(entry)
        timing = cache.replay_timing()
        if timing == "sleep" and recorded_wall:
            time.sleep(recorded_wall)
        accounted_elapsed = recorded_wall if timing in {"account", "sleep"} else 0.0
        return entry["response"], accounted_elapsed
    if cache.strict_replay():
        return {
            "error": "PaperHub request is missing from the frozen query cache",
            "error_code": "SEARCH_CACHE_MISS",
        }, 0.0
    live_started = time.monotonic()
    body, elapsed = _http_post(url, payload)
    live_wall = round(time.monotonic() - live_started, 3)
    if isinstance(body, dict) and body.get("success") is False and "error" not in body:
        body = {
            "error": str(body.get("message") or body.get("detail") or "PaperHub request failed"),
            "error_code": "PAPERHUB_API_ERROR",
        }
    if not isinstance(body, dict):
        body = {
            "error": "PaperHub response is not a JSON object",
            "error_code": "PAPERHUB_INVALID_RESPONSE",
        }
    cache.put(ns, payload, body, metadata={
        "wall_elapsed": live_wall,
        "backend_elapsed": elapsed,
    })
    return body, elapsed


def _external_id(external_ids, name):
    if not isinstance(external_ids, dict):
        return ""
    wanted = name.lower()
    for key, value in external_ids.items():
        if str(key).lower() == wanted and value is not None:
            return str(value)
    return ""


def _year_from_paper(paper):
    year = paper.get("year")
    if isinstance(year, int):
        return year
    if isinstance(year, str) and re.fullmatch(r"\d{4}", year.strip()):
        return int(year)
    publication_date = str(paper.get("publicationdate") or paper.get("publication_date") or "")
    match = re.search(r"(?<!\d)((?:19|20|21)\d{2})(?!\d)", publication_date)
    return int(match.group(1)) if match else None


def _int_value(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _string_value(*values):
    """Return the first non-empty value as a whitespace-trimmed string."""
    for value in values:
        if value is not None:
            text = str(value).strip()
            if text:
                return text
    return ""


def _normalize_paper(paper):
    """Extract clean paper metadata from a PaperHub result."""
    authors = []
    for a in (paper.get("authors") or []):
        if isinstance(a, dict):
            authors.append(a.get("name", ""))
        else:
            authors.append(str(a))
    external_ids = paper.get("externalids") or paper.get("external_ids") or {}
    publication_date = paper.get("publicationdate") or paper.get("publication_date") or ""
    return {
        "paper_id": str(paper.get("id") or paper.get("paper_id") or ""),
        "title": paper.get("title") or "",
        "authors": authors,
        "year": _year_from_paper(paper),
        "venue": paper.get("venue") or "",
        "journal_name": _string_value(
            paper.get("journalname"), paper.get("journal_name"),
        ),
        "journal_pages": _string_value(
            paper.get("journalpages"), paper.get("journal_pages"), paper.get("pages"),
        ),
        "journal_volume": _string_value(
            paper.get("journalvolume"), paper.get("journal_volume"), paper.get("volume"),
        ),
        "abstract": paper.get("abstract") or "",
        "citation_count": _int_value(paper.get("citationcount", paper.get("citation_count", 0))),
        "doi": _external_id(external_ids, "DOI") or str(paper.get("doi") or ""),
        "arxiv_id": _external_id(external_ids, "ArXiv") or str(paper.get("arxiv_id") or ""),
        "is_open_access": paper.get("isopenaccess", paper.get("is_open_access")),
        "url": paper.get("url") or "",
        "publication_date": str(publication_date),
        "reference_count": _int_value(paper.get("referencecount", paper.get("reference_count", 0))),
        "influential_citation_count": _int_value(
            paper.get("influentialcitationcount", paper.get("influential_citation_count", 0))
        ),
        "publication_types": paper.get("publicationtypes") or paper.get("publication_types") or [],
        "source": "paperhub",
    }


def _extract_data(body):
    """Return v2 response data, or an explicit protocol error."""
    if not isinstance(body, dict):
        return None, "PaperHub response is not a JSON object"
    if body.get("error"):
        return None, str(body["error"])
    if body.get("success") is not True:
        return None, "PaperHub response is missing success=true"
    data = body.get("data")
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return None, "PaperHub response data is not a list"
    return data, None


def _failure(body, error, elapsed, **fields):
    result = {"error": error, "elapsed": elapsed, **fields}
    if isinstance(body, dict):
        for key in ("error_code", "status"):
            if key in body:
                result[key] = body[key]
    return result


def _search_payload(limit, ensure_abstract, year_start=None, year_end=None):
    payload = {"limit": limit, "ensure_abstract": bool(ensure_abstract)}
    if year_start is not None:
        payload["year_start"] = year_start
    if year_end is not None:
        payload["year_end"] = year_end
    return payload


def keyword_search(query, limit=20, year_start=None, year_end=None, ensure_abstract=True):
    if not str(query).strip():
        return {
            "error": "A non-empty keyword query is required",
            "error_code": "PAPERHUB_INVALID_ARGUMENT",
            "papers": [],
            "elapsed": 0,
        }
    payload = _search_payload(limit, ensure_abstract, year_start, year_end)
    payload["query"] = query
    body, elapsed = _post(PAPERSEARCH_URL, payload)
    results, error = _extract_data(body)
    if error:
        return _failure(body, error, elapsed, papers=[])
    papers = [_normalize_paper(r) for r in results]
    return {"papers": papers, "count": len(papers), "elapsed": elapsed, "query": query, "mode": "keyword"}


def semantic_search(query, limit=20):
    del limit
    return {
        "error": "PaperHub v2 does not support semantic search; use keyword or title",
        "error_code": "PAPERHUB_UNSUPPORTED_MODE",
        "papers": [],
        "elapsed": 0,
        "query": query,
        "mode": "semantic",
    }


def title_search(title, limit=5, year_start=None, year_end=None, ensure_abstract=True):
    if not str(title).strip():
        return {
            "error": "A non-empty title query is required",
            "error_code": "PAPERHUB_INVALID_ARGUMENT",
            "papers": [],
            "elapsed": 0,
        }
    payload = _search_payload(limit, ensure_abstract, year_start, year_end)
    payload["title"] = title
    body, elapsed = _post(PAPERSEARCH_URL, payload)
    results, error = _extract_data(body)
    if error:
        return _failure(body, error, elapsed, papers=[])
    papers = [_normalize_paper(r) for r in results]
    return {"papers": papers, "count": len(papers), "elapsed": elapsed, "title": title, "mode": "title"}


def _mget_id(pid):
    """Keep v2 string IDs intact, while accepting the legacy unified_ prefix."""
    s = str(pid).strip()
    return s[len("unified_"):] if s.startswith("unified_") else s


def get_references(paper_ids):
    """Get reference IDs for given papers. Returns {paper_id: [ref_id, ...]}."""
    paper_ids = [_mget_id(p) for p in paper_ids]
    paper_ids = [p for p in paper_ids if p]
    if not paper_ids:
        return {
            "error": "At least one paper ID is required",
            "error_code": "PAPERHUB_INVALID_ARGUMENT",
            "references": {},
            "count": 0,
            "elapsed": 0,
        }
    body, elapsed = _post(PAPERSEARCH_URL, {"cited_by": paper_ids})
    docs, error = _extract_data(body)
    if error:
        return _failure(body, error, elapsed, references={}, count=0)
    ref_map = {}
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        pid = str(doc.get("cited_by") or "")
        ref_ids = doc.get("ids") or []
        ref_map[pid] = [str(r) for r in ref_ids]
    return {"references": ref_map, "count": len(ref_map), "elapsed": elapsed}


def get_papers(paper_ids):
    """Get paper details by IDs."""
    paper_ids = [_mget_id(p) for p in paper_ids]
    paper_ids = [p for p in paper_ids if p]
    if not paper_ids:
        return {
            "error": "At least one paper ID is required",
            "error_code": "PAPERHUB_INVALID_ARGUMENT",
            "papers": [],
            "count": 0,
            "elapsed": 0,
        }
    body, elapsed = _post(PAPERSEARCH_URL, {"ids": paper_ids})
    docs, error = _extract_data(body)
    if error:
        return _failure(body, error, elapsed, papers=[], count=0)
    papers = [_normalize_paper(doc) for doc in docs if isinstance(doc, dict)]
    return {"papers": papers, "count": len(papers), "elapsed": elapsed}


def _bounded_limit(value):
    value = int(value)
    if not 1 <= value <= 1000:
        raise argparse.ArgumentTypeError("limit must be between 1 and 1000")
    return value


def _bounded_year(value):
    value = int(value)
    if not 1900 <= value <= 2100:
        raise argparse.ArgumentTypeError("year must be between 1900 and 2100")
    return value


def main():
    if len(sys.argv) == 3 and sys.argv[1] == _CLEAN_POST_MODE:
        return _run_clean_post(sys.argv[2])

    parser = argparse.ArgumentParser(description="PaperHub search tool")
    parser.add_argument("mode", choices=["keyword", "semantic", "title", "references", "papers"])
    parser.add_argument("query_or_ids", help="Search query string, or comma-separated IDs")
    parser.add_argument(
        "--limit", type=_bounded_limit, default=None,
        help="result limit (default: 5 for title, 20 for keyword)",
    )
    parser.add_argument("--year-start", type=_bounded_year)
    parser.add_argument("--year-end", type=_bounded_year)
    parser.add_argument(
        "--allow-missing-abstract", action="store_true",
        help="set ensure_abstract=false for keyword/title search",
    )
    parser.add_argument("--url", default=None, help="Override PaperHub base URL")
    args = parser.parse_args()

    if args.url:
        global PAPERSEARCH_URL
        PAPERSEARCH_URL = _papersearch_url(args.url)

    if args.year_start and args.year_end and args.year_start > args.year_end:
        parser.error("--year-start cannot be greater than --year-end")

    search_options = {
        "year_start": args.year_start,
        "year_end": args.year_end,
        "ensure_abstract": not args.allow_missing_abstract,
    }

    limit = args.limit if args.limit is not None else (5 if args.mode == "title" else 20)

    if args.mode == "keyword":
        result = keyword_search(args.query_or_ids, limit, **search_options)
    elif args.mode == "semantic":
        result = semantic_search(args.query_or_ids, limit)
    elif args.mode == "title":
        result = title_search(args.query_or_ids, limit, **search_options)
    elif args.mode == "references":
        ids = [x.strip() for x in args.query_or_ids.split(",") if x.strip()]
        result = get_references(ids)
    elif args.mode == "papers":
        ids = [x.strip() for x in args.query_or_ids.split(",") if x.strip()]
        result = get_papers(ids)

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 1 if result.get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
