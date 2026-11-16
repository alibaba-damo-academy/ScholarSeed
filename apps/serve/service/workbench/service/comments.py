"""Versioned PDF user feedback through canonical record-owner readers."""

from __future__ import annotations

import base64
import json
import re
import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from enum import Enum

from service.content.domain.model import ContentError
from service.platform.context import (
    AssistantContextIssue,
    AssistantContextResolution,
    AssistantContextResolvedItem,
    AssistantContextResolveRequest,
    ContextAuthority,
    ContextOrigin,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ContextRetention,
)
from service.platform.records import PdfRecordSnapshot, RecordOwner, RecordTarget

IDENTITY_PREFIX = "pdf-comment:v1:"
IDENTITY_LIMIT = 2048
IDENTIFIER_LIMIT = 256
PROVIDER_VERSION = "pdf-comment/v1"
FEEDBACK_MEDIA_TYPE = "application/vnd.scholarseed.pdf-comment+json"
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9_.:-]+")
ENCODED_PATTERN = re.compile(r"[A-Za-z0-9_-]+")


class CommentFailure(str, Enum):
    INVALID = "pdf_comment_invalid"
    MISSING = "pdf_comment_missing"
    FORBIDDEN = "pdf_comment_forbidden"
    STALE = "pdf_comment_stale"
    UNAVAILABLE = "pdf_comment_unavailable"
    TOO_LARGE = "pdf_comment_too_large"


FAILURE_STATES = {
    CommentFailure.INVALID: ContextResolutionState.UNSUPPORTED,
    CommentFailure.MISSING: ContextResolutionState.MISSING,
    CommentFailure.FORBIDDEN: ContextResolutionState.FORBIDDEN,
    CommentFailure.STALE: ContextResolutionState.STALE,
    CommentFailure.UNAVAILABLE: ContextResolutionState.UNAVAILABLE,
    CommentFailure.TOO_LARGE: ContextResolutionState.TOO_LARGE,
}
OWNER_FAILURES = {
    "pdf_comment_missing": CommentFailure.MISSING,
    "literature_attachment_missing": CommentFailure.MISSING,
    "literature_not_found": CommentFailure.MISSING,
    "file_not_found": CommentFailure.MISSING,
    "asset_not_found": CommentFailure.MISSING,
    "unknown_project": CommentFailure.MISSING,
    "record_owner_mismatch": CommentFailure.FORBIDDEN,
    "path_outside_project": CommentFailure.FORBIDDEN,
    "source_revision_conflict": CommentFailure.STALE,
    "prepared_content_unavailable": CommentFailure.MISSING,
    "content_source_changed": CommentFailure.STALE,
}


class PdfCommentError(ValueError):
    def __init__(self, code: CommentFailure) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class CommentIdentity:
    target: RecordTarget
    mark_id: str
    comment_id: str


def _identifier(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) > IDENTIFIER_LIMIT
        or IDENTIFIER_PATTERN.fullmatch(value) is None
    ):
        raise PdfCommentError(CommentFailure.INVALID)
    return value


def encode_identity(identity: CommentIdentity) -> str:
    values = [
        identity.target.owner.value,
        _identifier(identity.target.scope_id),
        _identifier(identity.target.subject_id),
        _identifier(identity.mark_id),
        _identifier(identity.comment_id),
    ]
    encoded = (
        base64.urlsafe_b64encode(json.dumps(values, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )
    return IDENTITY_PREFIX + encoded


def decode_identity(source_id: str) -> CommentIdentity:
    if (
        not isinstance(source_id, str)
        or len(source_id) > IDENTITY_LIMIT
        or not source_id.startswith(IDENTITY_PREFIX)
    ):
        raise PdfCommentError(CommentFailure.INVALID)
    encoded = source_id[len(IDENTITY_PREFIX) :]
    if ENCODED_PATTERN.fullmatch(encoded) is None:
        raise PdfCommentError(CommentFailure.INVALID)
    try:
        values = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if not isinstance(values, list) or len(values) != 5:
            raise ValueError
        owner, scope, subject, mark, comment = (_identifier(value) for value in values)
        identity = CommentIdentity(RecordTarget(RecordOwner(owner), scope, subject), mark, comment)
        if encode_identity(identity) != source_id:
            raise ValueError
        return identity
    except (ValueError, TypeError, UnicodeError) as error:
        raise PdfCommentError(CommentFailure.INVALID) from error


class PdfCommentContext:
    def __init__(
        self, readers: Mapping[RecordOwner, Callable[[RecordTarget], PdfRecordSnapshot]]
    ) -> None:
        self._readers = dict(readers)

    def _snapshot(self, target: RecordTarget) -> PdfRecordSnapshot:
        reader = self._readers.get(target.owner)
        if reader is None:
            raise PdfCommentError(CommentFailure.INVALID)
        try:
            snapshot = reader(target)
        except ContentError as error:
            raise PdfCommentError(
                OWNER_FAILURES.get(error.code, CommentFailure.UNAVAILABLE)
            ) from error
        except PermissionError as error:
            raise PdfCommentError(CommentFailure.FORBIDDEN) from error
        except (OSError, ValueError, sqlite3.DatabaseError) as error:
            raise PdfCommentError(CommentFailure.UNAVAILABLE) from error
        if snapshot.record_target != target:
            raise PdfCommentError(CommentFailure.FORBIDDEN)
        if snapshot.source_state != "available":
            raise PdfCommentError(CommentFailure.UNAVAILABLE)
        return snapshot

    def prepare(
        self, target: RecordTarget, mark_id: str, source_revision: str, record_revision: str
    ) -> tuple[ContextRef, ...]:
        _identifier(mark_id)
        snapshot = self._snapshot(target)
        if (
            snapshot.source_revision != source_revision
            or snapshot.record_revision != record_revision
        ):
            raise PdfCommentError(CommentFailure.STALE)
        mark = next((mark for mark in snapshot.records["marks"] if mark["id"] == mark_id), None)
        if mark is None:
            raise PdfCommentError(CommentFailure.MISSING)
        if mark["anchor_state"] != "anchored":
            raise PdfCommentError(CommentFailure.STALE)
        refs = []
        for comment in snapshot.records["comments"]:
            if comment["mark_id"] != mark_id or not comment["body"].strip():
                continue
            identity = CommentIdentity(target, mark_id, comment["id"])
            source_id = encode_identity(identity)
            refs.append(
                ContextRef(
                    source_id,
                    ContextRefKind.PDF_COMMENT,
                    source_id,
                    f"PDF · {mark['page']}",
                    snapshot.record_revision,
                    retention=ContextRetention.NEXT_TURN,
                    origin=ContextOrigin.EXPLICIT,
                )
            )
        return tuple(refs)

    def preview(
        self, source_id: str, source_revision: str, *, project_id: str | None = None
    ) -> dict:
        identity = decode_identity(source_id)
        target = identity.target
        if (
            project_id is not None
            and target.owner is RecordOwner.PROJECT_ASSET
            and target.scope_id != project_id
        ):
            raise PdfCommentError(CommentFailure.FORBIDDEN)
        snapshot = self._snapshot(target)
        mark = next(
            (mark for mark in snapshot.records["marks"] if mark["id"] == identity.mark_id), None
        )
        comment = next(
            (
                comment
                for comment in snapshot.records["comments"]
                if comment["id"] == identity.comment_id and comment["mark_id"] == identity.mark_id
            ),
            None,
        )
        if mark is None or comment is None or not comment["body"].strip():
            raise PdfCommentError(CommentFailure.MISSING)
        if snapshot.record_revision != source_revision or mark["anchor_state"] != "anchored":
            raise PdfCommentError(CommentFailure.STALE)
        return {
            "record_target": asdict(target),
            "source_revision": snapshot.source_revision,
            "record_revision": snapshot.record_revision,
            "mark_id": identity.mark_id,
            "comment_id": identity.comment_id,
            "page": mark["page"],
            "point": mark.get("point"),
            "comment": comment["body"],
        }

    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution:
        try:
            ref = request.ref
            if (
                ref.kind is not ContextRefKind.PDF_COMMENT
                or ref.anchor is not None
                or ref.origin is not ContextOrigin.EXPLICIT
            ):
                raise PdfCommentError(CommentFailure.INVALID)
            surface = self.preview(
                ref.source_id, ref.source_revision or "", project_id=request.project_id
            )
            text = json.dumps(
                {
                    "user_comment": surface["comment"],
                    "source": {key: value for key, value in surface.items() if key != "comment"},
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if request.budget.max_items < 1 or len(text) > request.budget.max_chars:
                raise PdfCommentError(CommentFailure.TOO_LARGE)
            item = AssistantContextResolvedItem(
                item_id=ref.source_id,
                source_id=ref.source_id,
                label=ref.label,
                source_revision=ref.source_revision or "",
                text=text,
                authority=ContextAuthority.USER_FEEDBACK,
                surface=surface,
                media_type=FEEDBACK_MEDIA_TYPE,
            )
            return AssistantContextResolution(
                ContextResolutionState.READY, PROVIDER_VERSION, ref.source_revision or "", (item,)
            )
        except PdfCommentError as error:
            return AssistantContextResolution(
                FAILURE_STATES[error.code],
                PROVIDER_VERSION,
                issues=(AssistantContextIssue(error.code.value),),
            )
