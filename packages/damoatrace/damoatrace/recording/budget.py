"""Bounded body storage across explicitly selected evidence files; no body cache."""

from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from damoatrace.recording.content import (
    BUDGET_EVICTED,
    BUDGET_EXHAUSTED,
    CONTENT_FIELDS,
    CONTENT_MARKER,
    DISK_LIMIT,
    EXPIRED,
    UnsupportedContentVersion,
    validate_content_version,
)
from damoatrace.recording.storage import budget_lock, evidence_lock, make_private, rewrite_content

BlockKey = tuple[str, str, int]
Fingerprint = tuple[int, int, int]


@dataclass(frozen=True)
class Body:
    key: BlockKey
    size: int
    captured_at: float
    expires_at: float


@dataclass
class Inventory:
    fingerprint: Fingerprint
    bodies: list[Body]


def _fingerprint(path: Path) -> Fingerprint:
    stat = path.stat()
    return stat.st_ino, stat.st_size, stat.st_mtime_ns


def _bodies(record: dict[str, Any]) -> Iterator[Body]:
    validate_content_version(record)
    if CONTENT_MARKER not in record:
        return
    for field in CONTENT_FIELDS:
        for index, block in enumerate((record.get(field) or {}).get("blocks", [])):
            if "data" not in block:
                continue
            timestamp = block.get("captured_at")
            if timestamp is None:
                timestamp = datetime.fromisoformat(record["started_at"]).timestamp()
            yield Body(
                (record["span_id"], field, index),
                len(json.dumps(block["data"], ensure_ascii=False).encode()),
                float(timestamp),
                float(block["expires_at"]),
            )


class ContentBudget:
    """Cross-process hard limit on JSON-encoded body bytes, preserving evidence metadata.

    The cache contains only block identities/timestamps/sizes. Every operation checks
    file fingerprints under the root lock; another process or a purge invalidates it.
    """

    def __init__(self, directory: Path, *, pattern: str, limit: int = DISK_LIMIT) -> None:
        if limit < 0:
            raise ValueError("body budget must be nonnegative")
        self.directory = directory.expanduser().resolve()
        self.pattern = pattern
        self.limit = limit
        self._files: dict[Path, Inventory] = {}

    def _scan(self, path: Path) -> None:
        bodies: list[Body] = []
        with evidence_lock(path), path.open(encoding="utf-8") as source:
            for line in source:
                try:
                    record = json.loads(line)
                    if isinstance(record, dict):
                        bodies.extend(_bodies(record))
                except UnsupportedContentVersion:
                    raise
                except (ValueError, KeyError, TypeError):
                    # Unrecognized historical lines remain untouched, never reconstructed.
                    continue
            self._files[path] = Inventory(_fingerprint(path), bodies)

    def _refresh(self) -> None:
        paths = {p for p in self.directory.glob(self.pattern) if p.is_file() and not p.is_symlink()}
        self._files = {p: item for p, item in self._files.items() if p in paths}
        for path in sorted(paths):
            if path not in self._files or self._files[path].fingerprint != _fingerprint(path):
                self._scan(path)

    def _trim(self, allowance: int) -> int:
        entries = [
            (body.captured_at, str(path), body.key, path, body)
            for path, item in self._files.items()
            for body in item.bodies
        ]
        total = sum(entry[-1].size for entry in entries)
        selected: dict[Path, dict[BlockKey, str]] = {}
        now = time.time()
        for _, _, _, path, body in entries:
            if body.expires_at <= now:
                selected.setdefault(path, {})[body.key] = EXPIRED
                total -= body.size
        for _, _, _, path, body in sorted(entries) if total > allowance else ():
            if total <= allowance:
                break
            if body.key not in selected.get(path, {}):
                selected.setdefault(path, {})[body.key] = BUDGET_EVICTED
                total -= body.size
        for path, removed in selected.items():

            def project(record: dict, removed: dict[BlockKey, str] = removed) -> dict:
                result = copy.deepcopy(record)
                for field in CONTENT_FIELDS:
                    for index, block in enumerate((result.get(field) or {}).get("blocks", [])):
                        reason = removed.get((record.get("span_id", ""), field, index))
                        if reason and "data" in block:
                            block.pop("data", None)
                            block.pop("text", None)
                            block["missing_reason"] = reason
                return result

            rewrite_content(path, project)
            self._scan(path)
        return total

    def enforce(self) -> int:
        """Expire/evict idle or active files atomically with respect to body writers."""
        if not self.directory.exists():
            return 0
        with budget_lock(self.directory):
            self._refresh()
            return self._trim(self.limit)

    def append(self, path: Path, record: dict[str, Any]) -> None:
        self.append_many(path, [record])

    def append_many(self, path: Path, records: list[dict[str, Any]]) -> None:
        """Amortize I/O without changing per-record retention decisions."""
        if not records:
            return
        path = path.expanduser().resolve()
        if path.parent != self.directory or not path.match(self.pattern):
            raise ValueError("evidence file is outside the configured budget scope")
        with budget_lock(self.directory):
            self._refresh()
            incoming = [body for record in records for body in _bodies(record)]
            existing = [body for inventory in self._files.values() for body in inventory.bodies]
            bodies = existing + incoming
            if sum(body.size for body in bodies) > self.limit or any(
                body.expires_at <= time.time() for body in bodies
            ):
                # Include each newly appended record in subsequent eviction decisions.
                for record in records:
                    self._append_locked(path, record)
                return
            with evidence_lock(path), path.open("a", encoding="utf-8") as stream:
                make_private(path)
                stream.writelines(
                    json.dumps(record, ensure_ascii=False) + "\n" for record in records
                )
                stream.flush()
            previous = self._files.get(path)
            self._files[path] = Inventory(
                _fingerprint(path), [*(previous.bodies if previous else []), *incoming]
            )

    def _append_locked(self, path: Path, record: dict[str, Any]) -> None:
        incoming = list(_bodies(record))
        size = sum(body.size for body in incoming)
        if size > self.limit:
            record = copy.deepcopy(record)
            for field in CONTENT_FIELDS:
                for block in (record.get(field) or {}).get("blocks", []):
                    if "data" in block:
                        block.pop("data", None)
                        block["missing_reason"] = BUDGET_EXHAUSTED
            incoming, size = [], 0
        if incoming:
            self._trim(self.limit - size)
        with evidence_lock(path), path.open("a", encoding="utf-8") as stream:
            make_private(path)
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            stream.flush()
        previous = self._files.get(path)
        self._files[path] = Inventory(
            _fingerprint(path), [*(previous.bodies if previous else []), *incoming]
        )
