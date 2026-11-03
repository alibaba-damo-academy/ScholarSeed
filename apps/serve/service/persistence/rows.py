"""Bounded, typed observation of actual SQLite rows in a read-only snapshot.

Digest equality can bind a source owner's completed reads to identical candidate
rows. Inequality is not evidence of incompatibility and requires direct source
reads of the candidate projection; this primitive does not grant activation.
"""

from __future__ import annotations

import hashlib
import sqlite3
import struct
import time
from collections.abc import Callable, Iterable

from service.persistence.limits import SQLITE_TOTAL_BYTES, SQLITE_VALUE_BYTES

MAX_ROW_BYTES = SQLITE_TOTAL_BYTES
MAX_VALUE_BYTES = SQLITE_VALUE_BYTES
MAX_ROW_TABLES = 4096
ROW_CHUNK_BYTES = 64 * 1024
_DIGEST_SEED = b"scholarseed-sqlite-rows-v1\0"


def _quote(value: str) -> str:
    if not value or "\0" in value:
        raise ValueError("invalid SQLite row identifier")
    return '"' + value.replace('"', '""') + '"'


def rows_digest(
    connection: sqlite3.Connection, *, deadline: float, emit: Callable[[bytes], None] | None = None
) -> str:
    """Hash typed values, column order and observable row identity, without IO.

    This does not validate a codec. The caller must first run the actual owner
    readers on this same immutable projection and retain their exact coverage.
    No user values or exception details belong in diagnostic output.
    """
    if not connection.execute("PRAGMA query_only").fetchone()[0]:
        raise ValueError("SQLite row observation requires a read-only snapshot")
    if time.monotonic() >= deadline:
        raise RuntimeError("SQLite row observation deadline exceeded")
    digest = hashlib.sha256(_DIGEST_SEED)
    size = 0
    pending = bytearray()

    def put(value: bytes) -> None:
        nonlocal size
        size += len(value)
        if size > MAX_ROW_BYTES:
            raise ValueError("SQLite row observation exceeds budget")
        digest.update(value)
        if emit is not None:
            view = memoryview(value)
            while view:
                length = min(ROW_CHUNK_BYTES - len(pending), len(view))
                pending.extend(view[:length])
                view = view[length:]
                if len(pending) == ROW_CHUNK_BYTES:
                    emit(bytes(pending))
                    pending.clear()

    def scalar(value: object) -> None:
        if value is None:
            put(b"n")
        elif isinstance(value, int) and not isinstance(value, bool):
            put(b"i" + struct.pack(">q", value))
        elif isinstance(value, float):
            put(b"f" + struct.pack(">d", value))
        elif isinstance(value, (str, bytes)):
            if len(value) > MAX_VALUE_BYTES:
                raise ValueError("SQLite row value exceeds budget")
            encoded = value.encode("utf-8") if isinstance(value, str) else value
            if len(encoded) > MAX_VALUE_BYTES:
                raise ValueError("SQLite row value exceeds budget")
            put((b"s" if isinstance(value, str) else b"b") + struct.pack(">Q", len(encoded)))
            put(encoded)
        else:
            raise ValueError("unsupported SQLite row value")

    listed = connection.execute("PRAGMA main.table_list").fetchall()
    if not any(row[1] == "sqlite_schema" for row in listed):
        raise ValueError("SQLite runtime cannot inventory row tables")
    tables = sorted(
        (
            row
            for row in listed
            if row[0] == "main"
            and (not row[1].lower().startswith("sqlite_") or row[1] == "sqlite_sequence")
        ),
        key=lambda row: row[1],
    )
    if len(tables) > MAX_ROW_TABLES:
        raise ValueError("SQLite row observation exceeds table budget")
    put(struct.pack(">Q", len(tables)))
    for table in tables:
        if time.monotonic() >= deadline:
            raise RuntimeError("SQLite row observation deadline exceeded")
        if table[2] != "table":
            raise ValueError("unsupported SQLite row table")
        name = str(table[1])
        columns = connection.execute(f"PRAGMA main.table_xinfo({_quote(name)})").fetchall()
        names = [str(row[1]) for row in columns]
        if not names or len({name.casefold() for name in names}) != len(names):
            raise ValueError("unsupported SQLite row columns")
        if table[4]:
            order = [str(row[1]) for row in sorted(columns, key=lambda row: row[5]) if row[5]]
            if not order:
                raise ValueError("SQLite row identity is unavailable")
            selected = names
        else:
            shadowed = {name.casefold() for name in names}
            identity = next(
                (name for name in ("rowid", "_rowid_", "oid") if name not in shadowed), None
            )
            if identity is None:
                raise ValueError("SQLite row identity is unavailable")
            order = [identity]
            selected = [identity, *names]
        scalar(name)
        put(struct.pack(">Q", len(selected)))
        for column in selected:
            scalar(column)
        query = f"SELECT {','.join(_quote(column) for column in selected)} FROM main.{_quote(name)} ORDER BY {','.join(_quote(column) for column in order)}"
        count = 0
        for row in connection.execute(query):
            if time.monotonic() >= deadline:
                raise RuntimeError("SQLite row observation deadline exceeded")
            put(b"r")
            for value in row:
                scalar(value)
            count += 1
        put(b"e" + struct.pack(">Q", count))
    if pending and emit is not None:
        emit(bytes(pending))
    return digest.hexdigest()


class _RowInput:
    """Consume bounded private chunks without buffering a whole database."""

    def __init__(self, chunks: Iterable[bytes], deadline: float):
        self.chunks = iter(chunks)
        self.pending = b""
        self.size = 0
        self.deadline = deadline
        self.digest = hashlib.sha256(_DIGEST_SEED)

    def take(self, count: int) -> bytes:
        if count < 0 or count > MAX_ROW_BYTES - self.size:
            raise ValueError("SQLite row input exceeds budget")
        result = bytearray()
        while len(result) < count:
            if time.monotonic() >= self.deadline:
                raise RuntimeError("SQLite row input deadline exceeded")
            if not self.pending:
                chunk = next(self.chunks, None)
                if not isinstance(chunk, bytes) or not 0 < len(chunk) <= ROW_CHUNK_BYTES:
                    raise ValueError("incomplete SQLite row input")
                self.pending = chunk
            length = min(count - len(result), len(self.pending))
            result.extend(self.pending[:length])
            self.pending = self.pending[length:]
        self.size += count
        self.digest.update(result)
        return bytes(result)

    def integer(self) -> int:
        return struct.unpack(">Q", self.take(8))[0]

    def scalar(self) -> object:
        kind = self.take(1)
        if kind == b"n":
            return None
        if kind == b"i":
            return struct.unpack(">q", self.take(8))[0]
        if kind == b"f":
            return struct.unpack(">d", self.take(8))[0]
        if kind in (b"s", b"b"):
            length = self.integer()
            if length > MAX_VALUE_BYTES:
                raise ValueError("SQLite row value exceeds budget")
            value = self.take(length)
            return value.decode("utf-8") if kind == b"s" else value
        raise ValueError("unsupported SQLite row input type")

    def finish(self, expected: str) -> None:
        # Advancing to EOF also consumes the transport's final acknowledgement.
        if self.pending or next(self.chunks, None) is not None:
            raise ValueError("trailing SQLite row input")
        if time.monotonic() >= self.deadline or self.digest.hexdigest() != expected:
            raise ValueError("SQLite row input identity changed")


def restore_rows(
    connection: sqlite3.Connection, chunks: Iterable[bytes], expected: str, *, deadline: float
) -> None:
    """Populate an empty private candidate layout, then prove exact typed identity.

    The caller owns the in-memory connection and disposes it on any error. No
    disk access, migration or source-version repair is performed here. Actual
    source readers must run afterwards on the resulting read-only connection.
    """
    if (
        connection.execute("PRAGMA query_only").fetchone()[0]
        or connection.execute("PRAGMA foreign_keys").fetchone()[0]
    ):
        raise ValueError("SQLite row replay requires an isolated writable layout")
    databases = connection.execute("PRAGMA database_list").fetchall()
    if any(row[2] for row in databases) or any(row[1] not in {"main", "temp"} for row in databases):
        raise ValueError("SQLite row replay requires memory-only storage")
    listed = connection.execute("PRAGMA main.table_list").fetchall()
    if not any(row[1] == "sqlite_schema" for row in listed):
        raise ValueError("SQLite runtime cannot inventory row tables")
    tables = sorted(
        (
            row
            for row in listed
            if row[0] == "main"
            and (not row[1].lower().startswith("sqlite_") or row[1] == "sqlite_sequence")
        ),
        key=lambda row: row[1],
    )
    stream = _RowInput(chunks, deadline)
    if len(tables) > MAX_ROW_TABLES or stream.integer() != len(tables):
        raise ValueError("SQLite row table coverage changed")
    sequence = []
    sequence_columns = None
    for table in tables:
        name = table[1]
        if table[2] != "table" or stream.scalar() != name:
            raise ValueError("SQLite row table identity changed")
        columns = connection.execute(f"PRAGMA main.table_xinfo({_quote(name)})").fetchall()
        names = [row[1] for row in columns]
        shadowed = {name.casefold() for name in names}
        if not names or len(shadowed) != len(names):
            raise ValueError("unsupported SQLite row columns")
        identity = (
            None
            if table[4]
            else next((name for name in ("rowid", "_rowid_", "oid") if name not in shadowed), None)
        )
        if not table[4] and identity is None:
            raise ValueError("SQLite row identity is unavailable")
        selected = names if table[4] else [identity, *names]
        if stream.integer() != len(selected) or any(
            stream.scalar() != column for column in selected
        ):
            raise ValueError("SQLite row column identity changed")
        if (
            name != "sqlite_sequence"
            and connection.execute(f"SELECT 1 FROM main.{_quote(name)} LIMIT 1").fetchone()
            is not None
        ):
            raise ValueError("SQLite row replay requires empty tables")
        # Generated columns are observed but recomputed by SQLite. Rehashing
        # below rejects any change caused by expressions or type affinity.
        writable = ([identity] if identity is not None else []) + [
            row[1] for row in columns if not row[6]
        ]
        indices = [selected.index(column) for column in writable]
        sql = f"INSERT INTO main.{_quote(name)} ({','.join(_quote(column) for column in writable)}) VALUES ({','.join('?' for _ in writable)})"
        count = 0
        while True:
            marker = stream.take(1)
            if marker == b"e":
                if stream.integer() != count:
                    raise ValueError("SQLite row count changed")
                break
            if marker != b"r":
                raise ValueError("invalid SQLite row marker")
            values = [stream.scalar() for _ in selected]
            if name == "sqlite_sequence":
                # Later table inserts may alter high-water marks. Restore them
                # last, including row identity and entries for deleted rows.
                if count >= MAX_ROW_TABLES or any(
                    isinstance(value, (bytes, str)) and len(value) > 4096 for value in values
                ):
                    raise ValueError("SQLite sequence exceeds budget")
                sequence.append(tuple(values[index] for index in indices))
                sequence_columns = sql
            else:
                connection.execute(sql, tuple(values[index] for index in indices))
            count += 1
    stream.finish(expected)
    if any(table[1] == "sqlite_sequence" for table in tables):
        connection.execute("DELETE FROM main.sqlite_sequence")
        if sequence_columns is not None:
            connection.executemany(sequence_columns, sequence)
    connection.commit()
    connection.execute("PRAGMA query_only=ON")
    if rows_digest(connection, deadline=deadline) != expected:
        raise ValueError("SQLite row replay changed typed values")
