"""Private bounded row transport; payloads must never enter diagnostics."""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from dataclasses import asdict
from typing import BinaryIO

from service.persistence.preview import DatabasePreview
from service.persistence.rows import MAX_ROW_BYTES, ROW_CHUNK_BYTES

MAX_CHUNK_FRAME = 96 * 1024


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate private row field")
        result[key] = value
    return result


def _send(output: BinaryIO, value: dict) -> None:
    output.write(
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")
        + b"\n"
    )
    output.flush()


class RowOutput:
    def __init__(self, output: BinaryIO, preview: DatabasePreview):
        self.output = output
        self.preview = preview
        self.sequence = 0
        self.size = 0
        self.finished = False

    def emit(self, chunk: bytes) -> None:
        if (
            self.finished
            or not isinstance(chunk, bytes)
            or not 0 < len(chunk) <= ROW_CHUNK_BYTES
            or self.size + len(chunk) > MAX_ROW_BYTES
        ):
            raise ValueError("invalid private row chunk")
        _send(
            self.output,
            {
                "version": 1,
                "event": "rows_chunk",
                "name": self.preview.name,
                "sequence": self.sequence,
                "payload": base64.b64encode(chunk).decode("ascii"),
            },
        )
        self.sequence += 1
        self.size += len(chunk)

    def finish(self) -> None:
        # Caller invokes this only after all snapshot and native pins closed.
        if self.finished or not self.size:
            raise ValueError("invalid private row completion")
        _send(
            self.output,
            {
                "version": 1,
                "event": "rows_end",
                "name": self.preview.name,
                "sequence": self.sequence,
                "size": self.size,
                "digest": self.preview.rows_digest,
            },
        )
        self.finished = True


def read_candidate_rows(
    preview: DatabasePreview, source: BinaryIO, output: BinaryIO
) -> Iterator[bytes]:
    """Keep the source inspector's qualification throughout a nested transfer."""
    _send(output, {"version": 1, "event": "rows_required", "preview": asdict(preview)})
    sequence = size = 0
    while True:
        line = source.readline(MAX_CHUNK_FRAME + 1)
        if not line.endswith(b"\n") or len(line) > MAX_CHUNK_FRAME:
            raise ValueError("incomplete private row frame")
        frame = json.loads(line, object_pairs_hook=_unique)
        if (
            not isinstance(frame, dict)
            or type(frame.get("version")) is not int
            or frame["version"] != 1
            or frame.get("name") != preview.name
            or type(frame.get("sequence")) is not int
            or frame["sequence"] != sequence
        ):
            raise ValueError("private row transfer identity changed")
        if frame.get("event") == "rows_end":
            if (
                set(frame) != {"version", "event", "name", "sequence", "size", "digest"}
                or type(frame["size"]) is not int
                or frame["size"] != size
                or not size
                or frame["digest"] != preview.rows_digest
            ):
                raise ValueError("invalid private row completion")
            return
        if (
            frame.get("event") != "rows_chunk"
            or set(frame) != {"version", "event", "name", "sequence", "payload"}
            or not isinstance(frame["payload"], str)
        ):
            raise ValueError("invalid private row chunk")
        chunk = base64.b64decode(frame["payload"], validate=True)
        if (
            not 0 < len(chunk) <= ROW_CHUNK_BYTES
            or base64.b64encode(chunk).decode("ascii") != frame["payload"]
            or size + len(chunk) > MAX_ROW_BYTES
        ):
            raise ValueError("private row transfer exceeds budget")
        size += len(chunk)
        sequence += 1
        yield chunk
