"""Read historical Trace context ledgers beneath a qualified embedding root."""

from __future__ import annotations

import os
import stat
import time
from contextlib import closing
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from damoatrace.data.records import decode_object_line
from damoatrace.data.store import (
    CONTEXT_LEDGER_DIRNAME,
    CONTEXT_LEDGER_FILES,
    CONTEXT_SUBAGENTS_DIRNAME,
    TraceStore,
)
from service.platform.domains import DataInspection, DomainChangedError
from service.platform.storage import (
    NOFOLLOW,
    NONBLOCK,
    is_regular,
    open_directory,
    stable_read_matches,
)

MAX_ENTRIES = 8192
MAX_RECORDS = 4096
MAX_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 30.0


@dataclass(frozen=True)
class LedgerFileSource:
    relative: tuple[str, ...]
    present: bool
    size: int
    digest: str
    records: int
    opaque_lines: int


class _LedgerReader:
    def __init__(self, root: Path):
        self.root = root
        self.deadline = time.monotonic() + MAX_SECONDS
        self.entries = 0
        self.bytes = 0
        self.lines = 0
        self.inventories: dict[tuple[str, ...], tuple[tuple[str, bool, int, int], ...] | None] = {}
        self.files: list[LedgerFileSource] = []

    def check(self):
        if time.monotonic() > self.deadline:
            raise ValueError("context ledger inspection exceeded time budget")

    def inventory(self, parts: tuple[str, ...], *, remember: bool = True):
        self.check()
        try:
            directory = open_directory(self.root, parts)
        except FileNotFoundError:
            values = None
        else:
            with closing(directory):
                location = (
                    directory.fileno() if directory.descriptor is not None else directory.path
                )
                entries_found: list[tuple[str, bool, int, int]] = []
                with os.scandir(location) as entries:
                    for entry in entries:
                        self.check()
                        if len(entries_found) >= MAX_ENTRIES:
                            raise ValueError("context ledger inventory exceeds budget")
                        identity = directory.stat(entry.name)
                        if not stat.S_ISDIR(identity.st_mode) and not is_regular(identity):
                            raise ValueError("unsupported context ledger entry")
                        entries_found.append(
                            (
                                entry.name,
                                stat.S_ISDIR(identity.st_mode),
                                identity.st_dev,
                                identity.st_ino,
                            )
                        )
                values = tuple(sorted(entries_found))
        if remember and parts not in self.inventories:
            self.entries += len(values or ())
            if self.entries > MAX_ENTRIES:
                raise ValueError("context ledger inventory exceeds budget")
            self.inventories[parts] = values
        return values

    def directories(self, parts: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(
            name
            for name, is_directory, _device, _inode in self.inventory(parts) or ()
            if is_directory
        )

    def read(self, parts: tuple[str, ...], name: str) -> list[dict]:
        self.check()
        relative = (*parts, name)
        with closing(open_directory(self.root, parts)) as directory:
            try:
                descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
            except FileNotFoundError:
                self.files.append(LedgerFileSource(relative, False, 0, sha256().hexdigest(), 0, 0))
                return []
            with os.fdopen(descriptor, "rb") as source:
                before = os.fstat(source.fileno())
                if not is_regular(before) or not 0 <= before.st_size <= MAX_BYTES - self.bytes:
                    raise ValueError("context ledger source exceeds byte budget")
                rows = []
                digest = sha256()
                size = opaque = 0
                while True:
                    self.check()
                    line = source.readline(MAX_LINE_BYTES + 1)
                    if not line:
                        break
                    self.lines += 1
                    if len(line) > MAX_LINE_BYTES or self.lines > MAX_RECORDS:
                        raise ValueError("context ledger records exceed budget")
                    size += len(line)
                    if size > MAX_BYTES - self.bytes:
                        raise ValueError("context ledger source grew beyond byte budget")
                    digest.update(line)
                    record = decode_object_line(line.decode("utf-8"))
                    if record is None:
                        opaque += bool(line.strip())
                    else:
                        rows.append(record)
                if not stable_read_matches(
                    before, os.fstat(source.fileno()), directory.stat(name), size
                ):
                    raise DomainChangedError("context ledger source changed")
        self.bytes += size
        self.files.append(
            LedgerFileSource(relative, True, size, digest.hexdigest(), len(rows), opaque)
        )
        return rows

    def inspect(self, compactions: dict[str, list[dict]]) -> tuple[LedgerFileSource, ...]:
        for project in self.directories(()):
            for parent in ((project,), (project, CONTEXT_SUBAGENTS_DIRNAME)):
                for session in self.directories(parent):
                    parts = (*parent, session, CONTEXT_LEDGER_DIRNAME)
                    if self.inventory(parts) is None:
                        continue
                    rows = {name: self.read(parts, name) for name in CONTEXT_LEDGER_FILES}
                    TraceStore.inspect_context_records(
                        rows, compactions=compactions.get(session, [])
                    )
                    self.check()
        for parts, before in self.inventories.items():
            if self.inventory(parts, remember=False) != before:
                raise DomainChangedError("context ledger inventory changed")
        return tuple(self.files)


def inspect_context_ledgers(
    domains: DataInspection, root: Path | None, *, compactions: tuple[tuple[str, dict], ...] = ()
) -> tuple[LedgerFileSource, ...] | None:
    """Use Trace's actual lookup layout, without creating files or following links.

    None means discovery has not yet qualified the configured root. Only the
    outer owner can treat a later complete source snapshot as inspected.
    """
    if root is None:
        return ()
    if not domains.selected(str(root)):
        return None
    by_session: dict[str, list[dict]] = {}
    for session, event in compactions:
        by_session.setdefault(session, []).append(event)
    for events in by_session.values():
        events.sort(key=lambda event: str(event.get("at") or ""))
    with domains.inspection(str(root)):
        return _LedgerReader(root).inspect(by_session)
