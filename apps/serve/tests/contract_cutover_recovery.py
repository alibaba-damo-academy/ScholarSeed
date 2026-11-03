"""Real SQLite/process cutover recovery; no cross-database rollback authority."""

from __future__ import annotations

import multiprocessing
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from service import cutover
from service.literature.persistence.store import classify_schema as inspect_literature
from service.literature.persistence.store import connect as connect_literature
from service.literature.persistence.store import initialize_schema as initialize_literature
from service.persistence.preview import (
    SchemaObject,
    SchemaOwner,
    preview_database,
    require_candidate_layout,
)
from service.persistence.project import DatabaseBindingError


def old_project(path: Path):
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript("""
            CREATE TABLE content_asset(asset_id TEXT PRIMARY KEY);
            INSERT INTO content_asset VALUES('asset');
            CREATE TABLE workbench_pdf_record(asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),payload BLOB NOT NULL,revision TEXT NOT NULL,updated_at REAL NOT NULL);
            INSERT INTO workbench_pdf_record VALUES('asset','old records','old',1);
            CREATE TABLE user_notes(note TEXT);
        """)


def interrupted(path, second, between):
    original = cutover._cutover_project
    calls = 0

    def convert(connection):
        nonlocal calls
        calls += 1
        if between and calls == 2:
            os._exit(73)
        original(connection)
        if not between:
            os._exit(73)

    with patch.object(cutover, "_cutover_project", convert):
        cutover.cutover_pdf_records(Path(path).parent / "absent", (Path(path), Path(second)))


def starter(path, ready, proceed, blocked, result):
    original_backup = cutover._backup
    original_needs = cutover._needs_project_cutover
    checks = 0

    def needs(connection):
        nonlocal checks
        checks += 1
        answer = original_needs(connection)
        if not blocked and checks == 1:
            ready.set()  # This process saw the old schema before waiting for the writer.
        return answer

    def backup(*args):
        answer = original_backup(*args)
        if blocked:
            ready.set()
            if not proceed.wait(15):
                raise RuntimeError("test synchronization timeout")
        return answer

    with (
        patch.object(cutover, "_backup", backup),
        patch.object(cutover, "_needs_project_cutover", needs),
    ):
        backups = cutover.cutover_pdf_records(Path(path).parent / "absent", (Path(path),))
        result.put(len(backups))


class Recovery(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory(prefix="cutover-recovery-")
        self.root = Path(self.area.name)
        self.first = self.root / "first.sqlite3"
        self.second = self.root / "second.sqlite3"
        self.literature = self.root / "absent.sqlite3"
        old_project(self.first)
        old_project(self.second)

    def tearDown(self):
        self.area.cleanup()

    def test_project_cutover_preview_uses_actual_migration_without_source_writes(self):
        owners = (
            SchemaOwner(
                "pdf",
                lambda connection: cutover.inspect_pdf_connection(connection, "project"),
                lambda connection: cutover.initialize_pdf_schema(connection, "project"),
            ),
        )
        before_files = set(self.root.iterdir())
        with closing(sqlite3.connect(self.first)) as source:
            before = tuple(source.iterdump())
            preview = preview_database(self.first, "project", owners)
            require_candidate_layout(preview, preview, owners)
            self.assertEqual(tuple(source.iterdump()), before)
            self.assertNotIn("old records", repr(preview))
        self.assertEqual(set(self.root.iterdir()), before_files, "preview must not create backups")
        backups = cutover.cutover_pdf_records(self.literature, (self.first,))
        self.assertEqual(len(backups), 1)
        with closing(sqlite3.connect(self.first)) as source:
            actual = tuple(
                SchemaObject(*row)
                for row in source.execute(
                    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name,tbl_name"
                )
                if not row[1].lower().startswith("sqlite_")
            )
        self.assertEqual(preview.objects, actual)
        with closing(sqlite3.connect(backups[0])) as backup:
            self.assertEqual(tuple(backup.iterdump()), before)

    def test_source_pdf_reader_rejects_changed_candidate_payload_type(self):
        owners = (
            SchemaOwner(
                "pdf",
                lambda connection: cutover.inspect_pdf_connection(connection, "project"),
                lambda connection: cutover.initialize_pdf_schema(connection, "project"),
            ),
        )
        preview = preview_database(self.first, "project", owners)
        changed = replace(
            preview,
            objects=tuple(
                (
                    replace(row, sql=row.sql.replace("payload BLOB", "payload TEXT"))
                    if row.name == "workbench_pdf_record"
                    else row
                )
                for row in preview.objects
            ),
        )
        self.assertNotEqual(changed, preview)
        with self.assertRaises(cutover.PdfRecordCutoverError):
            require_candidate_layout(changed, preview, owners)

    def test_literature_cutover_preview_does_not_touch_attachment_paths_or_backups(self):
        connect_literature(self.literature).close()
        missing_attachment = self.root / "private-attachment-marker.pdf"
        with closing(sqlite3.connect(self.literature)) as source:
            source.execute(
                "ALTER TABLE literature_items ADD COLUMN pdf_path TEXT NOT NULL DEFAULT ''"
            )
            source.execute(
                "INSERT INTO literature_items(id,item_type,bib_type,title,created_at,updated_at,pdf_path) VALUES (?,?,?,?,?,?,?)",
                (
                    "paper",
                    "document",
                    "misc",
                    "private-title-marker",
                    1,
                    1,
                    str(missing_attachment),
                ),
            )
            source.commit()
            before = tuple(source.iterdump())
            before_files = set(self.root.iterdir())
            owners = (
                SchemaOwner(
                    "pdf",
                    lambda connection: cutover.inspect_pdf_connection(connection, "literature"),
                    lambda connection: cutover.initialize_pdf_schema(connection, "literature"),
                ),
                SchemaOwner("literature", inspect_literature, initialize_literature),
            )
            preview = preview_database(self.literature, "literature", owners)
            require_candidate_layout(preview, preview, owners)
            self.assertEqual(tuple(source.iterdump()), before)
            self.assertNotIn("private-title-marker", repr(preview))
            self.assertNotIn("private-attachment-marker", repr(preview))
            self.assertEqual(set(self.root.iterdir()), before_files)
        self.assertFalse(missing_attachment.exists())
        self.assertEqual(len(cutover.cutover_pdf_records(self.literature, ())), 1)
        connect_literature(self.literature).close()
        with closing(sqlite3.connect(self.literature)) as source:
            actual = tuple(
                SchemaObject(*row)
                for row in source.execute(
                    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name,tbl_name"
                )
                if not row[1].lower().startswith("sqlite_")
            )
        self.assertEqual(preview.objects, actual)

    def test_direct_cutover_requires_the_callers_schema_transaction(self):
        with closing(sqlite3.connect(self.first)) as source:
            source.row_factory = sqlite3.Row
            before = tuple(source.iterdump())
            with self.assertRaisesRegex(
                cutover.PdfRecordCutoverError, "requires a schema transaction"
            ):
                cutover.initialize_pdf_schema(source, "project")
            self.assertEqual(tuple(source.iterdump()), before)

    def test_project_snapshot_missing_database_has_no_side_effect(self):
        database = self.root / "missing" / "project.sqlite3"
        self.assertEqual(
            cutover.inspect_project_pdf(database), cutover.ProjectPdfSchema(False, False, ())
        )
        self.assertFalse(database.parent.exists())

    def test_project_snapshot_rejects_orphan_sidecar_without_creation(self):
        database = self.root / "orphan.sqlite3"
        sidecar = Path(str(database) + "-wal")
        sidecar.write_bytes(b"preserve orphan")
        with self.assertRaises(DatabaseBindingError):
            cutover.inspect_project_pdf(database)
        self.assertFalse(database.exists())
        self.assertEqual(sidecar.read_bytes(), b"preserve orphan")

    def test_project_snapshot_tracks_same_cutover_state_schema_changes_in_wal(self):
        with closing(sqlite3.connect(self.first)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            first = cutover.inspect_project_pdf(self.first)
            writer.execute("CREATE TABLE extra_owner(value TEXT)")
            writer.commit()
            second = cutover.inspect_project_pdf(self.first)
            self.assertTrue(first.present and first.cutover and second.cutover)
            self.assertNotEqual(first, second)
            self.assertIn(
                ("table", "extra_owner", "extra_owner", "CREATE TABLE extra_owner(value TEXT)"),
                second.declarations,
            )
        cutover.cutover_pdf_records(self.literature, (self.first,))
        current = cutover.inspect_project_pdf(self.first)
        self.assertTrue(current.present)
        self.assertFalse(current.needs_write)

    def test_unknown_project_constraints_are_not_migrated(self):
        declarations = (
            "asset_id TEXT PRIMARY KEY, revision TEXT NOT NULL,payload BLOB NOT NULL,updated_at REAL NOT NULL",
            "asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id), revision TEXT NOT NULL CHECK(length(revision)>0),payload BLOB NOT NULL,updated_at REAL NOT NULL",
            "asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id), record_revision TEXT NOT NULL,source_revision TEXT NOT NULL,payload BLOB NOT NULL,updated_at REAL NOT NULL,UNIQUE(record_revision)",
        )
        for position, declaration in enumerate(declarations):
            with self.subTest(declaration=declaration):
                database = self.root / f"constraints-{position}.sqlite3"
                with closing(sqlite3.connect(database)) as connection:
                    connection.execute("CREATE TABLE content_asset(asset_id TEXT PRIMARY KEY)")
                    connection.execute(f"CREATE TABLE workbench_pdf_record({declaration})")
                    before = tuple(connection.iterdump())
                with self.assertRaises(cutover.PdfRecordCutoverError):
                    cutover.cutover_pdf_records(self.literature, (database,))
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)
                self.assertFalse(list(self.root.glob(f"{database.name}*.bak")))

    def test_legacy_project_dependencies_prevent_destructive_cutover(self):
        dependencies = (
            "CREATE INDEX custom_index ON workbench_pdf_record(revision)",
            "CREATE TRIGGER custom_trigger AFTER INSERT ON workbench_pdf_record BEGIN SELECT 1; END",
            "CREATE TABLE custom_child(id TEXT REFERENCES workbench_pdf_record(asset_id))",
            "CREATE TABLE custom_child(id TEXT REFERENCES WorkBench_Pdf_Record(asset_id))",
            "CREATE VIEW custom_view AS SELECT revision FROM workbench_pdf_record",
        )
        for position, declaration in enumerate(dependencies):
            with self.subTest(declaration=declaration):
                database = self.root / f"dependent-{position}.sqlite3"
                old_project(database)
                with closing(sqlite3.connect(database)) as connection:
                    connection.execute(declaration)
                    before = tuple(connection.iterdump())
                with self.assertRaises(cutover.PdfRecordCutoverError):
                    cutover.cutover_pdf_records(self.literature, (database,))
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_current_project_dependencies_do_not_require_cutover(self):
        cutover.cutover_pdf_records(self.literature, (self.first,))
        with closing(sqlite3.connect(self.first)) as connection:
            connection.execute("CREATE INDEX custom_index ON workbench_pdf_record(record_revision)")
            connection.execute(
                "CREATE TABLE custom_child(id TEXT REFERENCES workbench_pdf_record(asset_id))"
            )
            connection.execute(
                "CREATE VIEW custom_view AS SELECT record_revision FROM workbench_pdf_record"
            )
            before = tuple(connection.iterdump())
        self.assertEqual(cutover.cutover_pdf_records(self.literature, (self.first,)), ())
        with closing(sqlite3.connect(self.first)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_inspection_reports_legacy_without_backup_or_database_changes(self):
        before = self.first.read_bytes(), self.second.read_bytes()
        targets = cutover.inspect_pdf_records(self.literature, (self.first, self.second))
        self.assertEqual(
            targets,
            (
                cutover.CutoverTarget(self.first, "project"),
                cutover.CutoverTarget(self.second, "project"),
            ),
        )
        self.assertEqual(before, (self.first.read_bytes(), self.second.read_bytes()))
        self.assertFalse(self.literature.exists())
        self.assertFalse(list(self.root.glob("*.bak")))

    def test_literature_startup_inspection_does_not_create_missing_parent(self):
        database = self.root / "missing" / "library.sqlite3"
        snapshot = cutover.inspect_literature_startup(database)
        self.assertFalse(snapshot.cutover)
        self.assertTrue(snapshot.library.needs_write)
        self.assertEqual(snapshot.declarations, ())
        self.assertFalse(database.parent.exists())

    def test_literature_startup_retains_legacy_changes_then_converges(self):
        connect_literature(self.literature).close()
        current = cutover.inspect_literature_startup(self.literature)
        self.assertFalse(current.needs_write)
        with closing(sqlite3.connect(self.literature)) as writer:
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(
                "ALTER TABLE literature_items ADD COLUMN pdf_path TEXT NOT NULL DEFAULT ''"
            )
            writer.commit()
            first = cutover.inspect_literature_startup(self.literature)
            writer.execute(
                "ALTER TABLE literature_items ADD COLUMN pdf_asset_id TEXT NOT NULL DEFAULT ''"
            )
            writer.commit()
            before = tuple(writer.iterdump())
            second = cutover.inspect_literature_startup(self.literature)
            self.assertTrue(first.cutover and second.cutover)
            self.assertIsNone(second.library)
            self.assertNotEqual(first, second)
            self.assertEqual(tuple(writer.iterdump()), before)
        self.assertEqual(len(cutover.cutover_pdf_records(self.literature, ())), 1)
        connect_literature(self.literature).close()
        final = cutover.inspect_literature_startup(self.literature)
        self.assertFalse(final.needs_write)
        self.assertIsNotNone(final.library)

    def test_literature_pdf_and_library_checks_share_readonly_snapshot(self):
        connect_literature(self.literature).close()
        original = cutover._needs_literature_cutover
        observed = []

        def check_pdf(connection):
            observed.append(connection)
            self.assertTrue(connection.in_transaction)
            with self.assertRaisesRegex(sqlite3.OperationalError, "readonly"):
                connection.execute("CREATE TABLE unwanted(value TEXT)")
            return original(connection)

        classify = cutover.classify_schema

        def check_library(connection):
            self.assertIs(connection, observed[0])
            self.assertTrue(connection.in_transaction)
            return classify(connection)

        with (
            patch.object(cutover, "_needs_literature_cutover", check_pdf),
            patch.object(cutover, "classify_schema", check_library),
        ):
            self.assertFalse(cutover.inspect_literature_startup(self.literature).needs_write)
        with self.assertRaises(sqlite3.ProgrammingError):
            observed[0].execute("SELECT 1")

    def test_current_schema_needs_no_migration_write_access(self):
        cutover.cutover_pdf_records(self.literature, (self.first,))
        before = self.first.read_bytes()
        with patch.object(cutover.os, "access", return_value=False):
            self.assertEqual(cutover.cutover_pdf_records(self.literature, (self.first,)), ())
        self.assertEqual(self.first.read_bytes(), before)

    def test_inspection_uses_readonly_sqlite_connection(self):
        original = cutover._needs_project_cutover

        def inspect(connection):
            self.assertTrue(connection.in_transaction)
            with self.assertRaisesRegex(sqlite3.OperationalError, "readonly"):
                connection.execute("CREATE TABLE unwanted(value TEXT)")
            return original(connection)

        with patch.object(cutover, "_needs_project_cutover", inspect):
            self.assertEqual(len(cutover.inspect_pdf_records(self.literature, (self.first,))), 1)
        self.assertFalse(list(self.root.glob("*.bak")))

    def test_inspection_observes_committed_wal_schema_without_changing_it(self):
        path = self.root / "wal.sqlite3"
        with closing(sqlite3.connect(path)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(
                "CREATE TABLE workbench_pdf_record(asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id), payload BLOB NOT NULL, revision TEXT NOT NULL, updated_at REAL NOT NULL)"
            )
            writer.commit()
            wal = Path(str(path) + "-wal")
            before = path.read_bytes(), wal.read_bytes()
            self.assertEqual(
                cutover.inspect_pdf_records(self.literature, (path,)),
                (cutover.CutoverTarget(path, "project"),),
            )
            self.assertEqual(before, (path.read_bytes(), wal.read_bytes()))
            writer.execute("ALTER TABLE workbench_pdf_record ADD COLUMN future TEXT")
            writer.commit()
            before = path.read_bytes(), wal.read_bytes()
            with self.assertRaises(cutover.PdfRecordCutoverError):
                cutover.inspect_pdf_records(self.literature, (path,))
            self.assertEqual(before, (path.read_bytes(), wal.read_bytes()))
        self.assertFalse(list(self.root.glob("*.bak")))

    def test_later_database_failure_does_not_restore_committed_database(self):
        original = cutover._cutover_project
        calls = 0

        def convert(target):
            nonlocal calls
            calls += 1
            if calls == 2:
                with closing(sqlite3.connect(self.first)) as another, another:
                    another.execute("INSERT INTO user_notes VALUES ('new user write')")
                raise OSError("second database failure")
            return original(target)

        with patch.object(cutover, "_cutover_project", convert):
            with self.assertRaises(cutover.PdfRecordCutoverError):
                cutover.cutover_pdf_records(self.literature, (self.first, self.second))
        with closing(sqlite3.connect(self.first)) as connection:
            self.assertEqual(
                connection.execute("SELECT * FROM user_notes").fetchall(), [("new user write",)]
            )
        cutover.cutover_pdf_records(self.literature, (self.first, self.second))
        with closing(sqlite3.connect(self.first)) as connection:
            self.assertEqual(
                connection.execute("SELECT * FROM user_notes").fetchall(), [("new user write",)]
            )

    def test_validation_failure_rolls_back_before_publication(self):
        # The validation callback deliberately observes the uncommitted schema.
        with patch.object(
            cutover, "_verify", side_effect=cutover.PdfRecordCutoverError("contract invalid")
        ):
            with self.assertRaises(cutover.PdfRecordCutoverError):
                cutover.cutover_pdf_records(self.literature, (self.first,))
        with closing(sqlite3.connect(self.first)) as connection:
            self.assertEqual(
                connection.execute("SELECT payload FROM workbench_pdf_record").fetchone()[0],
                "old records",
            )

    def test_unknown_project_columns_preserve_all_records(self):
        for definition in ("future TEXT", "computed TEXT GENERATED ALWAYS AS (payload) VIRTUAL"):
            with self.subTest(definition=definition):
                database = self.root / (definition.split()[0] + ".sqlite3")
                old_project(database)
                cutover.cutover_pdf_records(self.literature, (database,))
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute("DELETE FROM workbench_pdf_record")
                    connection.execute(
                        "INSERT INTO workbench_pdf_record(asset_id,record_revision,source_revision,payload,updated_at) VALUES ('asset','new','source','valuable',2)"
                    )
                    connection.execute("ALTER TABLE workbench_pdf_record ADD COLUMN " + definition)
                    before = list(connection.iterdump())
                with self.assertRaises(cutover.PdfRecordCutoverError):
                    cutover.cutover_pdf_records(self.literature, (database,))
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(list(connection.iterdump()), before)

    def test_unknown_literature_columns_preserve_database(self):
        with closing(sqlite3.connect(self.literature)) as connection:
            connection.executescript(
                "CREATE TABLE literature_attachments(id TEXT, future TEXT); INSERT INTO literature_attachments VALUES ('attachment','valuable');"
            )
            before = list(connection.iterdump())
        with self.assertRaises(cutover.PdfRecordCutoverError):
            cutover.cutover_pdf_records(self.literature, ())
        with closing(sqlite3.connect(self.literature)) as connection:
            self.assertEqual(list(connection.iterdump()), before)

    def test_obsolete_table_cleanup_preserves_final_literature_records(self):
        connect_literature(self.literature).close()
        with closing(sqlite3.connect(self.literature)) as connection:
            connection.execute(
                "INSERT INTO literature_items(id,item_type,bib_type,title,created_at,updated_at) VALUES('paper','document','misc','Paper',1,1)"
            )
            connection.execute(
                "INSERT INTO literature_attachments VALUES ('attachment','paper','pdf','paper.pdf','revision','pdf','primary','application/pdf',1)"
            )
            connection.execute(
                "CREATE TABLE literature_reading_records(literature_id TEXT PRIMARY KEY,payload TEXT NOT NULL)"
            )
            connection.commit()
        cutover.cutover_pdf_records(self.literature, ())
        with closing(sqlite3.connect(self.literature)) as connection, connection:
            connection.execute(
                "INSERT INTO literature_attachment_records VALUES ('attachment','revision','source','valuable',1)"
            )
            connection.execute(
                "CREATE TABLE literature_reading_records(literature_id TEXT PRIMARY KEY,payload TEXT NOT NULL)"
            )
        cutover.cutover_pdf_records(self.literature, ())
        with closing(sqlite3.connect(self.literature)) as connection:
            self.assertEqual(
                connection.execute("SELECT payload FROM literature_attachment_records").fetchone()[
                    0
                ],
                "valuable",
            )

    def test_unknown_literature_declarations_preserve_database(self):
        changes = (
            "CREATE TABLE literature_reading_records(literature_id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(length(payload)>0))",
            "CREATE TABLE literature_marks(id TEXT PRIMARY KEY,attachment_id TEXT,text TEXT,page INTEGER,created_at REAL NOT NULL)",
            "ALTER TABLE literature_items ADD COLUMN pdf_path TEXT NOT NULL DEFAULT ''; ALTER TABLE literature_items ADD COLUMN future TEXT",
            "CREATE TABLE literature_attachment_records(attachment_id TEXT PRIMARY KEY,record_revision TEXT NOT NULL,source_revision TEXT NOT NULL,payload BLOB NOT NULL,updated_at REAL NOT NULL)",
            "CREATE TABLE literature_attachments_cutover(valuable TEXT)",
            "DROP INDEX literature_primary_attachment; CREATE INDEX literature_primary_attachment ON literature_items(title)",
        )
        for position, sql in enumerate(changes):
            with self.subTest(sql=sql):
                database = self.root / f"library-format-{position}.sqlite3"
                connect_literature(database).close()
                with closing(sqlite3.connect(database)) as connection:
                    connection.executescript(sql)
                    before = tuple(connection.iterdump())
                with self.assertRaises(cutover.PdfRecordCutoverError):
                    cutover.cutover_pdf_records(database, ())
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)
                self.assertFalse(list(self.root.glob(f"{database.name}*.bak")))

    def test_obsolete_literature_dependencies_prevent_deletion(self):
        dependencies = (
            "CREATE INDEX extension ON literature_reading_records(payload)",
            "CREATE TRIGGER extension AFTER INSERT ON literature_reading_records BEGIN SELECT 1; END",
            "CREATE TABLE extension(id TEXT REFERENCES Literature_Reading_Records(literature_id))",
            "CREATE VIEW extension AS SELECT payload FROM literature_reading_records",
        )
        for position, sql in enumerate(dependencies):
            with self.subTest(sql=sql):
                database = self.root / f"library-dependency-{position}.sqlite3"
                connect_literature(database).close()
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute(
                        "CREATE TABLE literature_reading_records(literature_id TEXT PRIMARY KEY,payload TEXT NOT NULL)"
                    )
                    connection.execute(
                        "INSERT INTO literature_reading_records VALUES('paper','valuable')"
                    )
                    connection.execute(sql)
                    before = tuple(connection.iterdump())
                with self.assertRaises(cutover.PdfRecordCutoverError):
                    cutover.cutover_pdf_records(database, ())
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_backup_failure_leaves_old_database(self):
        with patch.object(cutover, "_backup", side_effect=OSError("disk full")):
            with self.assertRaises(cutover.PdfRecordCutoverError):
                cutover.cutover_pdf_records(self.literature, (self.first,))
        with closing(sqlite3.connect(self.first)) as connection:
            self.assertEqual(
                connection.execute("SELECT payload FROM workbench_pdf_record").fetchone()[0],
                "old records",
            )

    def test_kill_inside_conversion_rolls_back(self):
        context = multiprocessing.get_context("spawn")
        process = context.Process(
            target=interrupted, args=(str(self.first), str(self.second), False)
        )
        process.start()
        process.join(20)
        self.assertEqual(process.exitcode, 73)
        with closing(sqlite3.connect(self.first)) as connection:
            self.assertEqual(
                connection.execute("SELECT payload FROM workbench_pdf_record").fetchone()[0],
                "old records",
            )
        self.assertEqual(
            len(cutover.cutover_pdf_records(self.literature, (self.first, self.second))), 2
        )

    def test_kill_between_databases_preserves_new_records_on_retry(self):
        context = multiprocessing.get_context("spawn")
        process = context.Process(
            target=interrupted, args=(str(self.first), str(self.second), True)
        )
        process.start()
        process.join(20)
        self.assertEqual(process.exitcode, 73)
        with closing(sqlite3.connect(self.first)) as connection, connection:
            connection.execute(
                "INSERT INTO workbench_pdf_record VALUES ('asset','new','source','new records',2)"
            )
        self.assertEqual(
            len(cutover.cutover_pdf_records(self.literature, (self.first, self.second))), 1
        )
        with closing(sqlite3.connect(self.first)) as connection:
            self.assertEqual(
                connection.execute("SELECT payload FROM workbench_pdf_record").fetchone()[0],
                "new records",
            )

    def test_concurrent_starter_rechecks_after_acquiring_writer(self):
        context = multiprocessing.get_context("spawn")
        ready = context.Event()
        waiting = context.Event()
        proceed = context.Event()
        result = context.Queue()
        first = context.Process(
            target=starter, args=(str(self.first), ready, proceed, True, result)
        )
        second = context.Process(
            target=starter, args=(str(self.first), waiting, proceed, False, result)
        )
        try:
            first.start()
            self.assertTrue(ready.wait(10))
            second.start()
            self.assertTrue(waiting.wait(10))
            proceed.set()
            first.join(20)
            second.join(20)
            self.assertEqual(first.exitcode, 0)
            self.assertEqual(second.exitcode, 0)
            self.assertEqual(sorted([result.get(timeout=5), result.get(timeout=5)]), [0, 1])
        finally:
            proceed.set()
            for process in (first, second):
                if process.pid and process.is_alive():
                    process.kill()
                    process.join(5)
            result.close()

    def test_backup_contains_committed_wal_and_original_schema(self):
        with closing(sqlite3.connect(self.first)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("INSERT INTO user_notes VALUES ('committed WAL')")
            writer.commit()
            backups = cutover.cutover_pdf_records(self.literature, (self.first,))
            with closing(sqlite3.connect(backups[0])) as backup:
                self.assertEqual(
                    backup.execute("SELECT payload FROM workbench_pdf_record").fetchone()[0],
                    "old records",
                )
                self.assertEqual(
                    backup.execute("SELECT note FROM user_notes").fetchone()[0], "committed WAL"
                )


def main():
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(Recovery)
    )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
