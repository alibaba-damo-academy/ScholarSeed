"""Durable JSONL bodies; SQLite owns only references and committed extent."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Callable, Iterable, Iterator
from uuid import uuid4

from service.chat.persistence.utils import validate_transaction
from service.paths import SESSION_BODY_SUFFIX
from service.persistence.limits import SQLITE_VALUE_BYTES
from service.persistence.project import connect, database_files, reader, table_clauses
from service.platform import storage

BODY_TABLE = "session_body"
JOURNAL_TABLE = "session_journal"
GENERATION_TABLE = "session_body_generation"
LIVE_TABLE = "session_body_live"
COPY_TABLE = "session_body_copy"
GENERATION_STAGING = "staging"
GENERATION_RETIRED = "retired"
COMPACT_MIN_BYTES = 16 * 1024 * 1024
COMPACT_DEAD_DIVISOR = 4
COMPACT_PROGRESS_OPCODES = 1000
REFERENCE_PREFIX = "\x1escholarseed-body-v1:"
JOURNAL_SUFFIX = SESSION_BODY_SUFFIX
VERSION = 1
HEADER_TAG = "scholarseed-body-journal"
HEADER_LIMIT = 512
INITIAL_TOKEN = "initial-generation-v1"
TOKEN_PATTERN = re.compile(r"[0-9a-f]{32}\Z")
SINGLETON = 1
DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
RECORD_LIMIT = SQLITE_VALUE_BYTES
READ_CHUNK = 1024 * 1024
READ_CACHE_BYTES = 8 * 1024 * 1024
READ_CACHE_ITEMS = 1024
DEFINITIONS = {
    BODY_TABLE: f"""CREATE TABLE IF NOT EXISTS {BODY_TABLE} (
        digest TEXT PRIMARY KEY NOT NULL,
        offset INTEGER NOT NULL CHECK(offset >= 0),
        length INTEGER NOT NULL CHECK(length > 0)
    )""",
    JOURNAL_TABLE: f"""CREATE TABLE IF NOT EXISTS {JOURNAL_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        committed_bytes INTEGER NOT NULL CHECK(committed_bytes >= 0),
        active_generation INTEGER NOT NULL CHECK(active_generation >= 0),
        next_generation INTEGER NOT NULL CHECK(next_generation > active_generation),
        token TEXT NOT NULL
    )""",
    GENERATION_TABLE: f"""CREATE TABLE IF NOT EXISTS {GENERATION_TABLE} (
        generation INTEGER PRIMARY KEY CHECK(generation >= 0),
        state TEXT NOT NULL CHECK(state IN ('staging','retired')),
        token TEXT NOT NULL
    )""",
}


@dataclass(frozen=True)
class JournalSchema:
    create_tables: tuple[str, ...]

    @property
    def needs_write(self) -> bool:
        return bool(self.create_tables)


def inspect_connection(connection: sqlite3.Connection) -> JournalSchema:
    """Validate declarations without reading historical bodies."""
    missing = []
    for table, definition in DEFINITIONS.items():
        row = connection.execute(
            "SELECT type,sql FROM sqlite_master WHERE name=?", (table,)
        ).fetchone()
        if row is None:
            missing.append(table)
        elif row[0] != "table" or table_clauses(row[1], table) != table_clauses(definition, table):
            raise RuntimeError("unsupported session journal schema")
    if missing and len(missing) != len(DEFINITIONS):
        raise RuntimeError("incomplete session journal schema")
    return JournalSchema(tuple(missing))


def inspect_schema(database: Path) -> JournalSchema:
    """Inspect declarations only; opening the app never scans or compacts bodies."""
    with database_files(database) as present:
        if not present:
            return JournalSchema(tuple(DEFINITIONS))
        with reader(database) as connection:
            return inspect_connection(connection)


def initialize(connection: sqlite3.Connection) -> None:
    """Create empty indexes inside the caller's schema transaction."""
    if not connection.in_transaction:
        raise ValueError("journal initialization requires a transaction")
    schema = inspect_connection(connection)
    if schema.needs_write:
        for definition in DEFINITIONS.values():
            connection.execute(definition)
        connection.execute(
            f"INSERT INTO {JOURNAL_TABLE}(singleton,committed_bytes,active_generation,next_generation,token) VALUES (?,0,0,1,?)",
            (SINGLETON, INITIAL_TOKEN),
        )
    _extent(connection)


def _state(connection: sqlite3.Connection) -> tuple[int, int, int, str]:
    rows = connection.execute(
        f"SELECT singleton,committed_bytes,active_generation,next_generation,token FROM {JOURNAL_TABLE}"
    ).fetchall()
    if (
        len(rows) != SINGLETON
        or rows[0][0] != SINGLETON
        or any(not isinstance(value, int) or value < 0 for value in rows[0][1:4])
        or rows[0][3] <= rows[0][2]
    ):
        raise RuntimeError("invalid session journal state")
    header = _header(rows[0][2], rows[0][4])
    if 0 < rows[0][1] < len(header):
        raise RuntimeError("session journal extent truncates its header")
    return rows[0][2], rows[0][1], rows[0][3], rows[0][4]


def _extent(connection: sqlite3.Connection) -> int:
    return _state(connection)[1]


def _filename(generation: int) -> str:
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        raise ValueError("invalid session journal generation")
    return f"{generation}.jsonl"


def _header(generation: int, token: str) -> bytes:
    _filename(generation)
    if not isinstance(token, str) or not (
        token == INITIAL_TOKEN if generation == 0 else TOKEN_PATTERN.fullmatch(token)
    ):
        raise ValueError("invalid session journal token")
    return (
        json.dumps([HEADER_TAG, VERSION, generation, token], separators=(",", ":")) + "\n"
    ).encode("ascii")


def _read_header(descriptor: int, generation: int, token: str) -> None:
    expected = _header(generation, token)
    if len(expected) > HEADER_LIMIT:
        raise ValueError("session journal header exceeds limit")
    os.lseek(descriptor, 0, os.SEEK_SET)
    if os.read(descriptor, len(expected)) != expected:
        raise RuntimeError("session journal generation header mismatch")


def _write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("session journal write made no progress")
        view = view[written:]


def _digest(reference: str) -> str:
    if not reference.startswith(REFERENCE_PREFIX):
        raise ValueError("invalid session body reference")
    digest = reference[len(REFERENCE_PREFIX) :]
    if DIGEST_PATTERN.fullmatch(digest) is None:
        raise ValueError("invalid session body digest")
    return digest


def _encode_record(digest: str, text: str) -> Iterator[bytes]:
    yield f'[{VERSION},"{digest}","'.encode("ascii")
    for start in range(0, len(text), READ_CHUNK):
        yield json.dumps(text[start : start + READ_CHUNK], ensure_ascii=False)[1:-1].encode("utf-8")
    yield b'"]\n'


class Journal:
    """Explicit database-bound journal; reads also support qualified SQL snapshots."""

    def __init__(self, connection: sqlite3.Connection, database: Path) -> None:
        if not database.is_absolute():
            raise ValueError("session journal requires an absolute database path")
        self.connection = connection
        self.database = database
        self.directory_path = database.with_suffix(JOURNAL_SUFFIX)
        self._generation: int | None = None
        self._committed_extent: int | None = None
        self._token: str | None = None
        self._directory: storage.DirectoryHandle | None = None
        self._descriptor: int | None = None
        self._writable = False
        self._cache: OrderedDict[tuple[str, int, int], tuple[str, int]] = OrderedDict()
        self._cache_bytes = 0

    @property
    def path(self) -> Path:
        generation = self._generation
        if generation is None:
            generation = _state(self.connection)[0]
        return self.directory_path / _filename(generation)

    def _snapshot(self) -> int:
        if self._generation is None:
            self._generation, self._committed_extent, _, self._token = _state(self.connection)
        if self._committed_extent is None:
            raise RuntimeError("session journal snapshot is missing")
        return self._committed_extent

    def __enter__(self) -> Journal:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close(validate=exc_type is None)

    def close(self, *, validate: bool = True) -> None:
        failures: list[Exception] = []
        if validate and self._descriptor is not None:
            try:
                self._validate_file(self._snapshot())
            except Exception as error:
                failures.append(error)
        if self._descriptor is not None:
            descriptor, self._descriptor = self._descriptor, None
            try:
                os.close(descriptor)
            except Exception as error:
                failures.append(error)
        if self._directory is not None:
            directory, self._directory = self._directory, None
            try:
                directory.close()
            except Exception as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("session journal close failures", failures)

    def _open(self, *, write: bool, extent: int) -> int:
        if self._descriptor is not None:
            if write and not self._writable:
                raise RuntimeError("cannot upgrade a pinned journal reader")
            return self._descriptor
        self._snapshot()
        directory = storage.open_private_child(
            self.database.parent, self.directory_path.name, create=write
        )
        flags = os.O_RDWR if write else os.O_RDONLY
        created = False
        try:
            if write and extent == 0:
                try:
                    descriptor = directory.open_private(
                        self.path.name, flags | os.O_CREAT | os.O_EXCL, lock=True
                    )
                    created = True
                except FileExistsError:
                    descriptor = directory.open_private(self.path.name, flags, lock=True)
            else:
                descriptor = directory.open_private(self.path.name, flags, lock=True)
        except BaseException:
            directory.close()
            raise
        self._directory = directory
        self._descriptor = descriptor
        self._writable = write
        if self._generation is None or self._token is None:
            raise RuntimeError("session journal generation is not bound")
        if created:
            _write_all(descriptor, _header(self._generation, self._token))
        else:
            _read_header(descriptor, self._generation, self._token)
        self._validate_file(extent)
        return descriptor

    def put(self, text: str) -> str:
        """Durably append before publishing SQL references in the same transaction."""
        return self.put_many((text,))[0]

    def put_many(self, texts: Iterable[str]) -> tuple[str, ...]:
        """Append a caller-bounded batch with one durability barrier before SQL."""
        validate_transaction(self.connection, self.database)
        self.connection.execute(
            f"UPDATE {JOURNAL_TABLE} SET committed_bytes=committed_bytes WHERE singleton=?",
            (SINGLETON,),
        )
        self._cache.clear()
        self._cache_bytes = 0
        generation, extent, _, token = _state(self.connection)
        if self._generation is not None and self._generation != generation:
            raise RuntimeError("session journal generation changed")
        self._generation, self._committed_extent, self._token = generation, extent, token
        descriptor = self._open(write=True, extent=extent)
        self._validate_file(extent)
        extent = max(extent, len(_header(generation, token)))
        os.ftruncate(descriptor, extent)
        os.lseek(descriptor, extent, os.SEEK_SET)
        pending: dict[str, tuple[int, int]] = {}
        references = []
        position = extent
        for text in texts:
            if len(text) > SQLITE_VALUE_BYTES:
                raise ValueError("session body exceeds value limit")
            raw = text.encode("utf-8")
            if len(raw) > SQLITE_VALUE_BYTES:
                raise ValueError("session body exceeds value limit")
            digest = hashlib.sha256(raw).hexdigest()
            reference = REFERENCE_PREFIX + digest
            references.append(reference)
            if digest in pending:
                continue
            if self.connection.execute(
                f"SELECT 1 FROM {BODY_TABLE} WHERE digest=?", (digest,)
            ).fetchone():
                if self.get(reference) != text:
                    raise RuntimeError("session body digest collision")
                continue
            record = bytearray()
            for encoded in _encode_record(digest, text):
                if len(record) + len(encoded) > RECORD_LIMIT:
                    raise ValueError("encoded session body exceeds value limit")
                record.extend(encoded)
            os.lseek(descriptor, position, os.SEEK_SET)
            view = memoryview(record)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("session journal write made no progress")
                view = view[written:]
            pending[digest] = (position, len(record))
            position += len(record)
        os.fsync(descriptor)
        if self._directory is None:
            raise RuntimeError("session journal directory is not pinned")
        self._directory.sync()
        self._validate_file(position)
        self.connection.executemany(
            f"INSERT INTO {BODY_TABLE}(digest,offset,length) VALUES (?,?,?)",
            ((digest, offset, length) for digest, (offset, length) in pending.items()),
        )
        self.connection.execute(
            f"UPDATE {JOURNAL_TABLE} SET committed_bytes=? WHERE singleton=?",
            (position, SINGLETON),
        )
        self._committed_extent = position
        return tuple(references)

    def _validate_file(self, extent: int) -> None:
        if self._directory is None or self._descriptor is None:
            raise RuntimeError("session journal is not pinned")
        opened = os.fstat(self._descriptor)
        named = self._directory.stat(self.path.name)
        if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("session journal identity changed")
        if opened.st_size < extent or named.st_size < extent:
            raise RuntimeError("truncated committed session journal")
        if self._generation is None or self._token is None:
            raise RuntimeError("session journal generation is not bound")
        _read_header(self._descriptor, self._generation, self._token)

    def get(self, reference: str) -> str:
        digest = _digest(reference)
        self._snapshot()
        row = self.connection.execute(
            f"SELECT offset,length FROM {BODY_TABLE} WHERE digest=?", (digest,)
        ).fetchone()
        if row is None:
            raise RuntimeError("missing session body index")
        return self._read_indexed(digest, row[0], row[1])

    def _read_indexed(self, digest: str, offset: int, length: int) -> str:
        """Read a row from this SQL snapshot; native qualification pins its generation.

        Committed bytes are immutable until an exclusively qualified rotation.
        Pin and validate the file at open/close; each record retains independent
        bounds, framing and SHA256 checks without per-record filesystem stats.
        """
        _digest(REFERENCE_PREFIX + digest)
        extent = self._snapshot()
        if self._generation is None or self._token is None:
            raise RuntimeError("session journal generation is not bound")
        if (
            not isinstance(offset, int)
            or not isinstance(length, int)
            or offset < len(_header(self._generation, self._token))
            or length <= 0
            or length > RECORD_LIMIT
            or offset + length > extent
        ):
            raise RuntimeError("invalid session body bounds")
        descriptor = self._open(write=False, extent=extent)
        key = (digest, offset, length)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key][0]
        os.lseek(descriptor, offset, os.SEEK_SET)
        record = bytearray()
        while len(record) < length:
            chunk = os.read(descriptor, min(READ_CHUNK, length - len(record)))
            if not chunk:
                raise RuntimeError("truncated session body")
            record.extend(chunk)
        if not record.endswith(b"\n") or b"\n" in record[:-1]:
            raise RuntimeError("invalid session body framing")
        try:
            value = json.loads(record)
        except (ValueError, UnicodeError) as error:
            raise RuntimeError("invalid session body encoding") from error
        if (
            not isinstance(value, list)
            or len(value) != 3
            or not isinstance(value[0], int)
            or isinstance(value[0], bool)
            or value[0] != VERSION
            or value[1] != digest
            or not isinstance(value[2], str)
        ):
            raise RuntimeError("invalid session body record")
        raw = value[2].encode("utf-8")
        if len(raw) > SQLITE_VALUE_BYTES or hashlib.sha256(raw).hexdigest() != digest:
            raise RuntimeError("session body digest mismatch")
        if len(raw) <= READ_CACHE_BYTES:
            while self._cache and (
                self._cache_bytes + len(raw) > READ_CACHE_BYTES
                or len(self._cache) >= READ_CACHE_ITEMS
            ):
                _, (_, size) = self._cache.popitem(last=False)
                self._cache_bytes -= size
            self._cache[key] = (value[2], len(raw))
            self._cache_bytes += len(raw)
        return value[2]


def inspect_rows(connection: sqlite3.Connection, database: Path) -> None:
    """Validate every indexed body without interpreting any uncommitted tail."""
    generation, extent, next_generation, token = _state(connection)
    for record in connection.execute(f"SELECT generation,state,token FROM {GENERATION_TABLE}"):
        _header(record[0], record[2])
        if (
            record[0] == generation
            or record[0] >= next_generation
            or record[1] not in (GENERATION_STAGING, GENERATION_RETIRED)
        ):
            raise RuntimeError("invalid session body generation manifest")
    with Journal(connection, database) as journal:
        if extent:
            journal._open(write=False, extent=extent)
            journal._validate_file(extent)
        with closing(
            connection.execute(f"SELECT digest,offset,length FROM {BODY_TABLE} ORDER BY offset")
        ) as rows:
            for row in rows:
                journal._read_indexed(row[0], row[1], row[2])
        if extent:
            journal._validate_file(extent)


def inspect_index_rows(connection: sqlite3.Connection, database: Path) -> None:
    """Validate SQL indices and pinned generation, without claiming body coverage.

    Compiled product owners must separately read/hash/decode every live reference.
    This metadata pass also covers unreferenced indices awaiting scheduled GC.
    """
    generation, extent, next_generation, token = _state(connection)
    for record in connection.execute(f"SELECT generation,state,token FROM {GENERATION_TABLE}"):
        _header(record[0], record[2])
        if (
            record[0] == generation
            or record[0] >= next_generation
            or record[1] not in (GENERATION_STAGING, GENERATION_RETIRED)
        ):
            raise RuntimeError("invalid session body generation manifest")
    end = len(_header(generation, token)) if extent else 0
    with Journal(connection, database) as journal:
        if extent:
            journal._open(write=False, extent=extent)
        with closing(
            connection.execute(f"SELECT digest,offset,length FROM {BODY_TABLE} ORDER BY offset")
        ) as rows:
            for digest, offset, length in rows:
                _digest(REFERENCE_PREFIX + digest)
                if (
                    not isinstance(offset, int)
                    or not isinstance(length, int)
                    or offset < end
                    or length <= 0
                    or length > RECORD_LIMIT
                    or offset + length > extent
                ):
                    raise RuntimeError("invalid or overlapping session body index")
                end = offset + length


class _CompactionExpired(RuntimeError):
    """The scheduled owner can retry an uncommitted generation later."""


def _check_deadline(deadline: float | None) -> None:
    if deadline is not None and time.monotonic() >= deadline:
        raise _CompactionExpired("session body compaction budget expired")


def _maintenance_connection(database: Path) -> sqlite3.Connection:
    with database_files(database) as present:
        if not present:
            raise FileNotFoundError(database)
    connection = connect(database)
    try:
        connection.execute("PRAGMA busy_timeout=0")
        connection.execute("PRAGMA temp_store=FILE")
        return connection
    except BaseException:
        connection.close()
        raise


def _collect_live(
    connection: sqlite3.Connection,
    references: Callable[[sqlite3.Connection], Iterable[str]],
    deadline: float | None,
) -> int:
    connection.execute(f"CREATE TEMP TABLE IF NOT EXISTS {LIVE_TABLE}(digest TEXT PRIMARY KEY)")
    connection.execute(f"DELETE FROM {LIVE_TABLE}")
    for reference in references(connection):
        _check_deadline(deadline)
        connection.execute(
            f"INSERT OR IGNORE INTO {LIVE_TABLE}(digest) VALUES (?)", (_digest(reference),)
        )
    if connection.execute(
        f"SELECT 1 FROM {LIVE_TABLE} AS live LEFT JOIN {BODY_TABLE} AS body "
        "ON live.digest=body.digest WHERE body.digest IS NULL LIMIT 1"
    ).fetchone():
        raise RuntimeError("live session body index is missing")
    return connection.execute(
        f"SELECT COALESCE(SUM(body.length),0) FROM {LIVE_TABLE} AS live "
        f"JOIN {BODY_TABLE} AS body ON body.digest=live.digest"
    ).fetchone()[0]


def cleanup(database: Path, *, deadline: float | None = None) -> int:
    """Remove only SQL-manifested inactive generations under exclusive qualification.

    The currently committed file must still exist before retiring a former one.
    Deletion precedes manifest commit: a crash retries a known missing file, never
    guesses ownership by scanning names or removes the active generation.
    """
    removed = 0
    with closing(_maintenance_connection(database)) as connection:
        try:
            connection.execute("BEGIN IMMEDIATE")
            generation, extent, _, token = _state(connection)
            with Journal(connection, database) as active:
                if extent:
                    active._open(write=False, extent=extent)
                    active._validate_file(extent)
                records = connection.execute(
                    f"SELECT generation,state,token FROM {GENERATION_TABLE} ORDER BY generation"
                ).fetchall()
                for retired, status, retired_token in records:
                    _check_deadline(deadline)
                    if retired == generation or status not in (
                        GENERATION_STAGING,
                        GENERATION_RETIRED,
                    ):
                        raise RuntimeError("invalid session body cleanup manifest")
                    directory_path = database.with_suffix(JOURNAL_SUFFIX)
                    try:
                        with closing(
                            storage.open_private_child(database.parent, directory_path.name)
                        ) as directory:
                            try:
                                descriptor = directory.open_private(
                                    _filename(retired), os.O_RDONLY, lock=True
                                )
                                try:
                                    _read_header(descriptor, retired, retired_token)
                                    identity = os.fstat(descriptor)
                                finally:
                                    os.close(descriptor)
                                directory.unlink(_filename(retired), expected=identity)
                            except FileNotFoundError:
                                pass
                            directory.sync()
                    except FileNotFoundError:
                        # A reserved staging generation can fail before its first
                        # file/directory creation; there is then nothing to unlink.
                        if extent:
                            raise
                    connection.execute(
                        f"DELETE FROM {GENERATION_TABLE} WHERE generation=?", (retired,)
                    )
                    removed += 1
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
    return removed


def compact(
    database: Path,
    live_references: Callable[[sqlite3.Connection], Iterable[str]],
    deadline: float | None = None,
) -> bool:
    """Rotate a dead-heavy journal, only from scheduled exclusive maintenance.

    Reserve staging ownership durably before creating a file. Copy and validate
    live bodies in bounded memory, fsync before atomically publishing all offsets
    and the generation, then retire the old file. Failures before publication
    preserve the original generation; failures afterwards retain cleanup records.
    A budget is cooperative, not a hard filesystem-I/O deadline.
    """
    published = False
    try:
        _check_deadline(deadline)
        cleanup(database, deadline=deadline)
        with closing(_maintenance_connection(database)) as connection:
            if deadline is not None:
                connection.set_progress_handler(
                    lambda: int(time.monotonic() >= deadline), COMPACT_PROGRESS_OPCODES
                )
            try:
                connection.execute("BEGIN IMMEDIATE")
                generation, extent, target, token = _state(connection)
                target_token = uuid4().hex
                live_bytes = _collect_live(connection, live_references, deadline)
                dead_bytes = max(0, extent - len(_header(generation, token))) - live_bytes
                if dead_bytes < 0:
                    raise RuntimeError("overlapping session body extents")
                if dead_bytes < COMPACT_MIN_BYTES or dead_bytes * COMPACT_DEAD_DIVISOR < extent:
                    connection.rollback()
                    return False
                connection.execute(
                    f"INSERT INTO {GENERATION_TABLE}(generation,state,token) VALUES (?,?,?)",
                    (target, GENERATION_STAGING, target_token),
                )
                connection.execute(
                    f"UPDATE {JOURNAL_TABLE} SET next_generation=? WHERE singleton=?",
                    (target + 1, SINGLETON),
                )
                connection.commit()
                # Reacquire SQLite serialization and recollect references after
                # reserving the file. The exclusive application qualification is
                # still held, and no presumed snapshot crosses this SQL commit.
                connection.execute("BEGIN IMMEDIATE")
                if _state(connection)[:2] != (generation, extent):
                    raise RuntimeError("session journal changed before compaction")
                _collect_live(connection, live_references, deadline)
                connection.execute(
                    f"CREATE TEMP TABLE {COPY_TABLE}(digest TEXT PRIMARY KEY,offset INTEGER,length INTEGER)"
                )
                position = len(_header(target, target_token))
                directory_path = database.with_suffix(JOURNAL_SUFFIX)
                with (
                    Journal(connection, database) as source,
                    closing(
                        storage.open_private_child(
                            database.parent, directory_path.name, create=True
                        )
                    ) as directory,
                ):
                    descriptor = directory.open_private(
                        _filename(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, lock=True
                    )
                    try:
                        _write_all(descriptor, _header(target, target_token))
                        with closing(
                            connection.execute(
                                f"SELECT live.digest,body.offset,body.length FROM {LIVE_TABLE} AS live "
                                f"JOIN {BODY_TABLE} AS body ON body.digest=live.digest ORDER BY body.offset"
                            )
                        ) as records:
                            for digest, offset, original_length in records:
                                _check_deadline(deadline)
                                text = source._read_indexed(digest, offset, original_length)
                                length = 0
                                for encoded in _encode_record(digest, text):
                                    _check_deadline(deadline)
                                    length += len(encoded)
                                    if length > RECORD_LIMIT:
                                        raise ValueError("encoded session body exceeds value limit")
                                    view = memoryview(encoded)
                                    while view:
                                        written = os.write(descriptor, view)
                                        if written <= 0:
                                            raise OSError(
                                                "session body compaction made no progress"
                                            )
                                        view = view[written:]
                                connection.execute(
                                    f"INSERT INTO {COPY_TABLE}(digest,offset,length) VALUES (?,?,?)",
                                    (digest, position, length),
                                )
                                position += length
                        os.fsync(descriptor)
                        directory.sync()
                        opened = os.fstat(descriptor)
                        named = directory.stat(_filename(target))
                        if (opened.st_dev, opened.st_ino, opened.st_size) != (
                            named.st_dev,
                            named.st_ino,
                            position,
                        ):
                            raise RuntimeError("compacted session body identity changed")
                    finally:
                        os.close(descriptor)
                _check_deadline(deadline)
                connection.execute(
                    f"DELETE FROM {BODY_TABLE} WHERE digest NOT IN (SELECT digest FROM {COPY_TABLE})"
                )
                connection.execute(
                    f"UPDATE {BODY_TABLE} SET offset=(SELECT offset FROM {COPY_TABLE} "
                    f"WHERE {COPY_TABLE}.digest={BODY_TABLE}.digest), "
                    f"length=(SELECT length FROM {COPY_TABLE} WHERE {COPY_TABLE}.digest={BODY_TABLE}.digest)"
                )
                connection.execute(
                    f"UPDATE {JOURNAL_TABLE} SET active_generation=?,committed_bytes=?,token=? WHERE singleton=?",
                    (target, position, target_token, SINGLETON),
                )
                connection.execute(f"DELETE FROM {GENERATION_TABLE} WHERE generation=?", (target,))
                connection.execute(
                    f"INSERT INTO {GENERATION_TABLE}(generation,state,token) VALUES (?,?,?)",
                    (generation, GENERATION_RETIRED, token),
                )
                connection.commit()
                published = True
            except BaseException:
                connection.rollback()
                raise
            finally:
                connection.set_progress_handler(None, 0)
        cleanup(database, deadline=deadline)
        return True
    except _CompactionExpired:
        return published
    except sqlite3.OperationalError as error:
        if (
            error.sqlite_errorcode == sqlite3.SQLITE_INTERRUPT
            and deadline is not None
            and time.monotonic() >= deadline
        ):
            return published
        raise
