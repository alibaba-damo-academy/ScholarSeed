"""Bounded, append-only event blocks with transactional SQLite extents."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Generator, Iterable, Iterator, Mapping
from uuid import uuid4

from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
)
from service.chat.persistence.utils import validate_transaction
from service.paths import SESSION_BLOCK_SUFFIX
from service.persistence.limits import SQLITE_VALUE_BYTES
from service.persistence.project import connect, table_clauses
from service.platform import storage

TABLE = "session_event_block"
BLOCK_TABLE = TABLE
SEQUENCE_INDEX = "session_event_block_sequence"
INDEX_DEFINITION = (
    f"CREATE UNIQUE INDEX IF NOT EXISTS {SEQUENCE_INDEX} ON {TABLE}(session_id, first_seq)"
)
MAX_EVENTS = 256
MAX_BYTES = 256 * 1024
MAX_DECODED_BYTES = 8 * 1024 * 1024
KINDS = frozenset(
    (PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_REASONING_DELTA, PRODUCT_EVENT_TOOL_OUTPUT_DELTA)
)
STREAM_KINDS = KINDS
BLOCK_KINDS = KINDS
BLOOM_BYTES = 512
HEADER_LIMIT = 4096
VERSION = 1
NAMESPACE = "namespace.json"
DEFINITION = f"""CREATE TABLE IF NOT EXISTS {TABLE} (
 session_id TEXT NOT NULL, block_no INTEGER NOT NULL CHECK(block_no >= 0),
 first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
 offset INTEGER NOT NULL CHECK(offset >= 0), committed_end INTEGER NOT NULL,
 count INTEGER NOT NULL CHECK(count > 0 AND count <= 256),
 bloom BLOB NOT NULL, checksum BLOB NOT NULL,
 PRIMARY KEY(session_id, block_no),
 FOREIGN KEY(session_id) REFERENCES session_catalog(session_id) ON DELETE CASCADE,
 CHECK(committed_end > offset),
 CHECK(last_seq >= first_seq)
)"""


@dataclass(frozen=True)
class BlockSchema:
    create_tables: tuple[str, ...]
    create_indexes: tuple[str, ...] = ()

    @property
    def needs_write(self) -> bool:
        return bool(self.create_tables or self.create_indexes)


def inspect_connection(connection: sqlite3.Connection) -> BlockSchema:
    row = connection.execute("SELECT type,sql FROM sqlite_master WHERE name=?", (TABLE,)).fetchone()
    if row is None:
        return BlockSchema((TABLE,), (SEQUENCE_INDEX,))
    if row[0] != "table" or table_clauses(row[1], TABLE) != table_clauses(DEFINITION, TABLE):
        raise RuntimeError("unsupported event block schema")
    index = connection.execute(
        "SELECT type,sql FROM sqlite_master WHERE name=?", (SEQUENCE_INDEX,)
    ).fetchone()
    if index is None:
        return BlockSchema((), (SEQUENCE_INDEX,))
    with closing(sqlite3.connect(":memory:")) as reference:
        reference.execute(DEFINITION)
        reference.execute(INDEX_DEFINITION)
        expected = reference.execute(
            "SELECT sql FROM sqlite_master WHERE name=?", (SEQUENCE_INDEX,)
        ).fetchone()[0]
    if (
        index[0] != "index"
        or "".join(index[1].split()).lower() != "".join(expected.split()).lower()
    ):
        raise RuntimeError("unsupported event block sequence index")
    return BlockSchema(())


def initialize(connection: sqlite3.Connection) -> None:
    if not connection.in_transaction:
        raise RuntimeError("event block initialization requires transaction")
    schema = inspect_connection(connection)
    if schema.create_tables:
        connection.execute(DEFINITION)
    if schema.create_indexes:
        connection.execute(INDEX_DEFINITION)


def _pieces(value: Any) -> Iterator[bytes]:
    if isinstance(value, str):
        yield b'"'
        for start in range(0, len(value), 16384):
            yield json.dumps(value[start : start + 16384], ensure_ascii=False)[1:-1].encode("utf-8")
        yield b'"'
    elif isinstance(value, (list, tuple)):
        yield b"["
        for index, item in enumerate(value):
            if index:
                yield b","
            yield from _pieces(item)
        yield b"]"
    elif isinstance(value, dict):
        yield b"{"
        for index, (key, item) in enumerate(value.items()):
            if index:
                yield b","
            yield from _pieces(key)
            yield b":"
            yield from _pieces(item)
        yield b"}"
    else:
        yield json.dumps(value, separators=(",", ":")).encode("ascii")


def _line(value: Any) -> bytes:
    result = bytearray()
    for piece in _pieces(value):
        if len(result) + len(piece) + 1 > SQLITE_VALUE_BYTES:
            raise ValueError("event block record exceeds value limit")
        result.extend(piece)
    result.extend(b"\n")
    return bytes(result)


def _write(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        size = os.write(fd, view)
        if size <= 0:
            raise OSError("incomplete event block write")
        view = view[size:]


def _read(fd: int, offset: int, size: int) -> bytes:
    os.lseek(fd, offset, os.SEEK_SET)
    parts = bytearray()
    while len(parts) < size:
        chunk = os.read(fd, size - len(parts))
        if not chunk:
            raise RuntimeError("truncated event block")
        parts.extend(chunk)
    return bytes(parts)


def _name(session: str) -> str:
    return hashlib.sha256(session.encode("utf-8")).hexdigest() + ".jsonl"


def _bloom(keys: Iterator[str]) -> bytes:
    result = bytearray(BLOOM_BYTES)
    for key in keys:
        digest = hashlib.sha256(key.encode("utf-8")).digest()
        for offset in range(0, 16, 2):
            bit = int.from_bytes(digest[offset : offset + 2], "big") % (BLOOM_BYTES * 8)
            result[bit // 8] |= 1 << (bit % 8)
    return bytes(result)


def _contains(bloom: bytes, key: str) -> bool:
    if len(bloom) != BLOOM_BYTES:
        raise RuntimeError("invalid event block bloom")
    sought = _bloom(iter((key,)))
    return all((a & b) == b for a, b in zip(bloom, sought))


def _identity(event: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(
        event.get(key)
        for key in ("runtime_id", "vendor_thread_id", "vendor_turn_id", "vendor_item_id", "kind")
    )


class BlockStore:
    def __init__(self, connection: sqlite3.Connection, database: Path):
        self.connection = connection
        self.database = database
        self.directory_path = database.with_suffix(SESSION_BLOCK_SUFFIX)
        self._directory: storage.DirectoryHandle | None = None
        self._writable = False
        self._namespace_fd: int | None = None
        self._namespace_identity: tuple[int, int, int, int] | None = None
        self._token: str | None = None
        self._batch_files: dict[str, int] | None = None
        self._batch_extents: dict[str, tuple[int, int, int, int]] = {}
        self._read_session: str | None = None
        self._read_fd: int | None = None
        self._read_identity: tuple[int, int, int, int] | None = None
        self._read_ranges: dict[int, tuple[int, bytes]] = {}
        self._cache_decoded_bytes = 0
        self._cache_identity: tuple[int, int, int, int] | None = None
        self._cache: tuple[tuple[Any, ...], bytes, list[dict[str, Any]]] | None = None

    def __enter__(self) -> BlockStore:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    @staticmethod
    def _file_identity(info: os.stat_result) -> tuple[int, int, int, int]:
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns

    def _verify_namespace(self) -> None:
        if self._namespace_fd is None or self._directory is None:
            raise RuntimeError("missing event block namespace pin")
        info = os.fstat(self._namespace_fd)
        named = self._directory.stat(NAMESPACE)
        if self._file_identity(info) != self._namespace_identity or (
            named.st_dev,
            named.st_ino,
        ) != (info.st_dev, info.st_ino):
            raise RuntimeError("event block namespace changed")

    def _validate_reader(self) -> None:
        fd, session, expected = self._read_fd, self._read_session, self._read_identity
        if fd is None:
            return
        if self._directory is None or session is None or expected is None:
            raise RuntimeError("missing event block reader qualification")
        info = os.fstat(fd)
        named = self._directory.stat(_name(session))
        required = max(
            (offset + length for offset, (length, _) in self._read_ranges.items()), default=0
        )
        if (
            (info.st_dev, info.st_ino) != expected[:2]
            or (named.st_dev, named.st_ino) != expected[:2]
            or info.st_size < required
        ):
            raise RuntimeError("event block reader file identity or extent changed")
        if self._file_identity(info) != expected:
            # Only the committed prefix belongs to this SQL snapshot. A writer
            # may grow or roll back its tail; recheck every previously read
            # range before accepting a changed file or reusing cached content.
            self._cache = None
            for offset, (length, digest) in self._read_ranges.items():
                os.lseek(fd, offset, os.SEEK_SET)
                remaining = length
                actual = hashlib.sha256()
                while remaining:
                    chunk = os.read(fd, min(remaining, 1024 * 1024))
                    if not chunk:
                        raise RuntimeError("truncated committed event block prefix")
                    actual.update(chunk)
                    remaining -= len(chunk)
                if actual.digest() != digest:
                    raise RuntimeError("committed event block prefix changed")
            current = os.fstat(fd)
            if current.st_size < required:
                raise RuntimeError("truncated committed event block prefix")
            self._read_identity = self._file_identity(current)

    def _remember_range(self, row: Mapping[str, Any]) -> None:
        offset, length = row["offset"], row["committed_end"] - row["offset"]
        previous = self._read_ranges.get(offset)
        if previous is None or length >= previous[0]:
            self._read_ranges[offset] = (length, row["checksum"])

    def _close_reader(self, *, validate: bool = True) -> None:
        fd = self._read_fd
        if fd is None:
            return
        try:
            if validate:
                self._validate_reader()
        finally:
            self._read_fd = self._read_session = self._read_identity = None
            self._read_ranges = {}
            os.close(fd)

    def _reader(self, session: str) -> int:
        if self._read_session != session:
            self._close_reader()
            self._read_fd = self._file(session)
            self._read_session = session
            self._read_identity = self._file_identity(os.fstat(self._read_fd))
        assert self._read_fd is not None
        try:
            self._validate_reader()
        except BaseException:
            self._close_reader(validate=False)
            raise
        return self._read_fd

    def close(self) -> None:
        self._cache = None
        errors: list[Exception] = []
        try:
            self._close_reader()
        except Exception as error:
            errors.append(error)
        directory, self._directory = self._directory, None
        fd, self._namespace_fd = self._namespace_fd, None
        if fd is not None:
            try:
                info = os.fstat(fd)
                if directory is None:
                    raise RuntimeError("missing event block namespace directory")
                named = directory.stat(NAMESPACE)
                if (
                    info.st_dev,
                    info.st_ino,
                    info.st_size,
                    info.st_mtime_ns,
                ) != self._namespace_identity or (named.st_dev, named.st_ino) != (
                    info.st_dev,
                    info.st_ino,
                ):
                    raise RuntimeError("event block namespace changed")
            except Exception as error:
                errors.append(error)
            try:
                os.close(fd)
            except Exception as error:
                errors.append(error)
        if directory is not None:
            try:
                directory.close()
            except Exception as error:
                errors.append(error)
        if errors:
            raise ExceptionGroup("event block reader close failed", errors)

    def _open(self, write: bool = False) -> storage.DirectoryHandle:
        if self._directory is not None:
            if not write or self._writable:
                return self._directory
            self.close()
        directory = storage.open_private_child(
            self.database.parent, self.directory_path.name, create=write
        )
        try:
            try:
                fd = directory.open_private(NAMESPACE, os.O_RDONLY)
            except FileNotFoundError:
                if not write:
                    raise
                if os.listdir(self.directory_path):
                    raise RuntimeError("missing namespace for existing event block files")
                # The SQL writer lock serializes first namespace creation.
                fd = directory.open_private(NAMESPACE, os.O_RDWR | os.O_CREAT | os.O_EXCL)
                try:
                    _write(fd, _line(["scholarseed-event-blocks", VERSION, uuid4().hex]))
                    os.fsync(fd)
                    directory.sync()
                finally:
                    os.close(fd)
                fd = directory.open_private(NAMESPACE, os.O_RDONLY)
            try:
                size = os.fstat(fd).st_size
                if not 0 < size <= HEADER_LIMIT:
                    raise RuntimeError("invalid event block namespace")
                namespace = json.loads(_read(fd, 0, size))
                if (
                    not isinstance(namespace, list)
                    or len(namespace) != 3
                    or namespace[:2] != ["scholarseed-event-blocks", VERSION]
                    or not isinstance(namespace[2], str)
                    or len(namespace[2]) != 32
                    or any(c not in "0123456789abcdef" for c in namespace[2])
                ):
                    raise RuntimeError("invalid event block namespace")
                if self._token is not None and self._token != namespace[2]:
                    raise RuntimeError("event block namespace token changed")
                self._token = namespace[2]
                info = os.fstat(fd)
                self._namespace_identity = (
                    info.st_dev,
                    info.st_ino,
                    info.st_size,
                    info.st_mtime_ns,
                )
                self._namespace_fd = fd
            finally:
                if self._namespace_fd != fd:
                    os.close(fd)
            self._directory = directory
            self._writable = write
            return directory
        except BaseException:
            directory.close()
            raise

    def _header(self, session: str) -> bytes:
        result = _line(["session", VERSION, self._token, session])
        if len(result) > HEADER_LIMIT:
            raise ValueError("event block session identity too long")
        return result

    def _file(self, session: str, write: bool = False) -> int:
        directory = self._open(write)
        try:
            fd = directory.open_private(
                _name(session), os.O_RDWR if write else os.O_RDONLY, lock=True
            )
        except FileNotFoundError:
            if (
                not write
                or self.connection.execute(
                    f"SELECT 1 FROM {TABLE} WHERE session_id=? LIMIT 1", (session,)
                ).fetchone()
            ):
                raise
            fd = directory.open_private(
                _name(session), os.O_RDWR | os.O_CREAT | os.O_EXCL, lock=True
            )
            try:
                _write(fd, self._header(session))
                os.fsync(fd)
                directory.sync()
            except BaseException:
                os.close(fd)
                raise
        try:
            header = self._header(session)
            if _read(fd, 0, len(header)) != header:
                raise RuntimeError("event block file ownership mismatch")
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _decode(self, row: Mapping[str, Any]) -> tuple[bytes, list[dict[str, Any]]]:
        key = tuple(
            row[k]
            for k in (
                "session_id",
                "block_no",
                "first_seq",
                "last_seq",
                "offset",
                "committed_end",
                "count",
                "bloom",
                "checksum",
            )
        )
        if self._cache is not None and self._cache[0] == key:
            held = (
                self._batch_files.get(row["session_id"]) if self._batch_files is not None else None
            )
            fd = held if held is not None else self._reader(row["session_id"])
            if self._cache is None:
                return self._decode(row)
            info = os.fstat(fd)
            identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            if identity != self._cache_identity:
                if held is not None:
                    raise RuntimeError("cached event block writer file changed")
                self._cache = None
                return self._decode(row)
            if self._read_session == row["session_id"]:
                self._remember_range(row)
            return self._cache[1], self._cache[2]
        size = row["committed_end"] - row["offset"]
        if (
            not 0 < size <= SQLITE_VALUE_BYTES
            or not 0 < row["count"] <= MAX_EVENTS
            or (size > MAX_BYTES and row["count"] != 1)
        ):
            raise RuntimeError("invalid event block extent")
        fd = self._reader(row["session_id"])
        try:
            before = os.fstat(fd)
            if row["offset"] < len(self._header(row["session_id"])):
                raise RuntimeError("event block overlaps file header")
            raw = _read(fd, row["offset"], size)
            after = os.fstat(fd)
            named = self._open().stat(_name(row["session_id"]))
            if (named.st_dev, named.st_ino) != (after.st_dev, after.st_ino):
                raise RuntimeError("event block entry replaced")
            if (before.st_dev, before.st_ino) != (
                after.st_dev,
                after.st_ino,
            ) or after.st_size < row["committed_end"]:
                raise RuntimeError("event block changed during read")
        except BaseException:
            self._close_reader(validate=False)
            raise
        if hashlib.sha256(raw).digest() != row["checksum"] or not raw.endswith(b"\n"):
            raise RuntimeError("event block checksum mismatch")
        lines = raw.splitlines()
        header = json.loads(lines[0])
        if (
            not isinstance(header, list)
            or len(header) != 3
            or header[:2] != ["block", VERSION]
            or not isinstance(header[2], dict)
        ):
            raise RuntimeError("invalid event block header")
        base = header[2]
        events: list[dict[str, Any]] = []
        decoded_bytes = 0
        for line in lines[1:]:
            frame = json.loads(line)
            if not isinstance(frame, list) or len(frame) != 2 or not isinstance(frame[0], dict):
                raise RuntimeError("invalid event block frame")
            event = dict(base)
            event.update(frame[0])
            payload = frame[1]
            prefix_encoded = isinstance(payload, list)
            if prefix_encoded:
                if (
                    len(payload) != 2
                    or not events
                    or not isinstance(payload[0], int)
                    or isinstance(payload[0], bool)
                    or not isinstance(payload[1], str)
                    or not 0 <= payload[0] <= len(events[-1]["payload"])
                    or _identity(event) != _identity(events[-1])
                    or event.get("kind") != PRODUCT_EVENT_MESSAGE_DELTA
                ):
                    raise RuntimeError("invalid event block prefix")
                payload = events[-1]["payload"][: payload[0]] + payload[1]
            event["payload"] = payload
            self._validate(event)
            if prefix_encoded:
                old_text = json.loads(events[-1]["payload"]).get("delta")
                new_text = json.loads(payload).get("delta")
                if (
                    not isinstance(old_text, str)
                    or not isinstance(new_text, str)
                    or not old_text
                    or not new_text.startswith(old_text)
                    or len(new_text) <= len(old_text)
                ):
                    raise RuntimeError("event block prefix does not extend snapshot")
            decoded_bytes += len(payload.encode("utf-8"))
            if decoded_bytes > MAX_DECODED_BYTES and row["count"] != 1:
                raise RuntimeError("event block decoded byte limit exceeded")
            if event["session_id"] != row["session_id"] or (
                events and event["product_seq"] != events[-1]["product_seq"] + 1
            ):
                raise RuntimeError("invalid event block sequence")
            events.append(event)
        if (
            len(events) != row["count"]
            or events[0]["product_seq"] != row["first_seq"]
            or events[-1]["product_seq"] != row["last_seq"]
            or len({e["idempotency_key"] for e in events}) != len(events)
            or _bloom(iter(e["idempotency_key"] for e in events)) != row["bloom"]
        ):
            raise RuntimeError("event block index mismatch")
        self._remember_range(row)
        self._validate_reader()
        self._cache = key, raw, events
        self._cache_decoded_bytes = decoded_bytes
        self._cache_identity = self._read_identity
        return raw, events

    @staticmethod
    def _validate(event: Mapping[str, Any]) -> None:
        if isinstance(event.get("payload"), str) and len(event["payload"]) > SQLITE_VALUE_BYTES:
            raise ValueError("event payload exceeds value limit")
        if (
            event.get("kind") not in KINDS
            or not isinstance(event.get("payload"), str)
            or not isinstance(json.loads(event["payload"]), dict)
        ):
            raise ValueError("invalid block event payload or kind")
        for field in ("session_id", "idempotency_key", "runtime_id"):
            if not isinstance(event.get(field), str) or not event[field]:
                raise ValueError("missing block event identity")
        for field in ("product_seq", "event_id"):
            if (
                not isinstance(event.get(field), int)
                or isinstance(event[field], bool)
                or event[field] < 1
            ):
                raise ValueError("invalid block event sequence")

    def append(self, mapping: Mapping[str, Any]) -> None:
        if self._batch_files is None:
            validate_transaction(self.connection, self.database)
            self.connection.execute(f"UPDATE {TABLE} SET count=count WHERE 0")
        event = dict(mapping)
        self._validate(event)
        if self.by_key(event["session_id"], event["idempotency_key"]) is not None:
            raise ValueError("duplicate block event key")
        row = self.connection.execute(
            f"SELECT * FROM {TABLE} WHERE session_id=? ORDER BY block_no DESC LIMIT 1",
            (event["session_id"],),
        ).fetchone()
        previous: list[dict[str, Any]] = []
        previous_bytes = 0
        raw = b""
        if (
            row is not None
            and row["count"] < MAX_EVENTS
            and row["committed_end"] - row["offset"] < MAX_BYTES
            and event["product_seq"] == row["last_seq"] + 1
        ):
            raw, previous = self._decode(row)
            previous_bytes = self._cache_decoded_bytes
        occupied = self.connection.execute(
            f"SELECT 1 FROM {TABLE} WHERE session_id=? AND first_seq<=? AND last_seq>=? LIMIT 1",
            (event["session_id"], event["product_seq"], event["product_seq"]),
        ).fetchone()
        if occupied:
            raise ValueError("event sequence overlaps an existing block range")

        base = {k: v for k, v in event.items() if k != "payload"}

        def frame(baseline: Mapping[str, Any], prior: list[dict[str, Any]]) -> bytes:
            payload: Any = event["payload"]
            if (
                prior
                and event["kind"] == PRODUCT_EVENT_MESSAGE_DELTA
                and _identity(prior[-1]) == _identity(event)
            ):
                old_text = json.loads(prior[-1]["payload"]).get("delta")
                new_text = json.loads(payload).get("delta")
                if (
                    isinstance(old_text, str)
                    and isinstance(new_text, str)
                    and old_text
                    and new_text.startswith(old_text)
                    and len(new_text) > len(old_text)
                ):
                    old = prior[-1]["payload"]
                    common, upper = 0, min(len(old), len(payload))
                    while common < upper:
                        middle = (common + upper + 1) // 2
                        if old[:middle] == payload[:middle]:
                            common = middle
                        else:
                            upper = middle - 1
                    candidate = [common, payload[common:]]
                    if len(_line(candidate)) < len(_line(payload)):
                        payload = candidate
            return _line(
                [
                    {
                        k: v
                        for k, v in event.items()
                        if k != "payload" and (k not in baseline or baseline[k] != v)
                    },
                    payload,
                ]
            )

        baseline = json.loads(raw.split(b"\n", 1)[0])[2] if raw else base
        addition = frame(baseline, previous)
        event_bytes = len(event["payload"].encode("utf-8"))
        fresh = (
            not raw
            or len(previous) >= MAX_EVENTS
            or len(raw) + len(addition) > MAX_BYTES
            or any(k not in event for k in baseline)
            or (row is not None and event["product_seq"] != row["last_seq"] + 1)
            or previous_bytes + event_bytes > MAX_DECODED_BYTES
        )
        if fresh:
            raw = _line(["block", VERSION, base])
            previous = []
            previous_bytes = 0
            addition = frame(base, [])
        updated = raw + addition
        if len(updated) > SQLITE_VALUE_BYTES:
            raise ValueError("single event exceeds event block value limit")
        if self._batch_files is not None:
            fd = self._batch_files.get(event["session_id"])
            if fd is None:
                fd = self._file(event["session_id"], write=True)
                self._batch_files[event["session_id"]] = fd
        else:
            fd = self._file(event["session_id"], write=True)
        try:
            extent = (
                row["committed_end"] if row is not None else len(self._header(event["session_id"]))
            )
            actual_size = os.fstat(fd).st_size
            if actual_size < extent:
                raise RuntimeError("truncated committed event blocks")
            if actual_size > extent:
                os.ftruncate(fd, extent)
            os.lseek(fd, extent, os.SEEK_SET)
            _write(fd, updated if fresh else addition)
            if self._batch_files is None:
                os.fsync(fd)
                self._open().sync()
            written = os.fstat(fd)
            if self._batch_files is None:
                named = self._open().stat(_name(event["session_id"]))
                if (named.st_dev, named.st_ino) != (written.st_dev, written.st_ino):
                    raise RuntimeError("event block entry replaced before commit")
            else:
                self._batch_extents[event["session_id"]] = self._file_identity(written)
        finally:
            if self._batch_files is None:
                os.close(fd)
        if self._read_session == event["session_id"]:
            self._read_identity = self._file_identity(written)
        if fresh:
            block_no = row["block_no"] + 1 if row is not None else 0
            offset = extent
        else:
            assert row is not None
            block_no, offset = row["block_no"], row["offset"]
        all_events = previous + [event]
        added_bloom = int.from_bytes(_bloom(iter((event["idempotency_key"],))), "big")
        prior_bloom = int.from_bytes(row["bloom"], "big") if not fresh and row is not None else 0
        bloom = (prior_bloom | added_bloom).to_bytes(BLOOM_BYTES, "big")
        checksum = hashlib.sha256(updated).digest()
        index = (
            event["session_id"],
            block_no,
            all_events[0]["product_seq"],
            event["product_seq"],
            offset,
            offset + len(updated),
            len(all_events),
            bloom,
            checksum,
        )
        self.connection.execute(
            f"INSERT OR REPLACE INTO {TABLE} VALUES (?,?,?,?,?,?,?,?,?)",
            index,
        )
        self._cache = (index, updated, all_events)
        self._cache_decoded_bytes = previous_bytes + event_bytes
        self._cache_identity = (
            written.st_dev,
            written.st_ino,
            written.st_size,
            written.st_mtime_ns,
        )

    def append_many(self, mappings: Iterable[Mapping[str, Any]]) -> None:
        """Durably append a caller-bounded batch, rolling back SQL on any failure."""
        with self.batch():
            for mapping in mappings:
                self.append(mapping)

    @contextmanager
    def batch(self) -> Iterator[None]:
        validate_transaction(self.connection, self.database)
        if self._batch_files is not None:
            raise RuntimeError("nested event block batch")
        self.connection.execute(f"UPDATE {TABLE} SET count=count WHERE 0")
        self.connection.execute("SAVEPOINT event_block_batch")
        handles: dict[str, int] = {}
        self._batch_files = handles
        self._batch_extents = {}
        try:
            yield
            for session, fd in handles.items():
                info = os.fstat(fd)
                named = self._open().stat(_name(session))
                if self._file_identity(info) != self._batch_extents[session] or (
                    named.st_dev,
                    named.st_ino,
                ) != (
                    info.st_dev,
                    info.st_ino,
                ):
                    raise RuntimeError("event block batch file changed before commit")
                os.fsync(fd)
            if handles:
                self._open().sync()
                self._verify_namespace()
            while handles:
                _, fd = handles.popitem()
                os.close(fd)
            self.connection.execute("RELEASE SAVEPOINT event_block_batch")
        except BaseException as error:
            failures: list[BaseException] = [error]
            try:
                self.connection.execute("ROLLBACK TO SAVEPOINT event_block_batch")
                self.connection.execute("RELEASE SAVEPOINT event_block_batch")
            except BaseException as rollback_error:
                failures.append(rollback_error)
            while handles:
                _, fd = handles.popitem()
                try:
                    os.close(fd)
                except BaseException as close_error:
                    failures.append(close_error)
            self._cache = None
            self._cache_identity = None
            try:
                self._close_reader(validate=False)
            except BaseException as close_error:
                failures.append(close_error)
            if len(failures) > 1:
                raise BaseExceptionGroup("event block batch failed", failures) from None
            raise
        finally:
            self._batch_files = None
            self._batch_extents = {}

    def rows(
        self,
        session_id: str | None = None,
        after_seq: int = 0,
        kinds: set[str] | frozenset[str] | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        sql = f"SELECT * FROM {TABLE} WHERE last_seq>?"
        args: list[Any] = [after_seq]
        if session_id is not None:
            sql += f" AND session_id=? AND first_seq>=COALESCE((SELECT MAX(first_seq) FROM {TABLE} WHERE session_id=? AND first_seq<=?),0)"
            args.extend((session_id, session_id, after_seq))
        with closing(
            self.connection.execute(sql + " ORDER BY session_id,first_seq", args)
        ) as cursor:
            for row in cursor:
                for event in self._decode(row)[1]:
                    if event["product_seq"] > after_seq and (
                        kinds is None or event["kind"] in kinds
                    ):
                        yield dict(event)

    def by_key(self, session: str, key: str) -> dict[str, Any] | None:
        sought = int.from_bytes(_bloom(iter((key,))), "big")
        for candidate in self.connection.execute(
            f"SELECT block_no,bloom FROM {TABLE} WHERE session_id=? ORDER BY block_no DESC",
            (session,),
        ):
            bloom = candidate["bloom"]
            if not isinstance(bloom, bytes) or len(bloom) != BLOOM_BYTES:
                raise RuntimeError("invalid event block bloom")
            if int.from_bytes(bloom, "big") & sought != sought:
                continue
            row = self.connection.execute(
                f"SELECT * FROM {TABLE} WHERE session_id=? AND block_no=?",
                (session, candidate["block_no"]),
            ).fetchone()
            for event in self._decode(row)[1]:
                if event["idempotency_key"] == key:
                    return dict(event)
        return None


def inspect_rows(
    connection: sqlite3.Connection,
    database: Path | None = None,
    *,
    visit: Callable[[Mapping[str, Any]], None] | None = None,
) -> None:
    if database is None:
        if connection.execute(f"SELECT 1 FROM {TABLE} LIMIT 1").fetchone():
            raise ValueError("event block source database path required")
        return
    overlap = connection.execute(
        f"SELECT 1 FROM (SELECT first_seq,LAG(last_seq) OVER (PARTITION BY session_id ORDER BY first_seq) AS previous FROM {TABLE}) WHERE first_seq<=previous LIMIT 1"
    ).fetchone()
    if overlap:
        raise RuntimeError("overlapping event block sequence ranges")
    with BlockStore(connection, database) as store:
        previous: tuple[str, int, int] | None = None
        for row in connection.execute(f"SELECT * FROM {TABLE} ORDER BY session_id,block_no"):
            old = previous if previous is not None and previous[0] == row["session_id"] else None
            if old is not None and (row["block_no"] != old[1] + 1 or row["offset"] != old[2]):
                raise RuntimeError("invalid event block physical ordering")
            if old is None and row["block_no"] != 0:
                raise RuntimeError("missing first event block")
            events = store._decode(row)[1]
            if visit is not None:
                for event in events:
                    visit(event)
            if old is None and row["offset"] != len(store._header(row["session_id"])):
                raise RuntimeError("first event block offset mismatch")
            previous = row["session_id"], row["block_no"], row["committed_end"]


def cleanup(database: Path) -> int:
    """Delete only namespace-proven files without committed blocks; caller is exclusive."""
    with (
        closing(connect(database)) as connection,
        connection,
        BlockStore(connection, database) as store,
    ):
        connection.execute("BEGIN IMMEDIATE")
        try:
            directory = store._open()
        except FileNotFoundError:
            if store.directory_path.exists():
                raise
            return 0
        removed = 0
        for name in os.listdir(store.directory_path):
            if name == NAMESPACE:
                continue
            fd = directory.open_private(name, os.O_RDONLY)
            try:
                identity = os.fstat(fd)
                os.lseek(fd, 0, os.SEEK_SET)
                raw = os.read(fd, HEADER_LIMIT)
                line = raw.split(b"\n", 1)[0] + b"\n"
                header = json.loads(line)
                if (
                    not isinstance(header, list)
                    or len(header) != 4
                    or header[:3] != ["session", VERSION, store._token]
                    or not isinstance(header[3], str)
                    or _name(header[3]) != name
                    or line != store._header(header[3])
                ):
                    raise RuntimeError("unowned event block file retained")
            finally:
                os.close(fd)
            if not connection.execute(
                f"SELECT 1 FROM {TABLE} WHERE session_id=? LIMIT 1", (header[3],)
            ).fetchone():
                directory.unlink(name, expected=identity)
                directory.sync()
                removed += 1
        return removed
