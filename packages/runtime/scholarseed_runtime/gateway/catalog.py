"""Entry-point discovery for independently packaged runtime providers."""

from __future__ import annotations

from collections.abc import Iterable
from importlib.metadata import EntryPoint, entry_points
from typing import Callable, cast

from scholarseed_runtime.contract.provider import RuntimeProvider
from scholarseed_runtime.contract.runtime import RUNTIME_ABI_VERSION

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

    def provider(self, runtime_id: str) -> RuntimeProvider:
        normalized = runtime_id.strip().lower()
        try:
            return self._indexed[normalized]
        except KeyError as error:
            available = ", ".join(self.runtime_ids())
            raise RuntimeCatalogError(
                f"runtime {normalized!r} is not installed; available runtimes: {available}"
            ) from error


__all__ = [
    "RUNTIME_ENTRY_POINT_GROUP",
    "RuntimeCatalog",
    "RuntimeCatalogError",
    "RuntimeProviderFactory",
]
