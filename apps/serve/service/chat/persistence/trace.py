"""Read Trace-owned formats through qualified product filesystem handles."""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass, field
from enum import StrEnum
from hashlib import sha256
from pathlib import Path
from typing import BinaryIO, cast

from damoatrace.data.inspection import inspect_event_record
from damoatrace.paths import TRACE_FILE_SUFFIX, TracePaths
from damoatrace.recording.content import CONTENT_FORMAT, ContentFormat, inspect_content_versions
from damoatrace.search.index import PROJECTION_FORMAT, IndexCheck, ProjectionFormat, TraceIndex
from service.persistence.documents import DocumentSource
from service.persistence.project import (
    DatabaseFingerprint,
    database_files,
    database_fingerprint,
    reader,
    recover_database,
)
from service.platform.domains import DataInspection, DomainChangedError
from service.platform.storage import (
    NOFOLLOW,
    NONBLOCK,
    DirectoryHandle,
    is_regular,
    open_directory,
    stable_read_matches,
)

MAX_TRACE_ENTRIES = 8192
MAX_TRACE_BYTES = 256 * 1024 * 1024
MAX_TRACE_LINE_CHARS = 2 * 1024 * 1024
MAX_TRACE_SECONDS = 30.0
MAX_TRACE_COMPACTIONS = 4096
MAX_TRACE_COMPACTION_BYTES = 16 * 1024 * 1024
TRACE_HASH_CHUNK_BYTES = 1024 * 1024
_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TraceSource:
    path: Path
    identity: tuple[int, int]
    size: int
    modified_ns: int
    versions: tuple[int, ...]
    digest: str
    events: int
    opaque_lines: int
    compactions: tuple[tuple[str, dict], ...] = field(default=(), repr=False)


@dataclass(frozen=True)
class TraceProjection:
    present: bool
    current: bool
    sqlite_check: IndexCheck | None = field(default=None, compare=False)
    recovery: DatabaseFingerprint | None = None


@dataclass(frozen=True)
class TraceFormats:
    """Owner contracts for inspected content and projection only.

    Event envelopes, usage ledgers and other owners require their own coverage;
    this record must not be used as whole-Trace or whole-application approval.
    """

    content: ContentFormat
    projection: ProjectionFormat

    def require_candidate(self, candidate: TraceFormats) -> None:
        self.content.require_readable(candidate.content.written)
        self.projection.require_readable(candidate.projection.written)


class HistoryInspection(StrEnum):
    DEFERRED = "deferred"
    COMPLETE = "complete"


@dataclass(frozen=True)
class TraceStartupSources:
    roots: tuple[str, ...]
    files: tuple[TraceSource, ...] | None
    projection: TraceProjection | None = None
    formats: TraceFormats | None = None
    history: HistoryInspection | None = None


def require_trace_storage(
    files: tuple[TraceSource, ...] | None,
    projection: TraceProjection | None,
    formats: TraceFormats | None,
    history: HistoryInspection | None,
    *,
    allow_recovery: bool = False,
) -> None:
    if projection is None or formats is None or not isinstance(history, HistoryInspection):
        raise RuntimeError("Trace storage has not been inspected")
    if (history is HistoryInspection.COMPLETE) != (files is not None):
        raise RuntimeError("Trace history inspection evidence is inconsistent")
    if projection.recovery is not None and not allow_recovery:
        raise RuntimeError("Trace index requires exclusive rollback recovery")


def recover_trace_storage(paths: TracePaths, projection: TraceProjection) -> None:
    """Called only inside the startup owner's exclusive maintenance callback."""
    if projection.recovery is None:
        return
    _log.info("trace_index_recovery event=started reason=readonly_rollback")
    try:
        recover_database(paths.index, projection.recovery)
        with database_files(paths.index), reader(paths.index) as connection:
            connection.execute("BEGIN")
            TraceIndex.inspect_readonly(connection)
    except BaseException:
        _log.exception("trace_index_recovery event=failed reason=readonly_rollback")
        raise
    _log.info("trace_index_recovery event=finished reason=readonly_rollback")


class TraceInspectionCache:
    """Process-local evidence, usable only after another complete byte read.

    Metadata selects a candidate; it never proves that content is unchanged.
    Only complete, stable ordinary inspections may publish entries here.
    """

    def __init__(self) -> None:
        self._contract: tuple[TraceFormats, int] | None = None
        self._sources: dict[Path, TraceSource] = {}

    def candidate(
        self, path: Path, before: os.stat_result, formats: TraceFormats
    ) -> TraceSource | None:
        if self._contract != (formats, MAX_TRACE_LINE_CHARS):
            return None
        source = self._sources.get(path)
        if source is None or (
            source.identity != (before.st_dev, before.st_ino)
            or source.size != before.st_size
            or source.modified_ns != before.st_mtime_ns
        ):
            return None
        return source

    def remember(self, sources: tuple[TraceSource, ...], formats: TraceFormats) -> None:
        self._sources = {source.path: source for source in sources}
        self._contract = (formats, MAX_TRACE_LINE_CHARS)


def _digest(source: BinaryIO) -> str:
    digest = sha256()
    while chunk := source.read(TRACE_HASH_CHUNK_BYTES):
        digest.update(chunk)
    return digest.hexdigest()


def trace_write_format_source() -> DocumentSource:
    """A private format declaration, not a file or whole-Trace admission.

    No persisted source document exists for this declaration. The signed
    candidate supplies its actual writers' versions; the source process applies
    its own installed reader contracts. Source file observations and index
    startup projection remain separate, qualified inspection evidence.
    """
    payload = json.dumps(
        {
            "schema": 1,
            "content": CONTENT_FORMAT.written,
            "projection": PROJECTION_FORMAT.written,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    def require_readable(raw: bytes | None) -> None:
        if raw is None or len(raw) > 4096:
            raise ValueError("missing or oversized Trace write format declaration")
        value = json.loads(raw)
        if (
            not isinstance(value, dict)
            or set(value) != {"schema", "content", "projection"}
            or type(value["schema"]) is not int
            or value["schema"] != 1
            or json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8") != raw
        ):
            raise ValueError("invalid Trace write format declaration")
        CONTENT_FORMAT.require_readable(value["content"])
        PROJECTION_FORMAT.require_readable(value["projection"])

    return DocumentSource("trace-write-formats", None, payload, require_readable)


def _names(directory: DirectoryHandle, *, compatibility_preview: bool) -> tuple[str, ...]:
    location = directory.fileno() if directory.descriptor is not None else directory.path
    names = []
    with os.scandir(location) as entries:
        for count, entry in enumerate(entries, start=1):
            if compatibility_preview and count > MAX_TRACE_ENTRIES:
                raise ValueError("Trace inventory exceeds entry budget")
            if os.path.normcase(entry.name).endswith(os.path.normcase(TRACE_FILE_SUFFIX)):
                names.append(entry.name)
    return tuple(sorted(names))


def _inspect_index(
    connection: sqlite3.Connection | None, *, compatibility_preview: bool, deadline: float
) -> TraceProjection:
    if compatibility_preview:
        return TraceProjection(
            connection is not None, TraceIndex.inspect_startup(connection, deadline=deadline)
        )
    inspection = TraceIndex.inspect_readonly(connection)
    _log.info(
        "trace_index_inspection scope=readonly_sqlite status=%s current=%s",
        inspection.sqlite_check.value,
        inspection.current,
    )
    return TraceProjection(connection is not None, inspection.current, inspection.sqlite_check)


def _inspect_trace_storage(
    domains: DataInspection,
    paths: TracePaths,
    *,
    compatibility_preview: bool,
) -> TraceStartupSources:
    deadline = time.monotonic() + MAX_TRACE_SECONDS
    formats = TraceFormats(CONTENT_FORMAT, PROJECTION_FORMAT)
    roots: tuple[str, ...] = (str(paths.home),)
    if not domains.selected(str(paths.home)):
        return TraceStartupSources(roots, None)
    with domains.inspection(str(paths.home)):
        try:
            directory = open_directory(paths.home, paths.trace.relative_to(paths.home).parts)
        except FileNotFoundError:
            projection = _inspect_index(
                None, compatibility_preview=compatibility_preview, deadline=deadline
            )
            return TraceStartupSources(
                roots,
                (),
                projection,
                formats,
                HistoryInspection.COMPLETE,
            )
        directory.close()
    roots = tuple(sorted((*roots, str(paths.trace))))
    if not domains.selected(str(paths.trace)):
        return TraceStartupSources(roots, None)
    with domains.inspection(str(paths.trace)), database_files(paths.index) as present:
        if present:
            before = database_fingerprint(paths.index)
            try:
                with reader(paths.index) as connection:
                    connection.execute("BEGIN")
                    projection = _inspect_index(
                        connection, compatibility_preview=compatibility_preview, deadline=deadline
                    )
            except sqlite3.OperationalError as error:
                if (
                    compatibility_preview
                    or getattr(error, "sqlite_errorcode", None) != sqlite3.SQLITE_READONLY_ROLLBACK
                ):
                    raise
                if database_fingerprint(paths.index) != before:
                    raise DomainChangedError(
                        "Trace index changed during recovery inspection"
                    ) from error
                projection = TraceProjection(True, False, recovery=before)
                _log.info("trace_index_inspection scope=readonly_sqlite status=recovery_required")
        else:
            projection = _inspect_index(
                None, compatibility_preview=compatibility_preview, deadline=deadline
            )
    return TraceStartupSources(roots, None, projection, formats)


def inspect_trace_startup(domains: DataInspection, paths: TracePaths) -> TraceStartupSources:
    """Qualify storage without enumerating, reading or certifying historical content."""
    storage = _inspect_trace_storage(domains, paths, compatibility_preview=False)
    if storage.projection is None or storage.history is HistoryInspection.COMPLETE:
        return storage
    _log.info("trace_startup_inspection history=deferred files=uninspected bytes_read=0")
    return TraceStartupSources(
        storage.roots, None, storage.projection, storage.formats, HistoryInspection.DEFERRED
    )


def inspect_trace_sources(
    domains: DataInspection,
    paths: TracePaths,
    *,
    compatibility_preview: bool = True,
    cache: TraceInspectionCache | None = None,
) -> TraceStartupSources:
    """Explicit full history inspection; compatibility previews also retain compactions."""
    started_at = time.monotonic()
    deadline = started_at + MAX_TRACE_SECONDS
    storage = _inspect_trace_storage(domains, paths, compatibility_preview=compatibility_preview)
    if storage.projection is None or storage.history is HistoryInspection.COMPLETE:
        return storage
    if storage.projection.recovery is not None:
        raise RuntimeError("Trace index requires exclusive rollback recovery")
    total = 0
    compaction_count = 0
    compaction_bytes = 0
    formats = storage.formats
    if formats is None:
        raise RuntimeError("Trace formats have not been inspected")
    files = []
    reused = 0
    with (
        domains.inspection(str(paths.trace)),
        closing(open_directory(paths.trace, ())) as directory,
    ):
        names = _names(directory, compatibility_preview=compatibility_preview)
        for name in names:
            descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
            with os.fdopen(descriptor, "r", encoding="utf-8", newline="") as source:
                buffer = cast(BinaryIO, source.buffer)
                before = os.fstat(source.fileno())
                if not is_regular(before):
                    raise ValueError("Trace content source is not a regular file")
                if compatibility_preview and before.st_size > MAX_TRACE_BYTES - total:
                    raise ValueError("Trace content exceeds inspection byte budget")
                path = directory.child(name)
                cached = (
                    cache.candidate(path, before, formats)
                    if cache is not None and not compatibility_preview
                    else None
                )
                expected_digest = None
                if cached is not None:
                    expected_digest = _digest(buffer)
                    size = buffer.tell()
                    if not stable_read_matches(
                        before, os.fstat(source.fileno()), directory.stat(name), size
                    ):
                        raise DomainChangedError("Trace content source changed during inspection")
                    if expected_digest == cached.digest:
                        files.append(cached)
                        total += size
                        reused += 1
                        continue
                    source.seek(0)
                digest = sha256()
                events, opaque = 0, 0
                compactions = []

                def retain_compaction(session: str, value: dict) -> None:
                    nonlocal compaction_count, compaction_bytes
                    compaction_count += 1
                    compaction_bytes += len(
                        json.dumps((session, value), ensure_ascii=True, allow_nan=False).encode(
                            "ascii"
                        )
                    )
                    if (
                        compaction_count > MAX_TRACE_COMPACTIONS
                        or compaction_bytes > MAX_TRACE_COMPACTION_BYTES
                    ):
                        raise ValueError("Trace compaction evidence exceeds inspection budget")
                    compactions.append((session, value))

                def lines():
                    while True:
                        if compatibility_preview and time.monotonic() > deadline:
                            raise ValueError("Trace inspection exceeded time budget")
                        line = source.readline(MAX_TRACE_LINE_CHARS + 1)
                        if not line:
                            return
                        if len(line) > MAX_TRACE_LINE_CHARS:
                            raise ValueError("Trace line exceeds inspection budget")
                        digest.update(line.encode("utf-8"))
                        yield line

                def inspect_record(record: dict | None) -> None:
                    nonlocal events, opaque
                    if inspect_event_record(
                        record, compaction=retain_compaction if compatibility_preview else None
                    ):
                        events += 1
                    else:
                        opaque += 1

                versions = inspect_content_versions(lines(), inspect_record=inspect_record)
                size = buffer.tell()
                after = os.fstat(source.fileno())
                current = directory.stat(name)
                if not stable_read_matches(before, after, current, size):
                    raise DomainChangedError("Trace content source changed during inspection")
                observed_digest = digest.hexdigest()
                if expected_digest is not None and expected_digest != observed_digest:
                    raise DomainChangedError("Trace content source changed between complete reads")
                total += size
                files.append(
                    TraceSource(
                        path,
                        (before.st_dev, before.st_ino),
                        before.st_size,
                        before.st_mtime_ns,
                        versions,
                        observed_digest,
                        events,
                        opaque,
                        tuple(compactions),
                    )
                )
        if _names(directory, compatibility_preview=compatibility_preview) != names:
            raise DomainChangedError("Trace content inventory changed during inspection")
    if cache is not None and not compatibility_preview:
        cache.remember(tuple(files), formats)
    _log.info(
        "trace_startup_inspection compatibility_preview=%s files=%s parsed=%s reused=%s "
        "bytes=%s elapsed_seconds=%.3f",
        compatibility_preview,
        len(files),
        len(files) - reused,
        reused,
        total,
        time.monotonic() - started_at,
    )
    return TraceStartupSources(
        storage.roots, tuple(files), storage.projection, formats, HistoryInspection.COMPLETE
    )
