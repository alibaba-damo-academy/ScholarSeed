"""Product HTTP shutdown order: passive transports, requests, then lifespan."""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import stat
import sys
import threading
from collections.abc import Awaitable, Callable
from typing import cast

import uvicorn
from fastapi import FastAPI
from uvicorn.lifespan.on import LifespanOn

from service.platform.activity import Activities
from service.platform.domains import DomainOwner, Domains
from service.platform.parent_control import BOOTSTRAP_BYTES, ParentControl, ParentControlError
from service.platform.shutdown import (
    DEFAULT_SHUTDOWN_SECONDS,
    GracefulTimeout,
    Shutdown,
    ShutdownStage,
)
from service.platform.transport import LOOP_FACTORY

logger = logging.getLogger(__name__)
PARENT_CONTROL_READ_BYTES = 1
PARENT_CONTROL_THREAD = "serve-parent-control"
SHUTDOWN_INCOMPLETE = "serve_shutdown_incomplete"


class ProductServer(uvicorn.Server):
    def __init__(
        self,
        config: uvicorn.Config,
        activities: Activities,
        *,
        domains: Domains | DomainOwner,
        parent_stdin: bool = False,
        parent_control: ParentControl | None = None,
        shutdown_seconds: float = DEFAULT_SHUTDOWN_SECONDS,
        close_model_streams: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        if sys.platform == "win32" and config.loop in ("auto", "asyncio"):
            config.loop = LOOP_FACTORY
        super().__init__(config)
        self._activities = activities
        self._close_model_streams = close_model_streams
        if parent_control is not None and not parent_stdin:
            raise ValueError("private control requires inherited stdin")
        self._parent_control = parent_control
        self._parent_stdin = parent_stdin
        self._domains = domains
        self._storage_released = False
        self._shutdown = Shutdown(shutdown_seconds)
        cast(FastAPI, config.app).state.shutdown = self._shutdown

    def run(self, sockets: list[socket.socket] | None = None) -> None:
        try:
            super().run(sockets)
        except KeyboardInterrupt:
            # Uvicorn re-raises captured signals. A signal is successful only
            # when the normal shutdown path already released storage.
            if not self._storage_released:
                raise RuntimeError(SHUTDOWN_INCOMPLETE) from None

    async def serve(self, sockets: list[socket.socket] | None = None) -> None:
        if self._parent_stdin:
            descriptor = sys.stdin.fileno()
            mode = os.fstat(descriptor).st_mode
            if stat.S_ISSOCK(mode):
                # Node implements child stdio with a Unix stream socket on
                # POSIX. Reject network sockets; Windows uses a native pipe.
                with socket.socket(fileno=os.dup(descriptor)) as channel:
                    if (
                        channel.family != getattr(socket, "AF_UNIX")
                        or channel.type != socket.SOCK_STREAM
                    ):
                        raise RuntimeError("parent control requires a local stream pipe")
            elif not stat.S_ISFIFO(mode):
                raise RuntimeError("parent control requires an inherited stdin pipe")
            loop = asyncio.get_running_loop()

            def observe_parent() -> None:
                # This reader owns no application state or writer permission.
                # Raw os.read avoids a buffered-stdin finalizer lock. It may
                # remain blocked until process exit after an independent signal;
                # never put it in the executor that asyncio.run must join.
                try:
                    if self._parent_control is not None:
                        bootstrap = bytearray()
                        while len(bootstrap) < BOOTSTRAP_BYTES:
                            part = os.read(descriptor, 1)
                            if not part:
                                raise OSError("parent bootstrap incomplete")
                            bootstrap.extend(part)
                            if part == b"\n":
                                break
                        if not bootstrap.endswith(b"\n"):
                            raise OSError("parent bootstrap exceeds budget")
                        loop.call_soon_threadsafe(self._start_parent_control, bytes(bootstrap))
                        bootstrap.clear()
                    unexpected = bool(os.read(descriptor, PARENT_CONTROL_READ_BYTES))
                except OSError as error:
                    logger.error(
                        "parent_control_pipe_failed pid=%s exception_type=%s errno=%s winerror=%s",
                        os.getpid(),
                        type(error).__name__,
                        error.errno,
                        getattr(error, "winerror", None),
                    )
                    unexpected = True
                try:
                    loop.call_soon_threadsafe(self._parent_closed, unexpected)
                except RuntimeError:
                    # The HTTP server has already finished through another path.
                    pass

            threading.Thread(target=observe_parent, name=PARENT_CONTROL_THREAD, daemon=True).start()
        await super().serve(sockets)
        if not self._storage_released:
            raise RuntimeError(SHUTDOWN_INCOMPLETE)

    def _start_parent_control(self, bootstrap: bytes) -> None:
        logger.info("parent_control_bootstrap_received pid=%s", os.getpid())
        if self.should_exit or self._parent_control is None:
            return
        try:
            self._parent_control.start(bootstrap)
        except ParentControlError:
            logger.error("parent_control_bootstrap_rejected pid=%s", os.getpid())
            self._parent_closed(True)

    def _parent_closed(self, unexpected: bool) -> None:
        if unexpected:
            logger.warning("parent control failed; requesting ordinary server shutdown")
        self._shutdown.start("parent-control-failed" if unexpected else "parent-stdin-eof")
        self.should_exit = True

    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        self._shutdown.start("server-stop")
        try:
            if self._shutdown.remaining <= 0:
                raise TimeoutError(SHUTDOWN_INCOMPLETE)
            async with asyncio.timeout_at(self._shutdown.deadline) as deadline:
                await self._shutdown_product(sockets)
                if deadline.expired() or self._shutdown.remaining <= 0:
                    raise TimeoutError(SHUTDOWN_INCOMPLETE)
        except BaseException as error:
            self._shutdown.event("failed", failed=True, error_type=type(error).__name__)
            raise
        self._shutdown.event("complete")

    async def _shutdown_product(self, sockets: list[socket.socket] | None) -> None:
        # Lifespan teardown runs after uvicorn drains requests. Passive SSE
        # consumers must end first or an idle renderer can hold that drain open
        # forever. Iterator cleanup remains part of its actual HTTP request.
        if self._parent_control is not None:
            with self._shutdown.stage(ShutdownStage.CONTROL):
                await self._parent_control.aclose()
        with self._shutdown.stage(ShutdownStage.OBSERVERS):
            self._activities.stop_observers()
        # Model bridges are active HTTP responses owned by this process. Stop
        # their producers before asking HTTP to drain; lifespan cannot cancel
        # them while it is itself waiting behind that drain.
        if self._close_model_streams is not None:
            with self._shutdown.stage(ShutdownStage.MODELS):
                await self._close_model_streams()
        timeout_config = cast(GracefulTimeout, self.config)
        configured = timeout_config.timeout_graceful_shutdown
        timeout_config.timeout_graceful_shutdown = (
            self._shutdown.remaining
            if configured is None
            else min(configured, self._shutdown.remaining)
        )
        with self._shutdown.stage(ShutdownStage.HTTP):
            await super().shutdown(sockets)
        remaining = self._activities.snapshot().counts
        if remaining:
            logger.error("server shutdown left active operations: %s", remaining)
        # Uvicorn records lifespan failures without raising them. A caller must
        # not mistake that return (or a forced/unfinished drain) for clean exit.
        if (
            self.force_exit
            or self._shutdown.remaining <= 0
            or self.server_state.tasks
            or remaining
            or (
                isinstance(self.lifespan, LifespanOn)
                and (self.lifespan.shutdown_failed or self.lifespan.error_occurred)
            )
        ):
            raise RuntimeError(SHUTDOWN_INCOMPLETE)

        # HTTP transport and every application owner are now finished. Storage
        # is the last resource released; any earlier failure retains it until
        # process death rather than allowing a replacement writer to overlap.
        with self._shutdown.stage(ShutdownStage.STORAGE):
            self._domains.close()
            self._storage_released = True
