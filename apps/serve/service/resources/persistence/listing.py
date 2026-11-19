"""Durable resource-list attributes in the shared project database."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from enum import Enum
from pathlib import Path, PurePosixPath
from sqlite3 import Connection

from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import ProjectDatabasePath, transaction
from service.platform.content import AssetKind, AssetOrigin, AssetTree, ContentPort, FileAssetRef

LISTING_TABLE = "resources_listing"
CREATE_LISTING = f"""
CREATE TABLE IF NOT EXISTS {LISTING_TABLE} (
    path TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_type TEXT NOT NULL,
    source TEXT,
    updated_at REAL,
    origin TEXT NOT NULL
)
"""
UPSERT_LISTING = f"""
INSERT INTO {LISTING_TABLE} (path, name, kind, file_type, source, updated_at, origin)
VALUES (:path, :name, :kind, :file_type, :source, :updated_at, :origin)
ON CONFLICT(path) DO UPDATE SET
    name=excluded.name, kind=excluded.kind, file_type=excluded.file_type,
    source=COALESCE(excluded.source, {LISTING_TABLE}.source),
    updated_at=excluded.updated_at, origin=excluded.origin
"""


class ResourceSource(str, Enum):
    IMPORTED = "imported"
    CREATED = "created"
    LINKED = "linked"


@dataclass(frozen=True)
class ResourceListEntry:
    path: str
    name: str
    kind: str
    file_type: str
    source: str | None
    updated_at: float | None
    origin: str


def _entry(asset: FileAssetRef, updated_at: float | None = None) -> ResourceListEntry:
    return ResourceListEntry(
        asset.path,
        asset.name,
        asset.kind.value,
        (
            AssetKind.DIR.value
            if asset.kind is AssetKind.DIR
            else PurePosixPath(asset.name).suffix.removeprefix(".").upper()
        ),
        ResourceSource.LINKED.value if asset.origin is AssetOrigin.LINK else None,
        updated_at if asset.kind is AssetKind.FILE else None,
        asset.origin.value,
    )


class ResourceListingCatalog:
    def __init__(self, content: ContentPort) -> None:
        self._content = content

    def _database(self, project: str) -> ProjectDatabasePath:
        return ProjectDatabasePath(
            Path(self._content.resolve(project, PROJECT_DB_RELATIVE)),
            Path(self._content.resolve(project, "")),
        )

    def record(
        self, project: str, assets: tuple[FileAssetRef, ...], source: ResourceSource
    ) -> None:
        with transaction(self._database(project)) as connection:
            connection.execute(CREATE_LISTING)
            for asset in assets:
                entry = replace(_entry(asset), source=source.value)
                connection.execute(UPSERT_LISTING, asdict(entry))

    def relocate(self, project: str, previous: str, current: str, *, copy: bool = False) -> None:
        with transaction(self._database(project)) as connection:
            connection.execute(CREATE_LISTING)
            rows = connection.execute(f"SELECT * FROM {LISTING_TABLE}").fetchall()
            for row in rows:
                path = row["path"]
                if path != previous and not path.startswith(f"{previous}/"):
                    continue
                entry = ResourceListEntry(**dict(row))
                target = current + path[len(previous) :]
                entry = replace(entry, path=target, name=PurePosixPath(target).name)
                if not copy:
                    connection.execute(f"DELETE FROM {LISTING_TABLE} WHERE path=?", (path,))
                connection.execute(UPSERT_LISTING, asdict(entry))

    def synchronize(
        self, project: str, nodes: tuple[AssetTree, ...]
    ) -> tuple[ResourceListEntry, ...]:
        with transaction(self._database(project), immediate=True) as connection:
            connection.execute(CREATE_LISTING)
            existing = {
                row["path"]: ResourceListEntry(**dict(row))
                for row in connection.execute(f"SELECT * FROM {LISTING_TABLE}")
            }
            return self._synchronize(connection, nodes, existing)

    def synchronize_changes(
        self,
        project: str,
        paths: tuple[str, ...],
        nodes: tuple[AssetTree, ...],
        *,
        parents: tuple[str, ...],
    ) -> tuple[ResourceListEntry, ...] | None:
        """Update files under known directories, preserving the catalog's path spelling."""

        selected = (*paths, *parents)
        placeholders = ",".join("?" for _ in selected)
        with transaction(self._database(project), immediate=True) as connection:
            connection.execute(CREATE_LISTING)
            existing = {
                row["path"]: ResourceListEntry(**dict(row))
                for row in connection.execute(
                    f"SELECT * FROM {LISTING_TABLE} WHERE path IN ({placeholders})", selected
                )
            }
            if any(
                parent not in existing or existing[parent].kind != AssetKind.DIR.value
                for parent in parents
            ):
                return None
            dirty = {path: existing[path] for path in paths if path in existing}
            if any(entry.kind != AssetKind.FILE.value for entry in dirty.values()):
                return None
            return self._synchronize(connection, nodes, dirty)

    @staticmethod
    def _synchronize(
        connection: Connection,
        nodes: tuple[AssetTree, ...],
        existing: dict[str, ResourceListEntry],
    ) -> tuple[ResourceListEntry, ...]:
        result = []
        updates = []
        for node in nodes:
            entry = _entry(node.asset, node.updated_at)
            previous = existing.get(entry.path)
            if previous is not None and previous.source and previous.source != entry.source:
                entry = replace(entry, source=previous.source)
            if entry != previous:
                updates.append(vars(entry))
            result.append(entry)
        present = {node.asset.path for node in nodes}
        removed = existing.keys() - present
        if removed:
            connection.executemany(
                f"DELETE FROM {LISTING_TABLE} WHERE path=?", ((path,) for path in removed)
            )
        if updates:
            connection.executemany(UPSERT_LISTING, updates)
        return tuple(result)
