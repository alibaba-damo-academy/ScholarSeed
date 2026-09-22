#!/usr/bin/env scholarseed-skill-python
"""Content-addressed cache for tool calls, for reproducible benchmark iteration.

Problem: PaperHub (ES) and web search can return different results for the same
request across runs. That non-determinism makes A/B comparison of prompt/strategy
changes noisy — a recall delta could be the change or just data drift.

Solution: cache each (namespace, request) -> response on disk, keyed by a hash of
the request. Identical requests replay the identical response.

Controlled by env vars (caching is OFF unless SEARCH_CACHE_DIR is set):
    SEARCH_CACHE_DIR    directory to store cache entries (unset => passthrough, no cache)
    SEARCH_CACHE_MODE   readwrite (default) | readonly | refresh | replay | off
        readwrite : serve on hit, else call live and store
        readonly  : serve on hit, else return None (caller decides; never writes)
        refresh   : ignore existing entries, always call live and overwrite
        replay    : strict frozen replay; callers must fail instead of going live on miss
        off       : disable caching entirely (same as unset dir)
    SEARCH_CACHE_REPLAY_TIMING  instant (default) | account | sleep
        instant : replay immediately and report no live latency
        account : replay immediately but expose the recorded request wall time
        sleep   : wait for the recorded request wall time before returning

Design notes:
- Keys are host-agnostic: callers pass a stable namespace (e.g. the URL *path*,
  not host) so a cache built behind the SSH tunnel (localhost:18000) is reusable
  when hitting the backend directly (a reachable backend host), and vice versa.
- Error responses are never cached, so a transient failure won't be frozen in.
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import localconf  # noqa: E402,F401  (self-configures SEARCH_CACHE_DIR/MODE on import)


def _root():
    d = os.environ.get("SEARCH_CACHE_DIR")
    return d if d else None


def _mode():
    return os.environ.get("SEARCH_CACHE_MODE", "readwrite").lower()


def replay_timing():
    """Return the validated timing policy used for cache hits."""
    value = os.environ.get("SEARCH_CACHE_REPLAY_TIMING", "instant").lower()
    return value if value in {"instant", "account", "sleep"} else "instant"


def strict_replay():
    """True when a cache miss must not fall through to the live backend."""
    return enabled() and _mode() == "replay"


def enabled():
    """True if caching is active."""
    return bool(_root()) and _mode() != "off"


def make_key(namespace, payload):
    canon = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256((namespace + "\n" + canon).encode("utf-8")).hexdigest()


def _path(namespace, key):
    # namespace may contain slashes (URL path); flatten to a safe dir name
    safe_ns = namespace.strip("/").replace("/", "_") or "default"
    return os.path.join(_root(), safe_ns, key + ".json")


def get_entry(namespace, payload):
    """Return the full cache entry, including optional timing metadata."""
    if not enabled() or _mode() == "refresh":
        return None
    path = _path(namespace, make_key(namespace, payload))
    if os.path.exists(path):
        try:
            with open(path) as f:
                entry = json.load(f)
            if "response" not in entry:
                return None
            return entry
        except (OSError, ValueError, KeyError):
            return None
    return None


def get(namespace, payload):
    """Return cached response, or None on miss / when disabled / in refresh mode."""
    entry = get_entry(namespace, payload)
    return entry["response"] if entry is not None else None


def recorded_wall(entry):
    """Return a safe non-negative recorded request wall time for an entry."""
    try:
        value = float(entry.get("metadata", {}).get("wall_elapsed", 0) or 0)
    except (AttributeError, TypeError, ValueError):
        return 0.0
    # Cache files are user-controlled. Never allow a corrupt entry to sleep forever.
    return min(max(value, 0.0), 300.0)


def put(namespace, payload, response, metadata=None):
    """Store a response. No-op when disabled, in readonly mode, or on error responses."""
    if not enabled() or _mode() in {"readonly", "replay"}:
        return False
    if isinstance(response, dict):
        if response.get("error") or response.get("success") is False:
            return False
    path = _path(namespace, make_key(namespace, payload))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({
            "schema_version": 2,
            "namespace": namespace,
            "payload": payload,
            "response": response,
            "metadata": metadata or {},
        }, f, ensure_ascii=False)
    os.replace(tmp, path)
    return True


def cached_call(namespace, payload, compute):
    """Serve from cache or call compute() and store its result.

    compute: zero-arg callable returning the response object.
    Returns (response, from_cache: bool).
    """
    hit = get(namespace, payload)
    if hit is not None:
        return hit, True
    resp = compute()
    put(namespace, payload, resp)
    return resp, False
