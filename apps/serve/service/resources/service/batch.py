"""Application coordination for atomic and resumable resource review batches."""

from __future__ import annotations

import json
import time
from hashlib import sha256

from service.content.domain.model import ContentError
from service.paths import PROJECT_DB_RELATIVE
from service.platform.content import ContentPort
from service.platform.resources import (
    VERSION_MAX_BYTES,
    RestorePolicy,
    ReviewAction,
    ReviewBatch,
    ReviewBatchDecision,
    ReviewBatchDecisionResult,
    ReviewBatchMemberResult,
    ReviewBatchState,
    ReviewDecision,
    ReviewMemberState,
    ReviewOutcome,
)
from service.resources.persistence.batch import (
    ReviewBatchStore,
    ReviewBatchStoreConflict,
)
from service.resources.persistence.version import VersionStore, VersionStoreConflict
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.recovery import ResourceRecoveryError, ResourceRecoveryService

DEFAULT_BATCH_PAGE_SIZE = 50
BASE_CONTENT = "base"
CANDIDATE_CONTENT = "candidate"
CURRENT_CONTENT = "current"


class ResourceReviewBatchService:
    """Keep batch progress durable while delegating file truth to version services."""

    def __init__(
        self,
        content: ContentPort,
        versions: ResourceVersionService,
        recovery: ResourceRecoveryService,
    ) -> None:
        self._content = content
        self._versions = versions
        self._recovery = recovery

    def batches(
        self,
        project_id: str,
        state: ReviewBatchState | None = None,
        *,
        after_batch_id: str = "",
        limit: int = DEFAULT_BATCH_PAGE_SIZE,
    ) -> tuple[ReviewBatch, ...]:
        return self._store(project_id).batches(state, after_batch_id, limit)

    def batch(self, project_id: str, batch_id: str) -> ReviewBatch:
        result = self._store(project_id).batch(batch_id)
        if result is None:
            raise ResourceReviewBatchError("review_batch_not_found")
        return result

    def has_open_for_workdir(self, workdir: str) -> bool:
        project = self._content.project_for_path(workdir)
        if project is None:
            return False
        return bool(self._store(project.id).open_batches(1))

    def content(
        self, project_id: str, batch_id: str, file_id: str, kind: str
    ) -> tuple[bytes, str, str | None]:
        member = next(
            (item for item in self.batch(project_id, batch_id).members if item.file_id == file_id),
            None,
        )
        if member is None:
            raise ResourceReviewBatchError("review_batch_member_not_found")
        if kind == BASE_CONTENT:
            snapshot = member.base
        elif kind == CANDIDATE_CONTENT:
            snapshot = member.candidate
        elif kind == CURRENT_CONTENT:
            try:
                current = self._content.stable_snapshot(project_id, member.path, VERSION_MAX_BYTES)
            except ContentError as exc:
                if exc.code == "file_not_found":
                    return b"", "application/octet-stream", None
                raise ResourceReviewBatchError(exc.code) from exc
            return current.content, current.media_type, current.revision
        else:
            raise ResourceReviewBatchError("invalid_review_content")
        try:
            content, media_type = self._versions.review_snapshot(project_id, snapshot)
            return content, media_type, snapshot.object_id
        except ResourceVersionError as exc:
            raise ResourceReviewBatchError(exc.code) from exc

    def commit(
        self,
        project_id: str,
        batch_id: str,
        decisions: tuple[ReviewBatchDecision, ...],
        idempotency_key: str,
    ) -> ReviewBatchDecisionResult:
        if not idempotency_key or not decisions:
            raise ResourceReviewBatchError("invalid_review_batch_request")
        if len({decision.file_id for decision in decisions}) != len(decisions):
            raise ResourceReviewBatchError("review_batch_members_mismatch")
        store = self._store(project_id)
        current_batch = self.batch(project_id, batch_id)
        if {decision.file_id for decision in decisions} != {
            member.file_id for member in current_batch.members
        }:
            raise ResourceReviewBatchError("review_batch_members_mismatch")
        request_digest = _request_digest(decisions)
        try:
            receipt = store.begin_request(batch_id, idempotency_key, request_digest, _now_ms())
            current_batch = store.reconcile_completed(batch_id, _now_ms())
        except ReviewBatchStoreConflict as exc:
            raise ResourceReviewBatchError(exc.code) from exc
        if receipt is not None:
            return _receipt(current_batch, receipt)
        candidate_revisions = {
            member.file_id: member.candidate_revision for member in current_batch.members
        }
        if all(
            decision.action is ReviewAction.ACCEPT
            and decision.expected_disk_revision == candidate_revisions[decision.file_id]
            for decision in decisions
        ):
            result = self._accept(project_id, batch_id, decisions)
        else:
            try:
                batch = store.prepare(batch_id, decisions, _now_ms())
            except ReviewBatchStoreConflict as exc:
                raise ResourceReviewBatchError(exc.code) from exc
            indexed = {decision.file_id: decision for decision in decisions}
            for member in batch.members:
                if member.file_id not in indexed or member.state is ReviewMemberState.COMPLETED:
                    continue
                decision = indexed[member.file_id]
                try:
                    version_id = self._apply_member(
                        project_id,
                        batch_id,
                        member.path,
                        member.candidate_revision,
                        member.edited_by_user,
                        decision,
                    )
                except (
                    ContentError,
                    ResourceReviewBatchError,
                    ResourceRecoveryError,
                    ResourceVersionError,
                    ReviewBatchStoreConflict,
                    VersionStoreConflict,
                ) as exc:
                    store.finish_member(
                        batch_id,
                        member.file_id,
                        ReviewMemberState.FAILED,
                        _now_ms(),
                        error=getattr(exc, "code", type(exc).__name__),
                    )
                    continue
                store.finish_member(
                    batch_id,
                    member.file_id,
                    ReviewMemberState.COMPLETED,
                    _now_ms(),
                    version_id=version_id,
                )
            final = self.batch(project_id, batch_id)
            requested = {decision.file_id for decision in decisions}
            result = ReviewBatchDecisionResult(
                final,
                tuple(item for item in _results(final) if item.file_id in requested),
            )
        if all(item.state is ReviewMemberState.COMPLETED for item in result.results):
            payload = _receipt_payload(result)
            try:
                store.complete_request(idempotency_key, request_digest, payload, _now_ms())
            except ReviewBatchStoreConflict as exc:
                raise ResourceReviewBatchError(exc.code) from exc
        return result

    def _accept(
        self,
        project_id: str,
        batch_id: str,
        decisions: tuple[ReviewBatchDecision, ...],
    ) -> ReviewBatchDecisionResult:
        current = self.batch(project_id, batch_id)
        indexed = {member.file_id: member for member in current.members}
        if not {decision.file_id for decision in decisions}.issubset(indexed):
            raise ResourceReviewBatchError("review_batch_members_mismatch")
        pending = []
        for decision in decisions:
            member = indexed[decision.file_id]
            if (
                member.review_id != decision.review_id
                or member.pending_revision != decision.pending_revision
            ):
                raise ResourceReviewBatchError("review_batch_member_conflict")
            if member.action not in (None, ReviewAction.ACCEPT) and (
                member.state is not ReviewMemberState.FAILED
            ):
                raise ResourceReviewBatchError("review_batch_decision_conflict")
            if member.state is not ReviewMemberState.COMPLETED:
                pending.append(decision)
        try:
            versions = (
                self._versions.accept_review_batch(project_id, batch_id, tuple(pending))
                if pending
                else ()
            )
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            raise ResourceReviewBatchError(exc.code) from exc
        batch = self.batch(project_id, batch_id)
        by_file = {member.file_id: member.result_version_id for member in batch.members}
        by_file.update({version.file_id: version.id for version in versions})
        results = tuple(
            ReviewBatchMemberResult(
                decision.file_id,
                decision.action,
                ReviewMemberState.COMPLETED,
                by_file.get(decision.file_id),
            )
            for decision in decisions
        )
        return ReviewBatchDecisionResult(batch, results)

    def _apply_member(
        self,
        project_id: str,
        batch_id: str,
        path: str,
        candidate_revision: str | None,
        edited_by_user: bool,
        decision: ReviewBatchDecision,
    ) -> str | None:
        operation_key = _operation_key(batch_id, decision)
        effective = decision
        accepted_current = False
        if decision.expected_disk_revision != candidate_revision and not edited_by_user:
            preview = self._recovery.preview_review_conflict(project_id, decision.file_id)
            if preview.disk.object_id != decision.expected_disk_revision:
                raise ResourceReviewBatchError("review_disk_revision_conflict")
            if decision.action is not ReviewAction.REJECT:
                self._recovery.reconcile_review(
                    project_id,
                    decision.file_id,
                    "keep_current",
                    preview.token,
                    f"{operation_key}:reconcile",
                )
                accepted_current = True
                pending = self._versions.pending(project_id, decision.file_id)
                if pending is None or pending.review is None:
                    raise ResourceReviewBatchError("review_not_found")
                effective = ReviewBatchDecision(
                    decision.file_id,
                    pending.review.id,
                    pending.revision,
                    decision.action,
                    decision.expected_disk_revision,
                )
        outcome = {
            ReviewAction.ACCEPT: ReviewOutcome.ACCEPTED,
            ReviewAction.REJECT: ReviewOutcome.REJECTED,
            ReviewAction.REVISE: ReviewOutcome.REVISED,
        }[effective.action]
        if accepted_current:
            outcome = ReviewOutcome.REVISED
        review = ReviewDecision(effective.review_id, effective.pending_revision, outcome)
        if effective.action is ReviewAction.REJECT:
            self._recovery.reject_review(
                project_id,
                effective.file_id,
                review,
                effective.expected_disk_revision,
                f"{operation_key}:apply",
                policy=(
                    RestorePolicy.FORCE
                    if effective.expected_disk_revision != candidate_revision
                    else RestorePolicy.STRICT
                ),
            )
            return None
        return self._versions.seal_review(
            project_id,
            effective.file_id,
            path,
            review,
            effective.expected_disk_revision,
            f"{operation_key}:apply",
        ).version.id

    def _store(self, project_id: str) -> ReviewBatchStore:
        database = self._content.resolve(project_id, PROJECT_DB_RELATIVE)
        VersionStore(database, self._content.project(project_id).root).ensure()
        return ReviewBatchStore(database, self._content.project(project_id).root)


class ResourceReviewBatchError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _results(batch: ReviewBatch) -> tuple[ReviewBatchMemberResult, ...]:
    return tuple(
        ReviewBatchMemberResult(
            member.file_id,
            member.action or ReviewAction.ACCEPT,
            member.state,
            member.result_version_id,
            member.error,
        )
        for member in batch.members
    )


def _operation_key(batch_id: str, decision: ReviewBatchDecision) -> str:
    value = "\0".join(
        (
            batch_id,
            decision.file_id,
            decision.review_id,
            str(decision.pending_revision),
            decision.action.value,
        )
    )
    return "review-batch:" + sha256(value.encode("utf-8")).hexdigest()


def _request_digest(decisions: tuple[ReviewBatchDecision, ...]) -> str:
    payload = [
        {
            "file_id": item.file_id,
            "review_id": item.review_id,
            "pending_revision": item.pending_revision,
            "action": item.action.value,
            "expected_disk_revision": item.expected_disk_revision,
        }
        for item in sorted(decisions, key=lambda decision: decision.file_id)
    ]
    return sha256(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()


def _receipt_payload(result: ReviewBatchDecisionResult) -> dict:
    return {
        "results": [
            {
                "file_id": item.file_id,
                "action": item.action.value,
                "state": item.state.value,
                "version_id": item.version_id,
                "error": item.error,
            }
            for item in result.results
        ]
    }


def _receipt(batch: ReviewBatch, payload: dict) -> ReviewBatchDecisionResult:
    return ReviewBatchDecisionResult(
        batch,
        tuple(
            ReviewBatchMemberResult(
                str(item["file_id"]),
                ReviewAction(str(item["action"])),
                ReviewMemberState(str(item["state"])),
                str(item["version_id"]) if item.get("version_id") is not None else None,
                str(item["error"]) if item.get("error") is not None else None,
            )
            for item in payload["results"]
        ),
    )


def _now_ms() -> int:
    return int(time.time() * 1000)


__all__ = ["ResourceReviewBatchError", "ResourceReviewBatchService"]
