"""Typed row equality, not generic backwards data-format approval."""

from __future__ import annotations

import sqlite3
import time
import unittest
from unittest.mock import patch

from service.persistence.rows import ROW_CHUNK_BYTES, restore_rows, rows_digest


class SqliteRowContracts(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.addCleanup(self.connection.close)

    def digest(self):
        self.connection.execute("PRAGMA query_only=ON")
        try:
            return rows_digest(self.connection, deadline=time.monotonic() + 5)
        finally:
            self.connection.execute("PRAGMA query_only=OFF")

    def test_value_types_and_row_identity_are_not_coerced(self):
        self.connection.execute("CREATE TABLE records (value)")
        digests = []
        for value in (None, 1, 1.0, "1", b"1"):
            self.connection.execute("DELETE FROM records")
            self.connection.execute("INSERT INTO records(rowid,value) VALUES(1,?)", (value,))
            digests.append(self.digest())
        self.assertEqual(len(set(digests)), len(digests))
        before = self.digest()
        self.connection.execute("UPDATE records SET rowid=2")
        self.assertNotEqual(self.digest(), before)

    def test_python_boolean_from_custom_row_factory_is_not_an_integer(self):
        self.connection.execute("CREATE TABLE records (value INTEGER)")
        self.connection.execute("INSERT INTO records VALUES (1)")

        def boolean_value(cursor, row):
            return tuple(
                True if column[0] == "value" else value
                for column, value in zip(cursor.description, row, strict=True)
            )

        self.connection.row_factory = boolean_value
        with self.assertRaisesRegex(ValueError, "unsupported SQLite row value"):
            self.digest()
        self.connection.row_factory = None
        self.assertTrue(self.digest())

    def test_index_changes_do_not_change_row_observation(self):
        self.connection.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)")
        self.connection.execute("INSERT INTO records VALUES (9,'private-row-marker')")
        before = self.digest()
        self.connection.execute("CREATE INDEX records_value ON records(value)")
        self.assertEqual(self.digest(), before)
        self.assertNotIn("private-row-marker", before)

    def test_autoincrement_high_water_is_preserved_in_identity(self):
        self.connection.execute(
            "CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)"
        )
        self.connection.execute("INSERT INTO records(value) VALUES ('kept')")
        before = self.digest()
        self.connection.execute("INSERT INTO records(id,value) VALUES (100,'deleted')")
        self.connection.execute("DELETE FROM records WHERE id=100")
        self.assertEqual(
            self.connection.execute("SELECT id,value FROM records").fetchall(), [(1, "kept")]
        )
        self.assertNotEqual(self.digest(), before)

    def test_without_rowid_composite_keys_have_deterministic_identity(self):
        self.connection.execute(
            'CREATE TABLE "odd table" ("key a" TEXT, "key b" INTEGER, value BLOB, PRIMARY KEY ("key b", "key a")) WITHOUT ROWID'
        )
        rows = [("b", 2, b"second"), ("a", 1, b"first")]
        self.connection.executemany('INSERT INTO "odd table" VALUES (?,?,?)', rows)
        before = self.digest()
        self.connection.execute('DELETE FROM "odd table"')
        self.connection.executemany('INSERT INTO "odd table" VALUES (?,?,?)', reversed(rows))
        self.assertEqual(self.digest(), before)

    def test_shadowed_rowid_uses_an_available_identity_alias(self):
        self.connection.execute("CREATE TABLE records (rowid TEXT, value INTEGER)")
        self.connection.execute("INSERT INTO records(_rowid_,rowid,value) VALUES (3,'visible',1)")
        before = self.digest()
        self.connection.execute("UPDATE records SET _rowid_=4")
        self.assertNotEqual(self.digest(), before)

    def test_single_value_limit_is_independent_of_total_stream_budget(self):
        self.connection.execute("CREATE TABLE records (value BLOB)")
        self.connection.execute("INSERT INTO records VALUES (zeroblob(64))")
        self.connection.execute("PRAGMA query_only=ON")
        chunks = []
        digest = rows_digest(self.connection, deadline=time.monotonic() + 5, emit=chunks.append)
        with patch("service.persistence.rows.MAX_VALUE_BYTES", 32):
            with self.assertRaisesRegex(ValueError, "value.*budget"):
                rows_digest(self.connection, deadline=time.monotonic() + 5)
            with sqlite3.connect(":memory:") as restored:
                restored.execute("CREATE TABLE records (value BLOB)")
                with self.assertRaisesRegex(ValueError, "value.*budget"):
                    restore_rows(restored, iter(chunks), digest, deadline=time.monotonic() + 5)

    def test_utf8_value_budget_counts_bytes_not_characters(self):
        self.connection.execute("CREATE TABLE records (value TEXT)")
        self.connection.execute("INSERT INTO records VALUES (?)", ("界" * 12,))
        with patch("service.persistence.rows.MAX_VALUE_BYTES", 32):
            with self.assertRaisesRegex(ValueError, "value.*budget"):
                self.digest()

    def test_requires_read_only_and_bounds_work(self):
        with self.assertRaisesRegex(ValueError, "read-only"):
            rows_digest(self.connection, deadline=time.monotonic() + 5)
        self.connection.execute("PRAGMA query_only=ON")
        with self.assertRaisesRegex(RuntimeError, "deadline"):
            rows_digest(self.connection, deadline=0)
        with patch("service.persistence.rows.MAX_ROW_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "budget"):
                rows_digest(self.connection, deadline=time.monotonic() + 5)

    def test_private_stream_roundtrip_preserves_types_rowids_generated_values_and_sequence(self):
        statements = (
            "CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, value)",
            'CREATE TABLE "odd table" (a TEXT, b INTEGER, payload BLOB, PRIMARY KEY(b,a)) WITHOUT ROWID',
            "CREATE TABLE computed (value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value * 2) STORED)",
        )
        for statement in statements:
            self.connection.execute(statement)
        self.connection.executemany(
            "INSERT INTO records(value) VALUES(?)",
            [(None,), (1,), (1.25,), ("private-marker",), (b"\0" * (ROW_CHUNK_BYTES + 1),)],
        )
        self.connection.execute("INSERT INTO records(id,value) VALUES(1000,'deleted')")
        self.connection.execute("DELETE FROM records WHERE id=1000")
        self.connection.execute('INSERT INTO "odd table" VALUES(?,?,?)', ("a", 9, b"payload"))
        self.connection.execute("INSERT INTO computed(rowid,value) VALUES(8,7)")
        self.connection.execute("PRAGMA query_only=ON")
        chunks = []
        digest = rows_digest(self.connection, deadline=time.monotonic() + 5, emit=chunks.append)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(0 < len(chunk) <= ROW_CHUNK_BYTES for chunk in chunks))
        target = sqlite3.connect(":memory:")
        self.addCleanup(target.close)
        for statement in statements:
            target.execute(statement)
        # Deliberately split in the middle of scalar lengths and values.
        pieces = (part for chunk in chunks for part in (chunk[:3], chunk[3:]) if part)
        restore_rows(target, pieces, digest, deadline=time.monotonic() + 5)
        self.assertEqual(rows_digest(target, deadline=time.monotonic() + 5), digest)
        self.assertEqual(
            target.execute("SELECT seq FROM sqlite_sequence WHERE name='records'").fetchone()[0],
            1000,
        )
        self.assertEqual(target.execute("SELECT rowid,doubled FROM computed").fetchone(), (8, 14))
        with self.assertRaises(sqlite3.OperationalError):
            target.execute("DELETE FROM records")

    def test_incomplete_trailing_reordered_and_changed_streams_are_rejected(self):
        self.connection.execute("CREATE TABLE records (value TEXT)")
        self.connection.execute("INSERT INTO records VALUES('private-row-marker')")
        self.connection.execute("PRAGMA query_only=ON")
        chunks = []
        digest = rows_digest(self.connection, deadline=time.monotonic() + 5, emit=chunks.append)
        raw = b"".join(chunks)
        for pieces in (
            [raw[:-1]],
            [raw, b"extra"],
            [raw[5:], raw[:5]],
            [raw.replace(b"private-row-marker", b"altered-row-marker")],
            [b""],
            [b"x" * (ROW_CHUNK_BYTES + 1)],
        ):
            with self.subTest(case=len(pieces)), self.assertRaises((ValueError, sqlite3.Error)):
                target = sqlite3.connect(":memory:")
                try:
                    target.execute("CREATE TABLE records (value TEXT)")
                    restore_rows(target, pieces, digest, deadline=time.monotonic() + 5)
                finally:
                    target.close()

    def test_stream_affinity_changes_cannot_be_accepted_by_matching_payload_digest(self):
        self.connection.execute("CREATE TABLE records (value)")
        self.connection.execute("INSERT INTO records VALUES(1)")
        self.connection.execute("PRAGMA query_only=ON")
        chunks = []
        digest = rows_digest(self.connection, deadline=time.monotonic() + 5, emit=chunks.append)
        target = sqlite3.connect(":memory:")
        self.addCleanup(target.close)
        target.execute("CREATE TABLE records (value TEXT)")
        with self.assertRaisesRegex(ValueError, "typed values"):
            restore_rows(target, chunks, digest, deadline=time.monotonic() + 5)


if __name__ == "__main__":
    unittest.main()
