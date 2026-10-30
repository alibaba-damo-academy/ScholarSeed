"""Owned MCP client lifetimes for HTTP, legacy SSE and local processes."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sys
import tempfile
import uuid
from contextlib import AsyncExitStack
from datetime import timedelta
from typing import Awaitable, Callable

import httpx
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

from service.platform.mcp import McpServer, McpStdioServer
from service.settings.connectors.probe import MAX_TOOL_PAGES, MAX_TOOLS
from service.settings.connectors.utils import finish_cleanup, network_error, response_error

DEFAULT_CALL_SECONDS = 60
CONNECT_SECONDS = 30
TRANSPORT_CLOSED = "connector_transport_closed"
NOTIFICATION_SECONDS = 300
DIAGNOSTIC_BYTES = 8192
MILLISECONDS_PER_SECOND = 1000
LOGGER = logging.getLogger(__name__)
DIAGNOSTIC_CHAIN_LIMIT = 8
ZOTERO_MODULE_COMMAND = "from zotero_mcp.cli import main; main()"


def fingerprint(server: McpServer) -> str:
    values = server.model_dump(mode="json", exclude={"name", "description", "enabled"})
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def transport_error(error: BaseException) -> str:
    if isinstance(error, BaseExceptionGroup):
        return transport_error(error.exceptions[0])
    if isinstance(error, FileNotFoundError):
        return "connector_command_not_found"
    if isinstance(error, TimeoutError):
        return "connector_timeout"
    if isinstance(error, httpx.HTTPStatusError):
        return response_error(error.response)
    if isinstance(error, httpx.HTTPError):
        return network_error(error)
    if isinstance(error, ValueError) and str(error).startswith("connector_"):
        return str(error)
    if isinstance(error, OSError):
        return "connector_process_failed"
    return "connector_protocol_failed"


class CredentialAuth(httpx.Auth):
    def __init__(self, origin: str, headers: Callable[[], Awaitable[dict[str, str]]]) -> None:
        self.origin = httpx.URL(origin)
        self.headers = headers

    async def async_auth_flow(self, request: httpx.Request):
        target = request.url
        if (target.scheme, target.host, target.port) != (
            self.origin.scheme,
            self.origin.host,
            self.origin.port,
        ) or target.userinfo:
            raise ValueError("connector_oauth_resource_invalid")
        request.headers.update(await self.headers())
        yield request


class Connection:
    def __init__(
        self,
        server: McpServer,
        headers: Callable[[], Awaitable[dict[str, str]]],
        changed: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.server = server
        self.headers = headers
        self.changed = changed
        self.ready = asyncio.Event()
        self.stopped = asyncio.Event()
        self.dirty = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.session: ClientSession | None = None
        self.initialized: types.InitializeResult | None = None
        self.error: str = ""
        self.lock = asyncio.Lock()
        self.startup_deadline: float | None = None
        self.inventory_ready = False
        self.stage = "connect"
        self.closing = False
        self._close_task: asyncio.Task[None] | None = None

    def client(
        self,
        headers: dict[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
        auth: httpx.Auth | None = None,
    ) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers=headers, timeout=timeout, auth=auth, follow_redirects=False
        )

    async def messages(self, message) -> None:
        notification = getattr(message, "root", None)
        if isinstance(notification, types.ToolListChangedNotification):
            self.dirty.set()

    async def start(self) -> None:
        if self.closing:
            raise ValueError(TRANSPORT_CLOSED)
        if self.task is None:
            self.task = asyncio.create_task(self.run(), name="connector-transport")
        await self.ready.wait()
        if self.closing:
            raise ValueError(TRANSPORT_CLOSED)
        if self.error:
            raise ValueError(self.error)

    async def _initialize(self, stack: AsyncExitStack, diagnostics) -> None:
        if isinstance(self.server, McpStdioServer):
            environment = await self.headers()
            command, arguments = self.server.command, list(self.server.args)
            if command == "zotero-mcp":
                command, arguments = sys.executable, [
                    "-c",
                    ZOTERO_MODULE_COMMAND,
                    *arguments,
                ]
            if diagnostics is None:
                raise RuntimeError("connector_process_failed")
            streams = await stack.enter_async_context(
                stdio_client(
                    StdioServerParameters(
                        command=command,
                        args=arguments,
                        cwd=self.server.cwd,
                        env={**self.server.environment, **environment},
                    ),
                    errlog=diagnostics,
                )
            )
        else:
            auth = CredentialAuth(self.server.url, self.headers)
            context = (
                sse_client(
                    self.server.url,
                    timeout=(
                        max(CONNECT_SECONDS, self.server.startup_timeout / MILLISECONDS_PER_SECOND)
                        if self.server.startup_timeout
                        else CONNECT_SECONDS
                    ),
                    sse_read_timeout=NOTIFICATION_SECONDS,
                    httpx_client_factory=self.client,
                    auth=auth,
                )
                if self.server.transport == "sse"
                else streamablehttp_client(
                    self.server.url,
                    timeout=(
                        max(CONNECT_SECONDS, self.server.startup_timeout / MILLISECONDS_PER_SECOND)
                        if self.server.startup_timeout
                        else CONNECT_SECONDS
                    ),
                    sse_read_timeout=NOTIFICATION_SECONDS,
                    httpx_client_factory=self.client,
                    auth=auth,
                )
            )
            streams = await stack.enter_async_context(context)
        timeout = timedelta(
            seconds=(
                self.server.timeout / MILLISECONDS_PER_SECOND
                if self.server.timeout
                else DEFAULT_CALL_SECONDS
            )
        )
        session = await stack.enter_async_context(
            ClientSession(
                streams[0],
                streams[1],
                read_timeout_seconds=timeout if self.server.startup_timeout is None else None,
                message_handler=self.messages,
            )
        )
        self.session = session
        self.stage = "initialize"
        self.initialized = await session.initialize()

    async def run(self) -> None:
        diagnostics = None
        startup_guard: asyncio.Timeout | None = None
        try:
            diagnostics = (
                tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
                if isinstance(self.server, McpStdioServer)
                else None
            )
            async with AsyncExitStack() as stack:
                if self.server.startup_timeout is not None:
                    self.startup_deadline = (
                        asyncio.get_running_loop().time()
                        + self.server.startup_timeout / MILLISECONDS_PER_SECOND
                    )
                startup_guard = asyncio.timeout_at(self.startup_deadline)
                async with startup_guard:
                    await self._initialize(stack, diagnostics)
                self.ready.set()
                while not self.stopped.is_set():
                    waiter = asyncio.create_task(self.stopped.wait())
                    dirty = asyncio.create_task(self.dirty.wait())
                    try:
                        await asyncio.wait((waiter, dirty), return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        waiter.cancel()
                        dirty.cancel()
                        await asyncio.gather(waiter, dirty, return_exceptions=True)
                    if self.dirty.is_set() and not self.stopped.is_set():
                        self.dirty.clear()
                        if self.changed:
                            await self.changed()
        except Exception as error:
            expired = startup_guard is not None and startup_guard.expired()
            self._record_failure(TimeoutError() if expired else error)
            self.error = "connector_timeout" if expired else transport_error(error)
            if (
                isinstance(self.server, McpStdioServer)
                and self.error == "connector_protocol_failed"
            ):
                self.error = "connector_process_failed"
            if diagnostics is not None:
                diagnostics.seek(0)
                content = diagnostics.read(DIAGNOSTIC_BYTES)
                if "ModuleNotFoundError" in content or "ImportError" in content:
                    self.error = "connector_dependency_missing"
        finally:
            try:
                if diagnostics is not None:
                    diagnostics.close()
            finally:
                self.session = None
                self.ready.set()

    def _record_failure(self, error: BaseException) -> None:
        cause = error
        for _ in range(DIAGNOSTIC_CHAIN_LIMIT):
            if isinstance(cause, OSError):
                break
            nested = (
                cause.exceptions[0]
                if isinstance(cause, BaseExceptionGroup)
                else cause.__cause__ or cause.__context__
            )
            if nested is None:
                break
            cause = nested
        try:
            LOGGER.warning(
                "mcp_initialization_failed schema_version=1 server_hash=%s stage=%s reason=%s errno=%s system_code=%s correlation_id=%s",
                hashlib.sha256(self.server.id.encode()).hexdigest()[:16],
                self.stage,
                (
                    "timeout"
                    if isinstance(cause, TimeoutError)
                    else "os_error" if isinstance(cause, OSError) else "protocol_error"
                ),
                cause.errno if isinstance(cause, OSError) else None,
                getattr(cause, "winerror", None) if isinstance(cause, OSError) else None,
                uuid.uuid4().hex,
            )
        except Exception:
            # Diagnostic sinks cannot change the original startup outcome.
            pass

    async def inventory(self) -> dict:
        await self.start()
        initial = not self.inventory_ready
        self.stage = "tools"
        try:
            async with asyncio.timeout_at(self.startup_deadline if initial else None):
                result = await self._inventory(initial)
        except Exception as error:
            if initial:
                self._record_failure(error)
            raise
        self.inventory_ready = True
        return result

    async def _inventory(self, initial: bool) -> dict:
        if self.session is None:
            raise ValueError(self.error or "connector_process_failed")
        initialized = self.initialized
        if initialized is None:
            raise ValueError("connector_protocol_failed")
        if initialized.capabilities.tools is None:
            return {"version": initialized.serverInfo.version, "tools": []}
        async with self.lock:
            tools: list[dict] = []
            cursor = None
            seen = set()
            for _ in range(MAX_TOOL_PAGES):
                # Initial discovery shares the startup deadline. Subsequent lists
                # retain the independent tool request budget.
                timeout = (
                    None
                    if initial and self.server.startup_timeout is not None
                    else (
                        self.server.timeout / MILLISECONDS_PER_SECOND
                        if self.server.timeout
                        else DEFAULT_CALL_SECONDS
                    )
                )
                async with asyncio.timeout(timeout):
                    result = await self.session.list_tools(cursor=cursor)
                tools.extend(
                    tool.model_dump(mode="json", exclude_none=True) for tool in result.tools
                )
                if len(tools) > MAX_TOOLS or len({tool["name"] for tool in tools}) != len(tools):
                    raise ValueError("connector_response_invalid")
                cursor = result.nextCursor
                if not cursor:
                    return {"version": initialized.serverInfo.version, "tools": tools}
                if cursor in seen:
                    raise ValueError("connector_pagination_invalid")
                seen.add(cursor)
        raise ValueError("connector_pagination_invalid")

    async def aclose(self) -> None:
        self.closing = True
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        await finish_cleanup(self._close_task)

    async def _close(self) -> None:
        self.stopped.set()
        if self.task is not None:
            if not self.task.done():
                self.task.cancel()
            result = (await asyncio.gather(self.task, return_exceptions=True))[0]
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                raise result


async def inspect_server(server: McpServer, material: dict[str, str]) -> dict:
    async def headers() -> dict[str, str]:
        return material

    connection = Connection(server, headers)
    try:
        return await connection.inventory()
    except TimeoutError:
        raise ValueError("connector_timeout") from None
    finally:
        await connection.aclose()
