"""Durable conflict-aware single-file and Delivery recovery."""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass
from hashlib import sha256
from time import perf_counter
from uuid import uuid4

from service.content.domain.model import ContentError
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.content import ContentPort, RootKind
from service.platform.resources import (
    GIT_VERSION_DISABLED_ERROR,
    VERSION_MAX_BYTES,
    DeliveryRestoreMember,
    DeliveryRestorePreview,
    DeliveryRestoreResult,
    DeliveryResult,
    FileState,
    PendingReview,
    PendingSnapshot,
    ResourceAnnotationPort,
    ResourceRetentionPort,
    RestorePolicy,
    RestorePreview,
    ReviewConflict,
    ReviewConflictPreview,
    ReviewDecision,
    ReviewOutcome,
    ReviewResolutionChoice,
    SealResult,
    SnapshotIdentity,
    VersionOrigin,
    VersionRef,
)
from service.resources.domain.version import (
    DeliveryRecoveryMember,
    RestoreCompletion,
    RestoreKind,
    RestoreMember,
    RestoreState,
    RestoreTransaction,
    ReviewResolution,
    SnapshotVersion,
    same_source_identity,
)
from service.resources.persistence.objects import CasStore, ObjectDescriptor
from service.resources.persistence.version import (
    OPERATION_KIND_DELIVERY_RESTORE,
    OPERATION_KIND_PENDING_DISCARD,
    OPERATION_KIND_REVIEW_RECONCILE,
    OPERATION_KIND_REVIEW_REJECT,
    OPERATION_KIND_SAVE_AS,
    OPERATION_KIND_SINGLE_RESTORE,
    VersionStore,
    VersionStoreConflict,
)
from service.resources.service.events import ResourceVersionEvent, emit, emit_pending, emit_review

_log = logging.getLogger("scholarseed.resources.recovery")


@dataclass(frozen=True)
class _Observed:
    state: FileState
    revision: str | None
    object_id: str | None
    mode_bits: int | None
    descriptor: ObjectDescriptor | None


class ResourceRecoveryService:
    """Persist restore intent, apply exact bytes, and reconcile interrupted work."""

    def __init__(
        self,
        content: ContentPort,
        retention: ResourceRetentionPort,
        annotations: ResourceAnnotationPort,
    ) -> None:
        self._content = content
        self._retention = retention
        self._annotations = annotations

    def preview_version(self, project_id: str, version_id: str) -> RestorePreview:
        store = self._store(project_id)
        version = store.version(version_id)
        if version is None:
            raise ResourceRecoveryError("version_not_found")
        head = store.head(version.file_id)
        if head is None:
            raise ResourceRecoveryError("file_not_managed")
        path, expected_revision, _state, _expected_annotation_revision, _annotation_id = head
        observed = self._observe(project_id, path, persist=False)
        observed_revision = observed.revision
        conflict = observed_revision != expected_revision
        target = (
            observed
            if version.path == path or version.state is FileState.TOMBSTONE
            else self._observe(project_id, version.path, persist=False)
        )
        path_conflict = (
            version.state is FileState.PRESENT
            and version.path != path
            and target.state is not FileState.TOMBSTONE
        )
        conflict = conflict or path_conflict
        unsigned = {
            "target_path": version.path,
            "target_revision": target.revision,
            "path_conflict": path_conflict,
            "version_id": version.id,
            "file_id": version.file_id,
            "path": path,
            "expected_revision": expected_revision,
            "observed_revision": observed_revision,
            "conflict": conflict,
        }
        preview = RestorePreview(
            version_id=version.id,
            file_id=version.file_id,
            path=path,
            expected_revision=expected_revision,
            observed_revision=observed_revision,
            conflict=conflict,
            preflight_token=self._token(unsigned),
            path_conflict=path_conflict,
        )
        emit(
            _log,
            ResourceVersionEvent.RESTORE_PREFLIGHT,
            project_id=project_id,
            file_id=version.file_id,
            version_id=version.id,
            revision=observed_revision,
            result_code="conflict" if conflict else "ready",
        )
        return preview

    def restore_version(
        self,
        project_id: str,
        version_id: str,
        policy: RestorePolicy,
        preflight_token: str,
        idempotency_key: str | None = None,
    ) -> SealResult:
        cas = self._cas(project_id)
        with cas.writer():
            store = self._store(project_id)
            request_digest = self._restore_digest(
                RestoreKind.SINGLE, version_id, policy, preflight_token
            )
            if idempotency_key is not None:
                try:
                    existing = store.restore_operation(
                        idempotency_key,
                        OPERATION_KIND_SINGLE_RESTORE,
                        version_id,
                        request_digest,
                    )
                except VersionStoreConflict as exc:
                    raise ResourceRecoveryError(exc.code) from exc
                if existing is not None:
                    versions = self._execute(project_id, existing)
                    return SealResult(version=versions[0], unchanged=False)
            preview = self.preview_version(project_id, version_id)
            if preview.preflight_token != preflight_token:
                raise ResourceRecoveryError("preflight_stale")
            if preview.path_conflict or (preview.conflict and policy is not RestorePolicy.FORCE):
                emit(
                    _log,
                    ResourceVersionEvent.RESTORE_CONFLICT,
                    project_id=project_id,
                    file_id=preview.file_id,
                    version_id=version_id,
                    result_code="restore_conflict",
                )
                raise ResourceRecoveryError("restore_conflict")
            source = self._store(project_id).version(version_id)
            if source is None:
                raise ResourceRecoveryError("version_not_found")
            observed = self._observe(project_id, preview.path, persist=True)
            member = RestoreMember(
                order=0,
                file_id=source.file_id,
                conflict_at_prepare=preview.conflict,
                expected_revision=observed.revision,
                expected_annotation_revision=None,
                expected_state=observed.state,
                expected_path=preview.path,
                before_object_id=observed.object_id,
                before_annotation_object_id=None,
                before_state=observed.state,
                before_path=preview.path,
                before_mode_bits=observed.mode_bits,
                target_object_id=source.object_id,
                target_annotation_object_id=None,
                target_state=source.state,
                target_path=source.path if source.state is FileState.PRESENT else preview.path,
                target_mode_bits=source.mode_bits,
            )
            transaction = self._prepare(
                project_id,
                RestoreKind.SINGLE,
                source.id,
                policy,
                preflight_token,
                (member,),
                (observed,),
                idempotency_key=idempotency_key,
                operation_kind=OPERATION_KIND_SINGLE_RESTORE,
                request_digest=request_digest,
            )
            versions = self._execute(project_id, transaction)
            return SealResult(version=versions[0], unchanged=False)

    def save_as_version(
        self,
        project_id: str,
        version_id: str,
        target_dir: str,
        name: str,
        idempotency_key: str,
    ) -> SealResult:
        """Materialize one historical CAS snapshot as a new managed file and v1."""

        cas = self._cas(project_id)
        with cas.writer():
            store = self._store(project_id)
            request_digest = self._save_as_digest(version_id, target_dir, name)
            try:
                existing = store.restore_operation(
                    idempotency_key,
                    OPERATION_KIND_SAVE_AS,
                    version_id,
                    request_digest,
                )
            except VersionStoreConflict as exc:
                raise ResourceRecoveryError(exc.code) from exc
            if existing is not None:
                versions = self._execute(project_id, existing)
                return SealResult(version=versions[0], unchanged=False)
            source = store.version(version_id)
            if source is None:
                raise ResourceRecoveryError("version_not_found")
            if source.state is FileState.TOMBSTONE or source.object_id is None:
                raise ResourceRecoveryError("version_is_tombstone")
            parent = self._content.within_root(project_id, RootKind.RESOURCES, target_dir)
            target = self._content.destination(project_id, parent, name)
            observed = self._observe(project_id, target.path, persist=True)
            if observed.state is not FileState.TOMBSTONE:
                raise ResourceRecoveryError("save_as_conflict")
            file_id = uuid4().hex
            media_type = store.media_type(source.file_id) or "application/octet-stream"
            member = RestoreMember(
                order=0,
                file_id=file_id,
                conflict_at_prepare=False,
                expected_revision=None,
                expected_annotation_revision=None,
                expected_state=FileState.TOMBSTONE,
                expected_path=target.path,
                before_object_id=None,
                before_annotation_object_id=None,
                before_state=FileState.TOMBSTONE,
                before_path=target.path,
                before_mode_bits=None,
                target_object_id=source.object_id,
                target_annotation_object_id=None,
                target_state=FileState.PRESENT,
                target_path=target.path,
                target_mode_bits=source.mode_bits,
            )
            reserved = SnapshotVersion(
                path=target.path,
                media_type=media_type,
                revision=None,
                object_id=None,
                mode_bits=None,
                mtime_ns=None,
                origin=VersionOrigin.RESTORE,
                state=FileState.TOMBSTONE,
            )
            transaction = self._prepare(
                project_id,
                RestoreKind.SINGLE,
                source.id,
                RestorePolicy.STRICT,
                self._token({"version_id": source.id, "target_path": target.path}),
                (member,),
                (observed,),
                idempotency_key=idempotency_key,
                operation_kind=OPERATION_KIND_SAVE_AS,
                request_digest=request_digest,
                reserved_snapshot=reserved,
            )
            versions = self._execute(project_id, transaction)
            return SealResult(version=versions[0], unchanged=False)

    def preview_delivery(self, project_id: str, delivery_id: str) -> DeliveryRestorePreview:
        members = self._store(project_id).delivery_members(delivery_id)
        if not members:
            raise ResourceRecoveryError("delivery_not_found")
        projected = tuple(self._preview_member(project_id, member) for member in members)
        unsigned = {
            "delivery_id": delivery_id,
            "members": [
                {
                    "file_id": item.file_id,
                    "path": item.path,
                    "target_path": item.target_path,
                    "expected_revision": item.expected_revision,
                    "observed_revision": item.observed_revision,
                    "conflict": item.conflict,
                }
                for item in projected
            ],
        }
        preview = DeliveryRestorePreview(delivery_id, projected, self._token(unsigned))
        emit(
            _log,
            ResourceVersionEvent.RESTORE_PREFLIGHT,
            project_id=project_id,
            delivery_id=delivery_id,
            member_count=len(projected),
            result_code="conflict" if any(item.conflict for item in projected) else "ready",
        )
        return preview

    def deliveries(self, project_id: str, limit: int) -> tuple[DeliveryResult, ...]:
        return self._store(project_id).deliveries(limit)

    def delivery(self, project_id: str, delivery_id: str) -> DeliveryResult:
        result = self._store(project_id).delivery(delivery_id)
        if result is None:
            raise ResourceRecoveryError("delivery_not_found")
        return result

    def restore_delivery(
        self,
        project_id: str,
        delivery_id: str,
        policy: RestorePolicy,
        preflight_token: str,
        idempotency_key: str | None = None,
    ) -> DeliveryRestoreResult:
        cas = self._cas(project_id)
        with cas.writer():
            store = self._store(project_id)
            request_digest = self._restore_digest(
                RestoreKind.DELIVERY, delivery_id, policy, preflight_token
            )
            if idempotency_key is not None:
                try:
                    existing = store.restore_operation(
                        idempotency_key,
                        OPERATION_KIND_DELIVERY_RESTORE,
                        delivery_id,
                        request_digest,
                    )
                except VersionStoreConflict as exc:
                    raise ResourceRecoveryError(exc.code) from exc
                if existing is not None:
                    self._execute(project_id, existing)
                    versions, replay_skipped = store.restore_outcome(existing.id)
                    return DeliveryRestoreResult(versions, replay_skipped)
            preview = self.preview_delivery(project_id, delivery_id)
            if preview.preflight_token != preflight_token:
                raise ResourceRecoveryError("preflight_stale")
            conflicts = {item.file_id for item in preview.members if item.conflict}
            if conflicts and policy is RestorePolicy.STRICT:
                emit(
                    _log,
                    ResourceVersionEvent.RESTORE_CONFLICT,
                    project_id=project_id,
                    delivery_id=delivery_id,
                    conflict_count=len(conflicts),
                    result_code="delivery_restore_conflict",
                )
                raise ResourceRecoveryError("delivery_restore_conflict")
            skipped_file_ids = (
                tuple(sorted(conflicts)) if policy is RestorePolicy.SKIP_CONFLICTS else ()
            )
            source_members = self._store(project_id).delivery_members(delivery_id)
            selected = tuple(
                member
                for member in source_members
                if policy is not RestorePolicy.SKIP_CONFLICTS
                or member.baseline.file_id not in conflicts
            )
            observed = tuple(
                self._observe(project_id, member.after_path, persist=True) for member in selected
            )
            manifest = tuple(
                self._delivery_member(index, member, state, conflicts)
                for index, (member, state) in enumerate(zip(selected, observed, strict=True))
            )
            transaction = self._prepare(
                project_id,
                RestoreKind.DELIVERY,
                delivery_id,
                policy,
                preflight_token,
                manifest,
                observed,
                idempotency_key=idempotency_key,
                operation_kind=OPERATION_KIND_DELIVERY_RESTORE,
                request_digest=request_digest,
                skipped_file_ids=skipped_file_ids,
            )
            restored = self._execute(project_id, transaction)
            return DeliveryRestoreResult(restored, skipped_file_ids)

    def recover_pending(self, project_id: str) -> tuple[str, ...]:
        """Idempotently roll forward manifests containing only before/target states."""

        recovered: list[str] = []
        cas = self._cas(project_id)
        with cas.writer():
            store = self._store(project_id)
            for pending in store.pending_restores():
                try:
                    store.validate_restore_pending(pending)
                except VersionStoreConflict as exc:
                    if exc.code == ReviewConflict.ACTIVE_TURN.value:
                        emit(
                            _log,
                            ResourceVersionEvent.RESTORE_CONFLICT,
                            project_id=project_id,
                            transaction_id=pending.id,
                            result_code=exc.code,
                        )
                        continue
                    store.set_restore_state(
                        pending.id,
                        RestoreState.NEEDS_ATTENTION,
                        expected=(RestoreState.PREPARED, RestoreState.APPLYING),
                    )
                    emit(
                        _log,
                        ResourceVersionEvent.RESTORE_CONFLICT,
                        project_id=project_id,
                        transaction_id=pending.id,
                        result_code=exc.code,
                    )
                    continue
                states = tuple(
                    self._member_position(project_id, member) for member in pending.members
                )
                if any(state == "other" for state in states):
                    store.set_restore_state(
                        pending.id,
                        RestoreState.NEEDS_ATTENTION,
                        expected=(RestoreState.PREPARED, RestoreState.APPLYING),
                    )
                    continue
                transaction = pending
                if pending.state is RestoreState.PREPARED:
                    store.set_restore_state(
                        pending.id,
                        RestoreState.APPLYING,
                        expected=(RestoreState.PREPARED,),
                    )
                    transaction = store.restore_transaction(pending.id)
                for member, state in zip(transaction.members, states, strict=True):
                    if state == "target":
                        store.mark_restore_member_applied(transaction.id, member.file_id)
                self._execute(project_id, store.restore_transaction(transaction.id))
                recovered.append(transaction.id)
                emit(
                    _log,
                    ResourceVersionEvent.RESTORE_RECOVERED,
                    project_id=project_id,
                    transaction_id=transaction.id,
                    result_code=RestoreState.COMMITTED.value,
                )
        return tuple(recovered)

    def discard_pending(
        self,
        project_id: str,
        file_id: str,
        pending_revision: int,
        expected_revision: str | None,
        idempotency_key: str,
        *,
        version_id: str,
    ) -> None:
        """Restore the displayed saved snapshot without sealing another version."""

        digest = self._token(
            {
                "file_id": file_id,
                "pending_revision": pending_revision,
                "expected_revision": expected_revision,
                "version_id": version_id,
            }
        )
        with self._cas(project_id).writer():
            store = self._store(project_id)
            try:
                existing = store.restore_operation(
                    idempotency_key,
                    OPERATION_KIND_PENDING_DISCARD,
                    version_id,
                    digest,
                )
                if existing is not None:
                    self._execute(project_id, existing)
                    return
                current = store.pending(file_id)
                if current is None or current.revision != pending_revision:
                    raise ResourceRecoveryError(ReviewConflict.PENDING_REVISION.value)
                if current.needs_review:
                    raise ResourceRecoveryError(ReviewConflict.DECISION_REQUIRED.value)
                history = store.history_for_file(file_id, limit=1)
                if not history or history[0].id != version_id:
                    raise ResourceRecoveryError("version_head_conflict")
                source = history[0]
                working = store.working_snapshot(file_id)
                if working is None:
                    raise ResourceRecoveryError("file_not_managed")
                observed = self._observe(project_id, working.path, persist=True)
                actual = SnapshotIdentity(
                    observed.object_id,
                    observed.state,
                    working.path,
                    observed.mode_bits,
                    None,
                )
                if (
                    not same_source_identity(actual, working)
                    or observed.revision != expected_revision
                ):
                    raise ResourceRecoveryError("revision_conflict")
                target = SnapshotIdentity(
                    source.object_id,
                    source.state,
                    source.path,
                    source.mode_bits,
                    None,
                )
                if (
                    target.path != working.path
                    and self._revision(project_id, target.path) is not None
                ):
                    raise ResourceRecoveryError("restore_conflict")
                member = self._cancellation_member(file_id, working, target, observed)
                manifest = self._prepare(
                    project_id,
                    RestoreKind.SINGLE,
                    version_id,
                    RestorePolicy.STRICT,
                    digest,
                    (member,),
                    (observed,),
                    idempotency_key=idempotency_key,
                    operation_kind=OPERATION_KIND_PENDING_DISCARD,
                    request_digest=digest,
                    discard_revision=pending_revision,
                )
                self._execute(project_id, manifest)
            except VersionStoreConflict as exc:
                raise ResourceRecoveryError(exc.code) from exc

    def _review_conflict_state(self, project_id: str, file_id: str, *, persist: bool) -> tuple[
        PendingSnapshot,
        PendingReview,
        tuple[str, str | None, str, str | None, str | None],
        SnapshotIdentity,
        _Observed,
        SnapshotIdentity,
        str | None,
        str,
    ]:
        store = self._store(project_id)
        current = store.pending(file_id)
        head = store.head(file_id)
        working = store.working_snapshot(file_id)
        if current is None or current.review is None or head is None or working is None:
            raise ResourceRecoveryError(ReviewConflict.NOT_FOUND.value)
        if store.initialization_deferred(working.path):
            raise ResourceRecoveryError(ReviewConflict.ACTIVE_TURN.value)
        observed = self._observe(project_id, working.path, persist=persist)
        disk = SnapshotIdentity(
            observed.object_id,
            observed.state,
            working.path,
            observed.mode_bits,
            None,
        )
        if same_source_identity(disk, working):
            raise ResourceRecoveryError("review_not_conflicted")
        history = store.history_for_file(file_id, limit=1)
        version_id = history[0].id if history else None
        token = self._token(
            {
                "file_id": file_id,
                "pending": asdict(current),
                "working": asdict(working),
                "working_revision": head[1],
                "version_id": version_id,
                "disk": asdict(disk),
            }
        )
        return current, current.review, head, working, observed, disk, version_id, token

    def preview_review_conflict(self, project_id: str, file_id: str) -> ReviewConflictPreview:
        with self._cas(project_id).writer():
            current, review, _head, _working, _observed, disk, _version, token = (
                self._review_conflict_state(project_id, file_id, persist=False)
            )
            emit_review(
                _log,
                ResourceVersionEvent.REVIEW_PREFLIGHT,
                project_id,
                current,
                revision=_head[1],
                disk_revision=disk.object_id,
            )
            return ReviewConflictPreview(file_id, review.id, current.revision, disk, token)

    def reconcile_review(
        self, project_id: str, file_id: str, action: str, token: str, idempotency_key: str
    ) -> None:
        try:
            choice = ReviewResolutionChoice(action)
        except ValueError as exc:
            raise ResourceRecoveryError("invalid_review_resolution") from exc
        digest = self._token({"file_id": file_id, "action": choice.value, "token": token})
        with self._cas(project_id).writer():
            store = self._store(project_id)
            try:
                existing = store.restore_operation(
                    idempotency_key, OPERATION_KIND_REVIEW_RECONCILE, file_id, digest
                )
                if existing is not None:
                    self._execute(project_id, existing)
                    return
                current, review, head, working, observed, disk, version_id, actual_token = (
                    self._review_conflict_state(project_id, file_id, persist=True)
                )
                if actual_token != token:
                    emit_review(
                        _log,
                        ResourceVersionEvent.REVIEW_CONFLICT,
                        project_id,
                        current,
                        revision=head[1],
                        result_code="preflight_stale",
                    )
                    raise ResourceRecoveryError("preflight_stale")
                target = disk if choice is ReviewResolutionChoice.KEEP_CURRENT else review.candidate
                if (
                    target.path != working.path
                    and self._revision(project_id, target.path) is not None
                ):
                    raise ResourceRecoveryError("restore_conflict")
                resolution = ReviewResolution(
                    review.id, current.revision, choice, working, head[1], version_id
                )
                member = self._cancellation_member(file_id, disk, target, observed)
                manifest = self._prepare(
                    project_id,
                    RestoreKind.SINGLE,
                    file_id,
                    RestorePolicy.STRICT,
                    token,
                    (member,),
                    (observed,),
                    idempotency_key=idempotency_key,
                    operation_kind=OPERATION_KIND_REVIEW_RECONCILE,
                    request_digest=digest,
                    review_resolution=resolution,
                )
                self._execute(project_id, manifest)
            except VersionStoreConflict as exc:
                raise ResourceRecoveryError(exc.code) from exc

    def reject_review(
        self,
        project_id: str,
        file_id: str,
        decision: ReviewDecision,
        expected_revision: str | None,
        idempotency_key: str,
        *,
        policy: RestorePolicy = RestorePolicy.STRICT,
    ) -> None:
        """Restore the exact pre-Agent snapshot, retaining its original archival state."""

        if decision.outcome is not ReviewOutcome.REJECTED:
            raise ResourceRecoveryError(ReviewConflict.INVALID_OUTCOME.value)
        digest = self._token(
            {
                "file_id": file_id,
                "review_id": decision.review_id,
                "pending_revision": decision.pending_revision,
                "expected_revision": expected_revision,
                "policy": policy.value,
            }
        )
        with self._cas(project_id).writer():
            store = self._store(project_id)
            current = None
            try:
                existing = store.restore_operation(
                    idempotency_key, OPERATION_KIND_REVIEW_REJECT, decision.review_id, digest
                )
                if existing is not None:
                    self._execute(project_id, existing)
                    return
                current = store.pending(file_id)
                emit_review(
                    _log,
                    ResourceVersionEvent.REVIEW_PREFLIGHT,
                    project_id,
                    current,
                    expected_review_id=decision.review_id,
                    expected_pending_revision=decision.pending_revision,
                    revision=expected_revision,
                    outcome=decision.outcome.value,
                )
                if (
                    current is None
                    or current.review is None
                    or current.review.id != decision.review_id
                ):
                    raise ResourceRecoveryError(ReviewConflict.NOT_FOUND.value)
                if current.revision != decision.pending_revision:
                    raise ResourceRecoveryError(ReviewConflict.PENDING_REVISION.value)
                review = current.review
                head = store.head(file_id)
                if (
                    head is None
                    or head[1] != review.candidate_revision
                    or not same_source_identity(store.working_snapshot(file_id), review.candidate)
                    or review.edited_by_user
                ):
                    raise ResourceRecoveryError(ReviewConflict.CANDIDATE_REVISION.value)
                observed = self._observe(project_id, review.candidate.path, persist=True)
                observed_identity = SnapshotIdentity(
                    observed.object_id,
                    observed.state,
                    review.candidate.path,
                    observed.mode_bits,
                    None,
                )
                if observed.revision != expected_revision:
                    raise ResourceRecoveryError(ReviewConflict.CANDIDATE_REVISION.value)
                if policy is RestorePolicy.STRICT and not same_source_identity(
                    observed_identity, review.candidate
                ):
                    raise ResourceRecoveryError(ReviewConflict.CANDIDATE_REVISION.value)
                if (
                    review.base.path != review.candidate.path
                    and self._revision(project_id, review.base.path) is not None
                ):
                    raise ResourceRecoveryError("restore_conflict")
                member = self._cancellation_member(
                    file_id, observed_identity, review.base, observed
                )
                manifest = self._prepare(
                    project_id,
                    RestoreKind.SINGLE,
                    review.id,
                    policy,
                    digest,
                    (member,),
                    (observed,),
                    idempotency_key=idempotency_key,
                    operation_kind=OPERATION_KIND_REVIEW_REJECT,
                    request_digest=digest,
                    review_decision=decision,
                )
                self._execute(project_id, manifest)
            except VersionStoreConflict as exc:
                emit_review(
                    _log,
                    ResourceVersionEvent.REVIEW_CONFLICT,
                    project_id,
                    current,
                    expected_review_id=decision.review_id,
                    expected_pending_revision=decision.pending_revision,
                    revision=expected_revision,
                    result_code=exc.code,
                )
                raise ResourceRecoveryError(exc.code) from exc
            except (ResourceRecoveryError, ContentError) as exc:
                emit_review(
                    _log,
                    ResourceVersionEvent.REVIEW_CONFLICT,
                    project_id,
                    current,
                    expected_review_id=decision.review_id,
                    expected_pending_revision=decision.pending_revision,
                    revision=expected_revision,
                    result_code=exc.code,
                )
                raise

    @staticmethod
    def _cancellation_member(
        file_id: str, current: SnapshotIdentity, target: SnapshotIdentity, observed: _Observed
    ) -> RestoreMember:
        return RestoreMember(
            order=0,
            file_id=file_id,
            conflict_at_prepare=False,
            expected_revision=observed.revision,
            expected_annotation_revision=None,
            expected_state=observed.state,
            expected_path=current.path,
            before_object_id=observed.object_id,
            before_annotation_object_id=None,
            before_state=observed.state,
            before_path=current.path,
            before_mode_bits=observed.mode_bits,
            target_object_id=target.object_id,
            target_annotation_object_id=None,
            target_state=target.state,
            target_path=target.path,
            target_mode_bits=target.mode_bits,
        )

    def _require_book_versions(self, project_id: str, members: tuple[RestoreMember, ...]) -> None:
        paths = tuple(
            path
            for member in members
            for path in (member.expected_path, member.before_path, member.target_path)
            if path is not None
        )
        if any(
            root is not None for root in self._content.repository_roots(project_id, paths).values()
        ):
            raise ResourceRecoveryError(GIT_VERSION_DISABLED_ERROR)

    def _prepare(
        self,
        project_id: str,
        kind: RestoreKind,
        source_id: str,
        policy: RestorePolicy,
        preflight_token: str,
        members: tuple[RestoreMember, ...],
        observed: tuple[_Observed, ...],
        *,
        idempotency_key: str | None = None,
        operation_kind: str | None = None,
        request_digest: str | None = None,
        skipped_file_ids: tuple[str, ...] = (),
        reserved_snapshot: SnapshotVersion | None = None,
        review_decision: ReviewDecision | None = None,
        discard_revision: int | None = None,
        review_resolution: ReviewResolution | None = None,
    ) -> RestoreTransaction:
        self._require_book_versions(project_id, members)
        descriptors = tuple(
            descriptor
            for item in observed
            for descriptor in (item.descriptor,)
            if descriptor is not None
        )
        try:
            transaction = self._store(project_id).prepare_restore(
                kind,
                source_id,
                policy.value,
                preflight_token,
                members,
                descriptors,
                idempotency_key=idempotency_key,
                operation_kind=operation_kind,
                request_digest=request_digest,
                skipped_file_ids=skipped_file_ids,
                reserved_snapshot=reserved_snapshot,
                review_decision=review_decision,
                discard_revision=discard_revision,
                review_resolution=review_resolution,
            )
        except VersionStoreConflict as exc:
            raise ResourceRecoveryError(exc.code) from exc
        cas = self._cas(project_id)
        for member in members:
            if member.target_object_id is not None:
                cas.stage(member.target_object_id, transaction.id, member.order)
        return transaction

    def _execute(self, project_id: str, transaction: RestoreTransaction) -> tuple[VersionRef, ...]:
        started = perf_counter()
        store = self._store(project_id)
        if transaction.state is RestoreState.COMMITTED:
            try:
                return store.restore_outcome(transaction.id)[0]
            except VersionStoreConflict as exc:
                raise ResourceRecoveryError(exc.code) from exc
        if transaction.state not in (RestoreState.PREPARED, RestoreState.APPLYING):
            raise ResourceRecoveryError("invalid_transaction_state")
        self._require_book_versions(project_id, transaction.members)
        store.validate_restore_pending(transaction)
        review_pending = {
            member.file_id: store.pending(member.file_id)
            for member in transaction.members
            if transaction.review_decision is not None or transaction.review_resolution is not None
        }
        if transaction.state is RestoreState.PREPARED:
            positions = tuple(
                self._member_position(project_id, member) for member in transaction.members
            )
            if any(position not in {"before", "target"} for position in positions):
                store.set_restore_state(
                    transaction.id,
                    RestoreState.CONFLICTED,
                    expected=(RestoreState.PREPARED,),
                )
                emit(
                    _log,
                    ResourceVersionEvent.RESTORE_CONFLICT,
                    project_id=project_id,
                    transaction_id=transaction.id,
                    result_code="preflight_stale",
                )
                raise ResourceRecoveryError("preflight_stale")
            store.set_restore_state(
                transaction.id,
                RestoreState.APPLYING,
                expected=(RestoreState.PREPARED,),
            )
            transaction = store.restore_transaction(transaction.id)
        try:
            for member in transaction.members:
                position = self._member_position(project_id, member)
                if position == "target":
                    store.mark_restore_member_applied(transaction.id, member.file_id)
                    continue
                if position not in {"before", "partial"}:
                    store.set_restore_state(
                        transaction.id,
                        RestoreState.NEEDS_ATTENTION,
                        expected=(RestoreState.APPLYING,),
                    )
                    raise ResourceRecoveryError("preflight_stale")
                self._apply_member(project_id, transaction.id, member, position)
                if self._member_position(project_id, member) != "target":
                    raise ResourceRecoveryError("restore_verification_failed")
                store.mark_restore_member_applied(transaction.id, member.file_id)
        except ContentError as exc:
            store.set_restore_state(
                transaction.id,
                RestoreState.NEEDS_ATTENTION,
                expected=(RestoreState.APPLYING,),
            )
            raise ResourceRecoveryError(exc.code) from exc
        snapshots = tuple(
            self._restored_snapshot(project_id, transaction, member)
            for member in transaction.members
        )
        versions = store.commit_restore(transaction.id, snapshots)
        for file_id, before in review_pending.items():
            if before is None or before.review is None:
                continue
            review = before.review
            head = store.head(file_id)
            if head is None:
                raise ResourceRecoveryError("file_not_managed")
            emit(
                _log,
                (
                    ResourceVersionEvent.REVIEW_REJECT
                    if transaction.review_decision is not None
                    else ResourceVersionEvent.REVIEW_RECONCILED
                ),
                project_id=project_id,
                file_id=file_id,
                review_id=review.id,
                session_id=review.session_id,
                turn_id=review.turn_id,
                pending_revision=before.revision,
                revision=head[1],
                transaction_id=transaction.id,
                result_code=RestoreState.COMMITTED.value,
                resolution=(
                    transaction.review_resolution.choice.value
                    if transaction.review_resolution is not None
                    else None
                ),
            )
            emit_pending(_log, project_id, before, store.pending(file_id), head[1])
        self._cas(project_id).clear_stage(transaction.id)
        if (
            transaction.completion is RestoreCompletion.VERSION
            and transaction.review_resolution is None
        ):
            self._retention.enforce(project_id)
        emit(
            _log,
            ResourceVersionEvent.RESTORE_APPLY,
            project_id=project_id,
            transaction_id=transaction.id,
            duration_ms=round((perf_counter() - started) * 1000),
            member_count=len(transaction.members),
            result_code=RestoreState.COMMITTED.value,
        )
        return versions

    @staticmethod
    def _restore_digest(
        kind: RestoreKind,
        source_id: str,
        policy: RestorePolicy,
        preflight_token: str,
    ) -> str:
        return sha256(
            "\0".join((kind.value, source_id, policy.value, preflight_token)).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _save_as_digest(version_id: str, target_dir: str, name: str) -> str:
        return sha256("\0".join((version_id, target_dir, name)).encode("utf-8")).hexdigest()

    def _apply_member(
        self,
        project_id: str,
        transaction_id: str,
        member: RestoreMember,
        position: str,
    ) -> None:
        if member.target_state is FileState.TOMBSTONE:
            self._content.remove_bytes(
                project_id,
                member.expected_path,
                member.expected_revision,
                force=False,
                notify=False,
            )
            return
        if member.target_object_id is None:
            raise ResourceRecoveryError("version_object_missing")
        if position != "partial":
            cas = self._cas(project_id)
            descriptor = cas.verify(member.target_object_id)
            target_expected = (
                member.expected_revision if member.target_path == member.expected_path else None
            )
            with cas.stage_stream(
                member.target_object_id,
                transaction_id,
                member.order,
            ) as staged:
                self._content.apply_stream(
                    project_id,
                    member.target_path,
                    staged,
                    descriptor.raw_size_bytes,
                    member.target_object_id,
                    target_expected,
                    force=False,
                    mode_bits=member.target_mode_bits,
                    notify=False,
                )
        if member.target_path != member.expected_path:
            self._annotations.move(project_id, member.expected_path, member.target_path)
            self._content.remove_bytes(
                project_id,
                member.expected_path,
                member.expected_revision,
                force=False,
                notify=False,
            )

    def _restored_snapshot(
        self,
        project_id: str,
        transaction: RestoreTransaction,
        member: RestoreMember,
    ) -> tuple[
        SnapshotVersion,
        ObjectDescriptor | None,
        ObjectDescriptor | None,
    ]:
        origin = (
            VersionOrigin.RESTORE
            if transaction.kind is RestoreKind.SINGLE
            else VersionOrigin.DELIVERY_REVERT
        )
        source = (
            self._store(project_id).version(transaction.source_id)
            if transaction.kind is RestoreKind.SINGLE
            and transaction.completion is RestoreCompletion.VERSION
            and transaction.review_resolution is None
            else None
        )
        if member.target_state is FileState.TOMBSTONE:
            return (
                SnapshotVersion(
                    path=member.target_path,
                    media_type="application/octet-stream",
                    revision=None,
                    object_id=None,
                    mode_bits=None,
                    mtime_ns=None,
                    origin=origin,
                    state=FileState.TOMBSTONE,
                    restored_from_id=source.id if source is not None else None,
                    restored_from_sequence=source.sequence if source is not None else None,
                    restored_from_object_id=source.object_id if source is not None else None,
                    source_delivery_id=(
                        transaction.source_id if transaction.kind is RestoreKind.DELIVERY else None
                    ),
                ),
                None,
                None,
            )
        stable = self._content.stable_snapshot(project_id, member.target_path, VERSION_MAX_BYTES)
        descriptor = self._cas(project_id).verify(member.target_object_id or "")
        return (
            SnapshotVersion(
                path=member.target_path,
                media_type=stable.media_type,
                revision=stable.revision,
                object_id=member.target_object_id,
                mode_bits=stable.mode_bits,
                mtime_ns=stable.mtime_ns,
                origin=origin,
                restored_from_id=source.id if source is not None else None,
                restored_from_sequence=source.sequence if source is not None else None,
                restored_from_object_id=source.object_id if source is not None else None,
                source_delivery_id=(
                    transaction.source_id if transaction.kind is RestoreKind.DELIVERY else None
                ),
            ),
            descriptor,
            None,
        )

    @staticmethod
    def _delivery_member(
        order: int,
        member: DeliveryRecoveryMember,
        observed: _Observed,
        conflicts: set[str],
    ) -> RestoreMember:
        baseline = member.baseline
        return RestoreMember(
            order=order,
            file_id=baseline.file_id,
            conflict_at_prepare=baseline.file_id in conflicts,
            expected_revision=observed.revision,
            expected_annotation_revision=None,
            expected_state=observed.state,
            expected_path=member.after_path,
            before_object_id=observed.object_id,
            before_annotation_object_id=None,
            before_state=observed.state,
            before_path=member.after_path,
            before_mode_bits=observed.mode_bits,
            target_object_id=baseline.object_id,
            target_annotation_object_id=None,
            target_state=baseline.state,
            target_path=baseline.path,
            target_mode_bits=baseline.mode_bits,
        )

    def _preview_member(
        self, project_id: str, member: DeliveryRecoveryMember
    ) -> DeliveryRestoreMember:
        state = self._observe(project_id, member.after_path, persist=False)
        observed = state.revision
        conflict = observed != member.after_revision
        if member.after_path != member.baseline.path:
            conflict = conflict or self._revision(project_id, member.baseline.path) is not None
        return DeliveryRestoreMember(
            file_id=member.baseline.file_id,
            path=member.after_path,
            target_path=member.baseline.path,
            expected_revision=member.after_revision,
            observed_revision=observed,
            conflict=conflict,
        )

    def _observe(self, project_id: str, path: str, *, persist: bool) -> _Observed:
        if persist and self._content.repository_roots(project_id, (path,))[path] is not None:
            raise ResourceRecoveryError(GIT_VERSION_DISABLED_ERROR)
        try:
            stable = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES)
        except ContentError as exc:
            if exc.code != "file_not_found":
                raise
            return _Observed(
                FileState.TOMBSTONE,
                None,
                None,
                None,
                None,
            )
        object_id = (
            self._cas(project_id).put(stable.content, stable.media_type)
            if persist
            else stable.revision
        )
        descriptor = self._cas(project_id).verify(object_id) if persist else None
        return _Observed(
            FileState.PRESENT,
            stable.revision,
            object_id,
            stable.mode_bits,
            descriptor,
        )

    def _member_position(self, project_id: str, member: RestoreMember) -> str:
        expected = self._observe(project_id, member.expected_path, persist=False)
        target = (
            expected
            if member.target_path == member.expected_path
            else self._observe(project_id, member.target_path, persist=False)
        )
        before_matches = (
            expected.state is member.before_state
            and expected.mode_bits == member.before_mode_bits
            and expected.revision == member.before_object_id
            and (member.target_path == member.expected_path or target.state is FileState.TOMBSTONE)
        )
        target_matches = (
            target.state is member.target_state
            and target.mode_bits == member.target_mode_bits
            and target.revision == member.target_object_id
            and (
                member.target_path == member.expected_path or expected.state is FileState.TOMBSTONE
            )
        )
        if target_matches:
            return "target"
        if before_matches:
            return "before"
        if (
            member.target_path == member.expected_path
            and target.state is member.target_state
            and target.mode_bits == member.target_mode_bits
            and target.revision == member.target_object_id
        ):
            return "partial"
        if (
            member.target_path != member.expected_path
            and target.state is member.target_state
            and target.mode_bits == member.target_mode_bits
            and target.revision == member.target_object_id
            and expected.state is member.before_state
            and expected.revision == member.before_object_id
        ):
            return "partial"
        return "other"

    def _revision(self, project_id: str, path: str) -> str | None:
        try:
            return self._content.snapshot(project_id, path).revision
        except ContentError as exc:
            if exc.code == "file_not_found":
                return None
            raise

    def _store(self, project_id: str) -> VersionStore:
        return VersionStore(
            self._content.resolve(project_id, PROJECT_DB_RELATIVE),
            self._content.project(project_id).root,
        )

    def _cas(self, project_id: str) -> CasStore:
        return CasStore(
            self._content.resolve(project_id, PROJECT_VERSIONS_RELATIVE),
            project_root=self._content.project(project_id).root,
        )

    @staticmethod
    def _token(payload: dict) -> str:
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
        return f"sha256:{sha256(body).hexdigest()}"


class ResourceRecoveryError(RuntimeError):
    """Stable recovery failure code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


__all__ = ["ResourceRecoveryError", "ResourceRecoveryService"]
