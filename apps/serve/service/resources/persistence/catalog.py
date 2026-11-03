"""Project-local indexes owned by the resources domain.

The Markdown file remains the user-visible source of excerpt content and
provenance.  This table only indexes the canonical file for one upstream source
so repeated requests do not scan the whole resources tree in the common case.

Agent imports are different: binary and generated files cannot carry a uniform
user-visible provenance block, so their source conversation and optional turn
evidence are persisted beside the project in the shared business database.

Imported web pages follow the same boundary: Markdown contains only the
user-visible document while fetch provenance lives in the project database.
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import (
    ProjectDatabasePath,
    database_files,
    reader,
    reject_schema_residue,
    table_clauses,
    transaction,
)
from service.platform.content import ContentPort
from service.platform.excerpts import ExcerptSourceKind
from service.resources.domain.model import AgentImportSourceKind
from service.resources.persistence.listing import CREATE_LISTING, LISTING_TABLE

EXCERPT_DOCUMENTS_TABLE = "resources_excerpt_documents"
AGENT_IMPORTS_TABLE = "resources_agent_imports"
WEB_SOURCES_TABLE = "resources_web_sources"
AGENT_IMPORT_SCHEMA_VERSION = 1
WEB_SOURCE_SCHEMA_VERSION = 1

CREATE_EXCERPT_DOCUMENTS = f"""
CREATE TABLE IF NOT EXISTS {EXCERPT_DOCUMENTS_TABLE} (
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    resource_path TEXT NOT NULL,
    resource_revision TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (source_kind, source_id)
)
"""

UPSERT_EXCERPT_DOCUMENT = f"""
INSERT INTO {EXCERPT_DOCUMENTS_TABLE} (
    source_kind, source_id, resource_path, resource_revision, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(source_kind, source_id) DO UPDATE SET
    resource_path = excluded.resource_path,
    resource_revision = excluded.resource_revision,
    updated_at = excluded.updated_at
"""

CREATE_AGENT_IMPORTS = f"""
CREATE TABLE IF NOT EXISTS {AGENT_IMPORTS_TABLE} (
    import_id TEXT PRIMARY KEY,
    resource_path TEXT NOT NULL UNIQUE,
    resource_revision TEXT,
    source_kind TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    source_turn_id TEXT,
    source_item_id TEXT,
    source_id TEXT,
    source_event_seq INTEGER,
    source_detail_json TEXT,
    evidence_snapshot_id TEXT,
    evidence_json TEXT,
    conversation_snapshot_json TEXT,
    schema_version INTEGER NOT NULL DEFAULT {AGENT_IMPORT_SCHEMA_VERSION},
    imported_at REAL NOT NULL,
    updated_at REAL NOT NULL
)
"""

INSERT_AGENT_IMPORT = f"""
INSERT INTO {AGENT_IMPORTS_TABLE} (
    import_id, resource_path, resource_revision,
    source_kind, source_session_id, source_turn_id, source_item_id,
    source_id, source_event_seq, source_detail_json,
    evidence_snapshot_id, evidence_json, conversation_snapshot_json, schema_version,
    imported_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(import_id) DO NOTHING
"""

CREATE_WEB_SOURCES = f"""
CREATE TABLE IF NOT EXISTS {WEB_SOURCES_TABLE} (
    web_source_id TEXT PRIMARY KEY NOT NULL,
    resource_path TEXT NOT NULL UNIQUE,
    resource_revision TEXT NOT NULL,
    source_title TEXT,
    source_url TEXT NOT NULL,
    final_url TEXT,
    search_query TEXT,
    fetched_at REAL,
    schema_version INTEGER NOT NULL DEFAULT {WEB_SOURCE_SCHEMA_VERSION},
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
)
"""

INSERT_WEB_SOURCE = f"""
INSERT INTO {WEB_SOURCES_TABLE} (
    web_source_id, resource_path, resource_revision,
    source_title, source_url, final_url, search_query, fetched_at,
    schema_version, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


@dataclass(frozen=True)
class ResourceCatalogSchema:
    """Owned schema and envelope versions, not arbitrary provenance approval."""

    create_tables: tuple[str, ...]
    agent_versions: tuple[int, ...]
    web_versions: tuple[int, ...]

    @property
    def needs_write(self) -> bool:
        return bool(self.create_tables)


def _version(value: object, expected: int) -> int:
    if type(value) is not int or value != expected:
        raise RuntimeError("unsupported resource provenance version")
    return value


def inspect_catalog_connection(connection: sqlite3.Connection) -> ResourceCatalogSchema:
    declarations = (
        (EXCERPT_DOCUMENTS_TABLE, CREATE_EXCERPT_DOCUMENTS, None),
        (AGENT_IMPORTS_TABLE, CREATE_AGENT_IMPORTS, AGENT_IMPORT_SCHEMA_VERSION),
        (WEB_SOURCES_TABLE, CREATE_WEB_SOURCES, WEB_SOURCE_SCHEMA_VERSION),
        (LISTING_TABLE, CREATE_LISTING, None),
    )
    reject_schema_residue(connection, (name for name, _, _ in declarations))
    missing = []
    versions: dict[str, tuple[int, ...]] = {}
    for name, definition, supported in declarations:
        row = connection.execute(
            "SELECT type,sql FROM sqlite_master WHERE name=?", (name,)
        ).fetchone()
        versions[name] = ()
        if row is None:
            missing.append(name)
            continue
        if row[0] != "table":
            raise RuntimeError("unsupported resource provenance object")
        try:
            actual = table_clauses(row[1], name)
            expected = table_clauses(definition, name)
        except ValueError as error:
            raise RuntimeError("unsupported resource provenance definition") from error
        if len(actual) != len(expected) or set(actual) != set(expected):
            raise RuntimeError("unsupported resource provenance constraints or columns")
        if supported is not None:
            observed = set()
            for value in connection.execute(f"SELECT DISTINCT schema_version FROM {name}"):
                observed.add(_version(value[0], supported))
            versions[name] = tuple(sorted(observed))
    return ResourceCatalogSchema(
        tuple(missing), versions[AGENT_IMPORTS_TABLE], versions[WEB_SOURCES_TABLE]
    )


def inspect_resource_catalog(database: Path) -> ResourceCatalogSchema:
    """Inspect a WAL snapshot under caller-owned directory qualification."""
    with database_files(database) as present:
        if not present:
            with closing(sqlite3.connect(":memory:")) as connection:
                return inspect_catalog_connection(connection)
        with reader(database) as connection:
            connection.execute("BEGIN")
            return inspect_catalog_connection(connection)


def initialize_resource_catalog(database: Path, project_root: Path) -> None:
    """Create missing owned tables only while the caller holds maintenance."""
    if not inspect_resource_catalog(database).needs_write:
        return
    with transaction(ProjectDatabasePath(database, project_root), immediate=True) as connection:
        initialize_catalog_schema(connection)


def initialize_catalog_schema(connection: sqlite3.Connection) -> None:
    """Apply the actual resource declarations inside the caller's transaction."""
    schema = inspect_catalog_connection(connection)
    for name, definition in (
        (EXCERPT_DOCUMENTS_TABLE, CREATE_EXCERPT_DOCUMENTS),
        (AGENT_IMPORTS_TABLE, CREATE_AGENT_IMPORTS),
        (WEB_SOURCES_TABLE, CREATE_WEB_SOURCES),
        (LISTING_TABLE, CREATE_LISTING),
    ):
        if name in schema.create_tables:
            connection.execute(definition)
    if inspect_catalog_connection(connection).needs_write:
        raise RuntimeError("resource provenance initialization did not converge")


@dataclass(frozen=True)
class ResourceExcerptIndex:
    """Canonical resource path recorded for one upstream source."""

    source_kind: ExcerptSourceKind
    source_id: str
    resource_path: str
    resource_revision: str


@dataclass(frozen=True)
class ResourceAgentImport:
    """One imported project asset and its immutable Agent-side origin snapshot."""

    import_id: str
    resource_path: str
    resource_revision: str | None
    source_kind: AgentImportSourceKind
    source_session_id: str
    source_turn_id: str | None
    source_item_id: str | None
    source_id: str | None
    source_event_seq: int | None
    source_detail: dict[str, Any] | None
    evidence_snapshot_id: str | None
    evidence: tuple[dict[str, Any], ...] | None
    conversation: dict[str, Any] | None
    schema_version: int
    imported_at: float
    updated_at: float


@dataclass(frozen=True)
class ResourceWebSource:
    """Fetch provenance for one successfully imported Markdown resource."""

    web_source_id: str
    resource_path: str
    resource_revision: str
    source_title: str | None
    source_url: str
    final_url: str | None
    search_query: str | None
    fetched_at: float | None
    schema_version: int
    created_at: float
    updated_at: float


class ResourceAgentImportCatalog:
    """Persist imported Agent provenance in the shared project database."""

    def __init__(self, content: ContentPort) -> None:
        self._content = content

    def _database(self, project_id: str) -> ProjectDatabasePath:
        return ProjectDatabasePath(
            Path(self._content.resolve(project_id, PROJECT_DB_RELATIVE)),
            Path(self._content.resolve(project_id, "")),
        )

    @staticmethod
    def _encoded(value: object | None) -> str | None:
        if value is None:
            return None
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _mapping(raw: object) -> dict[str, Any] | None:
        if raw is None:
            return None
        try:
            decoded = json.loads(str(raw))
        except (TypeError, ValueError):
            return None
        return dict(decoded) if isinstance(decoded, dict) else None

    @staticmethod
    def _evidence(raw: object) -> tuple[dict[str, Any], ...] | None:
        if raw is None:
            return None
        try:
            decoded = json.loads(str(raw))
        except (TypeError, ValueError):
            return None
        if not isinstance(decoded, list):
            return None
        return tuple(dict(item) for item in decoded if isinstance(item, dict))

    @classmethod
    def _record(cls, row: Any) -> ResourceAgentImport:
        return ResourceAgentImport(
            import_id=str(row["import_id"]),
            resource_path=str(row["resource_path"]),
            resource_revision=(str(row["resource_revision"]) if row["resource_revision"] else None),
            source_kind=AgentImportSourceKind(str(row["source_kind"])),
            source_session_id=str(row["source_session_id"]),
            source_turn_id=str(row["source_turn_id"]) if row["source_turn_id"] else None,
            source_item_id=str(row["source_item_id"]) if row["source_item_id"] else None,
            source_id=str(row["source_id"]) if row["source_id"] else None,
            source_event_seq=(
                int(row["source_event_seq"]) if row["source_event_seq"] is not None else None
            ),
            source_detail=cls._mapping(row["source_detail_json"]),
            evidence_snapshot_id=(
                str(row["evidence_snapshot_id"]) if row["evidence_snapshot_id"] else None
            ),
            evidence=cls._evidence(row["evidence_json"]),
            conversation=cls._mapping(row["conversation_snapshot_json"]),
            schema_version=_version(row["schema_version"], AGENT_IMPORT_SCHEMA_VERSION),
            imported_at=float(row["imported_at"]),
            updated_at=float(row["updated_at"]),
        )

    def save(self, project_id: str, record: ResourceAgentImport) -> ResourceAgentImport:
        _version(record.schema_version, AGENT_IMPORT_SCHEMA_VERSION)
        with transaction(self._database(project_id)) as connection:
            connection.execute(CREATE_AGENT_IMPORTS)
            connection.execute(
                INSERT_AGENT_IMPORT,
                (
                    record.import_id,
                    record.resource_path,
                    record.resource_revision,
                    record.source_kind.value,
                    record.source_session_id,
                    record.source_turn_id,
                    record.source_item_id,
                    record.source_id,
                    record.source_event_seq,
                    self._encoded(record.source_detail),
                    record.evidence_snapshot_id,
                    self._encoded(record.evidence),
                    self._encoded(record.conversation),
                    record.schema_version,
                    record.imported_at,
                    record.updated_at,
                ),
            )
            row = connection.execute(
                f"SELECT * FROM {AGENT_IMPORTS_TABLE} WHERE import_id = ?",
                (record.import_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("persisted Agent import disappeared")
        return self._record(row)

    def get(self, project_id: str, resource_path: str) -> ResourceAgentImport | None:
        with transaction(self._database(project_id)) as connection:
            connection.execute(CREATE_AGENT_IMPORTS)
            row = connection.execute(
                f"SELECT * FROM {AGENT_IMPORTS_TABLE} WHERE resource_path = ?",
                (resource_path,),
            ).fetchone()
        return self._record(row) if row is not None else None

    def relocate(self, project_id: str, source_path: str, target_path: str) -> int:
        """Keep imported-resource provenance attached after rename or move.

        Directory mutations relocate every imported descendant.  Reading the
        candidate rows and matching path components in Python avoids treating
        SQL ``LIKE`` wildcard characters in user-owned filenames as patterns.
        """

        if source_path == target_path:
            return 0
        source_prefix = f"{source_path.rstrip('/')}/"
        relocated: list[tuple[str, float, str]] = []
        now = time.time()
        with transaction(self._database(project_id)) as connection:
            connection.execute(CREATE_AGENT_IMPORTS)
            rows = connection.execute(
                f"SELECT import_id, resource_path FROM {AGENT_IMPORTS_TABLE}"
            ).fetchall()
            for row in rows:
                current = str(row["resource_path"])
                if current == source_path:
                    destination = target_path
                elif current.startswith(source_prefix):
                    destination = f"{target_path.rstrip('/')}/{current[len(source_prefix):]}"
                else:
                    continue
                relocated.append((destination, now, str(row["import_id"])))
            connection.executemany(
                f"""
                UPDATE {AGENT_IMPORTS_TABLE}
                SET resource_path = ?, updated_at = ?
                WHERE import_id = ?
                """,
                relocated,
            )
        return len(relocated)


class ResourceWebSourceCatalog:
    """Persist Web fetch provenance in the shared project database."""

    def __init__(self, content: ContentPort) -> None:
        self._content = content

    def _database(self, project_id: str) -> ProjectDatabasePath:
        return ProjectDatabasePath(
            Path(self._content.resolve(project_id, PROJECT_DB_RELATIVE)),
            Path(self._content.resolve(project_id, "")),
        )

    @staticmethod
    def _record(row: Any) -> ResourceWebSource:
        return ResourceWebSource(
            web_source_id=str(row["web_source_id"]),
            resource_path=str(row["resource_path"]),
            resource_revision=str(row["resource_revision"]),
            source_title=str(row["source_title"]) if row["source_title"] is not None else None,
            source_url=str(row["source_url"]),
            final_url=str(row["final_url"]) if row["final_url"] is not None else None,
            search_query=(str(row["search_query"]) if row["search_query"] is not None else None),
            fetched_at=float(row["fetched_at"]) if row["fetched_at"] is not None else None,
            schema_version=_version(row["schema_version"], WEB_SOURCE_SCHEMA_VERSION),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    def save(self, project_id: str, record: ResourceWebSource) -> ResourceWebSource:
        _version(record.schema_version, WEB_SOURCE_SCHEMA_VERSION)
        with transaction(self._database(project_id)) as connection:
            connection.execute(CREATE_WEB_SOURCES)
            connection.execute(
                INSERT_WEB_SOURCE,
                (
                    record.web_source_id,
                    record.resource_path,
                    record.resource_revision,
                    record.source_title,
                    record.source_url,
                    record.final_url,
                    record.search_query,
                    record.fetched_at,
                    record.schema_version,
                    record.created_at,
                    record.updated_at,
                ),
            )
            row = connection.execute(
                f"SELECT * FROM {WEB_SOURCES_TABLE} WHERE web_source_id = ?",
                (record.web_source_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("persisted Web source disappeared")
        return self._record(row)

    def get(self, project_id: str, resource_path: str) -> ResourceWebSource | None:
        with transaction(self._database(project_id)) as connection:
            connection.execute(CREATE_WEB_SOURCES)
            row = connection.execute(
                f"SELECT * FROM {WEB_SOURCES_TABLE} WHERE resource_path = ?",
                (resource_path,),
            ).fetchone()
        return self._record(row) if row is not None else None


class ResourceExcerptCatalog:
    """Persist the source-to-resource index in the shared project database."""

    def __init__(self, content: ContentPort) -> None:
        self._content = content

    def _database(self, project_id: str) -> ProjectDatabasePath:
        return ProjectDatabasePath(
            Path(self._content.resolve(project_id, PROJECT_DB_RELATIVE)),
            Path(self._content.resolve(project_id, "")),
        )

    def get(
        self,
        project_id: str,
        source_kind: ExcerptSourceKind,
        source_id: str,
    ) -> ResourceExcerptIndex | None:
        with transaction(self._database(project_id)) as connection:
            connection.execute(CREATE_EXCERPT_DOCUMENTS)
            row = connection.execute(
                f"""
                SELECT source_kind, source_id, resource_path, resource_revision
                FROM {EXCERPT_DOCUMENTS_TABLE}
                WHERE source_kind = ? AND source_id = ?
                """,
                (source_kind.value, source_id),
            ).fetchone()
        if row is None:
            return None
        return self._record(row)

    @staticmethod
    def _record(row: sqlite3.Row) -> ResourceExcerptIndex:
        return ResourceExcerptIndex(
            source_kind=ExcerptSourceKind(str(row["source_kind"])),
            source_id=str(row["source_id"]),
            resource_path=str(row["resource_path"]),
            resource_revision=str(row["resource_revision"]),
        )

    def save(
        self,
        project_id: str,
        source_kind: ExcerptSourceKind,
        source_id: str,
        resource_path: str,
        resource_revision: str,
    ) -> ResourceExcerptIndex:
        now = time.time()
        with transaction(self._database(project_id)) as connection:
            connection.execute(CREATE_EXCERPT_DOCUMENTS)
            connection.execute(
                UPSERT_EXCERPT_DOCUMENT,
                (
                    source_kind.value,
                    source_id,
                    resource_path,
                    resource_revision,
                    now,
                    now,
                ),
            )
        return ResourceExcerptIndex(
            source_kind=source_kind,
            source_id=source_id,
            resource_path=resource_path,
            resource_revision=resource_revision,
        )


def inspect_catalog_rows(connection: sqlite3.Connection) -> None:
    """Decode project provenance with the normal readers, without Content IO."""
    for table, decode in (
        (AGENT_IMPORTS_TABLE, ResourceAgentImportCatalog._record),
        (WEB_SOURCES_TABLE, ResourceWebSourceCatalog._record),
        (EXCERPT_DOCUMENTS_TABLE, ResourceExcerptCatalog._record),
    ):
        for row in connection.execute(f"SELECT * FROM {table}"):
            decode(row)


__all__ = [
    "AGENT_IMPORTS_TABLE",
    "AGENT_IMPORT_SCHEMA_VERSION",
    "EXCERPT_DOCUMENTS_TABLE",
    "WEB_SOURCES_TABLE",
    "WEB_SOURCE_SCHEMA_VERSION",
    "ResourceAgentImport",
    "ResourceAgentImportCatalog",
    "ResourceCatalogSchema",
    "ResourceExcerptCatalog",
    "ResourceExcerptIndex",
    "ResourceWebSource",
    "ResourceWebSourceCatalog",
    "initialize_resource_catalog",
    "inspect_resource_catalog",
    "inspect_catalog_rows",
]
