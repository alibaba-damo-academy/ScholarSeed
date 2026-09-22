"""Product manifest selection over independently installed runtime providers."""

from __future__ import annotations

from dataclasses import dataclass

from scholarseed_runtime.contract import (
    CommandState,
    RuntimeBinding,
    RuntimeInspectionRequest,
    RuntimeInventory,
    RuntimeProvider,
    RuntimeReadiness,
)
from scholarseed_runtime.contract.runtime import ProviderConfiguration
from scholarseed_runtime.gateway.binding import RuntimeBindingError, validate_binding
from scholarseed_runtime.gateway.catalog import RuntimeCatalog, RuntimeCatalogError
from service.chat.service.adapters import (
    MANIFEST_CONFIGURATION_KEY,
    enabled_runtimes,
    registrations,
    resolve_runtime_id,
)


class RuntimeGatewayError(RuntimeError):
    """The product manifest and installed runtime providers disagree."""


@dataclass(frozen=True)
class RuntimeGateway:
    """Immutable product view of the vendor-neutral provider catalog."""

    catalog: RuntimeCatalog
    default_runtime_id: str

    @classmethod
    def discover(cls) -> "RuntimeGateway":
        catalog = RuntimeCatalog.discover()
        enabled = frozenset(enabled_runtimes())
        installed = frozenset(catalog.runtime_ids())
        missing = enabled - installed
        if missing:
            raise RuntimeGatewayError(
                f"enabled runtime providers are not installed: {', '.join(sorted(missing))}"
            )
        configured = registrations()
        for runtime_id in sorted(enabled):
            receipt = catalog.provider(runtime_id).configure(
                ProviderConfiguration(
                    runtime_id,
                    configured[runtime_id].settings.get(MANIFEST_CONFIGURATION_KEY),
                )
            )
            if receipt.state is not CommandState.APPLIED:
                raise RuntimeGatewayError(
                    f"runtime {runtime_id!r} configuration rejected: {receipt.safe_error}"
                )
        return cls(catalog=catalog, default_runtime_id=resolve_runtime_id())

    def provider(self, runtime_id: str = "") -> RuntimeProvider:
        selected = runtime_id.strip().lower() or self.default_runtime_id
        try:
            return self.catalog.provider(selected)
        except RuntimeCatalogError as error:
            raise RuntimeGatewayError(str(error)) from error

    def provider_for(self, binding: RuntimeBinding) -> RuntimeProvider:
        provider = self.provider(binding.runtime_id)
        try:
            validate_binding(binding, provider.descriptor)
        except RuntimeBindingError as error:
            raise RuntimeGatewayError(str(error)) from error
        return provider

    async def readiness(self, runtime_id: str = "") -> RuntimeReadiness:
        return await self.provider(runtime_id).probe()

    async def inspect(
        self,
        request: RuntimeInspectionRequest,
        runtime_id: str = "",
    ) -> RuntimeInventory:
        return await self.provider(runtime_id).inspect(request)


__all__ = ["RuntimeGateway", "RuntimeGatewayError"]
