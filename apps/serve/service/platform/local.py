"""Private local HTTP listener owned by the product application's lifespan."""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import tempfile
from contextlib import asynccontextmanager, nullcontext
from pathlib import Path

import uvicorn
from fastapi import APIRouter, FastAPI

SOCKET_FILENAME = "api.sock"
ENDPOINT_PREFIX = "endpoint-"
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_SOCKET_MODE = 0o600
START_TIMEOUT_SECONDS = 10
STOP_TIMEOUT_SECONDS = 10
START_POLL_SECONDS = 0.02
LOCAL_LOG_LEVEL = "warning"
WINDOWS_PLATFORM = "nt"
UNIX_SOCKET_FAMILY = getattr(socket, "AF_UNIX", None)
logger = logging.getLogger(__name__)


class LocalServer(uvicorn.Server):
    def capture_signals(self):
        # The outer Serve owns process signals. This listener shares its event loop.
        return nullcontext()


@asynccontextmanager
async def local_listener(router: APIRouter, root: Path):
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
                log_level=LOCAL_LOG_LEVEL,
                access_log=False,
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
            server.should_exit = True
            try:
                await asyncio.wait_for(task, STOP_TIMEOUT_SECONDS)
            except asyncio.CancelledError:
                # The outer Serve lifespan can cancel this task while the
                # local listener is being unwound.  It is already stopping;
                # absorb the cancellation so Ctrl+C remains a clean exit.
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            except TimeoutError:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                logger.warning(
                    "local capability listener did not stop within %ss", STOP_TIMEOUT_SECONDS
                )
