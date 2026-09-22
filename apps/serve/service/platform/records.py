"""Owner-neutral PDF record contract and canonical codec."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol, runtime_checkable

RECORD_LINK_CONFLICT = "record_link_conflict"
RECORD_SOURCE_UNAVAILABLE = "records_source_unavailable"

SCHEMA_VERSION = 1
REVISION_PREFIX = "sha256:"
MARK_STYLES = frozenset({"highlight", "underline", "strikethrough"})
MARK_COLORS = frozenset({"yellow", "orange", "green", "teal", "blue", "purple", "red", "gray"})
ANCHOR_STATES = frozenset({"anchored", "stale"})
EMPTY_RECORDS = {"schema_version": SCHEMA_VERSION, "marks": [], "comments": [], "notes": []}
FEEDBACK_TEXT_CHARS = 4_000


class RecordOwner(str, Enum):
    PROJECT_ASSET = "project_asset"
    LITERATURE_ATTACHMENT = "literature_attachment"


@dataclass(frozen=True)
class RecordTarget:
    owner: RecordOwner
    scope_id: str
    subject_id: str

    def response(self) -> dict[str, str]:
        return {
            "owner": self.owner.value,
            "scope_id": self.scope_id,
            "subject_id": self.subject_id,
        }


@dataclass(frozen=True)
class PdfRecordSnapshot:
    record_target: RecordTarget
    record_revision: str
    source_revision: str
    source_state: str
    records: dict[str, Any]
    source_path: str = ""

    def response(self) -> dict[str, Any]:
        return {
            "record_target": self.record_target.response(),
            "record_revision": self.record_revision,
            "source_revision": self.source_revision,
            "source_state": self.source_state,
            "source_path": self.source_path,
            "records": self.records,
        }


@runtime_checkable
class ProjectPdfRecordPort(Protocol):
    """Composition-facing write surface for project-owned PDF records."""

    def snapshot_asset(
        self, project_id: str, asset_id: str, *, initial_records: dict[str, Any] | None = None
    ) -> PdfRecordSnapshot: ...

    def snapshot(self, project_id: str, pdf_path: str) -> PdfRecordSnapshot: ...

    def link_asset(
        self,
        project_id: str,
        asset_id: str,
        target: RecordTarget,
    ) -> None: ...

    def commit_asset(
        self,
        project_id: str,
        asset_id: str,
        records: dict[str, Any],
        expected_record_revision: str,
        expected_source_revision: str,
    ) -> PdfRecordSnapshot: ...


@runtime_checkable
class PdfRecordTargetPort(Protocol):
    """Resolve and CAS-write canonical records owned outside a project asset."""

    def snapshot_target(self, target: RecordTarget) -> PdfRecordSnapshot: ...

    def commit_target(
        self,
        target: RecordTarget,
        records: dict[str, Any],
        expected_record_revision: str,
        expected_source_revision: str,
    ) -> PdfRecordSnapshot: ...


def canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def _identifier(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError
    return value


def _text(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError
    return value


def _page(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError
    return value


def _timestamp(value: Any) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError
    return float(value)


def _quads(value: Any) -> list[list[float]]:
    if not isinstance(value, list) or not value:
        raise ValueError
    normalized: list[list[float]] = []
    for quad in value:
        if not isinstance(quad, list) or len(quad) != 4:
            raise ValueError
        coordinates = [float(coordinate) for coordinate in quad]
        if any(
            not isinstance(coordinate, (int, float))
            or isinstance(coordinate, bool)
            or not math.isfinite(coordinate)
            or coordinate < 0
            or coordinate > 1
            for coordinate in quad
        ):
            raise ValueError
        left, top, right, bottom = coordinates
        if left >= right or top >= bottom:
            raise ValueError
        normalized.append(coordinates)
    return normalized


def decode_records(payload: bytes | dict[str, Any]) -> dict[str, Any]:
    decoded = json.loads(payload) if isinstance(payload, bytes) else payload
    if not isinstance(decoded, dict) or decoded.get("schema_version") != SCHEMA_VERSION:
        raise ValueError
    raw_marks = decoded.get("marks")
    raw_comments = decoded.get("comments")
    raw_notes = decoded.get("notes")
    if (
        not isinstance(raw_marks, list)
        or not isinstance(raw_comments, list)
        or not isinstance(raw_notes, list)
    ):
        raise ValueError

    marks: list[dict[str, Any]] = []
    mark_ids: set[str] = set()
    for raw in raw_marks:
        if not isinstance(raw, dict):
            raise ValueError
        mark_id = _identifier(raw.get("id"))
        style = raw.get("style")
        color = raw.get("color")
        anchor_state = raw.get("anchor_state")
        if (
            mark_id in mark_ids
            or style not in MARK_STYLES
            or color not in MARK_COLORS
            or anchor_state not in ANCHOR_STATES
        ):
            raise ValueError
        mark_ids.add(mark_id)
        marks.append(
            {
                "id": mark_id,
                "style": style,
                "color": color,
                "page": _page(raw.get("page")),
                "quads": _quads(raw.get("quads")),
                "text": _text(raw.get("text")),
                "anchor_state": anchor_state,
                "created_at": _timestamp(raw.get("created_at")),
                "updated_at": _timestamp(raw.get("updated_at")),
            }
        )

    comments: list[dict[str, Any]] = []
    comment_ids: set[str] = set()
    for raw in raw_comments:
        if not isinstance(raw, dict):
            raise ValueError
        comment_id = _identifier(raw.get("id"))
        mark_id = _identifier(raw.get("mark_id"))
        if comment_id in comment_ids or mark_id not in mark_ids:
            raise ValueError
        comment_ids.add(comment_id)
        comments.append(
            {
                "id": comment_id,
                "mark_id": mark_id,
                "body": _text(raw.get("body")),
                "created_at": _timestamp(raw.get("created_at")),
            }
        )

    notes: list[dict[str, Any]] = []
    note_ids: set[str] = set()
    excerpt_ids: set[str] = set()
    for raw in raw_notes:
        if not isinstance(raw, dict) or not isinstance(raw.get("excerpts"), list):
            raise ValueError
        note_id = _identifier(raw.get("id"))
        if note_id in note_ids:
            raise ValueError
        note_ids.add(note_id)
        excerpts: list[dict[str, Any]] = []
        for excerpt in raw["excerpts"]:
            if not isinstance(excerpt, dict):
                raise ValueError
            excerpt_id = _identifier(excerpt.get("id"))
            mark_id = _identifier(excerpt.get("mark_id"))
            if excerpt_id in excerpt_ids or mark_id not in mark_ids:
                raise ValueError
            excerpt_ids.add(excerpt_id)
            excerpts.append(
                {
                    "id": excerpt_id,
                    "mark_id": mark_id,
                    "text": _text(excerpt.get("text")),
                    "page": _page(excerpt.get("page")),
                }
            )
        notes.append(
            {
                "id": note_id,
                "title": _text(raw.get("title")),
                "body": _text(raw.get("body")),
                "excerpts": excerpts,
            }
        )
    return {"schema_version": SCHEMA_VERSION, "marks": marks, "comments": comments, "notes": notes}


def encode_records(records: dict[str, Any]) -> bytes:
    return canonical(decode_records(records))


def payload_revision(payload: bytes) -> str:
    """Return the content-addressed identity used by resource version history."""

    return f"{REVISION_PREFIX}{hashlib.sha256(payload).hexdigest()}"


def record_revision(source_revision: str, records: dict[str, Any]) -> str:
    state = canonical(
        {"source_revision": _identifier(source_revision), "records": decode_records(records)}
    )
    return f"{REVISION_PREFIX}{hashlib.sha256(state).hexdigest()}"


def project_anchors(records: dict[str, Any], stale: bool) -> dict[str, Any]:
    normalized = decode_records(records)
    if not stale:
        return normalized
    return {
        **normalized,
        "marks": [{**mark, "anchor_state": "stale"} for mark in normalized["marks"]],
    }


def feedback_parts(record_id: str, text: str) -> list[dict[str, Any]]:
    """Bound every user-authored text part without dropping oversized records."""

    chunks = [
        text[offset : offset + FEEDBACK_TEXT_CHARS]
        for offset in range(0, len(text), FEEDBACK_TEXT_CHARS)
    ] or [""]
    return [
        {"record_id": record_id, "text": chunk, "part": index + 1, "parts": len(chunks)}
        for index, chunk in enumerate(chunks)
    ]


def feedback_entries(
    snapshot: PdfRecordSnapshot,
    *,
    attachment: str = "",
) -> list[dict[str, Any]]:
    """Project canonical PDF records as bounded feedback, never citation evidence."""

    records = snapshot.records
    marks = {str(mark["id"]): mark for mark in records["marks"]}
    source = {
        "attachment": attachment,
        "record_revision": snapshot.record_revision,
        "source_revision": snapshot.source_revision,
        "source_state": snapshot.source_state,
    }
    entries: list[dict[str, Any]] = []
    for mark in records["marks"]:
        entries.extend(
            {
                "kind": "mark",
                **source,
                **part,
                "style": mark["style"],
                "color": mark["color"],
                "page": mark["page"],
                "anchor_state": mark["anchor_state"],
                "created_at": mark["created_at"],
                "updated_at": mark["updated_at"],
            }
            for part in feedback_parts(str(mark["id"]), str(mark["text"]))
        )
    for comment in records["comments"]:
        mark = marks[str(comment["mark_id"])]
        entries.extend(
            {
                "kind": "comment",
                **source,
                **part,
                "parent_id": comment["mark_id"],
                "page": mark["page"],
                "anchor_state": mark["anchor_state"],
                "created_at": comment["created_at"],
            }
            for part in feedback_parts(str(comment["id"]), str(comment["body"]))
        )
    for note in records["notes"]:
        entries.extend(
            {
                "kind": "pdf_note",
                **source,
                **part,
                "title": note["title"],
            }
            for part in feedback_parts(str(note["id"]), str(note["body"]))
        )
        for excerpt in note["excerpts"]:
            mark = marks[str(excerpt["mark_id"])]
            entries.extend(
                {
                    "kind": "pdf_note_excerpt",
                    **source,
                    **part,
                    "parent_id": note["id"],
                    "page": excerpt["page"],
                    "anchor_state": mark["anchor_state"],
                }
                for part in feedback_parts(str(excerpt["id"]), str(excerpt["text"]))
            )
    return entries


__all__ = [
    "EMPTY_RECORDS",
    "PdfRecordSnapshot",
    "ProjectPdfRecordPort",
    "PdfRecordTargetPort",
    "RecordOwner",
    "RecordTarget",
    "feedback_entries",
    "feedback_parts",
    "decode_records",
    "encode_records",
    "payload_revision",
    "project_anchors",
    "record_revision",
]
