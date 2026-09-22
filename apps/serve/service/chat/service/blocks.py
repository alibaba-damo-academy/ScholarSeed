"""Durable post-turn assistant blocks supplied by product-owned services."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol


@dataclass(frozen=True)
class AssistantBlockPublication:
    """One product block plus its live event and durable acknowledgement key."""

    publication_id: str
    block: Mapping[str, Any]
    event: Mapping[str, Any]


class AssistantBlockSource(Protocol):
    """Product-owned durable outbox consumed after a successful agent turn."""

    def pending_assistant_blocks(
        self, *, session_id: str
    ) -> tuple[AssistantBlockPublication, ...]: ...

    def mark_assistant_block_published(self, *, session_id: str, publication_id: str) -> None: ...


class AssistantBlockService:
    """Publish registered product outboxes without teaching chat turns product business."""

    def __init__(self, logger: Any) -> None:
        self._logger = logger
        self._sources: dict[str, AssistantBlockSource] = {}

    def register(self, *, work: str, source: AssistantBlockSource) -> None:
        if work in self._sources and self._sources[work] is not source:
            raise RuntimeError(f"assistant block source already registered for work {work}")
        self._sources[work] = source

    async def publish_after_turn(self, session: Any) -> None:
        source = self._sources.get(str(session.work))
        work_session = getattr(session, "ws", None)
        if source is None or work_session is None:
            return
        try:
            publications = source.pending_assistant_blocks(session_id=session.id)
        except Exception as exc:  # noqa: BLE001 - product outbox remains pending for recovery
            self._logger.error(
                "assistant_block_source_failed",
                session_id=session.id,
                work=session.work,
                error=f"{type(exc).__name__}: {exc}",
            )
            return
        for publication in publications:
            try:
                appended = await work_session.append_assistant_blocks([dict(publication.block)])
                durable = appended or self._contains_publication(
                    work_session.transcript_messages(), publication
                )
                if not durable:
                    continue
                source.mark_assistant_block_published(
                    session_id=session.id,
                    publication_id=publication.publication_id,
                )
                if appended:
                    session._emit(dict(publication.event))
            except Exception as exc:  # noqa: BLE001 - durable outbox retries after a later turn
                self._logger.error(
                    "assistant_block_publish_failed",
                    session_id=session.id,
                    work=session.work,
                    publication_id=publication.publication_id,
                    error=f"{type(exc).__name__}: {exc}",
                )

    @staticmethod
    def _contains_publication(
        messages: list[dict[str, Any]], publication: AssistantBlockPublication
    ) -> bool:
        expected_type = str(publication.block.get("type") or "")
        for message in messages:
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if (
                    isinstance(block, dict)
                    and str(block.get("type") or "") == expected_type
                    and str(block.get("delivery_id") or "") == publication.publication_id
                ):
                    return True
        return False


__all__ = ["AssistantBlockPublication", "AssistantBlockService", "AssistantBlockSource"]
