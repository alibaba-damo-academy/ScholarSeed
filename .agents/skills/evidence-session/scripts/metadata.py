#!/usr/bin/env python3
"""Read one explicitly selected JSONL without exposing message bodies."""

import argparse
import hashlib
import json
from collections import Counter, deque
from pathlib import Path

DEFAULT_LIMIT = 30
MAX_LINE_BYTES = 16 * 1024 * 1024
METADATA_FIELDS = (
    "span_id",
    "parent_span_id",
    "task_run_id",
    "session_id",
    "name",
    "kind",
    "status",
    "started_at",
    "ended_at",
    "timestamp",
    "type",
)
ATTRIBUTE_FIELDS = (
    "runtime_id",
    "vendor_thread_id",
    "vendor_turn_id",
    "native_turn_id",
    "product_event_kind",
    "vendor_event_kind",
    "incident_state",
    "retryability",
    "incident_scope",
    "failure_type",
    "state",
    "status",
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--span")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("limit must be positive")
    path = args.path.expanduser().resolve(strict=True)
    before = path.stat()
    counts = Counter()
    rows = deque(maxlen=args.limit)
    malformed = []
    oversized = []
    matched = 0
    line_number = 0
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            raw = source.readline(MAX_LINE_BYTES + 1)
            if not raw:
                break
            line_number += 1
            digest.update(raw)
            if len(raw) > MAX_LINE_BYTES:
                oversized.append(line_number)
                while not raw.endswith(b"\n"):
                    raw = source.readline(MAX_LINE_BYTES + 1)
                    digest.update(raw)
                    if not raw:
                        break
                continue
            try:
                record = json.loads(raw)
                if not isinstance(record, dict):
                    raise ValueError("record is not an object")
            except (ValueError, UnicodeError):
                malformed.append(line_number)
                continue
            counts[str(record.get("name") or record.get("type") or record.get("kind"))] += 1
            if args.span and record.get("span_id") != args.span:
                continue
            matched += 1
            row = {key: record[key] for key in METADATA_FIELDS if key in record}
            attributes = record.get("attributes")
            if isinstance(attributes, dict):
                row["attributes"] = {
                    key: attributes[key] for key in ATTRIBUTE_FIELDS if key in attributes
                }
            row["line"] = line_number
            rows.append(row)
    after = path.stat()
    print(
        json.dumps(
            {
                "source": str(path),
                "sha256": digest.hexdigest(),
                "bytes": after.st_size,
                "changed_during_read": (before.st_size, before.st_mtime_ns)
                != (after.st_size, after.st_mtime_ns),
                "lines": line_number,
                "malformed_lines": malformed,
                "oversized_lines": oversized,
                "counts": counts,
                "matched": matched,
                "truncated": matched > args.limit,
                "rows": list(rows),
                "content": "not inspected; metadata only; not evidence of full context",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
