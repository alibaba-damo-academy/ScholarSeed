"""Complete, flat resources projection through the authorized Content boundary."""

from __future__ import annotations

from service.platform.content import (
    AssetKind,
    ContentPort,
    FileAssetRef,
    ResourceTreeGroup,
    RootKind,
)
from service.resources.persistence.listing import (
    ResourceListEntry,
    ResourceListingCatalog,
    ResourceSource,
)


class ResourceListing:
    def __init__(self, content: ContentPort) -> None:
        self._content = content
        self._catalog = ResourceListingCatalog(content)

    def list(self, project: str) -> tuple[tuple[ResourceListEntry, ...], dict[str, str | None]]:
        entries, repositories, _ = self.snapshot(project, track_parents=False)
        return entries, repositories

    def snapshot(
        self, project: str, *, track_parents: bool
    ) -> tuple[tuple[ResourceListEntry, ...], dict[str, str | None], tuple[str, ...] | None]:
        root = self._content.root(project, RootKind.RESOURCES)
        tree = self._content.flat_resource_tree(
            project, (root.path,), include_repositories=True, track_parents=track_parents
        )
        return (
            self._catalog.synchronize(project, tree.nodes),
            tree.repositories,
            tree.incremental_parents,
        )

    def changes(
        self, project: str, paths: tuple[str, ...]
    ) -> (
        tuple[tuple[ResourceListEntry, ...], dict[str, str | None], tuple[ResourceTreeGroup, ...]]
        | None
    ):
        result = self._content.resource_tree_changes(project, paths)
        if result is None:
            return None
        entries = self._catalog.synchronize_changes(
            project,
            paths,
            result.nodes,
            parents=tuple(group.parent for group in result.groups if group.parent != result.root),
        )
        if entries is None:
            return None
        return entries, result.repositories, result.groups

    def record_import(self, project: str, assets: tuple[FileAssetRef, ...]) -> None:
        folders = tuple(asset.path for asset in assets if asset.kind is AssetKind.DIR)
        descendants = tuple(
            node.asset for node in self._content.flat_resource_tree(project, folders).nodes
        )
        self._catalog.record(project, (*assets, *descendants), ResourceSource.IMPORTED)
