from __future__ import annotations

from typing import Any

from service.content.domain.model import ContentError
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import PDF_MEDIA_TYPE
from service.literature.service.records import AttachmentRecords
from service.platform.records import POINT_COMMENT_STYLE, RecordOwner, RecordTarget

NOTE_SOURCE_VERSION = 1
NOTE_SOURCE_PREFIX = "#scholarseed-note-sources-"
NOTE_SOURCE_LIMIT = 100
NOTE_SOURCE_CANDIDATE_LIMIT = 1000
NOTE_SOURCE_TEXT_LIMIT = 16384
NOTE_SOURCE_IDENTIFIER_LIMIT = 256
NOTE_SOURCE_NAME_LIMIT = 512
NOTE_SOURCE_PAGE_LIMIT = (1 << 53) - 1
NOTE_SOURCE_BODY_LIMIT = 4 * 1024 * 1024
NOTE_SOURCE_INVALID = "literature_note_sources_invalid"
NOTE_SOURCE_MISSING = "literature_note_sources_missing"
NOTE_SOURCE_TEXT = "text"
NOTE_SOURCE_COMMENT = "user_comment"
NOTE_SOURCE_LOCATION = "location"
NOTE_SOURCE_AVAILABLE = "available"
NOTE_SOURCE_UNAVAILABLE = "unavailable"
NOTE_SOURCE_CHANGED = "changed"
SOURCE_FIELDS = frozenset(
    {
        "record_target",
        "source_revision",
        "mark_id",
        "comment_id",
        "kind",
        "page",
        "text",
        "attachment_name",
    }
)
TARGET_FIELDS = frozenset({"owner", "scope_id", "subject_id"})


def _bounded_text(value: Any, limit: int, *, empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(NOTE_SOURCE_INVALID)
    return value


def validate_source_group(payload: Any) -> list[dict[str, Any]]:
    version = payload.get("version") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or set(payload) != {"version", "sources"}
        or not isinstance(version, int)
        or isinstance(version, bool)
        or version != NOTE_SOURCE_VERSION
        or not isinstance(payload.get("sources"), list)
        or not 1 <= len(payload["sources"]) <= NOTE_SOURCE_LIMIT
    ):
        raise ValueError(NOTE_SOURCE_INVALID)
    result = []
    for source in payload["sources"]:
        if not isinstance(source, dict) or set(source) != SOURCE_FIELDS:
            raise ValueError(NOTE_SOURCE_INVALID)
        target = source["record_target"]
        if (
            not isinstance(target, dict)
            or set(target) != TARGET_FIELDS
            or target.get("owner") != RecordOwner.LITERATURE_ATTACHMENT.value
        ):
            raise ValueError(NOTE_SOURCE_INVALID)
        _bounded_text(target.get("scope_id"), NOTE_SOURCE_IDENTIFIER_LIMIT)
        _bounded_text(target.get("subject_id"), NOTE_SOURCE_IDENTIFIER_LIMIT)
        for name in ("source_revision", "mark_id"):
            _bounded_text(source[name], NOTE_SOURCE_IDENTIFIER_LIMIT)
        _bounded_text(source["attachment_name"], NOTE_SOURCE_NAME_LIMIT, empty=True)
        _bounded_text(
            source["text"], NOTE_SOURCE_TEXT_LIMIT, empty=source["kind"] == NOTE_SOURCE_LOCATION
        )
        page = source["page"]
        if (
            not isinstance(page, int)
            or isinstance(page, bool)
            or not 1 <= page <= NOTE_SOURCE_PAGE_LIMIT
        ):
            raise ValueError(NOTE_SOURCE_INVALID)
        if source["kind"] in (NOTE_SOURCE_TEXT, NOTE_SOURCE_LOCATION):
            if source["comment_id"] is not None:
                raise ValueError(NOTE_SOURCE_INVALID)
            if source["kind"] == NOTE_SOURCE_LOCATION and source["text"] != "":
                raise ValueError(NOTE_SOURCE_INVALID)
        elif source["kind"] == NOTE_SOURCE_COMMENT:
            _bounded_text(source["comment_id"], NOTE_SOURCE_IDENTIFIER_LIMIT)
        else:
            raise ValueError(NOTE_SOURCE_INVALID)
        result.append(source)
    return result


def source_identity(source: dict[str, Any]) -> tuple[str, str, str, str | None]:
    target = source["record_target"]
    return target["scope_id"], target["subject_id"], source["mark_id"], source["comment_id"]


def source_entries(mark: dict, comments: list[dict]) -> list[tuple[str, str | None, str]]:
    """Keep every mark identity, including anchors without extracted text."""
    text = mark.get("text", "")
    entries: list[tuple[str, str | None, str]] = (
        [(NOTE_SOURCE_TEXT, None, text)]
        if mark["style"] != POINT_COMMENT_STYLE and text.strip()
        else [(NOTE_SOURCE_LOCATION, None, "")]
    )
    entries.extend(
        (NOTE_SOURCE_COMMENT, comment["id"], comment["body"])
        for comment in comments
        if comment["mark_id"] == mark["id"] and comment["body"].strip()
    )
    return entries


class NoteSources:
    def __init__(self, repository: LiteratureRepository, records: AttachmentRecords) -> None:
        self._repository = repository
        self._records = records

    def candidates(self, literature_id: str) -> dict[str, Any]:
        return self._sources(literature_id)

    def _sources(
        self, literature_id: str, requested: set[tuple[str, str, str, str | None]] | None = None
    ) -> dict[str, Any]:
        item = self._repository.get(literature_id, read_only=True)
        if item is None:
            raise ContentError(NOTE_SOURCE_MISSING)
        attachment_ids = (
            None
            if requested is None
            else {identity[1] for identity in requested if identity[0] == literature_id}
        )
        result: list[dict[str, Any]] = []
        unavailable = []
        omitted = 0
        for attachment in self._repository.attachments(literature_id, read_only=True):
            if attachment["media_type"] != PDF_MEDIA_TYPE or (
                attachment_ids is not None and attachment["id"] not in attachment_ids
            ):
                continue
            target = RecordTarget(
                RecordOwner.LITERATURE_ATTACHMENT, literature_id, attachment["id"]
            )
            try:
                snapshot = self._records.peek_target(target)
            except ContentError:
                unavailable.append(attachment["id"])
                continue
            if snapshot.source_state != NOTE_SOURCE_AVAILABLE or snapshot.record_target != target:
                unavailable.append(attachment["id"])
                continue
            requested_marks = (
                None
                if requested is None
                else {
                    identity[2]
                    for identity in requested
                    if identity[:2] == (literature_id, attachment["id"])
                }
            )
            for mark in snapshot.records["marks"]:
                if mark["anchor_state"] != "anchored" or (
                    requested_marks is not None and mark["id"] not in requested_marks
                ):
                    continue
                entries = source_entries(mark, snapshot.records["comments"])
                for kind, comment_id, text in entries:
                    if (
                        requested is not None
                        and (literature_id, attachment["id"], mark["id"], comment_id)
                        not in requested
                    ):
                        continue
                    source = {
                        "record_target": target.response(),
                        "source_revision": snapshot.source_revision,
                        "mark_id": mark["id"],
                        "comment_id": comment_id,
                        "kind": kind,
                        "page": mark["page"],
                        "text": text,
                        "attachment_name": attachment["name"],
                    }
                    try:
                        validate_source_group({"version": NOTE_SOURCE_VERSION, "sources": [source]})
                    except ValueError:
                        omitted += 1
                        continue
                    if requested is None and len(result) == NOTE_SOURCE_CANDIDATE_LIMIT:
                        omitted += 1
                        continue
                    result.append(source)
        return {
            "items": result,
            "unavailable_attachment_ids": unavailable,
            "omitted_count": omitted,
        }

    def resolve(self, literature_id: str, payload: Any) -> dict[str, Any]:
        sources = validate_source_group(payload)
        candidates = self._sources(literature_id, {source_identity(source) for source in sources})
        current = {source_identity(source): source for source in candidates["items"]}
        result = []
        for source in sources:
            latest = current.get(source_identity(source))
            state = NOTE_SOURCE_UNAVAILABLE
            if latest is not None:
                state = (
                    NOTE_SOURCE_AVAILABLE
                    if all(
                        latest[key] == source[key]
                        for key in ("source_revision", "kind", "page", "text")
                    )
                    else NOTE_SOURCE_CHANGED
                )
            result.append(
                {
                    "source": source,
                    "state": state,
                    "current": latest if state == NOTE_SOURCE_AVAILABLE else None,
                }
            )
        return {"items": result}
