"""Entry-point discovery for independently packaged runtime providers."""

from __future__ import annotations

from collections.abc import Iterable
from importlib.metadata import EntryPoint, entry_points
from pathlib import Path
from typing import Callable, cast

from scholarseed_runtime.contract.provider import RuntimeProvider
from scholarseed_runtime.contract.runtime import RUNTIME_ABI_VERSION
from scholarseed_runtime.contract.storage import StorageInspection, StorageInventory, StorageRoot
from scholarseed_runtime.gateway.storage import StorageObservation

RUNTIME_ENTRY_POINT_GROUP = "scholarseed_runtime.providers"

RuntimeProviderFactory = Callable[[], RuntimeProvider]


class RuntimeCatalogError(RuntimeError):
    """A runtime distribution is missing or violates the public ABI."""


class RuntimeCatalog:
    """Immutable provider catalog assembled from installed distributions."""

    def __init__(self, providers: Iterable[RuntimeProvider]) -> None:
        indexed: dict[str, RuntimeProvider] = {}
        canonical: dict[str, RuntimeProvider] = {}
        for provider in providers:
            descriptor = provider.descriptor
            runtime_id = descriptor.runtime_id.strip().lower()
            if not runtime_id:
                raise RuntimeCatalogError("runtime descriptor id must not be empty")
            if descriptor.abi_version != RUNTIME_ABI_VERSION:
                raise RuntimeCatalogError(
                    f"runtime {runtime_id!r} requires ABI {descriptor.abi_version!r}; "
                    f"host provides {RUNTIME_ABI_VERSION!r}"
                )
            keys = (runtime_id, *(alias.strip().lower() for alias in descriptor.aliases))
            for key in keys:
                if not key:
                    raise RuntimeCatalogError(f"runtime {runtime_id!r} declares an empty alias")
                if key in indexed:
                    raise RuntimeCatalogError(f"duplicate runtime id or alias {key!r}")
                indexed[key] = provider
            canonical[runtime_id] = provider
        self._indexed = indexed
        self._canonical = canonical

    @classmethod
    def discover(cls, discovered: Iterable[EntryPoint] | None = None) -> "RuntimeCatalog":
        selected = (
            tuple(discovered)
            if discovered is not None
            else tuple(entry_points(group=RUNTIME_ENTRY_POINT_GROUP))
        )
        providers: list[RuntimeProvider] = []
        for entry_point in selected:
            loaded = entry_point.load()
            if not callable(loaded):
                raise RuntimeCatalogError(
                    f"runtime entry point {entry_point.name!r} does not export a provider factory"
                )
            factory = cast(RuntimeProviderFactory, loaded)
            provider = factory()
            if entry_point.name.strip().lower() != provider.descriptor.runtime_id.strip().lower():
                raise RuntimeCatalogError(
                    f"runtime entry point {entry_point.name!r} reports "
                    f"{provider.descriptor.runtime_id!r}"
                )
            providers.append(provider)
        return cls(providers)

    def runtime_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._canonical))

    def storage_roots(
        self, runtime_ids: Iterable[str], inspection: StorageInspection | None = None
    ) -> tuple[StorageRoot, ...]:
        """Collect selected providers' declarations without preparing their data."""
        roots: dict[Path, StorageRoot] = {}
        for runtime_id in sorted(set(runtime_ids)):
            provider = self.provider(runtime_id)
            declaration = getattr(provider, "storage_roots", None)
            if not callable(declaration):
                raise RuntimeCatalogError(f"runtime {runtime_id!r} has no storage declaration")
            try:
                declared = declaration() if inspection is None else declaration(inspection)
            except Exception as error:
                raise RuntimeCatalogError(
                    f"runtime {runtime_id!r} storage discovery failed"
                ) from error
            if not isinstance(declared, tuple) or any(
                not isinstance(root, StorageRoot)
                or not isinstance(root.path, Path)
                or not root.path.is_absolute()
                or ".." in root.path.parts
                or "\0" in str(root.path)
                or type(root.create) is not bool
                for root in declared
            ):
                raise RuntimeCatalogError(f"runtime {runtime_id!r} has invalid storage roots")
            for root in declared:
                previous = roots.get(root.path)
                # A consumer requiring existing storage must never have its
                # missing state recreated by another provider sharing the path.
                roots[root.path] = StorageRoot(
                    root.path, root.create and (previous is None or previous.create)
                )
        return tuple(roots[path] for path in sorted(roots, key=str))

    def provider(self, runtime_id: str) -> RuntimeProvider:
        normalized = runtime_id.strip().lower()
        try:
            return self._indexed[normalized]
        except KeyError as error:
            available = ", ".join(self.runtime_ids())
            raise RuntimeCatalogError(
                f"runtime {normalized!r} is not installed; available runtimes: {available}"
            ) from error

    def inspect_storage(
        self, runtime_ids: Iterable[str], inspection: StorageInspection
    ) -> StorageInventory:
        observation = StorageObservation(inspection)
        try:
            roots = self.storage_roots(runtime_ids, observation)
            return StorageInventory(roots, observation.sources())
        finally:
            observation.close()


__all__ = [
    "RUNTIME_ENTRY_POINT_GROUP",
    "RuntimeCatalog",
    "RuntimeCatalogError",
    "RuntimeProviderFactory",
]
