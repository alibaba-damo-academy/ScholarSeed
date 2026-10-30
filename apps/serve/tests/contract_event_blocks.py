"""Durability and reversible streaming block contracts."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.chat.persistence import blocks


class EventBlocksContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name).resolve() / "sessions.sqlite3"
        self.connection = sqlite3.connect(self.database)
        self.connection.row_factory = sqlite3.Row
        self.addCleanup(self.connection.close)
        self.connection.execute("CREATE TABLE session_catalog(session_id TEXT PRIMARY KEY)")
        self.connection.executemany("INSERT INTO session_catalog VALUES (?)", [("s",), ("other",)])
        self.connection.commit()
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("BEGIN IMMEDIATE")
        blocks.initialize(self.connection)
        self.connection.commit()

    def event(self, seq: int, text: str = "hello", session: str = "s") -> dict:
        return dict(
            event_id=seq,
            session_id=session,
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_turn_id="turn",
            vendor_item_id="item",
            kind="message_delta",
            payload=json.dumps({"delta": text, "other": True}, ensure_ascii=False),
            client_turn_id=None,
            schema_version=1,
            product_seq=seq,
            idempotency_key=f"key-{seq}",
            created_at=float(seq),
        )

    def append(self, *events: dict) -> None:
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            for event in events:
                store.append(event)
        self.connection.commit()

    def rows(self) -> list[dict]:
        with blocks.BlockStore(self.connection, self.database) as store:
            return list(store.rows())

    def test_schema_initialization_never_creates_files(self) -> None:
        self.assertFalse(self.database.with_suffix(".blocks").exists())
        self.assertFalse(blocks.inspect_connection(self.connection).needs_write)
        blocks.inspect_rows(self.connection, self.database)
        self.assertFalse(self.database.with_suffix(".blocks").exists())

    def test_exact_envelope_prefix_rewrite_empty_and_unicode(self) -> None:
        texts = ["文" * 100, "文" * 100 + "后", "rewrite", "", "next"]
        events = [self.event(i + 1, text) for i, text in enumerate(texts)]
        self.append(*events)
        self.assertEqual(self.rows(), events)
        blocks.inspect_rows(self.connection, self.database)
        row = self.connection.execute(f"SELECT * FROM {blocks.TABLE}").fetchone()
        self.assertEqual(row["count"], 5)
        with blocks.BlockStore(self.connection, self.database) as store:
            self.assertEqual(store.by_key("s", "key-2"), events[1])
            self.assertIsNone(store.by_key("s", "missing"))
        sql = self.connection.execute("SELECT sql FROM sqlite_master WHERE type='table'").fetchall()
        self.assertNotIn("payload", str([tuple(r) for r in sql]))

    def test_rollback_tail_retry_and_orphan_cleanup(self) -> None:
        first = self.event(1)
        self.append(first)
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            store.append(self.event(2, "abandoned"))
            store.append(self.event(1, "orphan", "other"))
        self.connection.rollback()
        self.append(self.event(2, "committed"))
        self.assertEqual(self.rows(), [first, self.event(2, "committed")])
        self.assertEqual(blocks.cleanup(self.database), 1)
        self.assertEqual(blocks.cleanup(self.database), 0)

    def test_count_boundary_and_read_filters(self) -> None:
        events = [self.event(i, "x") for i in range(1, 258)]
        self.append(*events)
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {blocks.TABLE}").fetchone()[0], 2
        )
        with blocks.BlockStore(self.connection, self.database) as store:
            self.assertEqual(list(store.rows("s", after_seq=255)), events[255:])
            self.assertEqual(list(store.rows("s", kinds={"reasoning_delta"})), [])
        blocks.inspect_rows(self.connection, self.database)

    def test_missing_corrupt_file_and_bloom_are_rejected(self) -> None:
        self.append(self.event(1))
        path = self.database.with_suffix(".blocks") / blocks._name("s")
        original = path.read_bytes()
        path.write_bytes(original[:-1])
        with self.assertRaises(RuntimeError):
            self.rows()
        path.write_bytes(original)
        self.connection.execute(f"UPDATE {blocks.TABLE} SET bloom=?", (bytes(blocks.BLOOM_BYTES),))
        self.connection.commit()
        with self.assertRaises(RuntimeError):
            blocks.inspect_rows(self.connection, self.database)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.rows()

    def test_cleanup_preserves_unknown_and_namespace_loss(self) -> None:
        self.append(self.event(1))
        directory = self.database.with_suffix(".blocks")
        unknown = directory / "unknown"
        with blocks.BlockStore(self.connection, self.database) as store:
            fd = store._open().open_private("unknown", os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            try:
                os.write(fd, b"unowned")
            finally:
                os.close(fd)
        with self.assertRaises((RuntimeError, ValueError)):
            blocks.cleanup(self.database)
        self.assertTrue(unknown.exists())
        (directory / blocks.NAMESPACE).unlink()
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            with self.assertRaises((RuntimeError, FileNotFoundError)):
                store.append(self.event(2))
        self.connection.rollback()
        self.assertFalse((directory / blocks.NAMESPACE).exists())

    def test_fsync_failure_does_not_publish_index(self) -> None:
        self.append(self.event(1))
        self.connection.execute("BEGIN IMMEDIATE")
        with (
            blocks.BlockStore(self.connection, self.database) as store,
            patch.object(blocks.os, "fsync", side_effect=OSError("disk")),
        ):
            with self.assertRaises(OSError):
                store.append(self.event(2))
        self.connection.rollback()
        self.assertEqual(self.rows(), [self.event(1)])
        self.append(self.event(2))
        self.assertEqual(len(self.rows()), 2)

    def test_live_writes_and_older_migration_stay_logically_ordered(self) -> None:
        for seq in (100, 1, 2, 101, 3, 4, 102):
            self.append(self.event(seq))
        self.assertEqual([row["product_seq"] for row in self.rows()], [1, 2, 3, 4, 100, 101, 102])
        with blocks.BlockStore(self.connection, self.database) as store:
            self.assertEqual(
                [row["product_seq"] for row in store.rows("s", after_seq=3)], [4, 100, 101, 102]
            )
        visited = []
        blocks.inspect_rows(self.connection, self.database, visit=visited.append)
        self.assertEqual(len(visited), 7)

    def test_large_single_event_and_decoded_block_budget(self) -> None:
        large = self.event(1, "x" * (blocks.MAX_BYTES + 100))
        self.append(large, self.event(2))
        self.assertEqual(self.rows(), [large, self.event(2)])
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {blocks.TABLE}").fetchone()[0], 2
        )
        with patch.object(blocks, "MAX_DECODED_BYTES", 100):
            self.append(self.event(3, "a" * 75), self.event(4, "a" * 76))
            blocks.inspect_rows(self.connection, self.database)
        self.assertEqual(len(self.rows()), 4)

    def test_delete_session_cascades_blocks_then_reclaims_file(self) -> None:
        self.append(self.event(1))
        self.connection.execute("DELETE FROM session_catalog WHERE session_id='s'")
        self.connection.commit()
        self.assertEqual(self.rows(), [])
        self.assertEqual(blocks.cleanup(self.database), 1)
        self.assertTrue((self.database.with_suffix(".blocks") / blocks.NAMESPACE).exists())

    def test_short_writes_and_schema_rejection(self) -> None:
        original = os.write
        with patch.object(blocks.os, "write", side_effect=lambda fd, data: original(fd, data[:7])):
            self.append(self.event(1))
        self.assertEqual(self.rows(), [self.event(1)])
        self.connection.execute(f"DROP INDEX {blocks.SEQUENCE_INDEX}")
        self.connection.execute(f"CREATE INDEX {blocks.SEQUENCE_INDEX} ON {blocks.TABLE}(last_seq)")
        with self.assertRaises(RuntimeError):
            blocks.inspect_connection(self.connection)

    def test_cache_rejects_same_path_replacement(self) -> None:
        self.append(self.event(1))
        path = self.database.with_suffix(".blocks") / blocks._name("s")
        with blocks.BlockStore(self.connection, self.database) as store:
            list(store.rows())
            raw = path.read_bytes()
            try:
                path.unlink()
            except PermissionError:
                self.assertEqual(list(store.rows()), [self.event(1)])
                return
            fd = store._open().open_private(blocks._name("s"), os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            try:
                blocks._write(fd, raw)
            finally:
                os.close(fd)
            with self.assertRaises(RuntimeError):
                list(store.rows())

    def test_batch_fsync_failure_and_sql_failure_cannot_publish(self) -> None:
        self.append(self.event(1), self.event(1, session="other"))
        self.connection.execute("BEGIN IMMEDIATE")
        original = os.fsync
        calls = 0

        def fail_second(fd: int) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("second file sync failed")
            original(fd)

        with blocks.BlockStore(self.connection, self.database) as store:
            with patch.object(blocks.os, "fsync", side_effect=fail_second):
                with self.assertRaises(OSError):
                    store.append_many([self.event(2), self.event(2, session="other")])
        self.connection.commit()
        self.assertEqual(len(self.rows()), 2)
        self.connection.execute(
            f"CREATE TRIGGER reject_block BEFORE INSERT ON {blocks.TABLE} WHEN NEW.last_seq=3 BEGIN SELECT RAISE(ABORT,'test'); END"
        )
        self.connection.commit()
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            with self.assertRaises(sqlite3.IntegrityError):
                store.append_many([self.event(2), self.event(3)])
        self.connection.commit()
        self.assertEqual(len(self.rows()), 2)
        self.connection.execute("DROP TRIGGER reject_block")
        self.connection.commit()
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            store.append_many([self.event(2), self.event(3)])
        self.connection.commit()
        self.assertEqual(len(self.rows()), 4)

    def test_batch_appends_only_new_bytes_and_syncs_once_per_file(self) -> None:
        self.append(self.event(1))
        path = self.database.with_suffix(".blocks") / blocks._name("s")
        before = path.stat().st_size
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            # This also verifies that a read-only directory pin is safely upgraded.
            self.assertIsNotNone(store.by_key("s", "key-1"))
            with (
                patch.object(blocks.os, "write", wraps=os.write) as writes,
                patch.object(blocks.os, "fsync", wraps=os.fsync) as syncs,
            ):
                store.append_many([self.event(i) for i in range(2, 8)])
                self.assertEqual(
                    sum(len(call.args[1]) for call in writes.call_args_list),
                    path.stat().st_size - before,
                )
                self.assertEqual(syncs.call_count, 1 if os.name == "nt" else 2)
        self.connection.commit()
        self.assertEqual(len(self.rows()), 7)

    def test_writer_serialization_and_reopen(self) -> None:
        other = sqlite3.connect(self.database, timeout=0)
        other.row_factory = sqlite3.Row
        self.addCleanup(other.close)
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            store.append(self.event(1))
            with self.assertRaises(sqlite3.OperationalError):
                other.execute("BEGIN IMMEDIATE")
        self.connection.commit()
        other.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(other, self.database) as store:
            store.append(self.event(2))
        other.commit()
        self.assertEqual(self.rows(), [self.event(1), self.event(2)])

    def test_hardlinked_and_symlinked_files_are_rejected(self) -> None:
        self.append(self.event(1))
        directory = self.database.with_suffix(".blocks")
        path = directory / blocks._name("s")
        linked = directory / "hardlink"
        try:
            os.link(path, linked)
        except OSError as error:
            self.skipTest(str(error))
        try:
            with self.assertRaises(OSError):
                self.rows()
        finally:
            linked.unlink()
        original = directory / "original"
        path.rename(original)
        try:
            path.symlink_to(original.name)
        except OSError as error:
            original.rename(path)
            self.skipTest(str(error))
        with self.assertRaises(OSError):
            self.rows()

    def test_batch_rejects_truncation_before_release_and_rolls_back(self) -> None:
        self.append(self.event(1))
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:

            def changed():
                yield self.event(2)
                assert store._batch_files is not None
                os.ftruncate(store._batch_files["s"], 1)

            with self.assertRaises(RuntimeError):
                store.append_many(changed())
        self.connection.commit()
        self.assertEqual(
            self.connection.execute(f"SELECT last_seq FROM {blocks.TABLE}").fetchone()[0], 1
        )

    def test_batch_rejects_namespace_mutation_before_release(self) -> None:
        self.append(self.event(1))
        self.connection.execute("BEGIN IMMEDIATE")
        with self.assertRaises((OSError, RuntimeError, ExceptionGroup)):
            with blocks.BlockStore(self.connection, self.database) as store:

                def changed():
                    yield self.event(2)
                    fd = store._open().open_private(blocks.NAMESPACE, os.O_RDWR)
                    try:
                        os.ftruncate(fd, 0)
                    finally:
                        os.close(fd)

                store.append_many(changed())
        self.connection.commit()
        self.assertEqual(
            self.connection.execute(f"SELECT last_seq FROM {blocks.TABLE}").fetchone()[0], 1
        )

    def test_batch_readback_reuses_pinned_reader_and_only_truncates_tail(self) -> None:
        self.append(self.event(1))
        self.connection.execute("BEGIN IMMEDIATE")
        with blocks.BlockStore(self.connection, self.database) as store:
            with (
                patch.object(store, "_file", wraps=store._file) as opens,
                patch.object(blocks.os, "ftruncate", wraps=os.ftruncate) as truncates,
            ):
                store.append_many([self.event(i) for i in range(2, 130)])
                for i in range(2, 130):
                    self.assertEqual(store.by_key("s", f"key-{i}"), self.event(i))
                self.assertLess(opens.call_count, 8)
                self.assertEqual(truncates.call_count, 0)
        self.connection.commit()

    def test_sql_snapshot_allows_concurrent_append_and_rollback_tail(self) -> None:
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.append(self.event(1))
        reader = sqlite3.connect(self.database)
        reader.row_factory = sqlite3.Row
        self.addCleanup(reader.close)
        reader.execute("BEGIN")
        with blocks.BlockStore(reader, self.database) as snapshot:
            self.assertEqual(list(snapshot.rows()), [self.event(1)])
            self.connection.execute("BEGIN IMMEDIATE")
            with blocks.BlockStore(self.connection, self.database) as writer:
                writer.append(self.event(2, "rolled-back" * 100))
            self.connection.rollback()
            self.assertEqual(list(snapshot.rows()), [self.event(1)])
            # Replacing the uncommitted long tail can shrink the physical file.
            self.append(self.event(2, "short"))
            self.assertEqual(list(snapshot.rows()), [self.event(1)])
            self.append(self.event(3, "new committed tail"))
            self.assertEqual(list(snapshot.rows()), [self.event(1)])
        reader.rollback()
        self.assertEqual(len(self.rows()), 3)

    def test_snapshot_rejects_prefix_rewrite_even_when_tail_grows(self) -> None:
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.append(self.event(1))
        reader = sqlite3.connect(self.database)
        reader.row_factory = sqlite3.Row
        self.addCleanup(reader.close)
        reader.execute("BEGIN")
        snapshot = blocks.BlockStore(reader, self.database)
        self.addCleanup(snapshot.close)
        self.assertEqual(list(snapshot.rows()), [self.event(1)])
        offset = self.connection.execute(f"SELECT offset FROM {blocks.TABLE}").fetchone()[0]
        with blocks.BlockStore(self.connection, self.database) as writer:
            fd = writer._file("s", write=True)
            try:
                os.lseek(fd, offset + 3, os.SEEK_SET)
                os.write(fd, b"X")
                os.lseek(fd, 0, os.SEEK_END)
                os.write(fd, b"uncommitted tail")
                os.fsync(fd)
            finally:
                os.close(fd)
        with self.assertRaises(RuntimeError):
            list(snapshot.rows())

    def test_snapshot_close_rechecks_previously_read_prefix(self) -> None:
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.append(self.event(1))
        reader = sqlite3.connect(self.database)
        reader.row_factory = sqlite3.Row
        self.addCleanup(reader.close)
        reader.execute("BEGIN")
        snapshot = blocks.BlockStore(reader, self.database)
        self.assertEqual(list(snapshot.rows()), [self.event(1)])
        offset = self.connection.execute(f"SELECT offset FROM {blocks.TABLE}").fetchone()[0]
        with blocks.BlockStore(self.connection, self.database) as writer:
            fd = writer._file("s", write=True)
            try:
                os.lseek(fd, offset + 3, os.SEEK_SET)
                os.write(fd, b"X")
                os.fsync(fd)
            finally:
                os.close(fd)
        with self.assertRaises(ExceptionGroup):
            snapshot.close()

    def test_source_memory_snapshot_uses_original_file(self) -> None:
        event = self.event(1)
        self.append(event)
        with sqlite3.connect(":memory:") as snapshot:
            snapshot.row_factory = sqlite3.Row
            self.connection.backup(snapshot)
            with blocks.BlockStore(snapshot, self.database) as store:
                self.assertEqual(list(store.rows()), [event])
                snapshot.execute("BEGIN")
                with self.assertRaises(ValueError):
                    store.append(self.event(2))


if __name__ == "__main__":
    unittest.main()
