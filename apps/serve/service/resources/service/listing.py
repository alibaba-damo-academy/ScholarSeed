"""Complete, flat resources projection through the authorized Content boundary."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from service.content.domain.model import ROOT_BUSY_ERROR, ContentError
from service.platform.content import (
    AssetKind,
    AssetTree,
    ContentPort,
    ExternalRootRef,
    FileAssetRef,
    FlatResourceTree,
    ResourceEntry,
    ResourceTreeGroup,
    RootKind,
)
from service.resources.persistence.listing import (
    ResourceListEntry,
    ResourceListingCatalog,
    ResourceSource,
)


@dataclass(frozen=True)
class ResourceListingSnapshot:
    entries: tuple[ResourceListEntry, ...]
    repositories: dict[str, str | None]
    incremental_parents: tuple[str, ...] | None
    observed_entries: dict[str, ResourceEntry | None]
    directory: str | None = None


_CandidatePublisher = Callable[
    [tuple[ResourceListEntry, ...], dict[str, str | None], tuple[ExternalRootRef, ...]],
    None,
]


class ResourceListing:
    def __init__(self, content: ContentPort) -> None:
        self._content = content
        self._catalog = ResourceListingCatalog(content)

    def _snapshot(self, project: str, tree: FlatResourceTree) -> ResourceListingSnapshot:
        return ResourceListingSnapshot(
            self._catalog.synchronize(project, tree.nodes),
            tree.repositories,
            tree.incremental_parents,
            tree.observed_entries,
        )

    def snapshot(self, project: str, *, track_parents: bool) -> ResourceListingSnapshot:
        root = self._content.root(project, RootKind.RESOURCES)
        tree = self._content.flat_resource_tree(
            project,
            (root.path,),
            include_repositories=True,
            track_parents=track_parents,
            observe_entries=True,
        )
        return self._snapshot(project, tree)

    def progressive_snapshot(
        self,
        project: str,
        publish: _CandidatePublisher,
        check: Callable[[], None],
        *,
        flush: Callable[[], None],
        complete_candidates: _CandidatePublisher | None = None,
    ) -> tuple[ResourceListingSnapshot, tuple[ExternalRootRef, ...]]:
        """Publish directory facts, then synchronize the completed inventory once."""
        root = self._content.root(project, RootKind.RESOURCES)
        expected_roots = self._content.external_roots(project)
        sources = self._catalog.sources(project)

        def on_directory(
            nodes: tuple[AssetTree, ...],
            repositories: dict[str, str | None],
            linked_roots: tuple[ExternalRootRef, ...],
        ) -> None:
            if linked_roots and linked_roots != expected_roots:
                raise ContentError(ROOT_BUSY_ERROR)
            publish(self._catalog.project_entries(nodes, sources), repositories, linked_roots)

        tree = self._content.flat_resource_tree(
            project,
            (root.path,),
            include_repositories=True,
            track_parents=True,
            observe_entries=True,
            on_directory=on_directory,
            check=check,
        )
        check()
        if self._content.external_roots(project) != expected_roots:
            raise ContentError(ROOT_BUSY_ERROR)
        flush()
        if complete_candidates is not None:
            current_sources = self._catalog.sources(project)
            corrected = (
                tuple(
                    node
                    for node in tree.nodes
                    if sources.get(node.asset.path) != current_sources.get(node.asset.path)
                )
                if sources != current_sources
                else ()
            )
            complete_candidates(
                self._catalog.project_entries(corrected, current_sources),
                tree.repositories,
                expected_roots,
            )
            # Publication can wait on the network queue. Recheck the captured
            # grants before reconciling the catalog from those observations.
            if expected_roots and self._content.external_roots(project) != expected_roots:
                raise ContentError(ROOT_BUSY_ERROR)
        check()
        return self._snapshot(project, tree), expected_roots

    def directory(
        self, project: str, path: str, *, track_parents: bool, observe_entries: bool
    ) -> ResourceListingSnapshot:
        parent = self._content.within_root(project, RootKind.RESOURCES, path)
        tree = self._content.flat_resource_tree(
            project,
            (parent,),
            include_repositories=True,
            track_parents=track_parents,
            observe_entries=observe_entries,
            shallow=True,
        )
        directory = tree.directory
        assert directory is not None
        root = self._content.root_path(project, RootKind.RESOURCES)
        return ResourceListingSnapshot(
            self._catalog.synchronize_directory(
                project,
                directory,
                tree.nodes,
                record_parent=tree.incremental_parents is not None and directory.path != root,
            ),
            tree.repositories,
            tree.incremental_parents,
            tree.observed_entries,
            directory.path,
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
