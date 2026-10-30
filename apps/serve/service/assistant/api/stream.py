"""Request-scoped action event transport and disconnect cleanup."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from dataclasses import asdict
from enum import Enum
from typing import Any, Protocol

from anyio import CancelScope, move_on_after
from fastapi import HTTPException

from service.assistant.persistence.invocations import AssistantInvocationConflictError
from service.chat.constants import SSE_HEARTBEAT_SECONDS
from service.chat.service.events import SSE_HEARTBEAT_FRAME, sse_encode
from service.platform.inference import ModelInvocationEvent, ModelInvocationObserver

SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
STREAM_QUEUE_SIZE = 256
INTERRUPT_WAIT_SECONDS = 10
logger = logging.getLogger(__name__)


class SelectionStreamKind(str, Enum):
    RESULT = "result"
    ERROR = "error"


class ActionCommand(Protocol):
    @property
    def owner_id(self) -> str: ...


class StreamingActionService(Protocol):
    async def execute(
        self, command: Any, *, observer: ModelInvocationObserver | None = None
    ) -> Any: ...
    async def cancel(self, *, invocation_id: str, owner_id: str) -> bool: ...


async def action_stream(
    service: StreamingActionService, command: ActionCommand
) -> AsyncGenerator[str, None]:
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=STREAM_QUEUE_SIZE)
    invocation_id = ""

    async def observe(event: ModelInvocationEvent) -> None:
        nonlocal invocation_id
        invocation_id = event.invocation_id
        await queue.put({"type": event.kind.value, **asdict(event)})

    async def execute() -> None:
        try:
            result = await service.execute(command, observer=observe)
            await queue.put({"type": SelectionStreamKind.RESULT, "result": asdict(result)})
        except Exception as error:
            # Once SSE headers are sent, preserve validation failures as safe events.
            detail = (
                error.detail
                if isinstance(error, HTTPException)
                else getattr(error, "code", "selection_model_failed")
            )
            if isinstance(error, AssistantInvocationConflictError):
                detail = "attempt_conflict"
            await queue.put({"type": SelectionStreamKind.ERROR, "error": detail})

    task = asyncio.create_task(execute())
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
            except TimeoutError:
                yield SSE_HEARTBEAT_FRAME
                continue
            yield sse_encode(event)
            if event["type"] in (SelectionStreamKind.RESULT, SelectionStreamKind.ERROR):
                await task
                return
    finally:
        if not task.done():
            # Drain activity while waiting so backpressure cannot prevent termination.
            async def drain() -> None:
                while not task.done():
                    pending = asyncio.create_task(queue.get())
                    try:
                        await asyncio.wait({pending, task}, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        if not pending.done():
                            pending.cancel()
                        await asyncio.gather(pending, return_exceptions=True)

            # Starlette cancels the response's AnyIO scope on a disconnect. Cleanup
            # must survive that cancellation, including a failing interrupt transport.
            with CancelScope(shield=True):
                try:
                    with move_on_after(INTERRUPT_WAIT_SECONDS):
                        if invocation_id:
                            await service.cancel(
                                invocation_id=invocation_id, owner_id=command.owner_id
                            )
                        await drain()
                except Exception as error:
                    logger.warning(
                        "selection_disconnect_interrupt_failed type=%s", type(error).__name__
                    )
                finally:
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
