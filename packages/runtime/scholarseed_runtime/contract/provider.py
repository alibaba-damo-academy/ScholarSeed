"""Provider SPI for opening and resuming external agent sessions."""

from __future__ import annotations

from typing import Protocol

from scholarseed_runtime.contract.command import (
    CommandReceipt,
    OpenSessionRequest,
    ResumeSessionRequest,
    RuntimeInspectionRequest,
    RuntimeInventory,
    SkillConfigurationRequest,
)
from scholarseed_runtime.contract.resource import ResourcePolicy, ResourceReceipt, ResourceRequest
from scholarseed_runtime.contract.runtime import (
    ProviderConfiguration,
    RuntimeDescriptor,
    RuntimeReadiness,
)
from scholarseed_runtime.contract.session import RuntimeSession


class RuntimeProvider(Protocol):
    @property
    def descriptor(self) -> RuntimeDescriptor: ...

    def configure(self, configuration: ProviderConfiguration) -> CommandReceipt: ...

    @property
    def resource_policy(self) -> ResourcePolicy: ...

    async def reserve(self, request: ResourceRequest) -> ResourceReceipt: ...

    async def wait_resource(self, reservation_id: str) -> ResourceReceipt: ...

    async def cancel_resource(self, reservation_id: str) -> ResourceReceipt: ...

    async def probe(self) -> RuntimeReadiness: ...

    async def inspect(self, request: RuntimeInspectionRequest) -> RuntimeInventory: ...

    async def configure_skills(self, request: SkillConfigurationRequest) -> CommandReceipt: ...

    async def open(self, request: OpenSessionRequest) -> RuntimeSession: ...

    async def resume(self, request: ResumeSessionRequest) -> RuntimeSession: ...

    async def shutdown(self) -> CommandReceipt: ...


__all__ = ["RuntimeProvider"]
