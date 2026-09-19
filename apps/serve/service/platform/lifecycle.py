"""Lifecycle contract for services composed into the FastAPI product."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ServiceLifecycle(Protocol):
    """One product service that starts and closes with the application."""

    async def start(self) -> None:
        """Start background work without blocking application readiness indefinitely."""
        raise NotImplementedError

    async def aclose(self) -> None:
        """Stop background work and release owned resources."""
        raise NotImplementedError


__all__ = ["ServiceLifecycle"]
