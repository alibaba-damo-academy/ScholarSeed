"""Private, bounded candidate CAS publication transport; never diagnostics."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import asdict
from typing import BinaryIO, Callable

from service.cli.inspection_rows import MAX_CHUNK_FRAME, _send, _unique
from service.persistence.rows import ROW_CHUNK_BYTES
from service.resources.persistence.chunks import CHUNK_MAX_BYTES
from service.resources.persistence.inspection import (
    MAX_METADATA_BYTES,
    MAX_OBJECTS,
    MAX_TOTAL_BYTES,
    MAX_WHOLE_BYTES,
    CasPublication,
    CasPublicationPreview,
)


def publication_preview(value: object) -> CasPublicationPreview:
    if not isinstance(value, dict) or set(value) != {"object_id", "files", "size", "digest"}:
        raise ValueError("invalid CAS publication preview")
    if (
        not isinstance(value["object_id"], str)
        or re.fullmatch(r"sha256:[0-9a-f]{64}", value["object_id"]) is None
    ):
        raise ValueError("invalid CAS publication identity")
    if (
        type(value["files"]) is not int
        or not 2 <= value["files"] <= 2 * MAX_OBJECTS + 2
        or type(value["size"]) is not int
        or not 0 < value["size"] <= MAX_TOTAL_BYTES
    ):
        raise ValueError("invalid CAS publication bounds")
    if (
        not isinstance(value["digest"], str)
        or re.fullmatch(r"[0-9a-f]{64}", value["digest"]) is None
    ):
        raise ValueError("invalid CAS publication digest")
    return CasPublicationPreview(**value)


def _database(value: str) -> None:
    if not isinstance(value, str) or re.fullmatch(r"project\.[A-Za-z0-9_-]{1,56}", value) is None:
        raise ValueError("invalid CAS publication database")


def publication_reports(value: object) -> dict[str, tuple[CasPublicationPreview, ...]]:
    if not isinstance(value, list) or len(value) > MAX_OBJECTS:
        raise ValueError("invalid CAS publication reports")
    result = {}
    count = size = 0
    for row in value:
        if not isinstance(row, dict) or set(row) != {"name", "objects"}:
            raise ValueError("invalid CAS publication report")
        _database(row["name"])
        if (
            row["name"] in result
            or not isinstance(row["objects"], list)
            or len(row["objects"]) > MAX_OBJECTS
        ):
            raise ValueError("duplicate or oversized CAS publication report")
        objects = tuple(publication_preview(item) for item in row["objects"])
        if tuple(item.object_id for item in objects) != tuple(
            sorted({item.object_id for item in objects})
        ):
            raise ValueError("CAS publication report object order changed")
        count += len(objects)
        size += sum(item.size for item in objects)
        if count > MAX_OBJECTS or size > MAX_TOTAL_BYTES:
            raise ValueError("CAS publication reports exceed budget")
        result[row["name"]] = objects
    return result


def encode_publication_reports(reports: dict[str, tuple[CasPublicationPreview, ...]]) -> list[dict]:
    result = [
        {"name": name, "objects": [asdict(item) for item in reports[name]]}
        for name in sorted(reports)
    ]
    publication_reports(result)
    return result


class PublicationExports:
    """One observed projection's immutable, single-use export batch.

    The first request regenerates the entire batch and checks every declared
    object. The prepare callback must close its native pins successfully before
    returning. Later frames use only these sealed private bytes, never cached
    source paths or stale filesystem handles. A new inspection gets a new batch.
    """

    def __init__(self, reports: dict[str, tuple[CasPublicationPreview, ...]]):
        self._reports = publication_reports(encode_publication_reports(reports))
        self._pending: dict[tuple[str, str], CasPublication] | None = None
        self._inflight: tuple[str, str] | None = None
        self._failed = False

    def select(
        self,
        database: str,
        preview: CasPublicationPreview,
        prepare: Callable[[], dict[str, tuple[CasPublication, ...]]],
    ) -> CasPublication:
        try:
            if self._failed or self._inflight is not None:
                raise ValueError("CAS export batch is unavailable")
            if preview not in self._reports.get(database, ()):
                raise ValueError("CAS export is outside the observed batch")
            if self._pending is None:
                images = prepare()
                if set(images) != set(self._reports):
                    raise ValueError("CAS export batch project coverage changed")
                pending = {}
                for name, expected in self._reports.items():
                    if tuple(image.preview() for image in images[name]) != expected:
                        raise ValueError("CAS export batch changed before export")
                    for image in images[name]:
                        pending[name, image.object_id] = image
                self._pending = pending
            key = (database, preview.object_id)
            selected_image = self._pending.get(key)
            if selected_image is None:
                raise ValueError("CAS export object already consumed")
            selected_image.check()
            self._inflight = key
            return selected_image
        except BaseException:
            self._failed = True
            self._pending = None
            raise

    def complete(self) -> None:
        if self._failed or self._inflight is None or self._pending is None:
            self._failed = True
            self._pending = None
            raise ValueError("CAS export batch has no completed object")
        # The caller has emitted the object's final receipt successfully.
        # Discard bytes immediately instead of retaining the full batch.
        del self._pending[self._inflight]
        self._inflight = None


class PublicationOutput:
    def __init__(self, output: BinaryIO, database: str, image: CasPublication):
        _database(database)
        self.output = output
        self.database = database
        self.image = image
        self.preview = publication_preview(asdict(image.preview()))
        self.sequence = 0
        self.emitted = self.finished = False
        self.complete = False

    def _frame(self, event: str, **fields) -> None:
        _send(
            self.output,
            {
                "version": 1,
                "event": event,
                "database": self.database,
                "object_id": self.preview.object_id,
                "sequence": self.sequence,
                **fields,
            },
        )
        self.sequence += 1

    def emit(self) -> None:
        if self.emitted or self.finished:
            raise ValueError("CAS publication already emitted")
        self.emitted = True
        for kind, identifier, name, data in self.image.files():
            self._frame("cas_file", kind=kind, identifier=identifier, name=name, size=len(data))
            for offset in range(0, len(data), ROW_CHUNK_BYTES):
                self.image.check()
                self._frame(
                    "cas_chunk",
                    payload=base64.b64encode(data[offset : offset + ROW_CHUNK_BYTES]).decode(
                        "ascii"
                    ),
                )
        self.complete = True

    def finish(self) -> None:
        # Only after all enclosing projection and directory pins close.
        if not self.complete or self.finished or self.image.preview() != self.preview:
            raise ValueError("invalid CAS publication completion")
        self._frame("cas_end", preview=asdict(self.preview))
        self.finished = True


def read_candidate_publication(
    database: str, preview: CasPublicationPreview, source: BinaryIO, output: BinaryIO
) -> CasPublication:
    _database(database)
    if publication_preview(asdict(preview)) != preview:
        raise ValueError("invalid CAS publication request")
    _send(
        output,
        {"version": 1, "event": "cas_required", "database": database, "preview": asdict(preview)},
    )
    image = CasPublication(preview.object_id)
    sequence = files = total = 0
    previous = None

    def frame(extra: set[str]) -> dict:
        nonlocal sequence
        image.check()
        line = source.readline(MAX_CHUNK_FRAME + 1)
        if not line.endswith(b"\n") or len(line) > MAX_CHUNK_FRAME:
            raise ValueError("incomplete CAS publication frame")
        value = json.loads(line, object_pairs_hook=_unique)
        if (
            not isinstance(value, dict)
            or set(value) != {"version", "event", "database", "object_id", "sequence"} | extra
            or type(value.get("version")) is not int
            or value["version"] != 1
            or value["database"] != database
            or value["object_id"] != preview.object_id
            or type(value["sequence"]) is not int
            or value["sequence"] != sequence
        ):
            raise ValueError("CAS publication frame identity changed")
        sequence += 1
        return value

    while files < preview.files:
        header = frame({"kind", "identifier", "name", "size"})
        if (
            header["event"] != "cas_file"
            or header["kind"] not in ("objects", "chunks")
            or header["name"] not in ("meta.json", "manifest.json", "payload")
            or not isinstance(header["identifier"], str)
            or re.fullmatch(r"sha256:[0-9a-f]{64}", header["identifier"]) is None
        ):
            raise ValueError("invalid CAS publication file")
        key = (header["kind"], header["identifier"], header["name"])
        if (
            key[0] == "objects"
            and key[1] != preview.object_id
            or key[0] == "chunks"
            and key[2] == "manifest.json"
        ):
            raise ValueError("CAS publication file ownership changed")
        if previous is not None and key <= previous:
            raise ValueError("CAS publication files out of order")
        previous = key
        limit = (
            MAX_METADATA_BYTES
            if header["name"] != "payload"
            else CHUNK_MAX_BYTES if header["kind"] == "chunks" else MAX_WHOLE_BYTES
        )
        size = header["size"]
        if type(size) is not int or not 0 <= size <= limit or total + size > preview.size:
            raise ValueError("CAS publication exceeds declared size")
        data = bytearray()
        while len(data) < size:
            chunk = frame({"payload"})
            if chunk["event"] != "cas_chunk" or not isinstance(chunk["payload"], str):
                raise ValueError("invalid CAS publication chunk")
            raw = base64.b64decode(chunk["payload"], validate=True)
            if (
                not 0 < len(raw) <= min(ROW_CHUNK_BYTES, size - len(data))
                or base64.b64encode(raw).decode("ascii") != chunk["payload"]
            ):
                raise ValueError("invalid CAS publication chunk size")
            data.extend(raw)
        image.add(*key, bytes(data))
        total += size
        files += 1
    end = frame({"preview"})
    if (
        end["event"] != "cas_end"
        or publication_preview(end["preview"]) != preview
        or total != preview.size
    ):
        raise ValueError("invalid CAS publication completion")
    image.verify()
    if image.preview() != preview:
        raise ValueError("CAS publication bytes differ from preview")
    return image
