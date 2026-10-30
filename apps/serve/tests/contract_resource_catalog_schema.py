"""Resource provenance format checks; not whole-product data admission."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.preview import SchemaOwner, preview_database, require_candidate_layout
from service.persistence.project import rebuild_table
from service.platform.activity import Activities
from service.platform.excerpts import ExcerptSourceKind
from service.resources.persistence import pending
from service.resources.persistence.catalog import (
    AGENT_IMPORTS_TABLE,
    CREATE_AGENT_IMPORTS,
    CREATE_WEB_SOURCES,
    EXCERPT_DOCUMENTS_TABLE,
    WEB_SOURCES_TABLE,
    ResourceAgentImportCatalog,
    ResourceExcerptCatalog,
    ResourceWebSourceCatalog,
    initialize_catalog_schema,
    initialize_resource_catalog,
    inspect_catalog_connection,
    inspect_catalog_rows,
    inspect_resource_catalog,
)
from service.resources.persistence.listing import LISTING_TABLE
from service.resources.persistence.version import VersionStore


class ResourceCatalogSchemaContract(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        catalog = ContentCatalog(self.root / "content.sqlite3")
        self.content = ContentService(
            ProjectRegistry(str(self.root), catalog), catalog, activities=Activities()
        )
        self.project = self.content.create_project("Format contract")
        self.database = Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE))
        self.database.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(CREATE_AGENT_IMPORTS)
            connection.execute(CREATE_WEB_SOURCES)
            connection.execute(
                f"INSERT INTO {AGENT_IMPORTS_TABLE} (import_id,resource_path,source_kind,source_session_id,imported_at,updated_at) VALUES ('agent','agent.md','answer','session',1,1)"
            )
            connection.execute(
                f"INSERT INTO {WEB_SOURCES_TABLE} (web_source_id,resource_path,resource_revision,source_url,created_at,updated_at) VALUES ('web','web.md','revision','https://example.test',1,1)"
            )

    def test_readers_reject_unknown_and_noninteger_versions_without_rewrite(self):
        for table, owner, path in (
            (AGENT_IMPORTS_TABLE, ResourceAgentImportCatalog(self.content), "agent.md"),
            (WEB_SOURCES_TABLE, ResourceWebSourceCatalog(self.content), "web.md"),
        ):
            for version in (999, 1.5, "future", b"1"):
                with self.subTest(table=table, version=version):
                    with closing(sqlite3.connect(self.database)) as connection, connection:
                        connection.execute(f"UPDATE {table} SET schema_version=?", (version,))
                        before = tuple(connection.iterdump())
                    with self.assertRaises(RuntimeError):
                        owner.get(self.project.id, path)
                    with closing(sqlite3.connect(self.database)) as connection:
                        self.assertEqual(tuple(connection.iterdump()), before)

    def test_schema_inspection_and_initialization_preserve_other_owners(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("CREATE TABLE user_notes (note TEXT)")
            connection.execute("INSERT INTO user_notes VALUES ('keep')")
        schema = inspect_resource_catalog(self.database)
        self.assertEqual(schema.create_tables, (EXCERPT_DOCUMENTS_TABLE, LISTING_TABLE))
        self.assertEqual(schema.agent_versions, (1,))
        self.assertEqual(schema.web_versions, (1,))
        initialize_resource_catalog(self.database, Path(self.content.resolve(self.project.id, "")))
        self.assertFalse(inspect_resource_catalog(self.database).needs_write)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT * FROM user_notes").fetchall(), [("keep",)])

    def test_missing_inspection_creates_no_directory(self):
        database = self.root / "absent" / "project.sqlite3"
        self.assertEqual(
            set(inspect_resource_catalog(database).create_tables),
            {AGENT_IMPORTS_TABLE, WEB_SOURCES_TABLE, EXCERPT_DOCUMENTS_TABLE, LISTING_TABLE},
        )
        self.assertFalse(database.parent.exists())

    def test_projection_reads_all_provenance_kinds_without_resolving_sources(self):
        initialize_resource_catalog(self.database, Path(self.content.resolve(self.project.id, "")))
        excerpt = ResourceExcerptCatalog(self.content)
        excerpt.save(
            self.project.id, ExcerptSourceKind.LITERATURE, "paper", "missing/excerpt.md", "revision"
        )
        owners = (
            SchemaOwner(
                "resource-versions",
                VersionStore.inspect_connection,
                VersionStore.initialize_schema,
                VersionStore.inspect_rows,
                triggers=VersionStore.preview_triggers,
            ),
            SchemaOwner(
                "resource-catalog",
                inspect_catalog_connection,
                initialize_catalog_schema,
                inspect_catalog_rows,
            ),
        )
        preview = preview_database(self.database, "project", owners)
        self.assertEqual(
            require_candidate_layout(preview, preview, owners).row_readers,
            ("resource-versions", "resource-catalog"),
        )
        for table, column, value in (
            (AGENT_IMPORTS_TABLE, "source_kind", "future-kind"),
            (AGENT_IMPORTS_TABLE, "imported_at", "future-date"),
            (WEB_SOURCES_TABLE, "fetched_at", "future-date"),
            (EXCERPT_DOCUMENTS_TABLE, "source_kind", "future-kind"),
        ):
            with (
                self.subTest(table=table, column=column),
                closing(sqlite3.connect(self.database)) as connection,
            ):
                original = connection.execute(f"SELECT {column} FROM {table}").fetchone()
                self.assertIsNotNone(original)
                connection.execute(f"UPDATE {table} SET {column}=?", (value,))
                connection.commit()
                before = tuple(connection.iterdump())
                try:
                    with self.assertRaises((ValueError, TypeError, RuntimeError)):
                        preview_database(self.database, "project", owners)
                    self.assertEqual(tuple(connection.iterdump()), before)
                finally:
                    connection.execute(f"UPDATE {table} SET {column}=?", original)
                    connection.commit()
        after = preview_database(self.database, "project", owners)
        self.assertEqual(replace(after, source_digest=preview.source_digest), preview)

    def test_unknown_schema_blocks_initialization_without_changes(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {AGENT_IMPORTS_TABLE} ADD COLUMN future_data TEXT")
            connection.execute(f"UPDATE {AGENT_IMPORTS_TABLE} SET future_data='preserve'")
            before = tuple(connection.iterdump())
        for operation in (
            lambda: inspect_resource_catalog(self.database),
            lambda: initialize_resource_catalog(
                self.database, Path(self.content.resolve(self.project.id, ""))
            ),
        ):
            with self.assertRaises(RuntimeError):
                operation()
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_wal_future_version_prevents_missing_table_creation(self):
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(f"UPDATE {WEB_SOURCES_TABLE} SET schema_version=999")
            writer.commit()
            wal = Path(str(self.database) + "-wal")
            before = self.database.read_bytes(), wal.read_bytes()
            for operation in (
                lambda: inspect_resource_catalog(self.database),
                lambda: initialize_resource_catalog(
                    self.database, Path(self.content.resolve(self.project.id, ""))
                ),
            ):
                with self.assertRaises(RuntimeError):
                    operation()
                self.assertEqual(before, (self.database.read_bytes(), wal.read_bytes()))
            self.assertIsNone(
                writer.execute(
                    "SELECT name FROM sqlite_master WHERE name=?", (EXCERPT_DOCUMENTS_TABLE,)
                ).fetchone()
            )

    def test_save_rejects_unsupported_envelope_before_writing(self):
        for owner, path in (
            (ResourceAgentImportCatalog(self.content), "agent.md"),
            (ResourceWebSourceCatalog(self.content), "web.md"),
        ):
            record = owner.get(self.project.id, path)
            with closing(sqlite3.connect(self.database)) as connection:
                before = tuple(connection.iterdump())
            for version in (999, 1.5, True, "1"):
                with self.subTest(owner=type(owner).__name__, version=version):
                    with self.assertRaises(RuntimeError):
                        owner.save(self.project.id, replace(record, schema_version=version))
                    with closing(sqlite3.connect(self.database)) as connection:
                        self.assertEqual(tuple(connection.iterdump()), before)


class ResourceVersionSchemaContract(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.database = self.root / ".scholarseed" / "service" / "project.sqlite3"
        self.store = VersionStore(self.database, self.root)
        self.store.ensure()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "ALTER TABLE resources_turns ADD COLUMN opaque_mutation INTEGER NOT NULL DEFAULT 0"
            )
            connection.execute(
                "INSERT INTO resources_turns (turn_occurrence_id,session_id,turn_id,runtime_generation,baseline_generation,state,started_at_ms,updated_at_ms,opaque_mutation) VALUES ('turn','session','turn','generation',1,'completed',1,1,1)"
            )
            connection.execute("DROP TABLE resources_pending")
            connection.execute(pending.LEGACY_SCHEMA)
            connection.execute(
                "ALTER TABLE resources_pending ADD COLUMN review_origin TEXT DEFAULT 'agent' CHECK (review_origin IN ('agent','external'))"
            )
            connection.execute(
                "INSERT INTO resources_files (file_id,current_path,media_type,state,management_state,next_sequence,created_at_ms,updated_at_ms) VALUES ('file','notes.md','text/markdown','present','managed',1,1,1)"
            )
            connection.execute(
                "INSERT INTO resources_pending (file_id,revision,origin,updated_at_ms) VALUES ('file',1,'user',1)"
            )
            connection.execute(
                "CREATE INDEX retained_pending_index ON resources_pending(updated_at_ms)"
            )
            connection.execute("CREATE TABLE user_notes(body TEXT)")
            connection.execute("INSERT INTO user_notes VALUES ('preserve')")

    def snapshot(self):
        with closing(sqlite3.connect(self.database)) as connection:
            return tuple(connection.iterdump())

    def test_legacy_schema_inspection_is_readonly_and_repair_preserves_rows(self):
        before = self.snapshot()
        schema = VersionStore.inspect_schema(self.database)
        self.assertEqual(schema.repair_tables, ("resources_pending",))
        self.assertEqual(self.snapshot(), before)
        self.store.ensure()
        self.assertFalse(VersionStore.inspect_schema(self.database).needs_write)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT opaque_mutation FROM resources_turns").fetchall(), [(1,)]
            )
            self.assertEqual(
                connection.execute(
                    "SELECT file_id,revision,origin,review_origin FROM resources_pending"
                ).fetchall(),
                [("file", 1, "user", "agent")],
            )
            self.assertEqual(
                connection.execute("SELECT body FROM user_notes").fetchall(), [("preserve",)]
            )
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertIsNotNone(
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE name='retained_pending_index'"
                ).fetchone()
            )
        repaired = self.snapshot()
        self.store.ensure()
        self.assertEqual(self.snapshot(), repaired)

    def test_unknown_columns_remain_rejected_without_changes(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("ALTER TABLE resources_turns ADD COLUMN future_instruction TEXT")
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "unsupported resource version constraints"):
            self.store.ensure()
        self.assertEqual(self.snapshot(), before)

    def test_failed_legacy_repair_rolls_back_schema_and_rows(self):
        before = self.snapshot()
        original = rebuild_table

        def fail_after_repair(*arguments):
            original(*arguments)
            raise RuntimeError("interrupted repair")

        with patch("service.resources.persistence.version.rebuild_table", fail_after_repair):
            with self.assertRaisesRegex(RuntimeError, "interrupted repair"):
                self.store.ensure()
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
