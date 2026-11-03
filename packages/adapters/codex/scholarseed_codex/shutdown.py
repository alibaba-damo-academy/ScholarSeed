"""Bounded shutdown timing and await locations, without arguments or local values."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from time import monotonic

LOGGER = logging.getLogger(__name__)
WAIT_INTERVAL_SECONDS = 1.0
MAX_TASKS = 16
MAX_FRAMES = 8
MAX_WAIT_SNAPSHOTS = 12


def await_locations(task: asyncio.Task) -> list[str]:
    locations = []
    coroutine = task.get_coro()
    for _ in range(MAX_FRAMES):
        frame = getattr(coroutine, "cr_frame", None) or getattr(coroutine, "gi_frame", None)
        if frame is not None:
            locations.append(
                f"{Path(frame.f_code.co_filename).name}:{frame.f_lineno}:{frame.f_code.co_name}"
            )
        coroutine = getattr(coroutine, "cr_await", None) or getattr(coroutine, "gi_yieldfrom", None)
        if coroutine is None:
            break
    return locations


class ShutdownObservation:
    def __init__(self, operation: str, pid: int | None, generation: int):
        self.operation, self.pid, self.generation = operation, pid, generation
        self.started = monotonic()
        self.stage = "begin"
        self.owner = asyncio.current_task()
        self.process: asyncio.subprocess.Process | None = None

    def emit(self, event: str, **extra) -> None:
        LOGGER.info(
            "codex_shutdown %s",
            json.dumps(
                {
                    "operation": self.operation,
                    "pid": self.pid,
                    "generation": self.generation,
                    "stage": self.stage,
                    "event": event,
                    "elapsed_ms": round((monotonic() - self.started) * 1000),
                    **extra,
                },
                sort_keys=True,
            ),
        )

    @contextmanager
    def phase(self, stage: str):
        previous = self.stage
        self.stage = stage
        started = monotonic()
        self.emit("started")
        try:
            yield
        except BaseException as error:
            self.emit("failed", error_type=type(error).__name__)
            raise
        else:
            self.emit("finished", stage_elapsed_ms=round((monotonic() - started) * 1000))
        finally:
            self.stage = previous

    async def watch(self) -> None:
        for _ in range(MAX_WAIT_SNAPSHOTS):
            await asyncio.sleep(WAIT_INTERVAL_SECONDS)
            tasks = sorted(
                (task for task in asyncio.all_tasks() if task is not asyncio.current_task()), key=id
            )
            selected = ([self.owner] if self.owner in tasks else []) + [
                task for task in tasks if task is not self.owner
            ]
            self.emit(
                "waiting",
                returncode=self.process.returncode if self.process else None,
                pipe_eof={
                    name: getattr(self.process, name).at_eof()
                    for name in ("stdout", "stderr")
                    if self.process and getattr(self.process, name) is not None
                },
                tasks=[await_locations(task) for task in selected[:MAX_TASKS]],
                truncated=len(selected) > MAX_TASKS,
            )


@asynccontextmanager
async def observe_shutdown(operation: str, pid: int | None, generation: int):
    observation = ShutdownObservation(operation, pid, generation)
    watcher = asyncio.create_task(observation.watch())
    try:
        yield observation
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
