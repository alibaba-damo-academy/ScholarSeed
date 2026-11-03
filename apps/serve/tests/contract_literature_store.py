"""Contracts for the user-level literature repository and project projections."""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager, nullcontext
from dataclasses import replace
from hashlib import md5, sha256
from pathlib import Path
from threading import Barrier
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.api.catalogue import (
    EXPORT_TOO_MANY_ITEMS,
    FACET_ENTRIES_LIMIT,
    register_global_routes,
)
from service.literature.domain.model import (
    LIBRARY_INVALID,
    MAX_BATCH_RECORDS,
    LiteratureError,
)
from service.literature.persistence import files as literature_files
from service.literature.persistence import store as persistence
from service.literature.persistence.store import (
    LiteratureRepository,
    connect,
    edit_library,
    load_library,
)
from service.literature.schema import (
    PDF_MEDIA_TYPE,
    AttachmentRole,
    DeletedAttachment,
    FulltextStatus,
    LiteratureCollection,
    LiteratureItem,
    LiteratureNote,
    LiteratureView,
)
from service.persistence.project import DatabaseBindingError
from service.platform.activity import Activities
from service.platform.citations import PDF_INDEX_STATE
from service.platform.storage import filesystem_path


class LiteratureStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="literature-store-")
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(root), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = self.content.create_project("事务文献库")
        self.other_project = self.content.create_project("另一个项目")
        self.database = root / "literature.sqlite3"
        repository_init = LiteratureRepository.__init__

        def isolated_repository_init(
            repository: LiteratureRepository,
            database: Path | str = self.database,
        ) -> None:
            repository_init(repository, database)

        repository_patch = patch.object(
            LiteratureRepository,
            "__init__",
            isolated_repository_init,
        )
        repository_patch.start()
        self.addCleanup(repository_patch.stop)
        with closing(connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM literature_items")
            connection.execute("UPDATE literature_collections SET parent_id=NULL")
            connection.execute("DELETE FROM literature_collections")
            connection.execute("DELETE FROM literature_tags")
        self.item = LiteratureItem(
            id="paper",
            title="Research",
            authors="Researcher",
            journal="J",
            year=2026,
            fulltext=FulltextStatus.NONE,
        )

    def seed(self) -> None:
        with edit_library(self.project.id) as edit:
            edit.view = LiteratureView(items=(self.item,))

    def legacy_column_database(self) -> Path:
        database = Path(self.temporary.name) / "legacy-columns.sqlite3"
        with closing(sqlite3.connect(database)) as connection, connection:
            for statement in persistence.DDL:
                if statement.startswith("CREATE TABLE IF NOT EXISTS literature_items("):
                    connection.execute(statement.replace("arxiv TEXT NOT NULL DEFAULT '',", ""))
                    connection.execute(
                        "ALTER TABLE literature_items ADD COLUMN arxiv TEXT NOT NULL DEFAULT ''"
                    )
                elif statement.startswith("CREATE TABLE IF NOT EXISTS literature_collections("):
                    connection.execute(
                        "CREATE TABLE literature_collections(id TEXT PRIMARY KEY,"
                        "name TEXT NOT NULL COLLATE NOCASE UNIQUE,"
                        "parent_id TEXT REFERENCES literature_collections(id) ON DELETE RESTRICT,"
                        "created_at REAL NOT NULL)"
                    )
                    connection.execute(
                        "ALTER TABLE literature_collections ADD COLUMN project_id TEXT"
                    )
                else:
                    connection.execute(statement)
            connection.execute(
                "INSERT INTO literature_items"
                "(id,item_type,bib_type,title,doi,arxiv,isbn,created_at,updated_at) "
                "VALUES('kept','document','misc','Kept','doi-kept','arxiv-kept','isbn-kept',1,2)"
            )
            connection.execute(
                "INSERT INTO literature_collections(id,name,parent_id,created_at,project_id) "
                "VALUES('root','Kept',NULL,1,NULL),('child','Child','root',2,NULL)"
            )
            connection.execute("INSERT INTO literature_collection_items VALUES('child','kept')")
            connection.execute("INSERT INTO literature_projects VALUES('project','kept',1)")
            connection.execute(
                "INSERT INTO literature_notes VALUES('note','kept','kept text',1,'Note',2,3,4)"
            )
            connection.execute(
                "INSERT INTO literature_attachments VALUES"
                "('attachment','kept','Kept.pdf','kept.pdf','revision','pdf','primary',"
                "'application/pdf',1)"
            )
            connection.execute("CREATE INDEX literature_kept_doi ON literature_items(doi)")
        return database

    def test_legacy_column_order_inspection_is_read_only(self) -> None:
        database = self.legacy_column_database()
        with closing(sqlite3.connect(database)) as connection:
            before = tuple(connection.iterdump())
        schema = persistence.inspect_schema(database)
        self.assertTrue(schema.needs_write)
        self.assertEqual(schema.repair_tables, ("literature_items", "literature_collections"))
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_legacy_column_repair_preserves_rows_relations_and_indexes(self) -> None:
        database = self.legacy_column_database()
        with closing(sqlite3.connect(database)) as connection:
            connection.row_factory = sqlite3.Row
            tables = [
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            ]
            before = {
                table: [dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')]
                for table in tables
            }
        with closing(connect(database)) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            for table, rows in before.items():
                self.assertEqual(
                    [dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')], rows
                )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT sql FROM sqlite_master WHERE name='literature_kept_doi'"
                ).fetchone()
            )
            self.assertFalse(persistence.classify_schema(connection).needs_write)
        repository = LiteratureRepository(database)
        self.assertEqual(repository.get("kept").arxiv, "arxiv-kept")
        self.assertEqual(repository.get("kept").isbn, "isbn-kept")
        repository.create_collection("Kept", project_id="another-project")
        with patch.object(
            persistence, "rebuild_table", side_effect=AssertionError("repeat repair")
        ):
            with closing(connect(database)) as connection:
                self.assertFalse(persistence.classify_schema(connection).needs_write)

    def test_legacy_column_repair_failure_rolls_back_every_table(self) -> None:
        database = self.legacy_column_database()
        with closing(sqlite3.connect(database)) as connection:
            before = tuple(connection.iterdump())
        rebuild = persistence.rebuild_table

        def fail_after_repair(connection, table, create):
            rebuild(connection, table, create)
            if table == "literature_collections":
                raise OSError("after real collection repair")

        with patch.object(persistence, "rebuild_table", side_effect=fail_after_repair):
            with self.assertRaisesRegex(OSError, "collection repair"):
                connect(database)
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_unknown_collection_constraint_is_not_repaired(self) -> None:
        database = self.legacy_column_database()
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("DROP TABLE literature_collections")
            connection.execute(
                "CREATE TABLE literature_collections(id TEXT PRIMARY KEY,"
                "name TEXT NOT NULL COLLATE BINARY UNIQUE,"
                "parent_id TEXT REFERENCES literature_collections(id) ON DELETE RESTRICT,"
                "created_at REAL NOT NULL,project_id TEXT)"
            )
            before = tuple(connection.iterdump())
        with self.assertRaises(LiteratureError):
            connect(database)
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_unknown_legacy_index_is_rejected_without_removal(self) -> None:
        for name in (
            "literature_global_collection_names",
            "literature_project_collection_names",
        ):
            for definition in (
                "CREATE UNIQUE INDEX {name} ON external_owner(value)",
                "CREATE INDEX {name} ON literature_collections(name COLLATE NOCASE) WHERE project_id IS NULL",
                "CREATE UNIQUE INDEX {name} ON literature_collections(id)",
                "CREATE UNIQUE INDEX {name} ON literature_collections(name COLLATE BINARY) WHERE project_id IS NULL",
            ):
                with self.subTest(name=name, definition=definition):
                    with closing(sqlite3.connect(self.database)) as connection, connection:
                        connection.execute("CREATE TABLE IF NOT EXISTS external_owner(value TEXT)")
                        connection.execute(definition.format(name=name))
                        before = tuple(connection.iterdump())
                    try:
                        with self.assertRaises(LiteratureError):
                            connect(self.database).close()
                        with closing(sqlite3.connect(self.database)) as connection:
                            self.assertEqual(tuple(connection.iterdump()), before)
                    finally:
                        with closing(sqlite3.connect(self.database)) as connection, connection:
                            connection.execute(f"DROP INDEX IF EXISTS {name}")

    def test_known_legacy_collection_indexes_are_replaced(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "CREATE UNIQUE INDEX literature_global_collection_names ON literature_collections(name COLLATE NOCASE) WHERE project_id IS NULL"
            )
            connection.execute(
                "CREATE UNIQUE INDEX literature_project_collection_names ON literature_collections(project_id,name COLLATE NOCASE) WHERE project_id IS NOT NULL"
            )
            connection.execute(
                "INSERT INTO literature_collections VALUES ('kept','Kept',NULL,NULL,1)"
            )
        with closing(connect(self.database)) as connection:
            names = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='index'")
            }
            self.assertNotIn("literature_global_collection_names", names)
            self.assertNotIn("literature_project_collection_names", names)
            self.assertIn("literature_collection_sibling_names", names)
            self.assertEqual(
                connection.execute(
                    "SELECT name FROM literature_collections WHERE id='kept'"
                ).fetchone()[0],
                "Kept",
            )

    def assert_connection_closed(self, connection: sqlite3.Connection) -> None:
        with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed"):
            connection.execute("SELECT 1")

    def test_owned_connections_close_after_write_read_and_early_return(self) -> None:
        repository = LiteratureRepository(self.database)
        # Strong references make this independent of CPython garbage collection.
        for operation in (
            lambda: repository.save(self.item),
            repository.list,
            repository.view,
            lambda: repository.delete_note("missing", "missing"),
        ):
            connection = connect(self.database)
            self.addCleanup(connection.close)
            with patch("service.literature.persistence.store.connect", return_value=connection):
                operation()
            self.assert_connection_closed(connection)
        self.assertEqual(repository.get(self.item.id).title, self.item.title)

    def test_owned_connection_rolls_back_and_closes_after_business_error(self) -> None:
        repository = LiteratureRepository(self.database)
        connection = connect(self.database)
        self.addCleanup(connection.close)
        save = repository._save

        def fail_after_write(*args):
            save(*args)
            raise ValueError("injected_after_write")

        with patch("service.literature.persistence.store.connect", return_value=connection):
            with patch.object(repository, "_save", side_effect=fail_after_write):
                with self.assertRaisesRegex(ValueError, "injected_after_write"):
                    repository.save(self.item)
        self.assert_connection_closed(connection)
        self.assertIsNone(repository.get(self.item.id))

    def test_owned_connection_closes_when_sqlite_rejects_commit(self) -> None:
        connection = connect(self.database)
        self.addCleanup(connection.close)
        connection.set_authorizer(
            lambda action, argument, *_: (
                sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_TRANSACTION and argument == "COMMIT"
                else sqlite3.SQLITE_OK
            )
        )
        repository = LiteratureRepository(self.database)
        with patch("service.literature.persistence.store.connect", return_value=connection):
            with self.assertRaises(sqlite3.DatabaseError):
                repository.save(self.item)
        self.assert_connection_closed(connection)
        self.assertIsNone(repository.get(self.item.id))

    def test_initialization_failure_closes_connection_without_discarding_data(self) -> None:
        LiteratureRepository(self.database).save(self.item)
        sqlite_connect = sqlite3.connect
        for stage in ("pragma", "_migrate_notes", "_require_final_schema"):
            with self.subTest(stage=stage):
                if stage == "_migrate_notes":
                    with closing(sqlite_connect(self.database)) as setup, setup:
                        setup.execute("DROP INDEX literature_primary_attachment")
                connection = sqlite3.connect(self.database)
                self.addCleanup(connection.close)
                if stage == "pragma":
                    connection.set_authorizer(
                        lambda action, *_: (
                            sqlite3.SQLITE_DENY
                            if action == sqlite3.SQLITE_PRAGMA
                            else sqlite3.SQLITE_OK
                        )
                    )
                    failure = sqlite3.DatabaseError
                    stage_patch = nullcontext()
                else:
                    failure = RuntimeError
                    original = getattr(persistence, stage)

                    def fail_owned(current, connection=connection, original=original):
                        if current is connection:
                            raise RuntimeError("injected_initialization_failure")
                        return original(current)

                    stage_patch = patch(
                        f"service.literature.persistence.store.{stage}",
                        side_effect=fail_owned,
                    )

                def open_connection(database, *args, connection=connection, **kwargs):
                    if database == self.database:
                        return connection
                    return sqlite_connect(database, *args, **kwargs)

                with (
                    patch.object(persistence, "open_database", side_effect=open_connection),
                    stage_patch,
                ):
                    with self.assertRaises(failure):
                        connect(self.database)
                self.assert_connection_closed(connection)
                self.assertEqual(
                    LiteratureRepository(self.database).get(self.item.id).title, self.item.title
                )

    def test_borrowed_connection_remains_owned_by_caller(self) -> None:
        repository = LiteratureRepository(self.database)
        with closing(connect(self.database)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            repository.save(self.item, connection=connection)
            self.assertEqual(repository.view(connection=connection).items[0].id, self.item.id)
            self.assertTrue(connection.in_transaction)
            connection.rollback()
            self.assertEqual(connection.execute("SELECT 1").fetchone()[0], 1)
        self.assertIsNone(repository.get(self.item.id))

    def test_empty_read_initializes_one_user_level_database(self) -> None:
        self.assertEqual(load_library(self.project.id), LiteratureView())
        self.assertTrue(self.database.is_file())

    def test_fresh_database_creates_the_complete_schema(self) -> None:
        database = Path(self.temporary.name) / "fresh.sqlite3"
        with closing(connect(database)) as connection, connection:
            item_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(literature_items)")
            }
            collection_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(literature_collections)")
            }
            attachment_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(literature_attachments)")
            }
            note_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(literature_notes)")
            }
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master")}

        self.assertIn("arxiv", item_columns)
        self.assertNotIn("pdf_asset_id", item_columns)
        self.assertNotIn("pdf_path", item_columns)
        self.assertIn("project_id", collection_columns)
        self.assertEqual(
            attachment_columns,
            {
                "id",
                "literature_id",
                "name",
                "path",
                "revision",
                "kind",
                "role",
                "media_type",
                "created_at",
            },
        )
        self.assertEqual(
            note_columns,
            {
                "id",
                "literature_id",
                "text",
                "created_at",
                "title",
                "updated_at",
                "version",
                "position",
            },
        )
        self.assertNotIn("literature_marks", tables)
        self.assertNotIn("literature_reading_records", tables)

    def test_rebuilt_database_can_be_reopened_without_project_attachment_links(self) -> None:
        repository = LiteratureRepository(self.database)
        repository.save_all((self.item,))

        with closing(connect(self.database)) as connection, connection:
            attachment_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(literature_attachments)")
            }

        self.assertIn("revision", attachment_columns)
        self.assertNotIn("project_id", attachment_columns)
        self.assertEqual(repository.get(self.item.id).title, self.item.title)

    def test_attachment_schema_requires_revision_without_discarding_items(self) -> None:
        repository = LiteratureRepository(self.database)
        repository.save_all((self.item,))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("ALTER TABLE literature_attachments DROP COLUMN revision")

        with self.assertRaisesRegex(LiteratureError, LIBRARY_INVALID):
            connect(self.database)

        with closing(sqlite3.connect(self.database)) as connection, connection:
            stored = connection.execute(
                "SELECT title FROM literature_items WHERE id=?", (self.item.id,)
            ).fetchone()
        self.assertEqual(stored, (self.item.title,))

    def test_attachment_deletion_is_confined_to_the_managed_file_root(self) -> None:
        root = Path(self.temporary.name) / "files"
        root.mkdir()
        managed = root / "paper.pdf"
        managed.write_bytes(b"pdf")
        outside = Path(self.temporary.name) / "outside.pdf"
        outside.write_bytes(b"outside")

        with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", root):
            # 托管目录之外的路径归 Content 域管, 已经不存在的文件说明清理发生过:
            # 两种都安静跳过, 不能让一次删除因为别人家的文件而失败。
            literature_files.delete_attachments(
                (
                    str(managed),
                    str(outside),
                    str(root / "already-gone.pdf"),
                )
            )

        self.assertFalse(managed.exists())
        self.assertTrue(outside.exists())

    def test_each_item_owns_its_own_copy_of_identical_bytes(self) -> None:
        """同一份字节被两条文献导入 = 两个文件, 删一条绝不动另一条。

        独占命名取代了内容寻址共享, 于是删除路径上不再需要任何跨条目的引用计数:
        行里带着自己的 path 与 revision, 文件与全文索引各自收口。
        """
        root = Path(self.temporary.name) / "files"
        root.mkdir()
        payload = b"%PDF-1.4 identical bytes"
        revision = f"sha256:{sha256(payload).hexdigest()}"
        repository = LiteratureRepository()
        repository.save_all((replace(self.item, id="paper-a"), replace(self.item, id="paper-b")))
        stored: dict[str, str] = {}
        for literature_id in ("paper-a", "paper-b"):
            published = literature_files.managed_object(literature_id, payload, ".pdf")
            (root / published.name).write_bytes(payload)
            stored[literature_id] = str(root / published.name)
            repository.add_attachment(
                literature_id,
                "paper.pdf",
                stored[literature_id],
                kind="pdf",
                revision=published.revision,
                role=AttachmentRole.PRIMARY,
                media_type=PDF_MEDIA_TYPE,
            )

        self.assertNotEqual(stored["paper-a"], stored["paper-b"])
        with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", root):
            files = repository.attachment_files("paper-a")
            self.assertEqual(files, ((stored["paper-a"], revision),))
            repository.delete("paper-a", True)
            literature_files.delete_attachments(tuple(path for path, _revision in files))
            self.assertFalse(Path(stored["paper-a"]).exists())
            self.assertTrue(Path(stored["paper-b"]).exists())
            self.assertEqual(
                repository.attachment_files("paper-b"), ((stored["paper-b"], revision),)
            )

    def test_deleting_the_primary_attachment_converges_the_item_state(self) -> None:
        """The primary attachment *is* the item's full text; losing it must show.

        Leaving ``fulltext`` at its old value keeps the without-fulltext count and
        every fulltext filter lying about an item that no longer has readable
        bytes, and the next metadata save re-persists the stale value on top of
        the deletion. A supplementary attachment feeds no such state.
        """
        repository = LiteratureRepository()
        repository.save(replace(self.item, fulltext=FulltextStatus.READY), self.project.id)
        primary = repository.add_attachment(
            self.item.id,
            "paper.pdf",
            str(Path(self.temporary.name) / "paper.pdf"),
            kind="pdf",
            revision="sha256:paper",
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )
        supplementary = repository.add_attachment(
            self.item.id,
            "slides.pdf",
            str(Path(self.temporary.name) / "slides.pdf"),
            kind="pdf",
            revision="sha256:slides",
            role=AttachmentRole.SUPPLEMENTARY,
            media_type=PDF_MEDIA_TYPE,
        )

        deleted = repository.delete_attachment(self.item.id, supplementary["id"])
        self.assertEqual(
            deleted,
            DeletedAttachment(
                literature_id=self.item.id,
                attachment_id=supplementary["id"],
                path=str(Path(self.temporary.name) / "slides.pdf"),
                revision="sha256:slides",
                role=AttachmentRole.SUPPLEMENTARY,
            ),
        )
        self.assertEqual(repository.get(self.item.id).fulltext, FulltextStatus.READY)

        deleted = repository.delete_attachment(self.item.id, primary["id"])
        self.assertEqual(deleted.role, AttachmentRole.PRIMARY)
        self.assertEqual(deleted.attachment_id, primary["id"])
        self.assertEqual(repository.get(self.item.id).fulltext, FulltextStatus.NONE)
        self.assertEqual(repository.attachments(self.item.id), [])
        # 已删的行再删一次必须报“没有这条”, 不能返回一个空壳让调用方去删文件。
        self.assertIsNone(repository.delete_attachment(self.item.id, primary["id"]))

    def test_managed_attachment_names_belong_to_exactly_one_item(self) -> None:
        """落盘名带着属主、内容摘要与写入唯一量, 因此两条附件不可能共用一个文件。

        同一批字节写两次得到两个不同的名字 (uuid 段), 而 revision 仍是这批字节的
        sha256 —— 它是全文索引缓存的键, 由附件行保存, 不再靠文件名反推。
        """
        root = Path(self.temporary.name) / "files"
        root.mkdir()
        payload = b"%PDF-1.4 owned"
        first = literature_files.managed_object("paper-a", payload, ".pdf")
        second = literature_files.managed_object("paper-a", payload, ".pdf")
        other = literature_files.managed_object("paper-b", payload, ".pdf")

        self.assertEqual(first.revision, f"sha256:{sha256(payload).hexdigest()}")
        self.assertEqual(first.revision, second.revision)
        self.assertNotEqual(first.name, second.name)
        self.assertNotEqual(first.name, other.name)
        self.assertTrue(first.name.startswith("paper-a-"))
        self.assertTrue(other.name.startswith("paper-b-"))
        self.assertEqual(Path(first.name).suffix, ".pdf")
        self.assertIn(f"-{md5(payload, usedforsecurity=False).hexdigest()}-", first.name)
        self.assertEqual(len(Path(first.name).stem.rsplit("-", 1)[1]), 32)
        # 托管目录只接受扁平文件名, 属主 id 不能变成一次目录穿越。
        with self.assertRaises(ValueError):
            literature_files.managed_object("../escape", payload, ".pdf")

        managed = root / first.name
        outside = Path(self.temporary.name) / "elsewhere" / f"{sha256(payload).hexdigest()}.pdf"
        with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", root):
            # 托管文件才由文献库负责 stat; 别处的位置归 Content 域自己报错。
            self.assertFalse(literature_files.is_available_attachment(str(managed)))
            managed.write_bytes(payload)
            self.assertTrue(literature_files.is_available_attachment(str(managed)))
            self.assertFalse(literature_files.is_available_attachment(str(root / "gone.pdf")))
            self.assertTrue(literature_files.is_available_attachment(str(outside)))
            self.assertTrue(literature_files.is_available_attachment(""))

    def test_managed_owner_tokens_are_portable_bounded_and_collision_resistant(self) -> None:
        payload = b"%PDF-1.4 portable"
        identities = (
            "arxiv:2609.10657v1",
            "arxiv_2609.10657v1",
            "paper<identifier>?*",
            "文献" * 100,
            "owner" * 100,
        )
        root = Path(self.temporary.name) / "files"
        root.mkdir()
        owners = set()
        for identity in identities:
            with self.subTest(identity=identity):
                managed = literature_files.managed_object(identity, payload, ".pdf")
                owner = managed.name.split("-", 1)[0]
                self.assertEqual(owner, sha256(identity.encode("utf-8")).hexdigest())
                self.assertNotIn(owner, owners)
                owners.add(owner)
                with literature_files.LiteratureFileBatch(root) as batch:
                    batch.stage(managed.name, payload)
                    batch.commit_operation(lambda: None)
                with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", root):
                    self.assertEqual(
                        literature_files.read_attachment(str(root / managed.name)), payload
                    )
        for identity in ("../escape", "..\\escape", "", ".", "..", "owner\x00name"):
            with self.subTest(identity=identity), self.assertRaises(ValueError):
                literature_files.managed_object(identity, payload, ".pdf")

    def test_batch_long_paths_preserve_public_identity_commit_and_rollback(self) -> None:
        payload = b"%PDF-1.4 long path"
        root = Path(self.temporary.name) / ("nested-" * 10) / ("nested-" * 10) / "files"
        filesystem_path(root).mkdir(parents=True)
        name = literature_files.managed_object("arxiv:2609.10657v1", payload, ".pdf").name
        destination = root / name
        self.assertGreater(len(str(destination)), 314)
        try:
            with literature_files.LiteratureFileBatch(root) as batch:
                self.assertEqual(batch.stage(name, payload), str(destination))
                self.assertEqual(batch.commit_operation(lambda: "committed"), "committed")
            with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", root):
                self.assertEqual(literature_files.read_attachment(str(destination)), payload)
                self.assertTrue(literature_files.is_available_attachment(str(destination)))
                self.assertEqual(literature_files.attachment_size(str(destination)), len(payload))
                literature_files.delete_attachments((str(destination),))
            with self.assertRaisesRegex(RuntimeError, "catalogue failure"):
                with literature_files.LiteratureFileBatch(root) as batch:
                    batch.stage(name, payload)
                    batch.commit_operation(lambda: self.fail_catalogue())
            self.assertEqual(list(filesystem_path(root).iterdir()), [])
            with self.assertRaisesRegex(RuntimeError, "before commit"):
                with literature_files.LiteratureFileBatch(root) as batch:
                    batch.stage(name, payload)
                    raise RuntimeError("before commit")
            self.assertEqual(list(filesystem_path(root).iterdir()), [])
        finally:
            shutil.rmtree(filesystem_path(root.parent.parent))

    @staticmethod
    def fail_catalogue() -> None:
        raise RuntimeError("catalogue failure")

    def test_attachment_size_reports_the_on_disk_bytes_of_managed_files(self) -> None:
        """The row carries no size column, so the projection stats the real file.

        A missing or foreign location must report None instead of a guessed
        zero, or the attachment tab would display a size for bytes that are
        not there.
        """
        root = Path(self.temporary.name) / "files"
        root.mkdir()
        payload = b"%PDF-1.4 sized"
        published = literature_files.managed_object(self.item.id, payload, ".pdf")
        managed = root / published.name
        outside = Path(self.temporary.name) / "outside.pdf"
        outside.write_bytes(b"outside")

        with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", root):
            self.assertIsNone(literature_files.attachment_size(str(managed)))
            managed.write_bytes(payload)
            self.assertEqual(literature_files.attachment_size(str(managed)), len(payload))
            self.assertIsNone(literature_files.attachment_size(str(root / "gone.pdf")))
            self.assertIsNone(literature_files.attachment_size(str(outside)))
            self.assertIsNone(literature_files.attachment_size(""))

    def test_attachment_delete_api_unlinks_file_index_and_fulltext_state(self) -> None:
        """One DELETE must leave nothing behind that still claims the paper exists.

        The row, its annotation records, the item's full-text state, the physical
        file and the cached full-text index derived from it all have to converge
        in one call; any survivor keeps the UI showing a PDF that cannot open.
        """
        root = Path(self.temporary.name) / "files"
        root.mkdir()
        payload = b"%PDF-1.4 delete me"
        published = literature_files.managed_object(self.item.id, payload, ".pdf")
        stored = root / published.name
        stored.write_bytes(payload)
        vanished = literature_files.managed_object(self.item.id, b"%PDF-vanished", ".pdf")
        repository = LiteratureRepository()
        repository.save(replace(self.item, fulltext=FulltextStatus.READY))
        attachment = repository.add_attachment(
            self.item.id,
            "paper.pdf",
            str(stored),
            kind="pdf",
            revision=published.revision,
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )
        dangling = repository.add_attachment(
            self.item.id,
            "gone.pdf",
            str(root / vanished.name),
            kind="pdf",
            revision=vanished.revision,
            role=AttachmentRole.SUPPLEMENTARY,
            media_type=PDF_MEDIA_TYPE,
        )
        app = FastAPI()
        app.state.content = self.content
        indexes = Mock()
        setattr(app.state, PDF_INDEX_STATE, indexes)
        register_global_routes(app)
        client = TestClient(app)

        with (
            patch("service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR", root),
            patch("service.literature.persistence.files.SERVICE_LITERATURE_FILES_DIR", root),
        ):
            # 行还在但字节已经没了的附件, 必须投影成 missing 而不是 available。
            before = client.get(f"/api/v1/literatures/{self.item.id}").json()
            self.assertEqual(
                {entry["id"]: entry["availability"] for entry in before["attachments"]},
                {attachment["id"]: "available", dangling["id"]: "missing"},
            )
            self.assertEqual(before["primary_attachment"]["availability"], "available")

            response = client.delete(
                f"/api/v1/literatures/{self.item.id}/attachments/{attachment['id']}"
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(stored.exists())
            indexes.forget_literature.assert_called_once_with(
                (f"sha256:{sha256(payload).hexdigest()}",)
            )

            after = client.get(f"/api/v1/literatures/{self.item.id}").json()
            self.assertIsNone(after["primary_attachment"])
            self.assertEqual(after["attachment_count"], 1)
            self.assertEqual(client.get("/api/v1/literatures/counts").json()["without_fulltext"], 1)
            missing = client.delete(
                f"/api/v1/literatures/{self.item.id}/attachments/{attachment['id']}"
            )
            self.assertEqual(missing.status_code, 404)

    def test_project_projections_share_items_without_copying_metadata(self) -> None:
        self.seed()
        repository = LiteratureRepository()
        repository.save(self.item, self.other_project.id)
        self.assertEqual(load_library(self.project.id).items[0].id, self.item.id)
        self.assertEqual(load_library(self.other_project.id).items[0].id, self.item.id)
        self.assertEqual(load_library().items[0].id, self.item.id)
        self.assertEqual(
            repository.projects(self.item.id),
            tuple(sorted((self.project.id, self.other_project.id))),
        )

    def test_external_import_links_project_with_or_without_collections(self) -> None:
        repository = LiteratureRepository()
        without_tree = replace(self.item, id="zotero-without-tree")
        with_tree = replace(self.item, id="zotero-with-tree")

        repository.save_external_tree((without_tree,), (), (), project_id=self.project.id)
        repository.save_external_tree(
            (with_tree,),
            (("source-folder", "Folder", None),),
            (("source-folder", with_tree.id),),
            project_id=self.project.id,
        )

        self.assertEqual(
            {item.id for item in repository.list(project_id=self.project.id)},
            {without_tree.id, with_tree.id},
        )
        self.assertEqual(
            repository.list(
                project_id=self.project.id,
                collection_ids=(f"zotero:{self.project.id}:source-folder",),
            )[0].id,
            with_tree.id,
        )

    def test_unorganized_sidebar_excludes_every_project_and_collection(self) -> None:
        repository = LiteratureRepository()
        repository.save(replace(self.item, id="loose"))
        repository.save(
            replace(self.item, id="global", collection="Reading", collections=("Reading",))
        )
        repository.save(replace(self.item, id="project-only"), self.project.id)
        repository.save(
            replace(
                self.item, id="project-classified", collection="Methods", collections=("Methods",)
            ),
            self.project.id,
        )
        repository.save(
            replace(self.item, id="both", collection="Reading", collections=("Reading",))
        )
        repository.save(replace(self.item, id="both"), self.project.id)

        filters = {"without_collection": True, "without_project": True}
        self.assertEqual([item.id for item in repository.list(**filters)], ["loose"])
        self.assertEqual(repository.filtered_total(**filters), 1)
        # Existing collection-only consumers keep their original filter semantics.
        self.assertEqual(
            {item.id for item in repository.list(without_collection=True)},
            {"loose", "project-only", "project-classified"},
        )
        self.assertEqual(
            {
                item.id
                for item in repository.list(project_id=self.project.id, without_collection=True)
            },
            {"project-only", "both"},
        )

        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        result = client.get("/api/v1/literatures", params=filters)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual([item["id"] for item in result.json()["items"]], ["loose"])
        self.assertEqual(result.json()["total"], 1)
        self.assertEqual(client.get("/api/v1/literatures/counts").json()["without_collection"], 1)
        self.assertEqual(
            client.get("/api/v1/literatures/counts", params={"project_id": self.project.id}).json()[
                "without_collection"
            ],
            2,
        )

    def test_list_search_matches_publication_year(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)

        self.assertEqual(
            [item.id for item in repository.list(q=str(self.item.year))],
            [self.item.id],
        )
        self.assertEqual(repository.filtered_total(q=str(self.item.year)), 1)

    def test_attachment_sort_groups_by_presence_and_keeps_the_original_order(self) -> None:
        """曲别针列排序：有附件的整组提前，组内仍是列表原始序。

        附件只有「有 / 没有」两个值，若沿用全局 id 兜底键，组内顺序会被 id 重排，
        与用户在未排序列表里看到的顺序不一致；因此次级键必须复用原始序。
        """

        root = Path(self.temporary.name) / "attachments"
        root.mkdir()
        repository = LiteratureRepository()
        # 原始序（created_at 倒序）：newest → newer → middle → oldest。
        for index, identifier in enumerate(("oldest", "middle", "newer", "newest")):
            repository.save(replace(self.item, id=identifier, added_at=1_000.0 + index))
        for identifier in ("newest", "middle"):
            payload = f"%PDF-1.4 {identifier}".encode()
            (root / f"{identifier}.pdf").write_bytes(payload)
            repository.add_attachment(
                identifier,
                "paper.pdf",
                str(root / f"{identifier}.pdf"),
                kind="pdf",
                revision=f"sha256:{sha256(payload).hexdigest()}",
                role=AttachmentRole.PRIMARY,
                media_type=PDF_MEDIA_TYPE,
            )

        self.assertEqual(
            [item.id for item in repository.list()],
            ["newest", "newer", "middle", "oldest"],
        )
        self.assertEqual(
            [item.id for item in repository.list(sort="attachment", order="asc")],
            ["newest", "middle", "newer", "oldest"],
        )
        # 方向只翻转附件这一级，组内原始序不变。
        self.assertEqual(
            [item.id for item in repository.list(sort="attachment", order="desc")],
            ["newer", "oldest", "newest", "middle"],
        )

        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        result = client.get("/api/v1/literatures", params={"sort": "attachment", "order": "asc"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(
            [item["id"] for item in result.json()["items"]],
            ["newest", "middle", "newer", "oldest"],
        )

    def test_nested_records_and_organization_round_trip_losslessly(self) -> None:
        item = replace(
            self.item,
            tags=("important",),
            collection="Reading",
            collections=("Reading",),
            notes=(
                LiteratureNote(
                    "note",
                    "Keep",
                    1.0,
                    title="Methods",
                    updated_at=2.0,
                    version=3,
                    position=1,
                ),
            ),
        )
        with edit_library(self.project.id) as edit:
            edit.view = LiteratureView(
                items=(item,),
                collections=(LiteratureCollection("Reading", 0),),
            )
        stored = load_library(self.project.id).items[0]
        self.assertEqual(stored.tags, item.tags)
        self.assertEqual(stored.collections, item.collections)
        self.assertEqual(stored.notes, item.notes)
        attachment = LiteratureRepository().add_attachment(
            item.id,
            "paper.pdf",
            "paper.pdf",
            kind="pdf",
            revision="sha256:paper",
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )
        self.assertEqual(LiteratureRepository().primary_attachment(item.id).id, attachment["id"])

    def test_invalid_duplicate_view_rolls_back(self) -> None:
        self.seed()
        with self.assertRaises(LiteratureError) as caught:
            with edit_library(self.project.id) as edit:
                edit.view = LiteratureView(items=(self.item, self.item))
        self.assertEqual(caught.exception.code, LIBRARY_INVALID)
        self.assertEqual(load_library(self.project.id).items[0].id, self.item.id)

    def test_failed_mutation_rolls_back(self) -> None:
        self.seed()
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            with edit_library(self.project.id) as edit:
                edit.view = LiteratureView()
                raise RuntimeError("interrupted")
        self.assertEqual(load_library(self.project.id).items[0].id, self.item.id)

    def test_concurrent_note_creates_receive_distinct_default_titles(self) -> None:
        self.seed()
        barrier = Barrier(2)

        def add_note(identity: str) -> None:
            barrier.wait(timeout=5)
            LiteratureRepository().create_note(self.item.id, identity)

        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(add_note, ("first", "second")))
        notes = load_library(self.project.id).items[0].notes
        self.assertEqual({note.text for note in notes}, {"first", "second"})
        self.assertEqual({note.title for note in notes}, {"笔记 1", "笔记 2"})

    def test_note_update_is_in_place_and_metadata_save_preserves_it(self) -> None:
        self.seed()
        repository = LiteratureRepository()
        created = repository.create_note(self.item.id, "draft")
        updated = repository.update_note(
            self.item.id,
            created.id,
            title="Methods",
            text="final body",
            expected_version=created.version,
        )
        repository.update(self.item.id, {"title": "Renamed paper"})

        stored = repository.get(self.item.id)
        assert stored is not None
        self.assertEqual(stored.notes[0].id, created.id)
        self.assertEqual(stored.notes[0].title, "Methods")
        self.assertEqual(stored.notes[0].text, "final body")
        self.assertEqual(stored.notes[0].version, updated.version)

    def test_structured_note_api_supports_create_update_list_and_delete(self) -> None:
        self.seed()
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)

        empty = client.post(f"/api/v1/literatures/{self.item.id}/notes", json={"text": " "})
        self.assertEqual(empty.status_code, 422)
        self.assertEqual(empty.json()["detail"]["code"], "literature_note_body_required")

        created = client.post(
            f"/api/v1/literatures/{self.item.id}/notes",
            json={"title": "", "text": "# Draft"},
        )
        self.assertEqual(created.status_code, 201, created.text)
        note = created.json()
        self.assertEqual(note["title"], "笔记 1")
        self.assertEqual(note["version"], 1)

        updated = client.patch(
            f"/api/v1/literatures/{self.item.id}/notes/{note['id']}",
            json={"title": "Renamed", "text": "# Final", "version": note["version"]},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["id"], note["id"])
        self.assertEqual(updated.json()["title"], "Renamed")

        conflict = client.patch(
            f"/api/v1/literatures/{self.item.id}/notes/{note['id']}",
            json={"title": "Stale", "text": "old", "version": note["version"]},
        )
        self.assertEqual(conflict.status_code, 409)
        listed = client.get(f"/api/v1/literatures/{self.item.id}/notes")
        self.assertEqual(listed.json()["items"], [updated.json()])

        deleted = client.delete(f"/api/v1/literatures/{self.item.id}/notes/{note['id']}")
        self.assertEqual(deleted.status_code, 200)
        missing = client.delete(f"/api/v1/literatures/{self.item.id}/notes/{note['id']}")
        self.assertEqual(missing.status_code, 404)

    def legacy_notes_database(self):
        database = Path(self.temporary.name) / "atomic-notes.sqlite3"
        with closing(connect(database)) as connection, connection:
            connection.execute(
                "INSERT INTO literature_items(id,item_type,bib_type,title,created_at,updated_at) VALUES('legacy','document','misc','Legacy',1,1)"
            )
            connection.execute("DROP TABLE literature_notes")
            connection.execute(
                "CREATE TABLE literature_notes(id TEXT,literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,text TEXT NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(literature_id,id))"
            )
            connection.execute("INSERT INTO literature_notes VALUES('note','legacy','kept text',1)")
            connection.execute("DROP INDEX literature_primary_attachment")
        return database

    def test_schema_inspection_missing_database_does_not_create_parent(self):
        database = Path(self.temporary.name) / "absent" / "literature.sqlite3"
        schema = persistence.inspect_schema(database)
        self.assertTrue(schema.needs_write)
        self.assertEqual(len(schema.create_tables), 8)
        self.assertFalse(database.parent.exists())

    def test_current_schema_connection_does_not_begin_initialization(self):
        self.assertFalse(persistence.inspect_schema(self.database).needs_write)
        with patch.object(persistence, "schema_transaction", side_effect=AssertionError("write")):
            with closing(connect(self.database)) as connection:
                self.assertFalse(connection.in_transaction)

    def test_runtime_schema_check_allows_sqlite_sidecar_rotation(self):
        for strict in (False, True):
            with self.subTest(strict=strict):
                keeper = sqlite3.connect(self.database)
                self.addCleanup(keeper.close)
                keeper.execute("SELECT * FROM literature_items").fetchall()
                original_reader = persistence.reader

                @contextmanager
                def rotate_after_close(path, original_reader=original_reader):
                    nonlocal keeper
                    with original_reader(path) as connection:
                        yield connection
                    keeper.close()
                    keeper = sqlite3.connect(self.database)
                    self.addCleanup(keeper.close)
                    keeper.execute("SELECT * FROM literature_items").fetchall()

                try:
                    with patch.object(persistence, "reader", rotate_after_close):
                        if strict:
                            with self.assertRaises(DatabaseBindingError):
                                persistence.inspect_schema(self.database)
                        else:
                            with closing(connect(self.database)) as connection:
                                self.assertFalse(connection.in_transaction)
                finally:
                    keeper.close()

    def test_schema_checks_reject_main_database_replacement(self):
        for strict in (False, True):
            with self.subTest(strict=strict):
                replacement = self.database.with_name("replacement.sqlite3")
                replacement.write_bytes(self.database.read_bytes())
                original_reader = persistence.reader

                @contextmanager
                def replace_after_close(
                    path, original_reader=original_reader, replacement=replacement
                ):
                    with original_reader(path) as connection:
                        yield connection
                    replacement.replace(self.database)

                with patch.object(persistence, "reader", replace_after_close):
                    with self.assertRaises(DatabaseBindingError):
                        if strict:
                            persistence.inspect_schema(self.database)
                        else:
                            connect(self.database).close()

    def test_runtime_rechecks_a_concurrently_created_database(self):
        for strict in (False, True):
            for future in (False, True):
                with self.subTest(strict=strict, future=future):
                    database = self.database.with_name(f"created-{strict}-{future}.sqlite3")
                    classify = persistence.classify_schema
                    published = False

                    def publish(connection, database=database, future=future, classify=classify):
                        nonlocal published
                        schema = classify(connection)
                        if not published:
                            published = True
                            with closing(connect(database)) as creator, creator:
                                if future:
                                    creator.execute(
                                        "ALTER TABLE literature_items ADD COLUMN future TEXT"
                                    )
                        return schema

                    with patch.object(persistence, "classify_schema", side_effect=publish):
                        if strict:
                            with self.assertRaises(DatabaseBindingError):
                                persistence.inspect_schema(database)
                        elif future:
                            with self.assertRaises(LiteratureError):
                                connect(database).close()
                        else:
                            with closing(connect(database)) as connection:
                                self.assertFalse(classify(connection).needs_write)
                    self.assertTrue(published)

    def test_unknown_columns_and_constraints_preserve_database(self):
        statements = (
            "ALTER TABLE literature_items ADD COLUMN future TEXT",
            "ALTER TABLE literature_items ADD COLUMN generated TEXT GENERATED ALWAYS AS (title) VIRTUAL",
            "DROP TABLE literature_notes; CREATE TABLE literature_notes(id TEXT,literature_id TEXT,text TEXT NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(literature_id,id))",
        )
        for position, statement in enumerate(statements):
            with self.subTest(statement=statement):
                database = Path(self.temporary.name) / f"unknown-{position}.sqlite3"
                connect(database).close()
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.executescript(statement)
                    before = tuple(connection.iterdump())
                with self.assertRaises(LiteratureError):
                    connect(database).close()
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_owned_column_order_is_repaired_before_positional_writes(self) -> None:
        database = self.legacy_column_database()
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("DROP TABLE literature_projects")
            connection.execute(
                "CREATE TABLE literature_projects("
                "literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,"
                "project_id TEXT,created_at REAL NOT NULL,PRIMARY KEY(project_id,literature_id))"
            )
            connection.execute("INSERT INTO literature_projects VALUES('kept','project',1)")
        with closing(connect(database)) as connection, connection:
            connection.execute("INSERT INTO literature_projects VALUES('next','kept',2)")
            self.assertEqual(
                [
                    tuple(row)
                    for row in connection.execute(
                        "SELECT project_id,literature_id,created_at FROM literature_projects ORDER BY created_at"
                    )
                ],
                [("project", "kept", 1.0), ("next", "kept", 2.0)],
            )

    def test_owned_index_wrong_definition_is_rejected(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DROP INDEX literature_primary_attachment")
            connection.execute(
                "CREATE INDEX literature_primary_attachment ON literature_attachments(literature_id)"
            )
            before = tuple(connection.iterdump())
        with self.assertRaises(LiteratureError):
            connect(self.database).close()
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_schema_inspection_observes_committed_wal(self):
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("ALTER TABLE literature_items ADD COLUMN future TEXT")
            writer.commit()
            self.assertGreater(Path(str(self.database) + "-wal").stat().st_size, 0)
            with self.assertRaises(LiteratureError):
                persistence.inspect_schema(self.database)

    def test_note_initialization_preserves_external_dependencies(self):
        database = self.legacy_notes_database()
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute(
                "CREATE TABLE external_owner(value TEXT REFERENCES literature_items(id))"
            )
            connection.execute("INSERT INTO external_owner VALUES('legacy')")
            connection.execute("CREATE INDEX external_index ON literature_notes(text)")
            connection.execute(
                "CREATE TRIGGER external_trigger AFTER UPDATE ON literature_notes BEGIN SELECT 1; END"
            )
            before = connection.execute(
                "SELECT name,sql FROM sqlite_master WHERE name LIKE 'external_%' ORDER BY name"
            ).fetchall()
        connect(database).close()
        self.assertFalse(persistence.inspect_schema(database).needs_write)
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT name,sql FROM sqlite_master WHERE name LIKE 'external_%' ORDER BY name"
                ).fetchall(),
                before,
            )
            self.assertEqual(
                connection.execute("SELECT value FROM external_owner").fetchall(), [("legacy",)]
            )

    def test_fresh_initialization_failure_leaves_no_partial_tables(self):
        database = Path(self.temporary.name) / "failed-fresh.sqlite3"
        with patch.object(persistence, "_migrate_notes", side_effect=OSError("after tables")):
            with self.assertRaisesRegex(OSError, "after tables"):
                connect(database)
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master").fetchall(), [])
        with closing(connect(database)) as connection:
            self.assertFalse(connection.in_transaction)
            self.assertIsNotNone(
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE name='literature_notes'"
                ).fetchone()
            )

    def test_legacy_initialization_returns_committed_connection(self):
        database = self.legacy_notes_database()
        with closing(connect(database)) as connection:
            self.assertFalse(connection.in_transaction)
            connection.execute("BEGIN IMMEDIATE")
            connection.rollback()
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT text,title,updated_at,version,position FROM literature_notes"
                ).fetchall(),
                [("kept text", "笔记 1", 1.0, 1, 1)],
            )

    def test_legacy_initialization_failure_rolls_back_ddl_and_backfill(self):
        database = self.legacy_notes_database()
        with closing(sqlite3.connect(database)) as connection:
            before = tuple(connection.iterdump())
        migrate = persistence._migrate_notes

        def fail_after_backfill(connection):
            migrate(connection)
            self.assertEqual(
                connection.execute("SELECT title FROM literature_notes").fetchone()[0], "笔记 1"
            )
            raise OSError("after real note backfill")

        with patch.object(persistence, "_migrate_notes", side_effect=fail_after_backfill):
            with self.assertRaisesRegex(OSError, "note backfill"):
                connect(database)
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_legacy_notes_are_backfilled_without_rebuilding_rows(self) -> None:
        database = Path(self.temporary.name) / "legacy-notes.sqlite3"
        with closing(connect(database)) as connection, connection:
            connection.execute(
                "INSERT INTO literature_items"
                "(id,item_type,bib_type,title,authors,publication,fulltext,created_at,updated_at) "
                "VALUES('legacy','document','misc','Legacy','','','none',1,1)"
            )
            connection.execute("DROP TABLE literature_notes")
            connection.execute(
                "CREATE TABLE literature_notes("
                "id TEXT,literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,"
                "text TEXT NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(literature_id,id))"
            )
            connection.executemany(
                "INSERT INTO literature_notes VALUES(?,?,?,?)",
                (("a", "legacy", "first", 1.0), ("b", "legacy", "second", 2.0)),
            )

        repository = LiteratureRepository(database)
        stored = repository.get("legacy")
        assert stored is not None
        self.assertEqual([note.id for note in stored.notes], ["a", "b"])
        self.assertEqual([note.text for note in stored.notes], ["first", "second"])
        self.assertEqual([note.title for note in stored.notes], ["笔记 1", "笔记 2"])

    def test_unlinking_one_project_preserves_global_item_and_other_link(self) -> None:
        classified = replace(self.item, collection="Shared", collections=("Shared",))
        with edit_library(self.project.id) as edit:
            edit.view = LiteratureView(
                items=(classified,),
                collections=(LiteratureCollection("Shared", 0),),
            )
        repository = LiteratureRepository()
        repository.save(classified, self.other_project.id)
        with edit_library(self.project.id) as edit:
            edit.view = LiteratureView()
        self.assertEqual(load_library(self.project.id).items, ())
        self.assertEqual(load_library(self.other_project.id).items[0].id, self.item.id)
        self.assertEqual(load_library().items[0].id, self.item.id)
        self.assertEqual(load_library().items[0].collections, ())
        self.assertEqual(load_library(self.other_project.id).items[0].collections, ("Shared",))
        self.assertEqual(
            tuple(collection.name for collection in load_library().collections),
            (),
        )

    def test_project_collections_are_scoped_and_can_share_names(self) -> None:
        repository = LiteratureRepository()
        first = repository.create_collection("Methods", project_id=self.project.id)
        second = repository.create_collection("Methods", project_id=self.other_project.id)
        child = repository.create_collection(
            "Neural", parent_id=first["id"], project_id=self.project.id
        )

        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(child["parent_id"], first["id"])
        self.assertEqual(
            {entry["name"] for entry in repository.collections(self.project.id)},
            {"Methods", "Neural"},
        )
        self.assertEqual(
            {entry["name"] for entry in repository.collections(self.other_project.id)},
            {"Methods"},
        )
        with self.assertRaises(LiteratureError):
            repository.create_collection(
                "Invalid", parent_id=first["id"], project_id=self.other_project.id
            )

    def test_deleting_parent_collection_cascades_tree_without_deleting_literature(self) -> None:
        repository = LiteratureRepository()
        parent = repository.create_collection("Parent", project_id=self.project.id)
        child = repository.create_collection(
            "Child", parent_id=parent["id"], project_id=self.project.id
        )
        repository.create_collection(
            "Grandchild", parent_id=child["id"], project_id=self.project.id
        )
        repository.save(
            replace(self.item, collection="Child", collections=("Child",)),
            self.project.id,
        )

        result = repository.delete_collection(parent["id"], self.project.id)

        self.assertEqual(result, {"collections": 3, "memberships": 1})
        self.assertEqual(repository.collections(self.project.id), [])
        self.assertEqual(repository.get(self.item.id).id, self.item.id)
        self.assertEqual(repository.view(self.project.id).items[0].collections, ())

    def test_deleting_tag_removes_memberships_without_deleting_literature(self) -> None:
        repository = LiteratureRepository()
        tag = repository.create_tag("Important")
        repository.save(replace(self.item, tags=("Important",)), self.project.id)

        result = repository.delete_tag(tag["id"])

        self.assertEqual(result, {"tags": 1, "memberships": 1})
        self.assertEqual(repository.tags(), [])
        self.assertEqual(repository.get(self.item.id).id, self.item.id)
        self.assertEqual(repository.get(self.item.id).tags, ())

    def test_creating_existing_tag_is_idempotent(self) -> None:
        repository = LiteratureRepository()
        first = repository.create_tag("Important")
        second = repository.create_tag("important")

        self.assertEqual(second["id"], first["id"])
        self.assertEqual(len(repository.tags()), 1)

    def test_one_literature_has_independent_project_classifications(self) -> None:
        first = replace(self.item, collection="Methods", collections=("Methods",))
        second = replace(self.item, collection="Background", collections=("Background",))
        repository = LiteratureRepository()
        repository.save(first, self.project.id)
        repository.save(second, self.other_project.id)

        self.assertEqual(
            load_library(self.project.id).items[0].collections,
            ("Methods",),
        )
        self.assertEqual(
            load_library(self.other_project.id).items[0].collections,
            ("Background",),
        )
        self.assertEqual(load_library().items[0].collections, ())

    def test_collection_update_moves_tree_and_preserves_memberships(self) -> None:
        repository = LiteratureRepository()
        for scope in ("", self.project.id):
            with self.subTest(scope=scope):
                source = repository.create_collection("Source", project_id=scope)
                child = repository.create_collection("Child", source["id"], scope)
                destination = repository.create_collection("Destination", project_id=scope)
                saved = repository.save(self.item, scope)
                if scope:
                    repository.replace_project_collections(saved.id, scope, (child["id"],))
                else:
                    repository.update(saved.id, {}, collection_ids=(child["id"],))
                updated = repository.update_collection(
                    source["id"], {"name": " Renamed ", "parent_id": destination["id"]}, scope
                )
                self.assertEqual(updated["name"], "Renamed")
                self.assertEqual(updated["parent_id"], destination["id"])
                listed = {entry["id"]: entry for entry in repository.collections(scope)}
                self.assertEqual(listed[child["id"]]["parent_id"], source["id"])
                self.assertEqual(listed[child["id"]]["count"], 1)
                root = repository.update_collection(source["id"], {"parent_id": None}, scope)
                self.assertIsNone(root["parent_id"])

    def test_collection_update_rejects_cycles_and_cross_scope_destinations(self) -> None:
        repository = LiteratureRepository()
        parent = repository.create_collection("Parent", project_id=self.project.id)
        child = repository.create_collection("Child", parent["id"], self.project.id)
        grandchild = repository.create_collection("Grandchild", child["id"], self.project.id)
        foreign = repository.create_collection("Foreign", project_id=self.other_project.id)
        global_collection = repository.create_collection("Global")
        for destination in (parent, child, grandchild, foreign, global_collection):
            with self.subTest(destination=destination["name"]):
                with self.assertRaises(LiteratureError):
                    repository.update_collection(
                        parent["id"], {"parent_id": destination["id"]}, self.project.id
                    )
        with self.assertRaises(LiteratureError):
            repository.update_collection(parent["id"], {"name": "Forbidden"}, self.other_project.id)
        listed = {entry["id"]: entry for entry in repository.collections(self.project.id)}
        self.assertIsNone(listed[parent["id"]]["parent_id"])

    def test_collection_patch_endpoint_validates_name_and_conflicts(self) -> None:
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        repository = LiteratureRepository()
        source = repository.create_collection("Source", project_id=self.project.id)
        destination = repository.create_collection("Destination", project_id=self.project.id)
        repository.create_collection("Source", destination["id"], self.project.id)
        url = f"/api/v1/collections/{source['id']}"
        scope = {"project_id": self.project.id}
        self.assertEqual(client.patch(url, params=scope, json={"name": " "}).status_code, 400)
        self.assertEqual(
            client.patch(url, params=scope, json={"parent_id": destination["id"]}).status_code, 409
        )
        self.assertEqual(client.patch(url, json={"name": "Cross scope"}).status_code, 400)
        renamed = client.patch(url, params=scope, json={"name": "Renamed"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        moved = client.patch(url, params=scope, json={"parent_id": destination["id"]})
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["project_id"], self.project.id)
        self.assertEqual(
            client.patch(url, params=scope, json={"parent_id": source["id"]}).status_code, 400
        )

    def test_concurrent_opposite_collection_moves_cannot_create_a_cycle(self) -> None:
        repository = LiteratureRepository()
        first = repository.create_collection("First")
        second = repository.create_collection("Second")
        barrier = Barrier(2)

        def move(source: str, destination: str) -> bool:
            barrier.wait()
            try:
                repository.update_collection(source, {"parent_id": destination})
            except LiteratureError:
                return False
            return True

        with ThreadPoolExecutor(max_workers=2) as executor:
            forward = executor.submit(move, first["id"], second["id"])
            backward = executor.submit(move, second["id"], first["id"])
            self.assertEqual(sorted((forward.result(), backward.result())), [False, True])

    def test_project_collection_api_validates_and_projects_scope(self) -> None:
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        repository = LiteratureRepository()
        repository.save(
            replace(self.item, collection="Methods", collections=("Methods",)),
            self.project.id,
        )

        parent = client.post(
            "/api/v1/collections",
            json={"name": "Parent", "project_id": self.project.id},
        )
        self.assertEqual(parent.status_code, 201)
        child = client.post(
            "/api/v1/collections",
            json={
                "name": "Child",
                "parent_id": parent.json()["id"],
                "project_id": self.project.id,
            },
        )
        self.assertEqual(child.status_code, 201)
        self.assertEqual(child.json()["project_id"], self.project.id)
        listed = client.get("/api/v1/collections", params={"project_id": self.project.id}).json()
        self.assertEqual({entry["name"] for entry in listed}, {"Methods", "Parent", "Child"})
        projected = client.get(
            "/api/v1/literatures", params={"project_id": self.project.id}
        ).json()["items"][0]
        self.assertEqual(
            [entry["name"] for entry in projected["project_collections"]],
            ["Methods"],
        )
        self.assertEqual(projected["collections"], [])
        rejected = client.post(
            "/api/v1/collections",
            json={"name": "Invalid", "project_id": "unknown"},
        )
        self.assertEqual(rejected.status_code, 400)
        deleted = client.delete(
            f"/api/v1/collections/{parent.json()['id']}",
            params={"project_id": self.project.id},
        )
        self.assertEqual(
            deleted.json(),
            {
                "deleted": parent.json()["id"],
                "collections": 2,
                "memberships": 0,
            },
        )

    def test_detail_replaces_only_the_current_projects_classifications(self) -> None:
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        repository.save(self.item, self.other_project.id)
        first = repository.create_collection("First", project_id=self.project.id)
        second = repository.create_collection("Second", project_id=self.other_project.id)
        repository.associate(
            (self.item.id,),
            project_id=self.other_project.id,
            collection_ids=(second["id"],),
        )

        response = client.patch(
            f"/api/v1/literatures/{self.item.id}",
            params={"project_id": self.project.id},
            json={"project_collection_ids": [first["id"]]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [entry["id"] for entry in response.json()["project_collections"]],
            [first["id"]],
        )
        self.assertEqual(
            [
                entry["id"]
                for entry in repository.project_collections(self.item.id, self.other_project.id)
            ],
            [second["id"]],
        )

    def test_tag_delete_api_reports_removed_memberships(self) -> None:
        repository = LiteratureRepository()
        tag = repository.create_tag("Important")
        repository.save(replace(self.item, tags=("Important",)), self.project.id)
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)

        response = TestClient(app).delete(f"/api/v1/tags/{tag['id']}")

        self.assertEqual(
            response.json(),
            {"deleted": tag["id"], "tags": 1, "memberships": 1},
        )
        self.assertEqual(repository.get(self.item.id).tags, ())

    def test_counts_follow_explicit_project_membership(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        repository.save(replace(self.item, id="other-count-item"), self.other_project.id)
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        self.assertEqual(client.get("/api/v1/literatures/counts").json()["all"], 2)
        for project in (self.project, self.other_project):
            response = client.get("/api/v1/literatures/counts", params={"project_id": project.id})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["all"], 1)
        self.assertEqual(
            client.get("/api/v1/literatures/counts", params={"project_id": "missing"}).status_code,
            400,
        )

    def test_tag_counts_follow_the_requested_project_scope(self) -> None:
        repository = LiteratureRepository()
        repository.save(replace(self.item, tags=("Important",)), self.project.id)
        repository.save(
            replace(self.item, id="other-tag-item", tags=("Important", "Shared")),
            self.other_project.id,
        )
        # 只挂在全库面、不属于任何项目的条目, 不计入任何项目的标签计数。
        repository.save(replace(self.item, id="unlinked-tag-item", tags=("Important",)))

        self.assertEqual(
            {tag["name"]: tag["count"] for tag in repository.tags()},
            {"Important": 3, "Shared": 1},
        )
        # 项目内计数为 0 的标签仍然列出, 与 collections() 一致。
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in repository.tags(self.project.id)},
            {"Important": 1, "Shared": 0},
        )
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in repository.tags(self.other_project.id)},
            {"Important": 1, "Shared": 1},
        )
        # total 始终是全库口径: 删除标签作用于全库, 确认框不能报项目内的数字。
        self.assertEqual(
            {tag["name"]: tag["total"] for tag in repository.tags()},
            {"Important": 3, "Shared": 1},
        )
        self.assertEqual(
            {tag["name"]: tag["total"] for tag in repository.tags(self.project.id)},
            {"Important": 3, "Shared": 1},
        )

        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        overview = client.get("/api/v1/literatures/facets")
        self.assertEqual(overview.status_code, 200)
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in overview.json()["tags"]},
            {"Important": 3, "Shared": 1},
        )
        scoped = client.get("/api/v1/literatures/facets", params={"project_id": self.project.id})
        self.assertEqual(scoped.status_code, 200)
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in scoped.json()["tags"]},
            {"Important": 1, "Shared": 0},
        )
        self.assertEqual(
            {tag["name"]: tag["total"] for tag in scoped.json()["tags"]},
            {"Important": 3, "Shared": 1},
        )
        self.assertEqual(
            {tag["name"]: tag["total"] for tag in overview.json()["tags"]},
            {"Important": 3, "Shared": 1},
        )

    def test_multiple_tags_intersect_and_tag_facets_follow_the_collection_scope(self) -> None:
        """多标签取交集; 侧栏标签 facet 按分类作用域收敛, 且不被已选标签反向收窄。"""

        repository = LiteratureRepository()
        parent = repository.create_collection("Parent", project_id=self.project.id)
        child = repository.create_collection("Child", parent["id"], self.project.id)
        outside = repository.create_collection("Outside", project_id=self.project.id)
        both = repository.save(
            replace(self.item, id="both-tags", tags=("Important", "Shared")), self.project.id
        )
        important_only = repository.save(
            replace(self.item, id="important-only", tags=("Important",)), self.project.id
        )
        shared_only = repository.save(
            replace(self.item, id="shared-only", tags=("Shared",)), self.project.id
        )
        # 项目内分类必须走项目作用域的写入口: update() 的 collection_ids 只认全局分类。
        repository.replace_project_collections(both.id, self.project.id, (child["id"],))
        repository.replace_project_collections(important_only.id, self.project.id, (child["id"],))
        repository.replace_project_collections(shared_only.id, self.project.id, (outside["id"],))
        # 从没被任何文献用过的标签: 验证 facet 不会因为计数为 0 就把它藏起来。
        repository.create_tag("Unused")
        ids = {tag["name"]: tag["id"] for tag in repository.tags()}

        # 交集: 单标签照常筛, 两个标签只留同时挂着的那一条。
        self.assertEqual(
            {item.id for item in repository.list(tag_ids=(ids["Important"],))},
            {"both-tags", "important-only"},
        )
        self.assertEqual(
            {item.id for item in repository.list(tag_ids=(ids["Important"], ids["Shared"]))},
            {"both-tags"},
        )
        # 计数走同一份 _selection, 不能和列表各说各话。
        self.assertEqual(repository.filtered_total(tag_ids=(ids["Important"], ids["Shared"])), 1)
        self.assertEqual(repository.filtered_total(tag_ids=(ids["Important"],)), 2)

        # 作用域 facet: 全库标签都列出, 计数为 0 的也照列, 不随分类忽隐忽现。
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in repository.scoped_tags()},
            {"Important": 2, "Shared": 2, "Unused": 0},
        )
        # 选中父分类要按递归子树收敛, 与列表的 collection 口径一致。
        subtree = repository.scoped_tags(project_id=self.project.id, collection_ids=(parent["id"],))
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in subtree},
            {"Important": 2, "Shared": 1, "Unused": 0},
        )
        self.assertEqual([tag["name"] for tag in subtree], ["Important", "Shared", "Unused"])
        outside_scope = repository.scoped_tags(
            project_id=self.project.id, collection_ids=(outside["id"],)
        )
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in outside_scope},
            {"Important": 0, "Shared": 1, "Unused": 0},
        )
        # 计数降序; 同为 0 的先后由 created_at 决定, 不断言以免绑死时间戳精度。
        counts = [tag["count"] for tag in outside_scope]
        self.assertEqual(counts, sorted(counts, reverse=True))
        self.assertEqual(outside_scope[0]["name"], "Shared")
        # total 保持全库口径: 删除标签是全库操作, 确认框必须报全库影响面。
        self.assertEqual(
            {tag["name"]: tag["total"] for tag in outside_scope},
            {"Important": 2, "Shared": 2, "Unused": 0},
        )

        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        scope = {"project_id": self.project.id, "collection_id": [child["id"]]}
        scoped = client.get("/api/v1/literatures/tag-facets", params=scope)
        self.assertEqual(scoped.status_code, 200, scoped.text)
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in scoped.json()["tags"]},
            {"Important": 2, "Shared": 1, "Unused": 0},
        )
        self.assertEqual(
            {tag["name"]: tag["total"] for tag in scoped.json()["tags"]},
            {"Important": 2, "Shared": 2, "Unused": 0},
        )
        # 排序由后端给出, 侧栏不再自己排。
        scoped_counts = [tag["count"] for tag in scoped.json()["tags"]]
        self.assertEqual(scoped_counts, sorted(scoped_counts, reverse=True))
        # 被选中的维度不能过滤自己的 facet: 多带一个 tag_id 也不许把结果收窄,
        # 否则选中第一个标签之后其余标签的计数会退化成交集, 没法再叠加第二个。
        narrowed = client.get(
            "/api/v1/literatures/tag-facets",
            params={**scope, "tag_id": [ids["Important"]]},
        )
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in narrowed.json()["tags"]},
            {"Important": 2, "Shared": 1, "Unused": 0},
        )
        # 打标签用的全量 facet 不受影响, 仍按项目口径列出全部标签。
        full = client.get("/api/v1/literatures/facets", params={"project_id": self.project.id})
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in full.json()["tags"]},
            {"Important": 2, "Shared": 2, "Unused": 0},
        )

        # 只选项目、不选分类时也必须按项目收敛: 全览里点侧栏的项目行走的就是这条
        # 路径, facet 漏掉 project_id 就会退回全库计数, 而项目文献库里两者恰好相等
        # 所以看不出来。别的项目里补一条 Shared, 让两种口径的差值可观测。
        elsewhere = replace(self.item, id="elsewhere", tags=("Shared",))
        repository.save(elsewhere, self.other_project.id)
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in repository.scoped_tags()},
            {"Important": 2, "Shared": 3, "Unused": 0},
        )
        in_project = repository.scoped_tags(project_id=self.project.id)
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in in_project},
            {"Important": 2, "Shared": 2, "Unused": 0},
        )
        by_project = client.get(
            "/api/v1/literatures/tag-facets", params={"project_id": self.project.id}
        )
        self.assertEqual(by_project.status_code, 200, by_project.text)
        self.assertEqual(
            {tag["name"]: tag["count"] for tag in by_project.json()["tags"]},
            {"Important": 2, "Shared": 2, "Unused": 0},
        )

    def test_project_navigation_uses_content_projects_as_the_dimension(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        parent = repository.create_collection("Methods", project_id=self.project.id)
        child = repository.create_collection(
            "Neural", parent_id=parent["id"], project_id=self.project.id
        )
        repository.save(
            replace(self.item, collection="Neural", collections=("Neural",)),
            self.project.id,
        )
        repository.save(replace(self.item, id="orphan"), "deleted-project")
        repository.create_collection("Ignored", project_id="deleted-project")
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)

        payload = TestClient(app).get("/api/v1/literatures/projects").json()

        self.assertEqual(
            [project["id"] for project in payload["projects"]],
            [self.project.id, self.other_project.id],
        )
        first = payload["projects"][0]
        self.assertEqual((first["name"], first["count"]), ("事务文献库", 1))
        self.assertEqual(
            {(entry["name"], entry["parent_id"], entry["count"]) for entry in first["collections"]},
            {("Methods", None, 1), ("Neural", child["parent_id"], 1)},
        )
        self.assertNotIn("deleted-project", str(payload))
        filtered = TestClient(app).get(
            "/api/v1/literatures",
            params={"project_id": self.project.id, "collection_id": parent["id"]},
        )
        self.assertEqual(filtered.status_code, 200, filtered.text)
        self.assertEqual([item["id"] for item in filtered.json()["items"]], [self.item.id])

    def test_archived_project_hidden_from_literature_dimension_and_restored(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)

        self.content.set_project_archived(self.project.id, True)
        payload = client.get("/api/v1/literatures/projects").json()
        self.assertEqual([entry["id"] for entry in payload["projects"]], [self.other_project.id])
        summary = client.get("/api/v1/literatures").json()["items"][0]
        self.assertEqual(summary["projects"], [])
        self.assertEqual(
            client.get("/api/v1/literatures", params={"project_id": self.project.id}).status_code,
            400,
        )
        # 关联行只是隐藏不是删除: 取消归档后名称表恢复解析, 关联原样回来
        self.assertEqual(repository.projects(self.item.id), (self.project.id,))

        self.content.set_project_archived(self.project.id, False)
        payload = client.get("/api/v1/literatures/projects").json()
        self.assertEqual(
            [entry["id"] for entry in payload["projects"]],
            [self.project.id, self.other_project.id],
        )
        summary = client.get("/api/v1/literatures").json()["items"][0]
        self.assertEqual([entry["id"] for entry in summary["projects"]], [self.project.id])

    def test_failed_forget_cleanup_keeps_registration_for_retry(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        repository.create_collection("Methods", project_id=self.project.id)

        def interrupted(project_id):
            repository.drop_project_links(project_id)
            raise OSError("cleanup interrupted")

        self.content.bind_project_forget_sink(interrupted)
        with self.assertRaises(OSError):
            self.content.forget_project(self.project.id)
        self.assertEqual(self.content.project(self.project.id).id, self.project.id)
        self.assertIsNotNone(repository.get(self.item.id))
        self.content.bind_project_forget_sink(repository.drop_project_links)
        self.content.forget_project(self.project.id)
        self.assertEqual(repository.projects(self.item.id), ())
        self.assertIsNotNone(repository.get(self.item.id))

    def test_project_unlink_projection_matches_live_rows_and_keeps_literature(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        repository.save(self.item, self.other_project.id)
        repository.create_collection("Methods", project_id=self.project.id)
        with (
            closing(connect(self.database)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            projected.execute("PRAGMA foreign_keys=ON")
            with self.assertRaises(ValueError):
                repository.drop_project_link_rows(projected, self.project.id)
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                count = repository.drop_project_link_rows(projected, self.project.id)
            expected = tuple(projected.iterdump())
            self.assertIn(self.project.id, repository.projects(self.item.id))
            self.assertEqual(repository.drop_project_links(self.project.id), count)
            self.assertEqual(tuple(source.iterdump()), expected)
            self.assertIsNotNone(repository.get(self.item.id))
            self.assertEqual(repository.projects(self.item.id), (self.other_project.id,))

    def test_forget_project_cleans_literature_links_via_bound_sink(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        repository.create_collection("Methods", project_id=self.project.id)
        self.content.bind_project_forget_sink(repository.drop_project_links)

        self.content.forget_project(self.project.id)

        self.assertEqual(repository.projects(self.item.id), ())
        with closing(connect(self.database)) as connection, connection:
            rows = connection.execute(
                "SELECT COUNT(*) FROM literature_projects WHERE project_id=?",
                (self.project.id,),
            ).fetchone()
            collections = connection.execute(
                "SELECT COUNT(*) FROM literature_collections WHERE project_id=?",
                (self.project.id,),
            ).fetchone()
            items = connection.execute(
                "SELECT COUNT(*) FROM literature_items WHERE id=?", (self.item.id,)
            ).fetchone()
        self.assertEqual(rows[0], 0)
        self.assertEqual(collections[0], 0)
        # 清的是关联不是文献: 条目本身保留
        self.assertEqual(items[0], 1)

    def test_bulk_link_project_validates_target_and_reports_missing_items(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item)
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        payload = {
            "literature_ids": [self.item.id, "missing", self.item.id],
            "operation": "link_project",
            "parameters": {"project_id": self.project.id},
        }

        response = client.post("/api/v1/literatures/bulk", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["succeeded"], [self.item.id])
        self.assertEqual(
            response.json()["failed"],
            [{"id": "missing", "code": "LITERATURE_NOT_FOUND"}],
        )
        self.assertEqual(repository.projects(self.item.id), (self.project.id,))
        repeated = client.post("/api/v1/literatures/bulk", json=payload)
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repository.projects(self.item.id), (self.project.id,))

        unknown = client.post(
            "/api/v1/literatures/bulk",
            json={**payload, "parameters": {"project_id": "unknown"}},
        )
        self.assertEqual(unknown.status_code, 400)
        missing_target = client.post(
            "/api/v1/literatures/bulk",
            json={**payload, "parameters": {}},
        )
        self.assertEqual(missing_target.status_code, 400)
        self.assertEqual(missing_target.json()["detail"]["code"], "LITERATURE_PROJECT_REQUIRED")

    def test_export_reports_only_the_entries_it_actually_wrote(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item)
        repository.save(replace(self.item, id="second-export-item", title="Second"))
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)

        response = TestClient(app).post(
            "/api/v1/exports",
            json={
                "literature_ids": [self.item.id, "second-export-item", "missing"],
                "format": "bibtex",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        # count 是前端「成功导出 N 条文献」的唯一依据: 库里查不到的 id 不能算进去。
        self.assertEqual(payload["count"], 2)
        # 请求数与缺失数如实回给调用方, 少导了哪几条自己对得上账。
        self.assertEqual(payload["requested"], 3)
        self.assertEqual(payload["missing"], 1)
        entries = [line for line in payload["bibtex"].splitlines() if line.startswith("@")]
        self.assertEqual(len(entries), payload["count"])

    def test_export_covers_selected_entries_beyond_one_page(self) -> None:
        """导出按 id 取数, 不受列表分页影响。

        回归锚点: 导出曾在 Python 里过滤 ``repository.list()`` (带 LIMIT 200), 库超过
        一页之后只有最新的一批能被导出 —— 用户全选老条目时会导出 0 条, 界面还报成功。
        """

        repository = LiteratureRepository()
        total = MAX_BATCH_RECORDS // 8
        items = tuple(
            replace(
                self.item,
                id=f"export-item-{index:04d}",
                title=f"Title {index}",
                added_at=float(index),
            )
            for index in range(total)
        )
        repository.save_all(items)
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        identifiers = [item.id for item in items]

        everything = client.post(
            "/api/v1/exports", json={"literature_ids": identifiers, "format": "bibtex"}
        )
        self.assertEqual(everything.status_code, 200, everything.text)
        self.assertEqual(everything.json()["count"], total)

        # 最老的几条一定落在「最新一页」之外, 是旧实现必然丢的那一批。
        oldest = identifiers[:5]
        response = client.post(
            "/api/v1/exports", json={"literature_ids": oldest, "format": "bibtex"}
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["count"], len(oldest))
        self.assertEqual(payload["missing"], 0)
        entries = [line for line in payload["bibtex"].splitlines() if line.startswith("@")]
        self.assertEqual(len(entries), len(oldest))

    def test_export_rejects_a_batch_above_the_shared_limit(self) -> None:
        """超过单批上限直接 422, 绝不静默裁成前 N 条。

        与导入共用 ``MAX_BATCH_RECORDS``: 导出 2000 条得到的 bib 必须能原样导回来。
        判据是**请求**的条数, 不是命中条数 —— 让用户在发出去之前就知道要分批。
        """

        repository = LiteratureRepository()
        repository.save(self.item)
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        too_many = [self.item.id, *(f"missing-{index}" for index in range(MAX_BATCH_RECORDS))]

        response = client.post(
            "/api/v1/exports", json={"literature_ids": too_many, "format": "bibtex"}
        )

        self.assertEqual(response.status_code, 422, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], EXPORT_TOO_MANY_ITEMS)
        self.assertEqual(detail["max"], MAX_BATCH_RECORDS)
        self.assertEqual(detail["requested"], MAX_BATCH_RECORDS + 1)
        self.assertNotIn("bibtex", response.json())

        at_limit = client.post(
            "/api/v1/exports",
            json={"literature_ids": [self.item.id] * MAX_BATCH_RECORDS, "format": "bibtex"},
        )
        # 去重之后只有一条, 正好在上限内: 上限判的是不同 id 的个数。
        self.assertEqual(at_limit.status_code, 200, at_limit.text)
        self.assertEqual(at_limit.json()["count"], 1)

    def test_facets_aggregate_the_whole_scope_and_report_truncation(self) -> None:
        """facet 是全量聚合, 且截断必须显式。

        回归锚点: 三个聚合维度曾在 Python 里遍历 ``repository.list()`` (带 LIMIT),
        库超过一页之后年份/类型/期刊只反映最新的一批条目; 现在由 SQL 聚合出全量,
        再按维度收成 {total, entries, truncated}。
        """

        repository = LiteratureRepository()
        total = MAX_BATCH_RECORDS // 8
        repository.save_all(
            tuple(
                replace(
                    self.item,
                    id=f"facet-item-{index:04d}",
                    title=f"Title {index}",
                    year=1900 + index,
                    journal=f"Journal {index % 60}",
                    added_at=float(index),
                )
                for index in range(total)
            ),
            project_id=self.project.id,
        )
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        scope = {"project_id": self.project.id}

        facets = client.get("/api/v1/literatures/facets", params=scope)
        self.assertEqual(facets.status_code, 200, facets.text)
        payload = facets.json()
        counts = client.get("/api/v1/literatures/counts", params=scope).json()
        self.assertEqual(counts["all"], total)

        years = payload["years"]
        self.assertEqual(years["total"], total)
        self.assertTrue(years["truncated"])
        self.assertEqual(len(years["entries"]), FACET_ENTRIES_LIMIT)
        # 每个年份各一条, 计数全相等: 截断留下的是哪一批必须确定 (年份倒序)。
        self.assertEqual(years["entries"][0]["value"], 1900 + total - 1)
        self.assertEqual(sum(entry["count"] for entry in years["entries"]), FACET_ENTRIES_LIMIT)

        publications = payload["publications"]
        self.assertEqual(publications["total"], 60)
        self.assertTrue(publications["truncated"])
        self.assertEqual(len(publications["entries"]), FACET_ENTRIES_LIMIT)
        # 期刊维度取值不均 (index % 60): 计数降序, 截断丢掉的一定是最小的那批。
        listed = [entry["count"] for entry in publications["entries"]]
        self.assertEqual(listed, sorted(listed, reverse=True))
        dropped = publications["total"] - len(listed)
        self.assertEqual(sum(listed), total - dropped * min(listed))

        item_types = payload["item_types"]
        self.assertEqual(item_types["total"], 1)
        self.assertFalse(item_types["truncated"])
        self.assertEqual(item_types["entries"][0]["count"], total)

        # 分类树与标签是给界面用的, 不套有界视图: 少一行用户就点不到。
        self.assertIsInstance(payload["collections"], list)
        self.assertIsInstance(payload["tags"], list)

    def test_bulk_tag_reports_only_the_entries_it_actually_tagged(self) -> None:
        """批量打标签走成员关系批写, 回执只列真正改到的条目。

        两件事一起锚住: (1) 打标签不再逐条重写题录行, 所以 ``updated_at`` / ``version``
        与项目内分类成员关系都不动; (2) 库里没有的 id 进 failed, 不再谎报全部成功。
        """

        repository = LiteratureRepository()
        collection = repository.create_collection("Methods", project_id=self.project.id)
        before = repository.save(self.item, self.project.id)
        repository.associate(
            (self.item.id,), project_id=self.project.id, collection_ids=(collection["id"],)
        )
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)

        added = client.post(
            "/api/v1/literatures/bulk",
            json={
                "literature_ids": [self.item.id, "missing"],
                "operation": "add_tags",
                "parameters": {"tags": ["Important", "Important"]},
            },
        )

        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(added.json()["succeeded"], [self.item.id])
        self.assertEqual(
            added.json()["failed"], [{"id": "missing", "code": "LITERATURE_NOT_FOUND"}]
        )
        tagged = repository.get(self.item.id)
        self.assertEqual(tagged.tags, ("Important",))
        self.assertEqual((tagged.updated_at, tagged.version), (before.updated_at, before.version))
        scoped = repository.list(project_id=self.project.id)
        self.assertEqual(scoped[0].collections, ("Methods",))

        removed = client.post(
            "/api/v1/literatures/bulk",
            json={
                "literature_ids": [self.item.id],
                "operation": "remove_tags",
                "parameters": {"tags": ["Important"]},
            },
        )
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json()["succeeded"], [self.item.id])
        self.assertEqual(repository.get(self.item.id).tags, ())
        # 删掉不存在的标签名是空操作, 不算失败。
        unknown = client.post(
            "/api/v1/literatures/bulk",
            json={
                "literature_ids": [self.item.id],
                "operation": "remove_tags",
                "parameters": {"tags": ["Never existed"]},
            },
        )
        self.assertEqual(unknown.status_code, 200, unknown.text)
        self.assertEqual(unknown.json()["succeeded"], [self.item.id])

    def test_detail_metadata_and_global_organization_are_editable(self) -> None:
        repository = LiteratureRepository()
        repository.save(self.item, self.project.id)
        global_collection = repository.create_collection("Reviewed")
        project_collection = repository.create_collection(
            "Project only", project_id=self.project.id
        )
        repository.save(
            replace(self.item, collection="Project only", collections=("Project only",)),
            self.project.id,
        )
        tag = repository.create_tag("Important")
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)

        response = TestClient(app).patch(
            f"/api/v1/literatures/{self.item.id}",
            json={
                "fields": {
                    "title": "Edited research",
                    "authors": "New author",
                    "year": 2025,
                    "abstract": "Updated abstract",
                },
                "bib_type": "article",
                "collection_ids": [global_collection["id"]],
                "tag_ids": [tag["id"]],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertEqual(
            (
                detail["title"],
                detail["creators_display"],
                detail["year"],
                detail["abstract"],
                detail["bib_type"],
            ),
            ("Edited research", "New author", 2025, "Updated abstract", "article"),
        )
        self.assertEqual([entry["name"] for entry in detail["collections"]], ["Reviewed"])
        self.assertEqual([entry["name"] for entry in detail["tags"]], ["Important"])
        project_view = repository.view(self.project.id)
        self.assertEqual(project_view.items[0].collections, ("Project only",))
        self.assertEqual(project_collection["project_id"], self.project.id)

    def test_deleting_referenced_item_cascades_project_relations(self) -> None:
        self.seed()
        repository = LiteratureRepository()
        removed, projects = repository.delete(self.item.id)
        self.assertTrue(removed)
        self.assertEqual(projects, (self.project.id,))
        self.assertIsNone(repository.get(self.item.id))


if __name__ == "__main__":
    unittest.main()
