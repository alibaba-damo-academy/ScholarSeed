"""Product-owned MCP declarations with versioned, atomic configuration writes."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from contextlib import ExitStack, closing
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Awaitable, Callable, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from scholarseed_runtime.contract.mcp import (
    MCP_CONFIGURATION_UNSUPPORTED,
    McpApplicationState,
    McpConfigurationReceipt,
    McpConfigurationRequest,
    McpCredentialBinding,
    McpCredentialTarget,
    McpHttpTransport,
    McpServerConfiguration,
    McpServerState,
    McpStdioTransport,
    RuntimeMcpConfiguration,
)
from scholarseed_runtime.contract.secret import RuntimeSecretPort
from service.paths import MCP_CONFIG_LOCK_FILENAME, MCP_CONFIG_PATH
from service.platform.activity import Activities, ActivityDomain
from service.platform.mcp import MCP_INVALID_CONFIG, McpServer, McpStdioServer
from service.platform.storage import (
    DirectoryHandle,
    canonical_root,
    open_private_directory,
    stable_read_matches,
)

MCP_SCHEMA_VERSION: Final = 1
MCP_INITIAL_REVISION = 0
MCP_MAX_CONFIG_BYTES = 1024 * 1024
MCP_MAX_SERVERS = 128
MCP_STAGE_PREFIX = ".mcp-"
MCP_STAGE_TOKEN_BYTES = 16
MCP_CONFIG_CONFLICT = "mcp_configuration_conflict"
MCP_CONFIG_TOO_LARGE = "mcp_configuration_too_large"
MCP_APPLICATION_FAILED = "mcp_application_failed"
MCP_CREDENTIALS_UNAVAILABLE = "mcp_credentials_unavailable"
MCP_APPLICATION_WAIT_SECONDS = 10.0
MCP_APPLICATION_OBSERVATION_SECONDS = 0.1
LOGGER = logging.getLogger(__name__)


class McpState(str, Enum):
    SAVED = "saved"
    PENDING_APPLY = "pending_apply"
    AUTH_REQUIRED = "auth_required"
    READY = "ready"
    FAILED = "failed"
    DISABLED = "disabled"
    CONNECTING = "connecting"


MCP_SERVER_STATE_PRIORITY = (
    McpServerState.FAILED,
    McpServerState.AUTH_REQUIRED,
    McpServerState.CONNECTING,
    McpServerState.READY,
)


class McpServerStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    state: McpState
    tool_count: int | None = Field(default=None, ge=0)
    safe_error: str = ""


def server_statuses(
    document: McpDocument, receipt: McpConfigurationReceipt
) -> tuple[McpServerStatus, ...]:
    statuses = []
    current_hosts = tuple(
        host for host in receipt.hosts if host.desired_revision == document.revision
    )
    for server in document.servers:
        if not server.enabled:
            statuses.append(McpServerStatus(id=server.id, state=McpState.DISABLED))
            continue
        host_observations = [
            tuple(item for item in host.servers if item.server_id == server.id)
            for host in current_hosts
        ]
        observed = [item for observations in host_observations for item in observations]
        if (
            receipt.desired_revision != document.revision
            or not receipt.hosts
            or len(current_hosts) != len(receipt.hosts)
            or any(len(observations) != 1 for observations in host_observations)
            or any(
                host.applied_revision != document.revision
                and any(item.state is not McpServerState.CONNECTING for item in observations)
                for host, observations in zip(current_hosts, host_observations)
            )
        ):
            statuses.append(McpServerStatus(id=server.id, state=McpState.PENDING_APPLY))
            continue
        state = next(
            state
            for state in MCP_SERVER_STATE_PRIORITY
            if any(item.state is state for item in observed)
        )
        selected = next(item for item in observed if item.state is state)
        count = (
            min(item.tool_count for item in observed if item.tool_count is not None)
            if state is McpServerState.READY
            and all(item.tool_count is not None for item in observed)
            else None
        )
        statuses.append(
            McpServerStatus(
                id=server.id,
                state=McpState(state.value),
                tool_count=count,
                safe_error=selected.safe_error,
            )
        )
    return tuple(statuses)


class McpConfigurationError(ValueError):
    def __init__(self) -> None:
        super().__init__(MCP_INVALID_CONFIG)


class McpConfigurationConflict(ValueError):
    def __init__(self) -> None:
        super().__init__(MCP_CONFIG_CONFLICT)


class McpConfigurationUnsupported(ValueError):
    def __init__(self) -> None:
        super().__init__(MCP_CONFIGURATION_UNSUPPORTED)


def runtime_server(server: McpServer) -> McpServerConfiguration:
    transport: McpStdioTransport | McpHttpTransport
    if isinstance(server, McpStdioServer):
        transport = McpStdioTransport(
            command=server.command,
            args=server.args,
            cwd=server.cwd,
            environment=tuple(sorted(server.environment.items())),
        )
        credentials = tuple(
            McpCredentialBinding(McpCredentialTarget.ENVIRONMENT, name, reference)
            for name, reference in sorted(server.environment_secrets.items())
        )
    else:
        if server.transport == "sse":
            raise McpConfigurationUnsupported()
        transport = McpHttpTransport(url=server.url, headers=tuple(sorted(server.headers.items())))
        credentials = tuple(
            McpCredentialBinding(McpCredentialTarget.HEADER, name, reference)
            for name, reference in sorted(server.header_secrets.items())
        )
    return McpServerConfiguration(
        name=server.id,
        enabled=server.enabled,
        transport=transport,
        credentials=credentials,
        tool_timeout_ms=server.timeout,
        startup_timeout_ms=server.startup_timeout,
    )


class McpDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    schema_version: Literal[1] = MCP_SCHEMA_VERSION
    revision: int = Field(default=MCP_INITIAL_REVISION, ge=MCP_INITIAL_REVISION)
    servers: tuple[McpServer, ...] = Field(default=(), max_length=MCP_MAX_SERVERS)

    def runtime(
        self,
        secret_port: RuntimeSecretPort | None = None,
        project_server: Callable[[McpServer], McpServerConfiguration] = runtime_server,
        shared_credentials: tuple[McpCredentialBinding, ...] = (),
    ) -> McpConfigurationRequest:
        return McpConfigurationRequest(
            revision=self.revision,
            servers=tuple(project_server(server) for server in self.servers),
            secret_port=secret_port,
            shared_credentials=shared_credentials,
        )

    @field_validator("schema_version", mode="before")
    @classmethod
    def validate_version(cls, value: object) -> object:
        if type(value) is not int or value != MCP_SCHEMA_VERSION:
            raise ValueError(MCP_INVALID_CONFIG)
        return value

    @model_validator(mode="after")
    def unique_servers(self) -> McpDocument:
        if len({server.id for server in self.servers}) != len(self.servers):
            raise ValueError(MCP_INVALID_CONFIG)
        return self


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise McpConfigurationError()
        result[name] = value
    return result


@dataclass
class PreparedMcpPublication:
    store: McpConfigurationStore = field(repr=False)
    directory: DirectoryHandle = field(repr=False)
    lifetime: ExitStack = field(repr=False)
    temporary: str
    previous: McpDocument
    target: McpDocument
    closed: bool = False

    def publish(self, authorize: Callable[[], None] | None = None) -> McpDocument:
        if self.closed:
            raise McpConfigurationConflict()
        if authorize is not None:
            authorize()
        if self.store._read(self.directory) != self.previous:
            raise McpConfigurationConflict()
        self.directory.replace_private(self.temporary, self.store.path.name)
        return self.target

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            try:
                self.directory.remove_private(self.temporary)
            except FileNotFoundError:
                pass
        finally:
            self.lifetime.close()


class McpConfigurationStore:
    def __init__(self, path: Path = MCP_CONFIG_PATH) -> None:
        self.path = path

    @staticmethod
    def decode(payload: bytes | None) -> McpDocument:
        if payload is None:
            return McpDocument()
        if len(payload) > MCP_MAX_CONFIG_BYTES:
            raise ValueError(MCP_CONFIG_TOO_LARGE)
        try:
            json.loads(payload, object_pairs_hook=_unique_object)
            return McpDocument.model_validate_json(payload)
        except (UnicodeError, ValueError):
            raise McpConfigurationError() from None

    def _read(self, directory: DirectoryHandle) -> McpDocument:
        try:
            descriptor = directory.open_private(self.path.name, os.O_RDONLY)
        except FileNotFoundError:
            return self.decode(None)
        with os.fdopen(descriptor, "rb") as handle:
            before = os.fstat(handle.fileno())
            if before.st_size > MCP_MAX_CONFIG_BYTES:
                raise ValueError(MCP_CONFIG_TOO_LARGE)
            payload = handle.read(MCP_MAX_CONFIG_BYTES + 1)
            after = os.fstat(handle.fileno())
            current = directory.stat(self.path.name)
            if not stable_read_matches(before, after, current, len(payload)):
                raise McpConfigurationConflict()
        return self.decode(payload)

    def read(self) -> McpDocument:
        with closing(open_private_directory(canonical_root(self.path.parent), ())) as directory:
            return self._read(directory)

    def replace(self, servers: tuple[McpServer, ...], *, expected_revision: int) -> McpDocument:
        publication = self.prepare(servers, expected_revision=expected_revision)
        try:
            return publication.publish()
        finally:
            publication.close()

    def prepare(
        self, servers: tuple[McpServer, ...], *, expected_revision: int
    ) -> PreparedMcpPublication:
        if type(expected_revision) is not int or expected_revision < MCP_INITIAL_REVISION:
            raise McpConfigurationConflict()
        lifetime = ExitStack()
        temporary = ""
        directory = None
        try:
            directory = lifetime.enter_context(
                closing(open_private_directory(canonical_root(self.path.parent), ()))
            )
            lifetime.enter_context(directory.arbitration(MCP_CONFIG_LOCK_FILENAME))
            current = self._read(directory)
            try:
                document = McpDocument(revision=current.revision + 1, servers=servers)
                payload = document.model_dump_json(indent=2).encode("utf-8")
            except ValueError:
                raise McpConfigurationError() from None
            document = self.decode(payload)
            temporary = MCP_STAGE_PREFIX + secrets.token_hex(MCP_STAGE_TOKEN_BYTES)
            descriptor = directory.open_private(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            return PreparedMcpPublication(self, directory, lifetime, temporary, current, document)
        except BaseException:
            try:
                if directory is not None and temporary:
                    try:
                        directory.remove_private(temporary)
                    except FileNotFoundError:
                        pass
            finally:
                lifetime.close()
            raise


class McpConfigurationView(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    configuration: McpDocument
    supported: bool
    state: McpState
    safe_error: str = ""
    servers: tuple[McpServerStatus, ...] = ()


class McpConfigurationService:
    def __init__(
        self,
        store: McpConfigurationStore,
        runtime: Callable[[], RuntimeMcpConfiguration | None],
        *,
        activities: Activities,
        secret_port: RuntimeSecretPort | None = None,
        validate_servers: Callable[[tuple[McpServer, ...]], None] | None = None,
        project_server: Callable[[McpServer], McpServerConfiguration] = runtime_server,
        reconcile_servers: Callable[[tuple[McpServer, ...]], Awaitable[None]] | None = None,
        shared_credentials: tuple[McpCredentialBinding, ...] = (),
    ) -> None:
        self._store = store
        self._runtime = runtime
        self._activities = activities
        self._secret_port = secret_port
        self._validate_servers = validate_servers
        self._project_server = project_server
        self._reconcile_servers = reconcile_servers
        self._shared_credentials = shared_credentials
        self._lock = asyncio.Lock()

    @staticmethod
    def _view(
        document: McpDocument,
        receipt: McpConfigurationReceipt,
    ) -> McpConfigurationView:
        if receipt.safe_error == MCP_CONFIGURATION_UNSUPPORTED:
            return McpConfigurationView(
                configuration=document,
                supported=False,
                state=McpState.SAVED,
                safe_error=MCP_CONFIGURATION_UNSUPPORTED,
            )
        state = McpState.PENDING_APPLY
        error = ""
        if receipt.desired_revision == document.revision:
            if receipt.safe_error or any(
                host.desired_revision == document.revision
                and (host.state is McpApplicationState.FAILED or host.safe_error)
                for host in receipt.hosts
            ):
                state = McpState.FAILED
                if receipt.safe_error or any(
                    host.desired_revision == document.revision
                    and (host.state is McpApplicationState.FAILED or host.safe_error)
                    and not any(
                        server.state in (McpServerState.FAILED, McpServerState.AUTH_REQUIRED)
                        and (not host.safe_error or server.safe_error == host.safe_error)
                        for server in host.servers
                    )
                    for host in receipt.hosts
                ):
                    error = MCP_APPLICATION_FAILED
            elif receipt.hosts and all(
                host.desired_revision == document.revision
                and host.applied_revision == document.revision
                and host.state is McpApplicationState.READY
                for host in receipt.hosts
            ):
                state = McpState.READY
        return McpConfigurationView(
            configuration=document,
            supported=True,
            state=state,
            safe_error=error,
            servers=server_statuses(document, receipt),
        )

    async def status(self) -> McpConfigurationView:
        async with self._lock:
            document = await self._activities.to_thread(ActivityDomain.ACTION, self._store.read)
            runtime = self._runtime()
            if runtime is None:
                return McpConfigurationView(
                    configuration=document,
                    supported=False,
                    state=McpState.SAVED,
                    safe_error=MCP_CONFIGURATION_UNSUPPORTED,
                )
            try:
                receipt = await runtime.mcp_configuration()
            except Exception as error:
                LOGGER.error("mcp_status_failed exception_type=%s", type(error).__name__)
                receipt = McpConfigurationReceipt(
                    desired_revision=document.revision,
                    safe_error=MCP_APPLICATION_FAILED,
                )
            current = await self._activities.to_thread(ActivityDomain.ACTION, self._store.read)
            return self._view(current, receipt)

    async def wait_application(self, initial: McpConfigurationView) -> McpConfigurationView:
        deadline = asyncio.get_running_loop().time() + MCP_APPLICATION_WAIT_SECONDS
        current = initial
        while (
            current.supported
            and current.configuration.revision == initial.configuration.revision
            and not current.safe_error
            and (
                current.state is McpState.PENDING_APPLY
                or any(
                    server.state in (McpState.PENDING_APPLY, McpState.CONNECTING)
                    for server in current.servers
                )
            )
        ):
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return current
            await asyncio.sleep(min(MCP_APPLICATION_OBSERVATION_SECONDS, remaining))
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return current
            try:
                current = await asyncio.wait_for(self.status(), timeout=remaining)
            except asyncio.TimeoutError:
                return current
        return current

    async def _apply(
        self, document: McpDocument, runtime: RuntimeMcpConfiguration
    ) -> McpConfigurationView:
        try:
            if self._reconcile_servers is not None:
                await self._reconcile_servers(document.servers)
            if self._validate_servers is not None:
                await self._activities.to_thread(
                    ActivityDomain.CREDENTIAL, self._validate_servers, document.servers
                )
            receipt = await runtime.configure_mcp(
                document.runtime(self._secret_port, self._project_server, self._shared_credentials)
            )
        except Exception as error:
            LOGGER.error(
                "mcp_apply_failed revision=%s exception_type=%s",
                document.revision,
                type(error).__name__,
            )
            receipt = McpConfigurationReceipt(
                desired_revision=document.revision, safe_error=MCP_APPLICATION_FAILED
            )
        current = await self._activities.to_thread(ActivityDomain.ACTION, self._store.read)
        return self._view(current, receipt)

    async def reconcile(self) -> McpConfigurationView:
        async def execute() -> McpConfigurationView:
            async with self._lock:
                document = await self._activities.to_thread(ActivityDomain.ACTION, self._store.read)
                runtime = self._runtime()
                if runtime is None:
                    return McpConfigurationView(
                        configuration=document,
                        supported=False,
                        state=McpState.SAVED,
                        safe_error=MCP_CONFIGURATION_UNSUPPORTED,
                    )
                return await self._apply(document, runtime)

        return await self._activities.finish(ActivityDomain.ACTION, execute)

    async def start(self) -> None:
        try:
            view = await self.reconcile()
        except (ValueError, OSError) as error:
            LOGGER.error("mcp_startup_failed exception_type=%s", type(error).__name__)
            return
        LOGGER.info(
            "mcp_configuration_reconciled revision=%s state=%s supported=%s",
            view.configuration.revision,
            view.state.value,
            view.supported,
        )

    async def replace(
        self,
        servers: tuple[McpServer, ...],
        *,
        expected_revision: int,
        authorize: Callable[[], None] | None = None,
    ) -> McpConfigurationView:
        try:
            immutable = self._store.decode(
                McpDocument(revision=expected_revision, servers=servers)
                .model_dump_json()
                .encode("utf-8")
            )
        except ValueError:
            raise McpConfigurationError() from None

        async def execute() -> McpConfigurationView:
            async with self._lock:
                if self._validate_servers is not None:
                    await self._activities.to_thread(
                        ActivityDomain.CREDENTIAL, self._validate_servers, immutable.servers
                    )
                if authorize is not None:
                    authorize()
                runtime = self._runtime()
                if runtime is None:
                    raise McpConfigurationUnsupported()
                capability = await runtime.mcp_configuration()
                if authorize is not None:
                    authorize()
                if capability.safe_error == MCP_CONFIGURATION_UNSUPPORTED:
                    raise McpConfigurationUnsupported()
                snapshot = immutable.runtime(
                    self._secret_port, self._project_server, self._shared_credentials
                )
                if self._secret_port is None and any(
                    server.enabled and server.credentials for server in snapshot.servers
                ):
                    raise ValueError(MCP_CREDENTIALS_UNAVAILABLE)
                if authorize is None:
                    document = await self._activities.to_thread(
                        ActivityDomain.ACTION,
                        self._store.replace,
                        immutable.servers,
                        expected_revision=expected_revision,
                    )
                else:
                    publication = await self._activities.to_thread(
                        ActivityDomain.ACTION,
                        self._store.prepare,
                        immutable.servers,
                        expected_revision=expected_revision,
                    )
                    try:
                        document = publication.publish(authorize)
                    finally:
                        await self._activities.to_thread(ActivityDomain.ACTION, publication.close)
                view = await self._apply(document, runtime)
                LOGGER.info(
                    "mcp_configuration_saved revision=%s state=%s",
                    document.revision,
                    view.state.value,
                )
                return view

        return await self._activities.finish(ActivityDomain.ACTION, execute)
