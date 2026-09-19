"""
no_proxy — keep the skill's own service traffic off the ambient HTTP proxy.

Why this exists
---------------
The retrieval corpus (PaperHub) and the card-upload target sit on an internal
network. A developer shell frequently has `HTTP_PROXY` / `HTTPS_PROXY` pointing
at some outbound proxy, and both `requests` and `httpx` honour those variables
for *every* host that is not listed in `NO_PROXY`. The stock `NO_PROXY` covers
localhost and the RFC1918 ranges, which is not enough: PaperHub is reached at a
public IP and at a public NLB hostname, so its traffic gets handed to a proxy
that has no route to it.

The failure is also badly disguised. A CONNECT-only proxy answers a forwarded
plain-HTTP request with `405 Method Not Allowed` rather than refusing the
connection, so the retrieval stage sees a well-formed HTTP error from something
that is not PaperHub and reports "no results" instead of "unreachable".

What it does
------------
`apply()` appends every host in `config/endpoints.json` to `NO_PROXY` and
`no_proxy` (both spellings -- `requests` reads the lower-case one first, some
stacks only read the upper-case one). Existing entries are preserved: this only
ever adds. It is idempotent, so the repeated `bootstrap()` calls that happen
when one script imports another cost nothing.

Scope is deliberately narrow: only hosts this skill is configured to talk to.
The LLM gateway in `config/model_config.<profile>.json` is NOT included --
whether that one needs the proxy depends on where it is deployed, so it stays
under the ambient environment's control. Set `SLR_NO_PROXY_EXTRA` (a
comma-separated host list) to add it, or anything else, without editing code.
"""
from __future__ import annotations

import os
from urllib.parse import urlparse

__all__ = ["apply", "hosts_from_endpoints", "current"]

_applied = False


def hosts_from_endpoints(services: dict) -> list[str]:
    """Hostnames from a resolved `endpoints()` mapping, in stable order.

    Bare hostnames only -- no scheme, no port. `NO_PROXY` matching in both
    `requests` and `httpx` is host-based; a `host:port` entry matches only that
    port, which would silently miss a service reached on a second port.
    """
    seen: list[str] = []
    for url in services.values():
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


def apply(services: dict | None = None) -> list[str]:
    """Add this skill's service hosts to NO_PROXY. Returns the hosts added.

    Called from `slr_paths.bootstrap()`, so every entry point gets it without
    each script having to remember. Safe to call repeatedly.
    """
    global _applied
    if _applied:
        return []

    if services is None:
        import slr_paths
        services = slr_paths.endpoints()

    wanted = hosts_from_endpoints(services)
    extra = os.environ.get("SLR_NO_PROXY_EXTRA", "")
    wanted += [h.strip() for h in extra.split(",") if h.strip()]

    existing = current()
    added = [h for h in wanted if h not in existing]
    if added:
        value = ",".join(existing + added)
        # Both spellings: `requests` prefers the lower-case one, parts of the
        # stdlib and some SDKs only look at the upper-case one.
        os.environ["NO_PROXY"] = value
        os.environ["no_proxy"] = value

    _applied = True
    return added
