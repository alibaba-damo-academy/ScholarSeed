"""Product manifest selection over independently installed runtime providers."""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field, replace
from pathlib import Path

from scholarseed_runtime.contract import (
    CommandState,
    RuntimeBinding,
    RuntimeInspectionRequest,
    RuntimeInventory,
    RuntimeProvider,
    RuntimeReadiness,
)
from scholarseed_runtime.contract.resource import ResourceLease
from scholarseed_runtime.contract.runtime import ProviderConfiguration
from scholarseed_runtime.contract.storage import (
    RuntimeConfigurationOwner,
    StorageInspection,
    StorageInventory,
    StorageRoot,
)
from scholarseed_runtime.gateway.binding import RuntimeBindingError, validate_binding
from scholarseed_runtime.gateway.catalog import RuntimeCatalog, RuntimeCatalogError
from service.chat.service.adapters import (
    MANIFEST_CONFIGURATION_KEY,
    enabled_runtimes,
    registrations,
    resolve_runtime_id,
)
from service.platform.configuration import ConfigurationStorage
from service.platform.recovery import SandboxRecovery, load_sandbox_recovery
from service.platform.toolchain import ToolResources, load_tool_resources


class RuntimeGatewayError(RuntimeError):
    """The product manifest and installed runtime providers disagree."""


@dataclass(frozen=True)
class RuntimeDiscovery:
    """One pre-write provider inventory, reused by actual runtime composition."""

    catalog: RuntimeCatalog
    default_runtime_id: str
    configurations: tuple[ProviderConfiguration, ...]
    storage_roots: tuple[StorageRoot, ...]
    configuration_files: tuple[tuple[str, tuple[Path, ...]], ...] = ()
    sandbox_resources: ToolResources | None = None
    sandbox_recovery: SandboxRecovery | None = None
    _configuration_stores: dict[str, tuple[Callable[[], ResourceLease], ConfigurationStorage]] = (
        field(default_factory=dict, repr=False, compare=False)
    )

    def private_configuration_roots(self, product_home: Path) -> tuple[Path, ...]:
        """Apply product privacy policy only inside the product's own Home.

        Provider creation declarations do not grant permission migration. External
        provider homes remain unchanged, even when their exact files are writable.
        The startup owner still owes no-follow pins and exclusive qualification.
        """
        return tuple(
            sorted(
                {
                    path.parent
                    for _, paths in self.configuration_files
                    for path in paths
                    if path.parent.is_relative_to(product_home)
                }
            )
        )

    def _configuration_storage(
        self, runtime_id: str, resource_lease: Callable[[], ResourceLease] | None
    ) -> ConfigurationStorage | None:
        files = dict(self.configuration_files).get(runtime_id, ())
        if not files or resource_lease is None:
            return None
        previous = self._configuration_stores.get(runtime_id)
        if previous is not None:
            if previous[0] is not resource_lease:
                raise RuntimeGatewayError("runtime configuration storage qualification changed")
            return previous[1]
        storage = ConfigurationStorage(files, resource_lease)
        self._configuration_stores[runtime_id] = (resource_lease, storage)
        return storage

    @staticmethod
    def _configuration_files(catalog: RuntimeCatalog, runtime_id: str) -> tuple[Path, ...]:
        provider = catalog.provider(runtime_id)
        if not isinstance(provider, RuntimeConfigurationOwner):
            return ()
        files = provider.configuration_files()
        roots = {root.path for root in catalog.storage_roots((runtime_id,))}
        if (
            not isinstance(files, tuple)
            or any(
                not isinstance(path, Path)
                or not path.is_absolute()
                or path.parent not in roots
                or path.name in {"", ".", ".."}
                for path in files
            )
            or len(set(files)) != len(files)
        ):
            raise RuntimeGatewayError("runtime configuration file declaration is invalid")
        return files

    @classmethod
    def discover(cls) -> "RuntimeDiscovery":
        catalog = RuntimeCatalog.discover()
        enabled = frozenset(enabled_runtimes())
        missing = enabled - frozenset(catalog.runtime_ids())
        if missing:
            raise RuntimeGatewayError(
                f"enabled runtime providers are not installed: {', '.join(sorted(missing))}"
            )
        configured = registrations()
        try:
            storage_roots = catalog.storage_roots(enabled)
        except RuntimeCatalogError as error:
            raise RuntimeGatewayError(str(error)) from error
        return cls(
            catalog=catalog,
            default_runtime_id=resolve_runtime_id(),
            configurations=tuple(
                ProviderConfiguration(
                    runtime_id,
                    deepcopy(configured[runtime_id].settings.get(MANIFEST_CONFIGURATION_KEY)),
                )
                for runtime_id in sorted(enabled)
            ),
            storage_roots=storage_roots,
            configuration_files=tuple(
                (runtime_id, cls._configuration_files(catalog, runtime_id))
                for runtime_id in sorted(enabled)
            ),
            sandbox_resources=load_tool_resources(),
            sandbox_recovery=load_sandbox_recovery(storage_roots),
        )

    def revalidate_storage(self) -> None:
        try:
            actual = self.catalog.storage_roots(row.runtime_id for row in self.configurations)
        except RuntimeCatalogError as error:
            raise RuntimeGatewayError(str(error)) from error
        if actual != self.storage_roots:
            raise RuntimeGatewayError("runtime storage roots changed after discovery")
        for runtime_id, expected in self.configuration_files:
            if self._configuration_files(self.catalog, runtime_id) != expected:
                raise RuntimeGatewayError("runtime configuration files changed after discovery")

    def inspect_storage(self, inspection: StorageInspection) -> StorageInventory:
        self.revalidate_storage()
        try:
            inventory = self.catalog.inspect_storage(
                (row.runtime_id for row in self.configurations), inspection
            )
        except RuntimeCatalogError as error:
            raise RuntimeGatewayError(str(error)) from error
        if not {root.path for root in self.storage_roots} <= {
            root.path for root in inventory.roots
        }:
            raise RuntimeGatewayError("runtime inspection omitted declared storage roots")
        return inventory

    def configure(
        self, *, resource_lease: Callable[[], ResourceLease] | None = None
    ) -> "RuntimeGateway":
        # A pathname inventory is not physical ownership. The startup owner must
        # still hold and revalidate its directory qualifications around this call.
        self.revalidate_storage()
        for configuration in self.configurations:
            provider = self.catalog.provider(configuration.runtime_id)
            receipt = provider.configure(
                replace(
                    configuration,
                    values=deepcopy(configuration.values),
                    resource_lease=resource_lease,
                    configuration_storage=self._configuration_storage(
                        configuration.runtime_id, resource_lease
                    ),
                    sandbox_resources=self.sandbox_resources,
                    sandbox_recovery=self.sandbox_recovery,
                )
            )
            if receipt.state is not CommandState.APPLIED:
                raise RuntimeGatewayError(
                    f"runtime {configuration.runtime_id!r} configuration rejected: {receipt.safe_error}"
                )
            self.revalidate_storage()
        return RuntimeGateway(self.catalog, self.default_runtime_id, self.storage_roots)


@dataclass(frozen=True)
class RuntimeGateway:
    """Immutable product view of the vendor-neutral provider catalog."""

    catalog: RuntimeCatalog
    default_runtime_id: str
    storage_roots: tuple[StorageRoot, ...] = ()

    @classmethod
    def discover(
        cls,
        *,
        resource_lease: Callable[[], ResourceLease] | None = None,
    ) -> "RuntimeGateway":
        return RuntimeDiscovery.discover().configure(resource_lease=resource_lease)

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


__all__ = ["RuntimeDiscovery", "RuntimeGateway", "RuntimeGatewayError"]
