"""Complete, flat resources projection through the authorized Content boundary."""

from __future__ import annotations

from collections import deque

from service.platform.content import AssetKind, AssetTree, ContentPort, FileAssetRef, RootKind
from service.resources.persistence.listing import (
    ResourceListEntry,
    ResourceListingCatalog,
    ResourceSource,
)

LISTING_DEPTH = 1


class ResourceListing:
    def __init__(self, content: ContentPort) -> None:
        self._content = content
        self._catalog = ResourceListingCatalog(content)

    def list(self, project: str) -> tuple[ResourceListEntry, ...]:
        root = self._content.root(project, RootKind.RESOURCES)
        return self._catalog.synchronize(project, self._nodes(project, (root.path,)))

    def record_import(self, project: str, assets: tuple[FileAssetRef, ...]) -> None:
        folders = tuple(asset.path for asset in assets if asset.kind is AssetKind.DIR)
        descendants = tuple(node.asset for node in self._nodes(project, folders))
        self._catalog.record(project, (*assets, *descendants), ResourceSource.IMPORTED)

    def _nodes(self, project: str, roots: tuple[str, ...]) -> tuple[AssetTree, ...]:
        pending = deque(roots)
        visited = set()
        nodes: dict[str, AssetTree] = {}
        while pending:
            path = pending.popleft()
            resolved = self._content.resolve(project, path)
            if resolved in visited:
                continue
            visited.add(resolved)
            offset = 0
            while True:
                page = self._content.subtree(project, path, depth=LISTING_DEPTH, offset=offset)
                for node in page.children:
                    nodes[node.asset.path] = node
                    if node.asset.kind is AssetKind.DIR and node.available:
                        pending.append(node.asset.path)
                offset += len(page.children)
                if offset >= page.total:
                    break
                if not page.children:
                    raise RuntimeError("resource listing pagination made no progress")
        return tuple(nodes.values())
