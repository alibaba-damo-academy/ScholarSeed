"""Bypass ambient proxies only for explicitly configured direct endpoints.

PaperHub uses the inherited proxy first, matching agentic-search, and falls
back to direct transport on connection errors. A caller may explicitly add
hosts with SLR_NO_PROXY_EXTRA. Existing NO_PROXY entries are preserved.
"""
from __future__ import annotations

import os
from urllib.parse import urlparse

__all__ = ["apply", "hosts_from_endpoints", "current"]

_applied = False


def hosts_from_endpoints(services: dict, bypass_services: set[str]) -> list[str]:
    """Hostnames of configured direct endpoints, in stable order.

    Bare hostnames only -- no scheme, no port. `NO_PROXY` matching in both
    `requests` and `httpx` is host-based; a `host:port` entry matches only that
    port, which would silently miss a service reached on a second port.
    """
    seen: list[str] = []
    for name, url in services.items():
        if name not in bypass_services:
            continue
        if not url:
            continue
        host = urlparse(url).hostname
        if host and host not in seen:
            seen.append(host)
    return seen


def current() -> list[str]:
    """Whatever `NO_PROXY` / `no_proxy` currently list, de-duplicated."""
    merged: list[str] = []
    for name in ("NO_PROXY", "no_proxy"):
        for item in os.environ.get(name, "").split(","):
            item = item.strip()
            if item and item not in merged:
                merged.append(item)
    return merged


def apply(services: dict, bypass_services: set[str]) -> list[str]:
    """Add configured direct hosts to NO_PROXY. Returns the hosts added.

    Called through `slr_paths.apply_proxy_policy()`. Safe to call repeatedly.
    """
    global _applied
    if _applied:
        return []

    wanted = hosts_from_endpoints(services, bypass_services)
    extra = os.environ.get("SLR_NO_PROXY_EXTRA", "")
    wanted += [h.strip() for h in extra.split(",") if h.strip()]

    existing = current()
    added = list(dict.fromkeys(h for h in wanted if h not in existing))
    if added:
        value = ",".join(existing + added)
        # Both spellings: `requests` prefers the lower-case one, parts of the
        # stdlib and some SDKs only look at the upper-case one.
        os.environ["NO_PROXY"] = value
        os.environ["no_proxy"] = value

    _applied = True
    return added
