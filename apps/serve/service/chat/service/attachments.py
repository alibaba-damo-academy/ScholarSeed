"""Resolve sent attachment references for project-library imports."""

from __future__ import annotations

from hashlib import file_digest, sha256
from pathlib import Path

from service.chat.constants import (
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_REFERENCE_FILE,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
)
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.chat.service.artifacts import ArtifactReadError
from service.paths import SESSION_ATTACHMENT_DIRNAME
from service.platform.citations import CitationDocument

ATTACHMENT_NOT_FOUND = "session_attachment_not_found"
ATTACHMENT_CHANGED = "session_attachment_changed"
ATTACHMENT_FORBIDDEN = "session_attachment_forbidden"


class AttachmentService:
    """Read references from durable sent messages, including after cold resume."""

    def __init__(self, catalog: SessionCatalogStore, events: ProductEventStore) -> None:
        self._catalog = catalog
        self._events = events

    def pdf_references(self, session_id: str, turn_id: str) -> tuple[dict, ...]:
        return tuple(ref for ref, _ in self._pdf_references(session_id, turn_id))

    def _pdf_references(self, session_id: str, turn_id: str) -> tuple[tuple[dict, int], ...]:
        references = {}
        after = 0
        while events := self._events.replay(session_id, after_seq=after):
            after = events[-1].product_seq
            for event in events:
                if event.kind != PRODUCT_EVENT_USER_MESSAGE or event.vendor_turn_id != turn_id:
                    continue
                for ref in event.payload.get("refs", []):
                    if (
                        isinstance(ref, dict)
                        and ref.get("type") == PRODUCT_REFERENCE_FILE
                        and str(ref.get("path", "")).lower().endswith(".pdf")
                    ):
                        references[str(ref["id"])] = (ref, event.product_seq)
        return tuple(references.values())

    def pdf_document(self, session_id: str, turn_id: str, reference_id: str) -> CitationDocument:
        found = next(
            (
                (ref, seq)
                for ref, seq in self._pdf_references(session_id, turn_id)
                if ref["id"] == reference_id
            ),
            None,
        )
        if found is None:
            raise ValueError(ATTACHMENT_NOT_FOUND)
        ref, source_seq = found
        try:
            source = self._reference_path(session_id, ref, source_seq)
            payload = source.read_bytes()
        except ArtifactReadError as error:
            raise ValueError(error.code) from error
        except OSError as error:
            raise ValueError(ATTACHMENT_NOT_FOUND) from error
        digest = sha256(payload).hexdigest()
        if ref.get("sha256") and ref["sha256"] != digest:
            raise ValueError(ATTACHMENT_CHANGED)
        return CitationDocument(
            "",
            str(ref.get("title") or source.name),
            str(ref.get("title") or source.name),
            "sha256:" + digest,
            payload,
            session_id,
            reference_id,
        )

    def source_path(self, session_id: str, reference_id: str) -> str:
        session = self._catalog.get(session_id)
        if session is None:
            raise ArtifactReadError(ATTACHMENT_NOT_FOUND)
        after = 0
        while records := self._events.replay(session_id, after_seq=after):
            after = records[-1].product_seq
            for event in records:
                if event.kind != PRODUCT_EVENT_USER_MESSAGE:
                    continue
                for ref in event.payload.get("refs", []):
                    if not isinstance(ref, dict):
                        continue
                    if ref.get("type") != PRODUCT_REFERENCE_FILE or ref.get("id") != reference_id:
                        continue
                    target = self._reference_path(session_id, ref, event.product_seq)
                    try:
                        if ref.get("sha256"):
                            with target.open("rb") as stream:
                                if file_digest(stream, "sha256").hexdigest() != ref["sha256"]:
                                    raise ArtifactReadError(ATTACHMENT_CHANGED)
                    except OSError as error:
                        raise ArtifactReadError(ATTACHMENT_NOT_FOUND) from error
                    return str(target)
        raise ArtifactReadError(ATTACHMENT_NOT_FOUND)

    def _reference_path(self, session_id: str, ref: dict, source_seq: int) -> Path:
        session = self._catalog.get(session_id)
        if session is None:
            raise ArtifactReadError(ATTACHMENT_NOT_FOUND)
        raw = Path(str(ref.get("path") or ""))
        if not raw.is_absolute():
            raise ArtifactReadError(ATTACHMENT_FORBIDDEN)
        target = raw.resolve()
        if target != raw:
            raise ArtifactReadError(ATTACHMENT_FORBIDDEN)
        if ref.get("origin") != PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE:
            try:
                origin = self._events.workspace_for_sequence(session, source_seq)
            except ValueError as error:
                raise ArtifactReadError(ATTACHMENT_FORBIDDEN) from error
            root = Path(origin.runtime_workdir).resolve()
            if not target.is_relative_to(root / SESSION_ATTACHMENT_DIRNAME):
                raise ArtifactReadError(ATTACHMENT_FORBIDDEN)
        if not target.is_file():
            raise ArtifactReadError(ATTACHMENT_NOT_FOUND)
        return target
