"""Complete, flat resources projection through the authorized Content boundary."""

from __future__ import annotations

from service.platform.content import AssetKind, ContentPort, FileAssetRef, RootKind
from service.resources.persistence.listing import (
    ResourceListEntry,
    ResourceListingCatalog,
    ResourceSource,
)


class ResourceListing:
    def __init__(self, content: ContentPort) -> None:
        self._content = content
        self._catalog = ResourceListingCatalog(content)

    def list(self, project: str) -> tuple[ResourceListEntry, ...]:
        root = self._content.root(project, RootKind.RESOURCES)
        nodes = self._content.flat_resource_tree(project, (root.path,))
        return self._catalog.synchronize(project, nodes)

    def record_import(self, project: str, assets: tuple[FileAssetRef, ...]) -> None:
        folders = tuple(asset.path for asset in assets if asset.kind is AssetKind.DIR)
        descendants = tuple(
            node.asset for node in self._content.flat_resource_tree(project, folders)
        )
        self._catalog.record(project, (*assets, *descendants), ResourceSource.IMPORTED)
