"""Bounded, redacted update evidence for the existing feedback bundle."""

from __future__ import annotations

import gzip
import json
import os
import re
import stat
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BUDGET = 2 * 1024 * 1024
SOURCE_BYTES = 128 * 1024
SUMMARY_BYTES = 64 * 1024
MIN_BUDGET = 16 * 1024
READ_BYTES = 2 * 1024 * 1024
ARCHIVE_READ_BYTES = 64 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024
ROTATIONS = 3
EVENT_LIMIT = 64
REDACTED = "<REDACTED>"
SUMMARY_NAME = "feedback/update-summary.json"
COLLECTION_NAME = "feedback/update-collection.json"
LOG_NAMES = ("update.log", "install.log", "install-prev.log", "components.log", "native-update.log")
ROTATED_NAMES = ("update.log", "components.log")
EVENT_FIELDS = frozenset(
    {
        "schemaVersion",
        "timestampUtc",
        "updateId",
        "generation",
        "phase",
        "event",
        "result",
        "errorCode",
        "fromVersion",
        "toVersion",
        "version",
        "buildNumber",
        "elapsedMs",
        "step",
        "stepElapsedMs",
        "reclaimedBytes",
        "remainingBytes",
        "deferredReason",
        "releaseId",
        "previousReleaseId",
        "sequence",
        "session",
        "removedFiles",
        "diagnosticRevision",
        "diagnosticEpoch",
        "capturedAt",
        "lastSyncedAt",
        "writeFailed",
        "truncated",
    }
)
URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
AUTH = re.compile(r"(?i)(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+")
SECRET = re.compile(
    r"""(?ix)(["']?\b(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|nonce|download_url)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}]+)"""
)
USER_PATH = re.compile(
    r"(?i)(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\r\n\"']+|/(?:Users|home)/[^/\r\n\"']+)"
)
COOKIE_HEADER = re.compile(r"(?im)(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+")


def redact(text: str) -> str:
    text = URL.sub("<URL>", text)
    text = COOKIE_HEADER.sub(lambda match: match[1] + REDACTED, text)
    text = AUTH.sub(lambda match: match[1] + REDACTED, text)
    text = SECRET.sub(lambda match: match[1] + json.dumps(REDACTED), text)
    return USER_PATH.sub("<HOME>", text)


def _json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _sources(update_log: Path) -> list[Path]:
    paths = [update_log, *(update_log.parent / name for name in LOG_NAMES[1:])]
    for name in ROTATED_NAMES:
        for index in range(1, ROTATIONS + 1):
            paths.extend(update_log.parent / f"{name}.{index}{suffix}" for suffix in ("", ".gz"))
    return paths


def _snapshot(path: Path) -> tuple[bytes, dict[str, Any]]:
    record: dict[str, Any] = {
        "source": path.name,
        "kind": (
            "snapshot"
            if (path.name.startswith("install") or path.name == "native-update.log")
            else "events"
        ),
    }
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or path.is_junction():
            record["status"] = "rejected"
            return b"", record
        # Fixed descriptor and size limit protect against rotation/growing logs.
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (
                opened.st_dev,
                opened.st_ino,
            ):
                record["status"] = "changed"
                return b"", record
            record["sourceBytes"] = opened.st_size
            compressed = path.suffix == ".gz"
            if compressed:
                with gzip.GzipFile(fileobj=source) as archive:
                    data = b""
                    total = 0
                    while total <= ARCHIVE_READ_BYTES:
                        chunk = archive.read(READ_CHUNK_BYTES)
                        if not chunk:
                            break
                        total += len(chunk)
                        data = (data + chunk)[-READ_BYTES:]
                    if total > ARCHIVE_READ_BYTES:
                        record.update(status="budget", reason="decompression-limit")
                        return b"", record
                truncated = total > READ_BYTES
                if truncated:
                    data = data.partition(b"\n")[2]
            else:
                offset = max(0, opened.st_size - READ_BYTES)
                source.seek(offset)
                data = source.read(min(opened.st_size, READ_BYTES))
                truncated = offset > 0
                if offset:
                    data = data.partition(b"\n")[2]
            # Do not include a partially written event, or half of a truncated line.
            if data and not data.endswith(b"\n"):
                data = data.rpartition(b"\n")[0]
                data = data + b"\n" if data else b""
                truncated = True
            text = redact(data.decode("utf-8", errors="replace"))
            data = text.encode("utf-8")
            if len(data) > SOURCE_BYTES:
                data = data[-SOURCE_BYTES:].partition(b"\n")[2]
                truncated = True
            record.update(status="truncated" if truncated else "included", capturedBytes=len(data))
            return data, record
    except FileNotFoundError:
        record["status"] = "missing"
    except (OSError, EOFError, ValueError, zlib.error):
        record["status"] = "unreadable"
    return b"", record


def collect_update_diagnostics(update_log: Path, budget: int = BUDGET) -> list[tuple[str, bytes]]:
    """Return bounded ZIP entries; never upload raw transactions or executable payloads."""
    if budget < MIN_BUDGET:
        return []
    entries: list[tuple[str, bytes]] = []
    records: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    # Small feedback bundles still need installer evidence. Reserve at most half
    # for the bounded collection report/summary, rather than consuming the whole
    # allocation with the default summary ceiling.
    summary_budget = min(SUMMARY_BYTES, budget // 2)
    remaining = budget - summary_budget
    event_count = 0
    for path in _sources(update_log):
        data, record = _snapshot(path)
        if data:
            source_events: list[dict[str, Any]] = []
            # Summary extraction uses the bounded, already-redacted snapshot,
            # even if the detailed log cannot fit this feedback allocation.
            for line in data.decode("utf-8").splitlines():
                start = line.find("{")
                if start < 0:
                    continue
                try:
                    event = json.loads(line[start:])
                except (ValueError, TypeError):
                    continue
                if not isinstance(event, dict):
                    continue
                projected = {
                    key: value
                    for key, value in event.items()
                    if key in EVENT_FIELDS and isinstance(value, (str, int, float, bool))
                }
                if projected:
                    source_events.append(projected)
            event_count += len(source_events)
            events.extend(reversed(source_events[-EVENT_LIMIT:]))
            if len(data) > remaining:
                record.update(status="budget", capturedBytes=0)
            else:
                entries.append(
                    (
                        f"update/{path.name + '.txt' if path.suffix == '.gz' else path.name}",
                        data,
                    )
                )
                remaining -= len(data)
        records.append(record)
    if not entries and all(record["status"] == "missing" for record in records):
        return []
    events.sort(key=lambda event: event.get("result") not in ("failed", "error", "rolled-back"))
    truncated = event_count > EVENT_LIMIT
    events = events[:EVENT_LIMIT]
    summary = _json(
        {
            "schemaVersion": 1,
            "events": events,
            "eventLimit": EVENT_LIMIT,
            "truncated": truncated,
        }
    )
    while len(summary) > summary_budget // 2 and events:
        events.pop()
        summary = _json({"schemaVersion": 1, "events": events, "truncated": True})
    collection = _json(
        {
            "schemaVersion": 1,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "sources": records,
        }
    )
    # The fixed source inventory fits the minimum allocation. Keep this bound
    # explicit if that inventory grows, without falling back to raw source bytes.
    if len(collection) + len(summary) > summary_budget:
        return []
    return [(SUMMARY_NAME, summary), (COLLECTION_NAME, collection), *entries]
