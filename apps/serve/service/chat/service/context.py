"""Searchable product conversation references for Assistant turns."""

from __future__ import annotations

import json

from service.chat.constants import SessionTitleFallback
from service.chat.service.history import HistoryError, HistoryService, content_revision
from service.platform.context import (
    AssistantContextIssue,
    AssistantContextResolution,
    AssistantContextResolvedItem,
    AssistantContextResolveRequest,
    ContextLabelFallback,
    ContextRefKind,
    ContextResolutionState,
)

PROVIDER_VERSION = "chat-context/v2"
HISTORY_REFERENCE_MEDIA_TYPE = "application/vnd.scholarseed.conversation-reference+json"
HISTORY_REFERENCE_LEVEL = "retrievable"
FAILURE_STATES = {
    "session_not_found": ContextResolutionState.MISSING,
    "session_forbidden": ContextResolutionState.FORBIDDEN,
}


class SessionContextProvider:
    """Expose reference metadata, never prefix-truncated conversation bodies."""

    def __init__(self, history: HistoryService) -> None:
        self._history = history

    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution:
        ref = request.ref
        if ref.kind is not ContextRefKind.SESSION:
            return self._failure(ContextResolutionState.UNSUPPORTED, "source_type_unsupported")
        try:
            source = self._history.source(request.requester_session_id, ref.source_id)
        except HistoryError as error:
            return self._failure(FAILURE_STATES[str(error)], str(error))
        if not source.entries:
            return self._failure(ContextResolutionState.MISSING, "session_history_empty")
        if ref.source_revision and ref.source_revision != source.revision:
            return self._failure(ContextResolutionState.STALE, "source_revision_changed")
        descriptor = json.dumps(
            {
                "session_id": source.session_id,
                "title": source.title,
                "message_count": len(source.entries),
                "content_level": HISTORY_REFERENCE_LEVEL,
                "instruction": "Use scholarseed-bridge history search/read to retrieve messages before answering. "
                "This descriptor contains no message evidence. See scholarseed-bridge history --help.",
            },
            ensure_ascii=False,
        )
        return AssistantContextResolution(
            state=ContextResolutionState.READY,
            provider_version=PROVIDER_VERSION,
            source_revision=source.revision,
            items=(
                AssistantContextResolvedItem(
                    item_id=ref.source_id,
                    source_id=ref.source_id,
                    label=source.title or ref.label,
                    label_fallback=(
                        (
                            ContextLabelFallback.NEW_SESSION
                            if source.title_fallback is SessionTitleFallback.NEW_SESSION
                            else None
                        )
                        if source.title
                        else ref.label_fallback
                    ),
                    source_revision=source.revision,
                    text=descriptor,
                    content_hash=content_revision(descriptor),
                    media_type=HISTORY_REFERENCE_MEDIA_TYPE,
                    content_level=HISTORY_REFERENCE_LEVEL,
                ),
            ),
        )

    @staticmethod
    def _failure(state: ContextResolutionState, reason: str) -> AssistantContextResolution:
        return AssistantContextResolution(
            state=state,
            provider_version=PROVIDER_VERSION,
            issues=(AssistantContextIssue(code=reason),),
        )
