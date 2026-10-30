"""Private, lifespan-bound MCP bridge; provider credentials never reach the renderer."""

from __future__ import annotations

import asyncio
import logging
import secrets
import traceback
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Awaitable, Callable

import uvicorn
from fastapi import FastAPI
from mcp import types
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.shared.exceptions import McpError
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from scholarseed_runtime.contract.mcp import (
    McpCredentialBinding,
    McpCredentialTarget,
    McpHttpTransport,
    McpServerConfiguration,
)
from scholarseed_runtime.contract.secret import RuntimeSecret
from service.platform.activity import Activities, ActivityDomain, ActivityPhase, MaintenanceStale
from service.platform.local import (
    START_POLL_SECONDS,
    START_TIMEOUT_SECONDS,
    STOP_TIMEOUT_SECONDS,
    LocalProtocol,
    LocalServer,
)
from service.platform.mcp import McpServer, McpStdioServer
from service.settings.connectors.transport import (
    DEFAULT_CALL_SECONDS,
    MILLISECONDS_PER_SECOND,
    Connection,
    fingerprint,
    transport_error,
)
from service.settings.connectors.utils import finish_cleanup

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 0
BROKER_REFERENCE = "broker:session"
BROKER_ROUTE = "/mcp/{binding}"
BROKER_TOKEN_BYTES = 32
RPC_FAILURE = -32000
LOGGER = logging.getLogger(__name__)
RPC_TYPES = (
    (types.CallToolRequest, types.CallToolResult, "tools"),
    (types.ListResourcesRequest, types.ListResourcesResult, "resources"),
    (types.ListResourceTemplatesRequest, types.ListResourceTemplatesResult, "resources"),
    (types.ReadResourceRequest, types.ReadResourceResult, "resources"),
    (types.ListPromptsRequest, types.ListPromptsResult, "prompts"),
    (types.GetPromptRequest, types.GetPromptResult, "prompts"),
)


class ConnectorServer(Server):
    def create_initialization_options(
        self, notification_options=None, experimental_capabilities=None
    ):
        return super().create_initialization_options(
            NotificationOptions(tools_changed=True), experimental_capabilities
        )


class Binding:
    def __init__(self, owner: ConnectorBroker, source: McpServer) -> None:
        self.owner = owner
        self.source = source
        self.token = owner.token
        self.ready = asyncio.Event()
        self.stop = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.manager: StreamableHTTPSessionManager | None = None
        self.sessions: set = set()
        self.connection = Connection(source, self.headers, self.changed)
        self.error = ""
        self.closing = False
        self._close_task: asyncio.Task[None] | None = None
        self.active = 0
        self.requests = 0
        self.drained = asyncio.Event()
        self.drained.set()

    @asynccontextmanager
    async def invocation(self):
        await self.owner.admit(self.source)
        if self.closing:
            raise ValueError("connector_configuration_conflict")
        self.active += 1
        self.drained.clear()
        try:
            with self.owner.activities.enter(ActivityDomain.INVOCATION):
                yield
        finally:
            self.active -= 1
            if not self.active:
                self.drained.set()

    async def headers(self) -> dict[str, str]:
        await self.owner.admit(self.source)
        field = (
            self.source.environment_secrets
            if isinstance(self.source, McpStdioServer)
            else self.source.header_secrets
        )
        result = {} if isinstance(self.source, McpStdioServer) else dict(self.source.headers)
        for name, reference in field.items():
            try:
                result[name] = (await self.owner.secrets.resolve(reference)).value
            except ValueError as error:
                await self.owner.observe(self.source, None, transport_error(error))
                raise
        return result

    async def changed(self) -> None:
        await self.owner.observe(self.source, None, "")
        try:
            observed = await self.connection.inventory()
            await self.owner.observe(self.source, observed, "")
            for session in tuple(self.sessions):
                try:
                    await session.send_tool_list_changed()
                except (RuntimeError, McpError):
                    self.sessions.discard(session)
        except Exception as error:
            await self.owner.observe(self.source, None, transport_error(error))

    async def run(self) -> None:
        lifetime = None
        try:
            lifetime = self.owner.activities.enter(
                ActivityDomain.RESOURCE, allow_startup_probe=False
            )
            await self.connection.start()
            initialized = self.connection.initialized
            if initialized is None:
                raise ValueError("connector_protocol_failed")
            observed = await self.connection.inventory()
            await self.owner.observe(self.source, observed, "")
            server = ConnectorServer(
                self.source.name or self.source.id, version=observed.get("version")
            )

            @server.list_tools()
            async def tools():
                self.sessions.add(server.request_context.session)
                observed = await self.connection.inventory()
                await self.owner.observe(self.source, observed, "")
                return [types.Tool.model_validate(tool) for tool in observed["tools"]]

            for request_type, result_type, capability in RPC_TYPES:
                if getattr(initialized.capabilities, capability, None) is None:
                    continue

                @self.invocation()
                async def relay(request, result_type=result_type):
                    self.sessions.add(server.request_context.session)
                    session = self.connection.session
                    if session is None:
                        raise McpError(
                            types.ErrorData(
                                code=RPC_FAILURE,
                                message=self.connection.error or "connector_process_failed",
                            )
                        )
                    try:
                        context = server.request_context
                        metadata = getattr(request.params, "meta", None)
                        progress_token = getattr(metadata, "progressToken", None)

                        async def notify_progress(
                            progress: float, total: float | None, message: str | None
                        ):
                            if progress_token is None:
                                return
                            await context.session.send_progress_notification(
                                progress_token=progress_token,
                                progress=progress,
                                total=total,
                                message=message,
                            )

                        timeout = (
                            self.source.timeout / MILLISECONDS_PER_SECOND
                            if self.source.timeout
                            else DEFAULT_CALL_SECONDS
                        )
                        result = await session.send_request(
                            types.ClientRequest.model_validate(
                                request.model_dump(
                                    by_alias=True, exclude={"jsonrpc", "id"}, exclude_none=True
                                )
                            ),
                            result_type,
                            request_read_timeout_seconds=timedelta(seconds=timeout),
                            progress_callback=(
                                notify_progress if progress_token is not None else None
                            ),
                        )
                        return types.ServerResult(result)
                    except McpError:
                        raise
                    except Exception as error:
                        LOGGER.error(
                            "connector_request_failed server_id=%s exception_type=%s\n%s",
                            self.source.id,
                            type(error).__name__,
                            "".join(traceback.format_tb(error.__traceback__)),
                        )
                        code = transport_error(error)
                        if code in (
                            "connector_credentials_invalid",
                            "connector_network_unavailable",
                            "connector_process_failed",
                        ):
                            await self.owner.observe(self.source, None, code)
                        raise McpError(types.ErrorData(code=RPC_FAILURE, message=code)) from None

                server.request_handlers[request_type] = relay
            self.manager = StreamableHTTPSessionManager(server, json_response=True)
            async with self.manager.run():
                self.ready.set()
                await self.stop.wait()
        except Exception as error:
            if not self.closing:
                self.error = transport_error(error)
                await self.owner.observe(self.source, None, self.error)
        finally:
            self.ready.set()
            try:
                await self.connection.aclose()
            finally:
                if lifetime is not None:
                    lifetime.close()

    async def start(self) -> None:
        if self.closing:
            raise ValueError("connector_configuration_conflict")
        if self.task is None:
            self.task = asyncio.create_task(self.run(), name="connector-binding")
        await self.ready.wait()
        if self.closing:
            raise ValueError("connector_configuration_conflict")
        if self.error:
            raise ValueError(self.error)

    async def aclose(self) -> None:
        self.closing = True
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        await finish_cleanup(self._close_task)

    async def _close(self) -> None:
        await self.drained.wait()
        self.stop.set()
        await self.connection.aclose()
        if self.task:
            await asyncio.shield(self.task)


class Endpoint:
    def __init__(self, broker: ConnectorBroker) -> None:
        self.broker = broker

    async def __call__(self, scope, receive, send):
        request = Request(scope, receive)
        binding = self.broker.bindings.get(scope["path_params"]["binding"])
        value = request.headers.get("authorization", "")
        if (
            request.headers.get("origin")
            or not binding
            or not secrets.compare_digest(value, "Bearer " + binding.token)
        ):
            await JSONResponse({"error": "forbidden"}, status_code=403)(scope, receive, send)
            return
        try:
            await self.broker.admit(binding.source)
            await binding.start()
        except ValueError as error:
            await JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": RPC_FAILURE, "message": str(error)},
                },
                status_code=401 if str(error) == "connector_credentials_invalid" else 503,
            )(scope, receive, send)
            return
        with self.broker.activities.enter(ActivityDomain.INVOCATION):
            manager = binding.manager
            if manager is None:
                raise RuntimeError("connector_protocol_failed")
            binding.requests += 1
            try:
                await manager.handle_request(scope, receive, send)
            finally:
                binding.requests -= 1


class ConnectorBroker:
    def __init__(self, store, secret_port, activities: Activities) -> None:
        self.store = store
        self.secrets = secret_port
        self.activities = activities
        self.token = secrets.token_urlsafe(BROKER_TOKEN_BYTES)
        self.credential = McpCredentialBinding(
            McpCredentialTarget.HEADER, "Authorization", BROKER_REFERENCE
        )
        self.bindings: dict[str, Binding] = {}
        self.port: int | None = None
        self.server: LocalServer | None = None
        self._close_task: asyncio.Task[None] | None = None
        self.task: asyncio.Task | None = None
        self.observer: Callable[[McpServer, dict | None, str], Awaitable[None]] | None = None

    async def observe(self, source: McpServer, observed: dict | None, error: str) -> None:
        if self.observer:
            await self.observer(source, observed, error)

    async def admit(self, source: McpServer) -> None:
        def check():
            current = next(
                (server for server in self.store.read().servers if server.id == source.id), None
            )
            if (
                current is None
                or not current.enabled
                or fingerprint(current) != fingerprint(source)
            ):
                raise ValueError("connector_configuration_conflict")
            self.secrets.validate_servers((current,))

        await self.activities.to_thread(ActivityDomain.CREDENTIAL, check)

    def project(self, source: McpServer) -> McpServerConfiguration:
        if self._close_task is not None:
            raise ValueError("connector_configuration_conflict")
        if self.port is None:
            raise ValueError("connector_local_runtime_required")
        identity = fingerprint(source)
        binding = self.bindings.setdefault(identity, Binding(self, source))
        if binding.closing or (binding.task is not None and binding.task.done()):
            binding = Binding(self, source)
            self.bindings[identity] = binding
        return McpServerConfiguration(
            source.id,
            McpHttpTransport(f"http://{BROKER_HOST}:{self.port}/mcp/{identity}"),
            source.enabled,
            (self.credential,),
            source.timeout,
            startup_timeout_ms=source.startup_timeout,
        )

    async def reconcile(self, sources: tuple[McpServer, ...]) -> None:
        active = {fingerprint(source) for source in sources if source.enabled}
        await asyncio.gather(
            *(
                binding.aclose()
                for identity, binding in self.bindings.items()
                if identity not in active
            )
        )

    async def drain_resources(self, generation: str) -> tuple[str, ...]:
        def check_generation() -> None:
            snapshot = self.activities.snapshot()
            if snapshot.phase is not ActivityPhase.DRAINING or snapshot.generation != generation:
                raise MaintenanceStale("update_maintenance_stale")

        check_generation()
        blocked: list[str] = []
        for identity, binding in tuple(self.bindings.items()):
            check_generation()
            if binding.active or binding.requests or (binding.task and not binding.ready.is_set()):
                blocked.append(binding.source.id)
                continue
            if binding.task is None and not binding.closing:
                continue
            await binding.aclose()
            check_generation()
            if self.bindings.get(identity) is binding:
                self.bindings[identity] = Binding(self, binding.source)
            LOGGER.info("connector_idle_resource_released server_id=%s", binding.source.id)
        check_generation()
        return tuple(blocked)

    async def resolve(self, reference: str) -> RuntimeSecret:
        if reference == BROKER_REFERENCE:
            return RuntimeSecret("Bearer " + self.token)
        return await self.secrets.resolve(reference)

    async def start(self) -> None:
        if self._close_task is not None:
            raise ValueError("connector_configuration_conflict")
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
        app.router.routes.append(
            Route(BROKER_ROUTE, Endpoint(self), methods=["GET", "POST", "DELETE"])
        )
        self.server = LocalServer(
            uvicorn.Config(
                app,
                host=BROKER_HOST,
                port=BROKER_PORT,
                lifespan="off",
                log_config=None,
                http=LocalProtocol,
                timeout_graceful_shutdown=STOP_TIMEOUT_SECONDS,
            )
        )
        self.task = asyncio.create_task(self.server.serve(), name="connector-listener")
        async with asyncio.timeout(START_TIMEOUT_SECONDS):
            while not self.server.started:
                if self.task.done():
                    await self.task
                    raise RuntimeError("connector_listener_failed")
                await asyncio.sleep(START_POLL_SECONDS)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]

    async def aclose(self) -> None:
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        await finish_cleanup(self._close_task)

    async def _close(self) -> None:
        results = await asyncio.gather(
            *(binding.aclose() for binding in self.bindings.values()), return_exceptions=True
        )
        failures = [result for result in results if isinstance(result, BaseException)]
        if self.server:
            self.server.should_exit = True
        if self.task:
            try:
                await self.task
            except BaseException as error:
                failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("Connector broker cleanup failed", failures)
