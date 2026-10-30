"""Close passive event subscriptions after admitted execution has drained."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

from anyio import CancelScope

from service.platform.activity import Activities


async def passive_events(
    source: AsyncGenerator[str, None], activities: Activities
) -> AsyncGenerator[str, None]:
    """Never use for a stream that owns model execution or response artifacts.

    Active turns keep observers connected for HIL and final events. Once the
    execution barrier clears, cancel only the passive iterator and await its
    cleanup before letting the HTTP response finish. Durable event cursors keep
    their existing replay semantics when the client reconnects. Process shutdown
    independently ends these observers before the HTTP server drains requests;
    that notification does not assert execution has ended.
    """
    drained = asyncio.create_task(activities.wait_execution_drained())
    stopped = asyncio.create_task(activities.wait_observers_stopped())
    pending: asyncio.Task[str] | None = None
    try:
        while True:
            pending = asyncio.create_task(anext(source))
            done, _ = await asyncio.wait(
                {pending, drained, stopped}, return_when=asyncio.FIRST_COMPLETED
            )
            if pending in done:
                try:
                    item = pending.result()
                except StopAsyncIteration:
                    return
                pending = None
                yield item
            if drained in done or stopped in done:
                return
    finally:
        with CancelScope(shield=True):
            drained.cancel()
            stopped.cancel()
            if pending is not None:
                pending.cancel()
            await asyncio.gather(
                drained,
                stopped,
                *([pending] if pending is not None else []),
                return_exceptions=True,
            )
            await source.aclose()
