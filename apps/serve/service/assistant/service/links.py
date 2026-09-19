"""Project durable library relationships into the existing session event log."""

from __future__ import annotations

from service.assistant.persistence.links import (
    LINK_INVALID,
    ArtifactLinkCatalog,
    ArtifactLinkError,
    ArtifactLinkRecord,
    LinkState,
)
from service.chat.constants import PRODUCT_EVENT_ARTIFACT_LIBRARY_LINKED
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.platform.content import ContentPort


class LibraryLinkProjection:
    """Commit immutable facts before acknowledging their project-owned outbox."""

    def __init__(
        self, content: ContentPort, sessions: SessionCatalogStore, events: ProductEventStore
    ) -> None:
        self._links = ArtifactLinkCatalog(content)
        self._sessions = sessions
        self._events = events

    def project(self, record: ArtifactLinkRecord) -> None:
        if record.state is not LinkState.COMPLETED:
            raise ArtifactLinkError(LINK_INVALID)
        if record.projected:
            return
        payload = {
            "link_id": record.link_id,
            "project_id": record.project_id,
            "artifact_id": record.artifact_id,
            "source_sha256": record.source_sha256,
            "destination": record.destination.value,
            "target_ids": list(record.target_ids),
        }
        key = f"{PRODUCT_EVENT_ARTIFACT_LIBRARY_LINKED}:{record.project_id}:{record.link_id}"
        existing = self._events.by_key(record.session_id, key)
        if existing is not None:
            if (
                existing.kind != PRODUCT_EVENT_ARTIFACT_LIBRARY_LINKED
                or existing.payload != payload
            ):
                raise ArtifactLinkError(LINK_INVALID)
            self._links.acknowledge(record)
            return
        legacy_key = f"{PRODUCT_EVENT_ARTIFACT_LIBRARY_LINKED}:{record.link_id}"
        legacy = self._events.by_key(record.session_id, legacy_key)
        if legacy is not None:
            if legacy.kind != PRODUCT_EVENT_ARTIFACT_LIBRARY_LINKED:
                raise ArtifactLinkError(LINK_INVALID)
            if legacy.payload == payload:
                self._links.acknowledge(record)
                return
            if legacy.payload.get("project_id") == record.project_id:
                raise ArtifactLinkError(LINK_INVALID)
        session = self._sessions.get(record.session_id)
        if session is None or not session.vendor_thread_id:
            raise ArtifactLinkError(LINK_INVALID)
        self._events.append(
            session_id=record.session_id,
            runtime_id=session.runtime_id,
            vendor_thread_id=session.vendor_thread_id,
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=PRODUCT_EVENT_ARTIFACT_LIBRARY_LINKED,
            payload=payload,
            idempotency_key=key,
        )
        # A crash between these commits replays the same immutable event key.
        # Mutable paths and availability are deliberately not event payloads.
        self._links.acknowledge(record)
