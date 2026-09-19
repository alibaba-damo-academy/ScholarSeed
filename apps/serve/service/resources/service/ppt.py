"""Resource action processor for legacy binary PPT selections."""

from __future__ import annotations

from pathlib import PurePosixPath

from service.resources.domain.ai import ResourceAction, ResourceCommand
from service.resources.service.evidence import (
    MAX_RESOURCE_CONTEXT,
    ResolvedResourceEvidence,
    from_verified,
    frozen_snapshot_matches,
)
from service.workbench.domain.selection import SelectionEvidenceError, SelectionEvidenceProvider
from service.workbench.domain.slides import PPT_SUFFIX

PPT_SNAPSHOT_ACTIONS = frozenset((ResourceAction.EXPLAIN, ResourceAction.TRANSLATE))
PPT_SNAPSHOT_REQUIRED_ERROR = "selection_snapshot_required"


class PptActionProcessor:
    def resolve(
        self,
        command: ResourceCommand,
        evidence: SelectionEvidenceProvider,
        *,
        max_chars: int = MAX_RESOURCE_CONTEXT,
    ) -> ResolvedResourceEvidence:
        if (
            command.selection is None
            or PurePosixPath(command.source_id).suffix.lower() != PPT_SUFFIX
        ):
            raise SelectionEvidenceError("selection_unsupported")
        try:
            verified = evidence.resolve_action(command.selection, command.draft)
        except SelectionEvidenceError as exc:
            if exc.code == PPT_SNAPSHOT_REQUIRED_ERROR and command.action is ResourceAction.POLISH:
                raise SelectionEvidenceError("resource_polish_unsupported") from exc
            if (
                exc.code != PPT_SNAPSHOT_REQUIRED_ERROR
                or command.action not in PPT_SNAPSHOT_ACTIONS
                or not frozen_snapshot_matches(command, max_chars=max_chars)
            ):
                raise
            snapshot = command.selected_text_snapshot
            return ResolvedResourceEvidence(
                selected_text=snapshot,
                context_text=snapshot,
                locator=command.selection.locator,
                can_edit=False,
            )
        return from_verified(verified)


__all__ = ["PptActionProcessor"]
