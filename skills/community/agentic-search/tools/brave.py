#!/usr/bin/env scholarseed-skill-python
"""Brave Web Search tool with PaperHub reconciliation.

Usage:
    scholarseed-skill-python brave.py "reinforcement learning agentic search 2024 arxiv" --count 10
    
Env:
    BRAVE_API_KEY - required
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import urllib.error

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
TIMEOUT = 15


def _title_key(title):
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())


def _clean_brave_subprocess(query, api_key, count):
    """Retry once in a child launched without a stale loopback proxy."""
    if os.environ.get("_AGENTIC_SEARCH_CLEAN_BRAVE") == "1":
        return None
    env = os.environ.copy()
    for key in (
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy",
    ):
        env.pop(key, None)
    env["BRAVE_API_KEY"] = api_key
    env["_AGENTIC_SEARCH_CLEAN_BRAVE"] = "1"
    try:
        proc = subprocess.run(
            [sys.executable, os.path.abspath(__file__), query, "--count", str(count)],
            capture_output=True, text=True, env=env, timeout=TIMEOUT + 5,
            check=False,
        )
        result = json.loads(proc.stdout)
        if proc.returncode == 0 and isinstance(result.get("results"), list):
            return result["results"]
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def brave_search(query, api_key, count=10):
    """Search Brave Web API.
    
    The API key is read only from BRAVE_API_KEY in the process environment.
    """
    params = urllib.parse.urlencode({"q": query, "count": min(count, 20)})
    url = f"{BRAVE_URL}?{params}"
    req = urllib.request.Request(url, headers={
        "X-Subscription-Token": api_key,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            results = body.get("web", {}).get("results", [])
            return [{"title": r.get("title", ""), "url": r.get("url", ""),
                     "snippet": r.get("description", "")} for r in results]
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return [{"error": "BRAVE_API_RATE_LIMITED",
                     "message": "Brave API 额度耗尽或请求过频。请更换 BRAVE_API_KEY 或稍后重试。建议改用 web-search skill 作为替代。"}]
        elif e.code == 401 or e.code == 403:
            return [{"error": "BRAVE_API_AUTH_FAILED",
                     "message": f"Brave API 认证失败(HTTP {e.code})。请检查 BRAVE_API_KEY 是否有效。"}]
        return [{"error": f"HTTP {e.code}: {str(e)}"}]
    except Exception as e:
        clean_results = _clean_brave_subprocess(query, api_key, count)
        if clean_results is not None:
            return clean_results
        return [{"error": str(e)}]


def extract_arxiv_id(url):
    m = re.search(r'(\d{4}\.\d{4,5})', url or "")
    return m.group(1) if m else None


def reconcile_with_paperhub(brave_results):
    """Try to find each Brave result in PaperHub via title search."""
    import subprocess

    matched = []
    unmatched = []

    for r in brave_results:
        if "error" in r:
            continue
        title = r.get("title", "")
        title_clean = re.sub(r'\s*[-|].*$', '', title).strip()
        if len(title_clean) < 10:
            unmatched.append(r)
            continue

        try:
            result = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(__file__), "paperhub.py"),
                 "title", title_clean[:80], "--limit", "3"],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                ph = json.loads(result.stdout)
                for p in ph.get("papers", []):
                    if _title_key(p.get("title", "")) == _title_key(title_clean):
                        p["source"] = "brave+paperhub"
                        p["brave_url"] = r.get("url", "")
                        matched.append(p)
                        break
                else:
                    arxiv_id = extract_arxiv_id(r.get("url", ""))
                    unmatched.append({
                        "title": title_clean,
                        "url": r.get("url", ""),
                        "snippet": r.get("snippet", ""),
                        "arxiv_id": arxiv_id,
                        "source": "brave_only",
                    })
            else:
                unmatched.append(r)
        except Exception:
            unmatched.append(r)

    return matched, unmatched


def main():
    parser = argparse.ArgumentParser(description="Brave Web Search tool")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--reconcile", action="store_true",
                        help="Reconcile results with PaperHub (slower but richer metadata)")
    args = parser.parse_args()

    api_key = os.environ.get("BRAVE_API_KEY", "")
    if not api_key:
        json.dump({"error": "BRAVE_API_KEY not set", "papers": []}, sys.stdout)
        print()
        return

    raw_results = brave_search(args.query, api_key, args.count)

    if args.reconcile:
        matched, unmatched = reconcile_with_paperhub(raw_results)
        result = {
            "matched": matched,
            "unmatched": unmatched,
            "total_brave_results": len(raw_results),
            "matched_count": len(matched),
            "query": args.query,
        }
    else:
        result = {
            "results": raw_results,
            "count": len(raw_results),
            "query": args.query,
        }

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
