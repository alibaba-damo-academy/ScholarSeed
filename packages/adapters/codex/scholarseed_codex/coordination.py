"""Shared-home MCP publication and physical-host application ownership."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from scholarseed_codex.command import _finish
from scholarseed_codex.configuration import MCP_NATIVE_ENABLED, NativeMcpConfiguration
from scholarseed_codex.environment import CODEX_HOME_ENV
from scholarseed_codex.mcp import MCP_INVENTORY_PENDING, NativeMcpInventory
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.projection import CodexConfigurationEditor
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_runtime.contract.mcp import (
    MCP_INITIAL_CONFIGURATION_REVISION,
    McpApplicationState,
    McpConfigurationReceipt,
    McpHostApplication,
    McpServerObservation,
    McpServerState,
)
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
)
from scholarseed_runtime.contract.session import RUNTIME_SUSPEND_STALE

logger = logging.getLogger(__name__)

MCP_UNAPPLIED_REVISION = -1
MCP_COORDINATOR_CLOSED = "mcp_coordinator_closed"
MCP_HOST_ALREADY_REGISTERED = "mcp_host_already_registered"
MCP_NOT_INITIALIZED = "mcp_configuration_not_initialized"
MCP_REVISION_CONFLICT = "mcp_configuration_revision_conflict"
MCP_APPLICATION_FAILED = "mcp_configuration_application_failed"
MCP_CONFIGURATION_HOME_MISMATCH = "mcp_configuration_home_mismatch"
MCP_ENVIRONMENT_RESTART_REQUIRED = "mcp_environment_restart_required"
MCP_APPLICATION_POLL_SECONDS = 0.1


@dataclass
class _HostApplication:
    host: CodexProcessHost = field(repr=False)
    editor: CodexConfigurationEditor = field(repr=False)
    generation: int = 0
    applied_revision: int = MCP_UNAPPLIED_REVISION
    inventory: NativeMcpInventory = field(default_factory=NativeMcpInventory)


class McpCoordinator:
    def __init__(
        self, editor: CodexConfigurationEditor, *, publication: asyncio.Lock | None = None
    ) -> None:
        self._editor = editor
        self._partitions: dict[Path, CodexConfigurationEditor] = {}
        self._hosts: dict[str, _HostApplication] = {}
        self._desired: NativeMcpConfiguration | None = None
        self._published: NativeMcpConfiguration | None = None
        self._publication = publication if publication is not None else asyncio.Lock()
        self._observation = asyncio.Lock()
        self._initialized = asyncio.Event()
        self._wake = asyncio.Event()
        self._worker: asyncio.Task[None] | None = None
        self._observer: asyncio.Task[McpConfigurationReceipt] | None = None
        self._closed = False
        self._safe_error = ""
        self._schedule_epoch = 0

    def register(self, host_id: str, host: CodexProcessHost, *, isolation_scope: str = "") -> None:
        if self._closed:
            raise AppServerError(MCP_COORDINATOR_CLOSED, safe_error=MCP_COORDINATOR_CLOSED)
        if host_id in self._hosts:
            raise AppServerError(
                MCP_HOST_ALREADY_REGISTERED, safe_error=MCP_HOST_ALREADY_REGISTERED
            )
        home = Path(host.process_environment.get(CODEX_HOME_ENV, "")).expanduser()
        editor = self._configuration_editor(home)
        if (
            not home.is_absolute()
            or editor is None
            or (isolation_scope and (str(home) != isolation_scope or home not in self._partitions))
        ):
            raise AppServerError(
                MCP_CONFIGURATION_HOME_MISMATCH, safe_error=MCP_CONFIGURATION_HOME_MISMATCH
            )
        self._hosts[host_id] = _HostApplication(host, editor=editor)
        if self._desired is not None:
            host.admission.freeze(self._desired.revision)
        self._wake.set()

    def allocate_home(self) -> Path:
        if self._closed:
            raise AppServerError(MCP_COORDINATOR_CLOSED, safe_error=MCP_COORDINATOR_CLOSED)
        editor = self._editor.partition()
        self._partitions[editor.runtime_home] = editor
        return editor.runtime_home

    def _configuration_editor(self, home: Path) -> CodexConfigurationEditor | None:
        if home == self._editor.runtime_home:
            return self._editor
        return self._partitions.get(home)

    def release_home(self, home: Path) -> None:
        if not any(entry.editor.runtime_home == home for entry in self._hosts.values()):
            self._partitions.pop(home, None)

    def remove(self, host_id: str) -> None:
        entry = self._hosts.pop(host_id, None)
        if entry is not None:
            if entry.editor is not self._editor and not any(
                other.editor is entry.editor for other in self._hosts.values()
            ):
                self._partitions.pop(entry.editor.runtime_home, None)
            self._wake.set()

    def submit(self, configuration: NativeMcpConfiguration) -> McpConfigurationReceipt:
        if self._closed:
            raise AppServerError(MCP_COORDINATOR_CLOSED, safe_error=MCP_COORDINATOR_CLOSED)
        if self._desired is not None:
            if configuration.revision < self._desired.revision or (
                configuration.revision == self._desired.revision and configuration != self._desired
            ):
                raise ValueError(MCP_REVISION_CONFLICT)
            if configuration == self._desired and not self._safe_error:
                return self.receipt()
        return self._schedule(configuration)

    def reload(self) -> McpConfigurationReceipt:
        if self._closed:
            raise AppServerError(MCP_COORDINATOR_CLOSED, safe_error=MCP_COORDINATOR_CLOSED)
        if self._desired is None:
            raise ValueError(MCP_NOT_INITIALIZED)
        for entry in self._hosts.values():
            entry.applied_revision = MCP_UNAPPLIED_REVISION
        return self._schedule(self._desired)

    def _schedule(self, configuration: NativeMcpConfiguration) -> McpConfigurationReceipt:
        previous_servers = self._desired.servers() if self._desired is not None else {}
        desired_servers = configuration.servers()
        self._schedule_epoch += 1
        self._desired = configuration
        self._safe_error = ""
        for entry in self._hosts.values():
            entry.inventory = NativeMcpInventory(
                servers=tuple(
                    McpServerObservation(item.server_id, McpServerState.CONNECTING)
                    for item in entry.inventory.servers
                    if entry.generation == entry.host.process_generation
                    and item.server_id in desired_servers
                    and previous_servers.get(item.server_id) == desired_servers[item.server_id]
                    and desired_servers[item.server_id].get(MCP_NATIVE_ENABLED, True)
                )
            )
        self._wake.set()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())
        return self.receipt()

    def receipt(self) -> McpConfigurationReceipt:
        revision = self._desired.revision if self._desired else MCP_INITIAL_CONFIGURATION_REVISION
        hosts = []
        for host_id, entry in sorted(self._hosts.items()):
            current = entry.generation == entry.host.process_generation
            ready = (
                current
                and entry.applied_revision == revision
                and bool(entry.inventory.revision)
                and not entry.inventory.safe_error
                and entry.host.readiness.ready
                and not entry.host.admission.failed
            )
            error = entry.inventory.safe_error if current else ""
            if entry.host.admission.failed:
                error = RESOURCE_HOST_CONFIGURATION_UNCERTAIN
            hosts.append(
                McpHostApplication(
                    host_id,
                    entry.host.process_generation,
                    revision,
                    entry.applied_revision if current else MCP_UNAPPLIED_REVISION,
                    (
                        McpApplicationState.READY
                        if ready
                        else (
                            McpApplicationState.FAILED
                            if error and error != MCP_INVENTORY_PENDING
                            else McpApplicationState.PENDING
                        )
                    ),
                    entry.inventory.revision if ready else "",
                    error if error != MCP_INVENTORY_PENDING else "",
                    (entry.inventory.servers if current else ()),
                )
            )
        return McpConfigurationReceipt(revision, tuple(hosts), self._safe_error)

    async def refresh(self) -> McpConfigurationReceipt:
        if not self._closed and (self._observer is None or self._observer.done()):
            self._observer = asyncio.create_task(self._refresh())
        return self.receipt()

    async def _refresh(self) -> McpConfigurationReceipt:
        configuration = self._desired
        schedule_epoch = self._schedule_epoch
        if configuration is None:
            return self.receipt()
        for host_id, entry in tuple(self._hosts.items()):
            generation = entry.host.process_generation
            admission_epoch = entry.host.admission.epoch
            if (
                entry.applied_revision != configuration.revision
                or entry.generation != generation
                or not entry.host.admission.accepting
                or not entry.host.readiness.ready
            ):
                continue
            try:
                inventory = await entry.host.verify_mcp_startup(
                    self._expected(configuration),
                    disabled_servers=self._disabled(configuration),
                    include_threads=True,
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.exception(
                    "mcp_host_observation_failed host_id=%s revision=%s exception_type=%s",
                    host_id,
                    configuration.revision,
                    type(error).__name__,
                )
                inventory = NativeMcpInventory(
                    safe_error=(
                        error.safe_error
                        if isinstance(error, AppServerError) and error.safe_error
                        else MCP_APPLICATION_FAILED
                    )
                )
            if (
                self._closed
                or self._desired != configuration
                or self._schedule_epoch != schedule_epoch
                or self._hosts.get(host_id) is not entry
                or entry.host.process_generation != generation
                or entry.host.admission.epoch != admission_epoch
            ):
                return self.receipt()
            entry.inventory = inventory
        return self.receipt()

    @staticmethod
    def _expected(configuration: NativeMcpConfiguration) -> frozenset[str]:
        return frozenset(
            name
            for name, server in configuration.servers().items()
            if server.get(MCP_NATIVE_ENABLED, True)
        )

    @staticmethod
    def _disabled(configuration: NativeMcpConfiguration) -> frozenset[str]:
        return frozenset(configuration.servers()) - McpCoordinator._expected(configuration)

    @asynccontextmanager
    async def catalog_configuration(
        self, providers: Mapping[str, Any], home: Path | None = None
    ) -> AsyncIterator[None]:
        await self._initialized.wait()
        async with self._publication:
            if self._closed or (self._published is None and self._safe_error):
                safe_error = self._safe_error or MCP_COORDINATOR_CLOSED
                raise AppServerError(safe_error, safe_error=safe_error)
            if self._desired is not None and self._published != self._desired:
                await self._publish(self._desired)
            if self._closed or self._published is None:
                safe_error = self._safe_error or MCP_COORDINATOR_CLOSED
                raise AppServerError(safe_error, safe_error=safe_error)
            if self._hosts:
                if any(
                    entry.host.provider_configuration != providers for entry in self._hosts.values()
                ):
                    raise AppServerError(
                        RESOURCE_HOST_CONFIGURATION_CONFLICT,
                        safe_error=RESOURCE_HOST_CONFIGURATION_CONFLICT,
                    )
            editor = self._configuration_editor(home) if home is not None else self._editor
            if editor is None:
                raise AppServerError(
                    MCP_CONFIGURATION_HOME_MISMATCH, safe_error=MCP_CONFIGURATION_HOME_MISMATCH
                )
            if not self._hosts or editor is not self._editor:
                publication = asyncio.create_task(
                    asyncio.to_thread(editor.publish_provider, providers)
                )
                try:
                    await asyncio.shield(publication)
                except asyncio.CancelledError:
                    await _finish(publication)
                    raise
            yield

    @asynccontextmanager
    async def startup(self, host_id: str) -> AsyncIterator[None]:
        if self._desired is None:
            raise AppServerError(MCP_NOT_INITIALIZED, safe_error=MCP_NOT_INITIALIZED)
        await self._initialized.wait()
        async with self._publication:
            if self._closed or self._published is None:
                safe_error = self._safe_error or MCP_COORDINATOR_CLOSED
                raise AppServerError(safe_error, safe_error=safe_error)
            configuration = self._published
            entry = self._hosts[host_id]
            publication = asyncio.create_task(
                asyncio.to_thread(
                    entry.editor.publish_provider,
                    entry.host.provider_configuration,
                )
            )
            try:
                await asyncio.shield(publication)
            except asyncio.CancelledError:
                await _finish(publication)
                raise
            if entry.editor is not self._editor:
                publication = asyncio.create_task(
                    asyncio.to_thread(entry.editor.publish, configuration.servers())
                )
                try:
                    await asyncio.shield(publication)
                except asyncio.CancelledError:
                    await _finish(publication)
                    raise
            if self._published != self._desired and self._desired is not None:
                await self._publish(self._desired)
                configuration = self._published
            if entry.host.thread_count and self._desired is not None:
                entry.host.admission.freeze(self._desired.revision)
            entry.host.prepare_mcp_launch(configuration.environment)
            entry.inventory = NativeMcpInventory()
            yield
            if self._closed:
                raise AppServerError(MCP_COORDINATOR_CLOSED, safe_error=MCP_COORDINATOR_CLOSED)
            entry.generation = entry.host.process_generation
            entry.applied_revision = configuration.revision
            if entry.host.admission.frozen(entry.host.admission.desired_revision):
                entry.host.admission.applied(entry.host.admission.desired_revision)
            if self._worker is None or self._worker.done():
                self._worker = asyncio.create_task(self._run())
            self._wake.set()

    async def _publish(self, configuration: NativeMcpConfiguration) -> None:
        editors = {self._editor, *(entry.editor for entry in self._hosts.values())}
        for editor in editors:
            writing = asyncio.create_task(
                asyncio.to_thread(editor.publish, configuration.servers())
            )
            try:
                await asyncio.shield(writing)
            except asyncio.CancelledError:
                await writing
                raise
        self._published = configuration
        self._initialized.set()

    async def _run(self) -> None:
        while not self._closed:
            configuration = self._desired
            if configuration is None:
                return
            entries = tuple(self._hosts.items())
            schedule_epoch = self._schedule_epoch
            try:
                complete = await self._apply(configuration)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if (
                    self._desired != configuration
                    or entries != tuple(self._hosts.items())
                    or schedule_epoch != self._schedule_epoch
                ):
                    continue
                if isinstance(error, AppServerError) and error.safe_error == RUNTIME_SUSPEND_STALE:
                    self._wake.clear()
                    try:
                        await asyncio.wait_for(
                            self._wake.wait(), timeout=MCP_APPLICATION_POLL_SECONDS
                        )
                    except asyncio.TimeoutError:
                        pass
                    continue
                logger.exception(
                    "mcp_configuration_apply_failed revision=%s exception_type=%s",
                    configuration.revision,
                    type(error).__name__,
                )
                self._safe_error = (
                    error.safe_error
                    if isinstance(error, AppServerError)
                    else MCP_APPLICATION_FAILED
                )
                self._initialized.set()
                return
            if complete and self._desired == configuration:
                return
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=MCP_APPLICATION_POLL_SECONDS)
            except asyncio.TimeoutError:
                pass

    async def _apply(self, configuration: NativeMcpConfiguration) -> bool:
        schedule_epoch = self._schedule_epoch
        async with self._publication:
            if self._desired != configuration or schedule_epoch != self._schedule_epoch:
                return False
            if self._published != configuration:
                await self._publish(configuration)
        entries = tuple(self._hosts.items())
        complete = True
        for host_id, entry in entries:
            if self._desired != configuration or schedule_epoch != self._schedule_epoch:
                return False
            if (
                entry.applied_revision == configuration.revision
                and entry.generation == entry.host.process_generation
                and entry.host.readiness.ready
            ):
                continue
            if entry.host.pid is None:
                continue
            generation = entry.host.process_generation
            try:
                entry.host.admission.require_healthy()
                if not entry.host.mcp_launch_matches(configuration.environment):
                    entry.inventory = NativeMcpInventory(
                        safe_error=MCP_ENVIRONMENT_RESTART_REQUIRED
                    )
                    continue
                await entry.host.reload_mcp(generation)
                if (
                    self._hosts.get(host_id) is not entry
                    or self._desired != configuration
                    or schedule_epoch != self._schedule_epoch
                    or entry.host.process_generation != generation
                    or self._closed
                ):
                    return False
                logger.info(
                    "mcp_host_reload_acknowledged host_id=%s generation=%s revision=%s "
                    "admission_active=%s",
                    host_id,
                    generation,
                    configuration.revision,
                    entry.host.admission.active,
                )
                entry.generation = generation
                entry.applied_revision = configuration.revision
                entry.inventory = NativeMcpInventory()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if entry.host.process_generation != generation:
                    return False
                logger.exception(
                    "mcp_host_apply_failed host_id=%s revision=%s exception_type=%s",
                    host_id,
                    configuration.revision,
                    type(error).__name__,
                )
                entry.generation = entry.host.process_generation
                entry.inventory = NativeMcpInventory(
                    safe_error=(
                        error.safe_error
                        if isinstance(error, AppServerError) and error.safe_error
                        else MCP_APPLICATION_FAILED
                    )
                )
        return complete

    async def aclose(self) -> None:
        self._closed = True
        self._partitions.clear()
        self._initialized.set()
        self._wake.set()
        if self._worker is not None:
            self._worker.cancel()
            await asyncio.gather(self._worker, return_exceptions=True)
        if self._observer is not None:
            self._observer.cancel()
            await asyncio.gather(self._observer, return_exceptions=True)
