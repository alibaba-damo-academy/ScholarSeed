"""Private local HTTP listener owned by the product application's lifespan."""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import tempfile
from contextlib import asynccontextmanager, nullcontext
from pathlib import Path
from typing import cast

import uvicorn
from fastapi import APIRouter, FastAPI
from uvicorn.protocols.http.h11_impl import H11Protocol

from service.platform.shutdown import GracefulTimeout, Shutdown, ShutdownStage

SOCKET_FILENAME = "api.sock"
ENDPOINT_PREFIX = "endpoint-"
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_SOCKET_MODE = 0o600
START_TIMEOUT_SECONDS = 10
STOP_TIMEOUT_SECONDS = 10
START_POLL_SECONDS = 0.02
SHUTDOWN_INCOMPLETE = "local_listener_shutdown_incomplete"
WINDOWS_PLATFORM = "nt"
UNIX_SOCKET_FAMILY = getattr(socket, "AF_UNIX", None)
logger = logging.getLogger(__name__)


class LocalServer(uvicorn.Server):
    def capture_signals(self):
        # The outer Serve owns process signals. This listener shares its event loop.
        return nullcontext()

    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        await super().shutdown(sockets)
        # Uvicorn's graceful timeout cancels requests without joining their
        # cleanup. A returned server task alone is not proof that writers ended.
        if self.force_exit or self.server_state.tasks:
            raise RuntimeError(SHUTDOWN_INCOMPLETE)


class LocalProtocol(H11Protocol):
    """Silence this private listener without mutating shared Uvicorn loggers."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.access_log = False


@asynccontextmanager
async def local_listener(router: APIRouter, root: Path, *, shutdown: Shutdown | None = None):
    """Expose only the supplied capability router; no renderer or account routes."""

    # Windows asyncio cannot serve Unix sockets, even on builds exposing AF_UNIX.
    # The same scoped routes are already mounted on Serve's loopback HTTP listener.
    if os.name == WINDOWS_PLATFORM or UNIX_SOCKET_FAMILY is None:
        logger.info("local bridge uses the existing HTTP listener; Unix sockets unavailable")
        yield None
        return

    root.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
    with tempfile.TemporaryDirectory(prefix=ENDPOINT_PREFIX, dir=root) as directory:
        path = Path(directory) / SOCKET_FILENAME
        # Prebind with private permissions; never leave uvicorn's default 0666 socket.
        with socket.socket(UNIX_SOCKET_FAMILY, socket.SOCK_STREAM) as bound:
            bound.bind(str(path))
            os.chmod(path, PRIVATE_SOCKET_MODE)
        local_app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
        local_app.include_router(router)
        server = LocalServer(
            uvicorn.Config(
                local_app,
                uds=str(path),
                lifespan="off",
                log_config=None,
                log_level=None,
                http=LocalProtocol,
                timeout_graceful_shutdown=STOP_TIMEOUT_SECONDS,
            )
        )
        task = asyncio.create_task(server.serve())
        try:
            async with asyncio.timeout(START_TIMEOUT_SECONDS):
                while not server.started:
                    if task.done():
                        await task
                        raise RuntimeError("local capability listener failed to start")
                    await asyncio.sleep(START_POLL_SECONDS)
            yield path
        finally:
            if shutdown is not None:
                cast(GracefulTimeout, server.config).timeout_graceful_shutdown = min(
                    STOP_TIMEOUT_SECONDS, shutdown.remaining
                )
            server.should_exit = True
            cancellation: asyncio.CancelledError | None = None
            scope = shutdown.stage(ShutdownStage.LOCAL) if shutdown is not None else nullcontext()
            with scope:
                while True:
                    try:
                        # The configured graceful timeout belongs to Uvicorn's
                        # request drain. Cancelling serve() here bypasses that drain.
                        await asyncio.shield(task)
                    except asyncio.CancelledError as error:
                        if task.cancelled():
                            raise
                        cancellation = error
                        continue
                    except BaseException as error:
                        if cancellation is not None:
                            raise BaseExceptionGroup(
                                "Local listener shutdown failed during cancellation",
                                [error, cancellation],
                            ) from None
                        raise
                    if cancellation is not None:
                        raise cancellation
                    break
