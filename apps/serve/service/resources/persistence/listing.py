"""Durable resource-list attributes in the shared project database."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from enum import Enum
from pathlib import Path, PurePosixPath

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
        with transaction(self._database(project)) as connection:
            connection.execute(CREATE_LISTING)
            existing = {
                row["path"]: ResourceListEntry(**dict(row))
                for row in connection.execute(f"SELECT * FROM {LISTING_TABLE}")
            }
            entries = []
            present = {node.asset.path for node in nodes}
            for path in existing.keys() - present:
                connection.execute(f"DELETE FROM {LISTING_TABLE} WHERE path=?", (path,))
            for node in nodes:
                entry = _entry(node.asset, node.updated_at)
                previous = existing.get(entry.path)
                source = previous.source if previous else None
                entry = replace(entry, source=source or entry.source)
                connection.execute(UPSERT_LISTING, asdict(entry))
                entries.append(entry)
            return tuple(entries)
