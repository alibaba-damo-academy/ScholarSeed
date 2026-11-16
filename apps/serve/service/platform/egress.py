"""Outbound HTTP client lifecycle for proxy-aware egress.

httpx snapshots environment/system proxies when a client is constructed, so a
process-lifetime client keeps obsolete routes after the network configuration
changes. Borrowed clients keep their owner's lifecycle; default clients live for
one outbound operation and observe the proxy configuration current at that time.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx


@asynccontextmanager
async def outbound(
    client: httpx.AsyncClient | None, **kwargs: Any
) -> AsyncIterator[httpx.AsyncClient]:
    if client is not None:
        yield client
        return
    async with httpx.AsyncClient(**kwargs) as fresh:
        yield fresh
