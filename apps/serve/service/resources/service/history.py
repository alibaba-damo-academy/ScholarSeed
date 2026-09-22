"""Application service for sealing and reading resource versions."""

from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from difflib import unified_diff
from hashlib import sha256
from typing import Iterator
from unicodedata import category

from service.content.domain.model import ContentError
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.content import (
    ContentPort,
    ContentWriteReceipt,
    StableContentCapture,
    StableContentSnapshot,
)
from service.platform.files import guess_media_type
from service.platform.resources import (
    DEFAULT_PENDING_PAGE_SIZE,
    DEFAULT_PRODUCT_FILE_MODE,
    GIT_VERSION_DISABLED_ERROR,
    VERSION_INLINE_MAX_BYTES,
    VERSION_MAX_BYTES,
    FileState,
    ManagementState,
    PendingFile,
    PendingOrigin,
    PendingSnapshot,
    ProductMutationKind,
    ResourceAdmissionPolicy,
    ResourceAnnotationPort,
    ResourceCapability,
    ResourceFormatPolicy,
    ResourceRetentionPort,
    ResourceVersionReadError,
    ReviewAction,
    ReviewBatchDecision,
    ReviewConflict,
    ReviewDecision,
    ReviewOutcome,
    SealResult,
    SnapshotIdentity,
    VersionContentSnapshot,
    VersionDeletePreview,
    VersionedFile,
    VersionOrigin,
    VersionPairSnapshot,
    VersionRef,
)
from service.resources.domain.version import (
    DiskObservation,
    ObservationState,
    SnapshotVersion,
    TurnBaseline,
    same_source_identity,
)
from service.resources.persistence.objects import CasCorruptError, CasStore, ObjectDescriptor
from service.resources.persistence.version import (
    OPERATION_KIND_ADMISSION,
    VersionStore,
    VersionStoreConflict,
)
from service.resources.service.context import resource_turn_context
from service.resources.service.events import ResourceVersionEvent, emit, emit_pending, emit_review

_log = logging.getLogger("scholarseed.resources.versions")
VERSION_FILE_MISMATCH = "version_file_mismatch"
VERSION_ORDER_INVALID = "version_order_invalid"
FALLBACK_MEDIA_TYPE = "application/octet-stream"
REVIEW_SEAL_EVENTS = {
    ReviewOutcome.ACCEPTED: ResourceVersionEvent.REVIEW_ACCEPT,
    ReviewOutcome.REVISED: ResourceVersionEvent.REVIEW_REVISED,
}
VERSION_ALIAS_MAX_LENGTH = 80
VERSION_ALIAS_ACTOR = "user"
VERSION_HISTORY_ORDERS = frozenset({"newest", "oldest"})


class ResourceVersionService:
    """Coordinate stable disk reads, CAS publication and short ledger commits."""

    def __init__(
        self,
        content: ContentPort,
        retention: ResourceRetentionPort,
        formats: ResourceFormatPolicy,
        annotations: ResourceAnnotationPort,
    ) -> None:
        self._content = content
        self._retention = retention
        self._formats = formats
        self._annotations = annotations
        self._admission_policy: ResourceAdmissionPolicy | None = None

    def bind_admission_policy(self, policy: ResourceAdmissionPolicy) -> None:
        self._admission_policy = policy

    def _git_managed(self, project_id: str, path: str) -> bool:
        return self._content.repository_roots(project_id, (path,))[path] is not None

    def _require_book_versions(self, project_id: str, *paths: str) -> None:
        if any(
            root is not None for root in self._content.repository_roots(project_id, paths).values()
        ):
            raise ResourceVersionError(GIT_VERSION_DISABLED_ERROR)

    def manual_admitted(self, project_id: str, path: str) -> bool:
        return self._store(project_id).manual_admitted(path)

    def manual_admitted_states(self, project_id: str, paths: tuple[str, ...]) -> dict[str, bool]:
        return self._store(project_id).manual_admitted_states(paths)

    def admit(
        self, project_id: str, path: str, expected_disk_revision: str, idempotency_key: str
    ) -> SealResult | None:
        """Explicitly select one authorized stable file without accepting pending work."""
        self._require_book_versions(project_id, path)
        digest = sha256((path + "\0" + expected_disk_revision).encode()).hexdigest()
        with self.writer(project_id):
            store = self._store(project_id)
            try:
                response = store.operation_result(
                    idempotency_key, OPERATION_KIND_ADMISSION, path, digest
                )
                if response is None:
                    if self._admission_policy is not None:
                        state = self._admission_policy.admission_state(project_id, path)
                        if state is ManagementState.OVERSIZED:
                            raise ResourceVersionError("file_too_large")
                        if state is ManagementState.UNAVAILABLE:
                            raise ResourceVersionError("version_admission_unavailable")
                    cas = self._cas(project_id)
                    stable, object_id, descriptor = self._capture_object(project_id, path, cas)
                    if stable.revision != expected_disk_revision:
                        raise ResourceVersionError("revision_conflict")
                    snapshot = SnapshotVersion(
                        path=path,
                        media_type=stable.media_type,
                        revision=stable.revision,
                        object_id=object_id,
                        mode_bits=stable.mode_bits,
                        mtime_ns=stable.mtime_ns,
                        origin=VersionOrigin.INITIAL_SCAN,
                        state=FileState.PRESENT,
                    )
                    final = self._content.snapshot(project_id, path)
                    if final.revision != stable.revision:
                        raise ResourceVersionError("revision_conflict")
                    response = store.admit(snapshot, descriptor, None, idempotency_key, digest)
            except VersionStoreConflict as exc:
                raise ResourceVersionError(exc.code) from exc
            if response["version_id"] is None:
                return None
            version = store.version(response["version_id"])
            if version is None:
                raise ResourceVersionError("version_not_found")
            return SealResult(version, response["unchanged"])

    @contextmanager
    def writer(self, project_id: str) -> Iterator[None]:
        """Serialize one complete version-domain mutation for a project."""

        with self._cas(project_id).writer():
            yield

    def ensure_initial(self, project_id: str, path: str) -> SealResult | None:
        """Create v1 on first stable discovery and remain idempotent afterwards."""

        if self._git_managed(project_id, path):
            return None
        with self.writer(project_id):
            existing = self.history(project_id, path)
            if existing:
                return SealResult(version=existing[0], unchanged=True)
            store = self._store(project_id)
            identity = store.identity(path)
            if identity is not None and store.pending(identity[0]) is not None:
                return None
            if store.initialization_deferred(path):
                if store.identity(path) is None:
                    self._accept_working(project_id, None, path, PendingOrigin.EXTERNAL)
                return None
            return self.seal(project_id, path, VersionOrigin.INITIAL_SCAN)

    def seal(
        self,
        project_id: str,
        path: str,
        origin: VersionOrigin,
        *,
        expected_revision: str | None = None,
        expected_version_id: str | None = None,
        idempotency_key: str | None = None,
        operation_target: str | None = None,
        review_decision: ReviewDecision | None = None,
        expected_pending_revision: int | None = None,
    ) -> SealResult:
        """Seal current stable complete bytes after publishing their CAS object."""

        self._require_book_versions(project_id, path)
        request_digest = None
        store = self._store(project_id)
        if idempotency_key is not None:
            if operation_target is None:
                raise ResourceVersionError("invalid_idempotency_request")
            request_digest = self._seal_digest(
                path,
                origin,
                expected_revision,
                expected_version_id,
                review_decision,
                expected_pending_revision,
            )
            try:
                receipt = store.seal_receipt(idempotency_key, operation_target, request_digest)
            except VersionStoreConflict as exc:
                raise ResourceVersionError(exc.code) from exc
            if receipt is not None:
                return receipt
        cas = self._cas(project_id)
        with cas.writer():
            if idempotency_key is not None:
                if operation_target is None or request_digest is None:
                    raise ResourceVersionError("invalid_idempotency_request")
                try:
                    receipt = store.seal_receipt(idempotency_key, operation_target, request_digest)
                except VersionStoreConflict as exc:
                    raise ResourceVersionError(exc.code) from exc
                if receipt is not None:
                    return receipt
            object_id = None
            descriptor = None
            try:
                stable, object_id, descriptor = self._capture_object(project_id, path, cas)
            except ContentError as exc:
                if exc.code != "file_not_found" or operation_target is None:
                    raise
                stable = None
            if expected_revision is not None and (
                stable is None or stable.revision != expected_revision
            ):
                raise ResourceVersionError("revision_conflict")
            if (
                operation_target is not None
                and review_decision is None
                and ((stable.revision if stable else None) != expected_revision)
            ):
                raise ResourceVersionError("revision_conflict")
            object_id = object_id if stable else None
            descriptor = descriptor if stable else None
            snapshot = SnapshotVersion(
                path=path,
                media_type=(
                    stable.media_type if stable else guess_media_type(path) or FALLBACK_MEDIA_TYPE
                ),
                revision=stable.revision if stable else None,
                object_id=object_id,
                mode_bits=stable.mode_bits if stable else None,
                mtime_ns=stable.mtime_ns if stable else None,
                origin=origin,
                state=FileState.PRESENT if stable else FileState.TOMBSTONE,
            )
            try:
                result = store.seal(
                    snapshot,
                    descriptor,
                    None,
                    expected_version_id=expected_version_id,
                    idempotency_key=idempotency_key,
                    operation_target=operation_target,
                    request_digest=request_digest,
                    review_decision=review_decision,
                    expected_pending_revision=expected_pending_revision,
                )
                if review_decision is not None and not result.unchanged:
                    emit(
                        _log,
                        REVIEW_SEAL_EVENTS[review_decision.outcome],
                        project_id=project_id,
                        file_id=result.version.file_id,
                        review_id=result.version.source_review_id,
                        session_id=result.version.session_id,
                        turn_id=result.version.turn_id,
                        pending_revision=review_decision.pending_revision,
                        revision=snapshot.revision,
                        version_id=result.version.id,
                        result_code="committed",
                    )
                if not result.unchanged and origin is not VersionOrigin.INITIAL_SCAN:
                    self._retention.enforce(project_id)
                if not result.unchanged:
                    emit(
                        _log,
                        ResourceVersionEvent.VERSION_CREATED,
                        project_id=project_id,
                        file_id=result.version.file_id,
                        version_id=result.version.id,
                        revision=snapshot.revision,
                        object_id=result.version.object_id,
                        size_bytes=stable.size if stable else 0,
                        result_code=result.version.origin.value,
                    )
                return result
            except VersionStoreConflict as exc:
                raise ResourceVersionError(exc.code) from exc

    def versioned_files(
        self,
        project_id: str,
        state: FileState,
        *,
        after_file_id: str = "",
        limit: int = DEFAULT_PENDING_PAGE_SIZE,
    ) -> tuple[VersionedFile, ...]:
        return self._store(project_id).versioned_files(
            state, after_file_id=after_file_id, limit=limit
        )

    def pending_files(
        self, project_id: str, *, after_file_id: str = "", limit: int = DEFAULT_PENDING_PAGE_SIZE
    ) -> tuple[PendingFile, ...]:
        return self._store(project_id).pending_files(after_file_id=after_file_id, limit=limit)

    def pending(self, project_id: str, file_id: str) -> PendingSnapshot | None:
        return self._store(project_id).pending(file_id)

    def seal_review(
        self,
        project_id: str,
        file_id: str,
        path: str,
        decision: ReviewDecision,
        expected_revision: str | None,
        idempotency_key: str,
    ) -> SealResult:
        if decision.outcome not in (ReviewOutcome.ACCEPTED, ReviewOutcome.REVISED):
            raise ResourceVersionError(ReviewConflict.INVALID_OUTCOME.value)
        replay = self.seal_receipt(
            project_id,
            path,
            VersionOrigin.USER,
            expected_revision,
            None,
            idempotency_key,
            file_id,
            decision,
        )
        if replay is not None:
            return replay
        identity = self._store(project_id).identity(path)
        if identity is None or identity[0] != file_id:
            raise ResourceVersionError("file_not_managed")
        with self.writer(project_id):
            current = self.pending(project_id, file_id)
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
            try:
                return self.seal(
                    project_id,
                    path,
                    VersionOrigin.USER,
                    expected_revision=expected_revision,
                    idempotency_key=idempotency_key,
                    operation_target=file_id,
                    review_decision=decision,
                )
            except (ResourceVersionError, ContentError) as exc:
                emit_review(
                    _log,
                    ResourceVersionEvent.REVIEW_CONFLICT,
                    project_id,
                    current,
                    expected_review_id=decision.review_id,
                    expected_pending_revision=decision.pending_revision,
                    revision=expected_revision,
                    outcome=decision.outcome.value,
                    result_code=exc.code,
                )
                raise

    def disk_identity(self, project_id: str, path: str) -> SnapshotIdentity:
        """Read complete current bytes and metadata without adopting or sealing them."""

        try:
            stable = self._capture_metadata(project_id, path)
        except ContentError as exc:
            if exc.code != "file_not_found":
                raise
            return SnapshotIdentity(None, FileState.TOMBSTONE, path, None, None)
        return SnapshotIdentity(
            stable.revision,
            FileState.PRESENT,
            path,
            stable.mode_bits,
            None,
        )

    def review_base(self, project_id: str, file_id: str, review_id: str) -> tuple[bytes, str]:
        """Read the immutable first baseline without inventing a historical version."""

        with self.writer(project_id):
            current = self.pending(project_id, file_id)
            if current is None or current.review is None or current.review.id != review_id:
                raise ResourceVersionError(ReviewConflict.NOT_FOUND.value)
            baseline = current.review.base
            if baseline.object_id is None or baseline.state is FileState.TOMBSTONE:
                raise ResourceVersionError("version_is_tombstone")
            with self._cas(project_id).open(baseline.object_id) as source:
                return source.read(), guess_media_type(baseline.path) or FALLBACK_MEDIA_TYPE

    def review_snapshot(self, project_id: str, snapshot: SnapshotIdentity) -> tuple[bytes, str]:
        """Read one frozen batch snapshot directly from the existing resource CAS."""

        if snapshot.state is FileState.TOMBSTONE:
            return b"", guess_media_type(snapshot.path) or FALLBACK_MEDIA_TYPE
        if snapshot.object_id is None:
            raise ResourceVersionError("version_is_tombstone")
        with self._cas(project_id).open(snapshot.object_id) as source:
            return source.read(), guess_media_type(snapshot.path) or FALLBACK_MEDIA_TYPE

    def accept_review_batch(
        self,
        project_id: str,
        batch_id: str,
        decisions: tuple[ReviewBatchDecision, ...],
    ) -> tuple[VersionRef, ...]:
        """Materialize and atomically seal an all-accept review batch."""

        snapshots = []
        with self.writer(project_id):
            for decision in decisions:
                if decision.action is not ReviewAction.ACCEPT:
                    raise ResourceVersionError(ReviewConflict.INVALID_OUTCOME.value)
                pending_snapshot = self.pending(project_id, decision.file_id)
                if (
                    pending_snapshot is None
                    or pending_snapshot.review is None
                    or pending_snapshot.review.id != decision.review_id
                ):
                    raise ResourceVersionError(ReviewConflict.NOT_FOUND.value)
                review = pending_snapshot.review
                self._require_book_versions(project_id, review.candidate.path)
                disk = self.disk_identity(project_id, review.candidate.path)
                if (
                    pending_snapshot.revision != decision.pending_revision
                    or review.candidate_revision != decision.expected_disk_revision
                    or not same_source_identity(disk, review.candidate)
                ):
                    raise ResourceVersionError(ReviewConflict.CANDIDATE_REVISION.value)
                snapshots.append(
                    (
                        decision.file_id,
                        ReviewDecision(
                            decision.review_id,
                            decision.pending_revision,
                            ReviewOutcome.ACCEPTED,
                        ),
                        SnapshotVersion(
                            path=review.candidate.path,
                            media_type=(
                                guess_media_type(review.candidate.path) or FALLBACK_MEDIA_TYPE
                            ),
                            revision=review.candidate_revision,
                            object_id=review.candidate.object_id,
                            mode_bits=review.candidate.mode_bits,
                            mtime_ns=None,
                            origin=VersionOrigin.AGENT,
                            state=review.candidate.state,
                        ),
                    )
                )
            try:
                versions = self._store(project_id).accept_review_batch(batch_id, tuple(snapshots))
            except VersionStoreConflict as exc:
                raise ResourceVersionError(exc.code) from exc
        if versions:
            self._retention.enforce(project_id)
        return versions

    def seal_receipt(
        self,
        project_id: str,
        path: str,
        origin: VersionOrigin,
        expected_revision: str | None,
        expected_version_id: str | None,
        idempotency_key: str,
        operation_target: str,
        review_decision: ReviewDecision | None = None,
        expected_pending_revision: int | None = None,
    ) -> SealResult | None:
        """Resolve one committed HTTP replay without observing current disk state."""

        try:
            return self._store(project_id).seal_receipt(
                idempotency_key,
                operation_target,
                self._seal_digest(
                    path,
                    origin,
                    expected_revision,
                    expected_version_id,
                    review_decision,
                    expected_pending_revision,
                ),
            )
        except VersionStoreConflict as exc:
            raise ResourceVersionError(exc.code) from exc

    @staticmethod
    def _seal_digest(
        path: str,
        origin: VersionOrigin,
        expected_revision: str | None,
        expected_version_id: str | None,
        review_decision: ReviewDecision | None = None,
        expected_pending_revision: int | None = None,
    ) -> str:
        fields = [path, origin.value, expected_revision or "", expected_version_id or ""]
        if review_decision is not None:
            fields.extend(
                (
                    review_decision.review_id,
                    str(review_decision.pending_revision),
                    review_decision.outcome.value,
                )
            )
        else:
            fields.append(str(expected_pending_revision))
        return sha256("\0".join(fields).encode("utf-8")).hexdigest()

    def history(self, project_id: str, path: str) -> tuple[VersionRef, ...]:
        """Return newest-first history without exposing CAS layout."""

        return self._store(project_id).history(path)

    def commit_working(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str,
        idempotency_key: str,
        *,
        automatic_version: bool = False,
    ) -> ContentWriteReceipt:
        """Apply a Workbench save and optionally retain it as a version."""

        if len(content) > VERSION_MAX_BYTES or (
            self._admission_policy is not None
            and len(content) > self._admission_policy.max_size_bytes()
        ):
            return self._content.commit_bytes(project_id, path, content, expected_revision)
        if self._git_managed(project_id, path):
            return self._content.commit_bytes(project_id, path, content, expected_revision)
        return self._commit_product(
            project_id,
            path,
            content,
            expected_revision,
            idempotency_key,
            ProductMutationKind.WRITE,
            automatic_version=automatic_version,
        )

    def commit_versioned_replace(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str,
        idempotency_key: str,
        request_digest: str,
    ) -> tuple[ContentWriteReceipt, VersionRef]:
        """Replace imported bytes while retaining the exact pre-replace generation."""

        if len(content) > VERSION_MAX_BYTES:
            raise ResourceVersionError("file_too_large")
        with self.writer(project_id):
            current = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES)
            if current.revision != expected_revision:
                raise ResourceVersionError("revision_conflict")
            self.seal(
                project_id,
                path,
                VersionOrigin.EXTERNAL_CONFIRMED,
                expected_revision=expected_revision,
            )
            receipt = self._commit_product(
                project_id,
                path,
                content,
                expected_revision,
                idempotency_key,
                ProductMutationKind.WRITE,
                request_digest=request_digest,
                seal_version=True,
            )
            history = self.history(project_id, path)
            if not history:
                raise ResourceVersionError("file_not_managed")
            return receipt, history[0]

    def commit_product(
        self,
        project_id: str,
        path: str,
        content: bytes,
        kind: ProductMutationKind,
        idempotency_key: str,
        *,
        mode_bits: int | None = None,
        request_digest: str | None = None,
    ) -> ContentWriteReceipt:
        """Commit one policy-approved ScholarSeed product write."""

        expected_revision: str | None = None
        if kind is ProductMutationKind.WRITE:
            expected_revision = self._content.stable_snapshot(
                project_id, path, VERSION_MAX_BYTES
            ).revision
        return self._commit_product(
            project_id,
            path,
            content,
            expected_revision,
            idempotency_key,
            kind,
            mode_bits=mode_bits,
            request_digest=request_digest,
        )

    def product_mutation_target(
        self,
        project_id: str,
        idempotency_key: str,
        request_digest: str,
    ) -> str | None:
        """Return the target frozen by an earlier semantic create request."""

        mutation = self._store(project_id).working_mutation(idempotency_key)
        if mutation is None:
            return None
        if (
            mutation.kind is not ProductMutationKind.CREATE
            or mutation.request_digest != request_digest
        ):
            raise ResourceVersionError("idempotency_conflict")
        return mutation.target_path

    def product_mutation_receipt(
        self,
        project_id: str,
        idempotency_key: str,
        request_digest: str,
    ) -> ContentWriteReceipt | None:
        """Resolve a completed product mutation without repeating its filesystem action."""

        mutation = self._store(project_id).working_mutation(idempotency_key)
        if mutation is None:
            return None
        if mutation.request_digest != request_digest:
            raise ResourceVersionError("idempotency_conflict")
        if mutation.state != "ledger_committed":
            return None
        current = self._content.stable_snapshot(project_id, mutation.target_path, VERSION_MAX_BYTES)
        if current.revision != mutation.target_revision:
            raise ResourceVersionError("idempotency_conflict")
        return ContentWriteReceipt(
            project_id=project_id,
            path=mutation.target_path,
            size=len(current.content),
            revision=current.revision,
        )

    def _commit_product(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str | None,
        idempotency_key: str,
        kind: ProductMutationKind,
        *,
        mode_bits: int | None = None,
        request_digest: str | None = None,
        seal_version: bool = False,
        automatic_version: bool = False,
    ) -> ContentWriteReceipt:
        """Persist target bytes before applying their exact filesystem transition."""

        self._require_book_versions(project_id, path)
        with self.writer(project_id):
            if kind is ProductMutationKind.WRITE and not self.history(project_id, path):
                self.ensure_initial(project_id, path)
            identity = self._store(project_id).identity(path)
            if kind is ProductMutationKind.WRITE and identity is None:
                raise ResourceVersionError("file_not_managed")
            try:
                current = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES)
            except ContentError as exc:
                if kind is not ProductMutationKind.CREATE or exc.code != "file_not_found":
                    raise
                current = None
            media_type = (
                current.media_type
                if kind is ProductMutationKind.WRITE and current is not None
                else guess_media_type(path) or "application/octet-stream"
            )
            cas = self._cas(project_id)
            object_id = cas.put(content, media_type)
            target_revision = "sha256:" + sha256(content).hexdigest()
            snapshot = SnapshotVersion(
                path=path,
                media_type=media_type,
                revision=target_revision,
                object_id=object_id,
                mode_bits=(
                    current.mode_bits
                    if current is not None
                    else mode_bits if mode_bits is not None else DEFAULT_PRODUCT_FILE_MODE
                ),
                mtime_ns=None,
                origin=(
                    VersionOrigin.INITIAL_SCAN
                    if kind is ProductMutationKind.CREATE
                    else VersionOrigin.USER
                ),
            )
            store = self._store(project_id)
            pending = store.pending(identity[0]) if identity is not None else None
            automatically_seal = automatic_version and (
                pending is None
                or (
                    not pending.needs_review
                    and pending.origin in {PendingOrigin.USER, PendingOrigin.RESTORE}
                )
            )
            effective_seal_version = seal_version or automatically_seal
            try:
                mutation = store.prepare_working_mutation(
                    (
                        identity[0]
                        if kind is ProductMutationKind.WRITE and identity is not None
                        else None
                    ),
                    snapshot,
                    cas.verify(object_id),
                    idempotency_key,
                    expected_revision,
                    kind,
                    request_digest,
                    seal_version=effective_seal_version,
                )
            except VersionStoreConflict as exc:
                raise ResourceVersionError(exc.code) from exc
            if (
                (
                    kind is ProductMutationKind.WRITE
                    and identity is not None
                    and mutation.file_id != identity[0]
                )
                or mutation.target_revision != target_revision
                or mutation.target_path != path
                or mutation.expected_revision != expected_revision
                or mutation.kind is not kind
                or mutation.seal_version is not effective_seal_version
                or mutation.request_digest != request_digest
            ):
                raise ResourceVersionError("idempotency_conflict")
            if mutation.state == "ledger_committed":
                final_current = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES)
                if final_current.revision != target_revision:
                    raise ResourceVersionError("idempotency_conflict")
                return ContentWriteReceipt(
                    project_id=project_id,
                    path=path,
                    size=len(content),
                    revision=final_current.revision,
                )
            if mutation.state == "prepared":
                current_revision = current.revision if current is not None else None
                if current_revision == expected_revision:
                    receipt = self._content.apply_bytes(
                        project_id,
                        path,
                        content,
                        expected_revision,
                        force=False,
                        mode_bits=snapshot.mode_bits,
                        notify=False,
                    )
                elif current_revision == target_revision:
                    receipt = ContentWriteReceipt(
                        project_id=project_id,
                        path=path,
                        size=len(content),
                        revision=current_revision,
                    )
                else:
                    raise ResourceVersionError("revision_conflict")
                store.mark_working_mutation_applied(mutation.id)
            elif mutation.state == "file_applied":
                final_current = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES)
                if final_current.revision != target_revision:
                    raise ResourceVersionError("revision_conflict")
                receipt = ContentWriteReceipt(
                    project_id=project_id,
                    path=path,
                    size=len(content),
                    revision=final_current.revision,
                )
            else:
                raise ResourceVersionError("invalid_mutation_state")
            final = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES)
            before_pending = store.pending(mutation.file_id)
            snapshot = self._complete_snapshot(
                path,
                final,
                object_id,
                (
                    VersionOrigin.INITIAL_SCAN
                    if kind is ProductMutationKind.CREATE
                    else VersionOrigin.USER
                ),
            )
            sealed = store.commit_working_mutation(
                mutation.id,
                snapshot,
                None,
            )
            if effective_seal_version and sealed is not None and not sealed.unchanged:
                self._retention.enforce(project_id)
                emit(
                    _log,
                    ResourceVersionEvent.VERSION_CREATED,
                    project_id=project_id,
                    file_id=sealed.version.file_id,
                    version_id=sealed.version.id,
                    revision=target_revision,
                    object_id=sealed.version.object_id,
                    size_bytes=len(content),
                    result_code=VersionOrigin.USER.value,
                )
            emit_pending(
                _log, project_id, before_pending, store.pending(mutation.file_id), final.revision
            )
            return receipt

    def recover_working_mutations(self, project_id: str) -> tuple[str, ...]:
        """Roll forward interrupted product saves when disk matches a fenced state."""

        recovered: list[str] = []
        with self.writer(project_id):
            store = self._store(project_id)
            cas = self._cas(project_id)
            for mutation in store.pending_working_mutations():
                if self._git_managed(project_id, mutation.target_path):
                    _log.warning(
                        GIT_VERSION_DISABLED_ERROR,
                        extra={"project_id": project_id, "path": mutation.target_path},
                    )
                    continue
                current: StableContentSnapshot | None
                try:
                    current = self._content.stable_snapshot(
                        project_id, mutation.target_path, VERSION_MAX_BYTES
                    )
                except ContentError as exc:
                    if (
                        exc.code != "file_not_found"
                        or mutation.kind is not ProductMutationKind.CREATE
                    ):
                        store.fail_working_mutation(mutation.id, "needs_reconcile")
                        continue
                    current = None
                current_revision = current.revision if current is not None else None
                if mutation.state == "prepared" and current_revision == mutation.expected_revision:
                    with cas.open(mutation.target_object_id) as stream:
                        payload = stream.read()
                    self._content.apply_bytes(
                        project_id,
                        mutation.target_path,
                        payload,
                        mutation.expected_revision,
                        force=False,
                        mode_bits=mutation.target_mode_bits,
                        notify=False,
                    )
                    store.mark_working_mutation_applied(mutation.id)
                    current = self._content.stable_snapshot(
                        project_id, mutation.target_path, VERSION_MAX_BYTES
                    )
                if current is None or current.revision != mutation.target_revision:
                    store.fail_working_mutation(mutation.id, "needs_reconcile")
                    continue
                before_pending = store.pending(mutation.file_id)
                snapshot = self._complete_snapshot(
                    mutation.target_path,
                    current,
                    mutation.target_object_id,
                    (
                        VersionOrigin.INITIAL_SCAN
                        if mutation.kind is ProductMutationKind.CREATE
                        else VersionOrigin.USER
                    ),
                )
                sealed = store.commit_working_mutation(
                    mutation.id,
                    snapshot,
                    None,
                )
                if mutation.seal_version and sealed is not None and not sealed.unchanged:
                    self._retention.enforce(project_id)
                    emit(
                        _log,
                        ResourceVersionEvent.VERSION_CREATED,
                        project_id=project_id,
                        file_id=sealed.version.file_id,
                        version_id=sealed.version.id,
                        revision=current.revision,
                        object_id=sealed.version.object_id,
                        size_bytes=len(current.content),
                        result_code=VersionOrigin.USER.value,
                    )
                emit_pending(
                    _log,
                    project_id,
                    before_pending,
                    store.pending(mutation.file_id),
                    current.revision,
                )
                recovered.append(mutation.id)
        return tuple(recovered)

    def prepare_agent(
        self,
        project_id: str,
        path: str,
        session_id: str,
        turn_id: str,
        delivery_id: str,
        stable: StableContentCapture,
        object_id: str,
        descriptor: ObjectDescriptor,
        *,
        source_path: str | None = None,
    ) -> tuple[SnapshotVersion, ObjectDescriptor, ObjectDescriptor | None]:
        """Publish final bytes to CAS without exposing a Version before terminal commit."""

        self._require_book_versions(project_id, path, *((source_path,) if source_path else ()))
        if descriptor.object_id != object_id or stable.revision != object_id:
            raise ResourceVersionError("version_object_mismatch")
        if source_path is not None:
            self._annotations.move(project_id, source_path, path)
        return (
            SnapshotVersion(
                path=path,
                media_type=stable.media_type,
                revision=stable.revision,
                object_id=object_id,
                mode_bits=stable.mode_bits,
                mtime_ns=stable.mtime_ns,
                origin=VersionOrigin.AGENT,
                state=FileState.PRESENT,
                session_id=session_id,
                turn_id=turn_id,
                delivery_id=delivery_id,
            ),
            descriptor,
            None,
        )

    def capture_agent(
        self,
        project_id: str,
        path: str,
    ) -> tuple[StableContentCapture, str, ObjectDescriptor]:
        """Capture one exact Agent-produced generation into the streaming CAS path."""

        self._require_book_versions(project_id, path)
        return self._capture_object(project_id, path, self._cas(project_id))

    def verify_object(self, project_id: str, object_id: str) -> ObjectDescriptor:
        """Resolve and verify one immutable object independently of its layout."""

        return self._cas(project_id).verify(object_id)

    def prepare_agent_deleted(
        self,
        project_id: str,
        baseline: TurnBaseline,
        session_id: str,
        turn_id: str,
        delivery_id: str,
    ) -> SnapshotVersion:
        """Build a tombstone for the same atomic terminal publication."""

        self._require_book_versions(project_id, baseline.path)
        self._annotations.remove(project_id, baseline.path)
        return SnapshotVersion(
            path=baseline.path,
            media_type="application/octet-stream",
            revision=None,
            object_id=None,
            mode_bits=None,
            mtime_ns=None,
            origin=VersionOrigin.AGENT,
            state=FileState.TOMBSTONE,
            session_id=session_id,
            turn_id=turn_id,
            delivery_id=delivery_id,
        )

    def enforce_retention(self, project_id: str) -> int:
        """Enforce retention after an Agent Delivery has committed as one group."""

        return self._retention.enforce(project_id)

    def record_changes(self, project_id: str, paths: tuple[str, ...]) -> None:
        """Accept successful product writes as WorkingHead updates, not Versions."""

        repositories = self._content.repository_roots(project_id, paths)
        candidates = tuple(path for path in dict.fromkeys(paths) if repositories[path] is None)
        if not candidates:
            return
        with self.writer(project_id):
            store = self._store(project_id)
            baselines = {item.path: item for item in store.managed_files()}
            missing: list[str] = []
            present: dict[str, tuple[StableContentCapture, str, ObjectDescriptor]] = {}
            for path in candidates:
                try:
                    captured = self._capture_object(project_id, path, self._cas(project_id))
                except ContentError as exc:
                    if exc.code == "file_not_found":
                        missing.append(path)
                    elif exc.code not in {"not_a_file", "file_too_large"}:
                        raise
                else:
                    present[path] = captured
            moved: set[str] = set()
            for path, (stable_capture, _object_id, _descriptor) in present.items():
                if store.identity(path) is not None:
                    continue
                matches = [
                    source
                    for source in missing
                    if source not in moved
                    and baselines.get(source) is not None
                    and baselines[source].object_id == stable_capture.revision
                ]
                if len(matches) == 1:
                    source = matches[0]
                    store.move_identity(baselines[source].file_id, path, VersionOrigin.USER.value)
                    moved.add(source)
            for path, captured in present.items():
                if (
                    self._admission_policy is not None
                    and self._admission_policy.admission_state(project_id, path)
                    is not ManagementState.MANAGED
                ):
                    continue
                identity = store.identity(path)
                if identity is None:
                    self.ensure_initial(project_id, path)
                    continue
                self._accept_working(project_id, identity[0], path, captured=captured)
            for path in missing:
                if path in moved:
                    continue
                baseline = baselines.get(path)
                if baseline is not None:
                    self._accept_deleted(project_id, baseline.file_id, path)
                    self._annotations.remove(project_id, path)

    def is_managed(self, project_id: str, path: str) -> bool:
        """Return whether a stable identity already owns this logical path."""

        return self._store(project_id).identity(path) is not None

    def tracked_paths(self, project_id: str) -> tuple[str, ...]:
        """Include tombstones when reconciling a newly restored external root."""

        return self._store(project_id).tracked_paths()

    def managed_paths(self, project_id: str) -> tuple[str, ...]:
        """Return current managed paths for product subtree mutation expansion."""

        return tuple(item.path for item in self._store(project_id).managed_files())

    def versioned_paths(self, project_id: str) -> frozenset[str]:
        """Return current paths backed by at least one published Version."""

        return self._store(project_id).versioned_paths()

    def record_moves(self, project_id: str, pairs: tuple[tuple[str, str], ...]) -> None:
        """Apply product-declared path mappings without appending Versions."""

        if not pairs:
            return
        with self.writer(project_id):
            store = self._store(project_id)
            for source, target in pairs:
                if self._git_managed(project_id, source) or self._git_managed(project_id, target):
                    continue
                identity = store.identity(source)
                if identity is None:
                    continue
                try:
                    captured = self._capture_object(project_id, target, self._cas(project_id))
                except ContentError as exc:
                    if exc.code in {"file_not_found", "not_a_file", "file_too_large"}:
                        continue
                    raise
                self._annotations.move(project_id, source, target)
                store.move_identity(identity[0], target, VersionOrigin.USER.value)
                self._accept_working(project_id, identity[0], target, captured=captured)

    def _accept_working(
        self,
        project_id: str,
        file_id: str | None,
        path: str,
        origin: PendingOrigin = PendingOrigin.USER,
        *,
        captured: tuple[StableContentCapture, str, ObjectDescriptor] | None = None,
    ) -> None:
        cas = self._cas(project_id)
        stable, object_id, descriptor = captured or self._capture_object(project_id, path, cas)
        snapshot = self._complete_snapshot(
            path,
            stable,
            object_id,
            VersionOrigin.USER,
        )
        store = self._store(project_id)
        before = store.pending(file_id) if file_id is not None else None
        store.accept_working(
            file_id,
            snapshot,
            descriptor,
            None,
            origin.value,
        )
        if file_id is not None:
            emit_pending(_log, project_id, before, store.pending(file_id), stable.revision)

    def _accept_deleted(
        self, project_id: str, file_id: str, path: str, origin: PendingOrigin = PendingOrigin.USER
    ) -> None:
        store = self._store(project_id)
        before = store.pending(file_id)
        store.accept_working(
            file_id,
            SnapshotVersion(
                path=path,
                media_type="application/octet-stream",
                revision=None,
                object_id=None,
                mode_bits=None,
                mtime_ns=None,
                origin=VersionOrigin.USER,
                state=FileState.TOMBSTONE,
            ),
            None,
            None,
            origin.value,
        )
        emit_pending(_log, project_id, before, store.pending(file_id), None)

    def capture_turn_baselines(
        self,
        project_id: str,
        session_id: str,
        turn_id: str,
        eligible_paths: tuple[str, ...],
        initial_paths: tuple[str, ...],
    ) -> tuple[TurnBaseline, ...]:
        """Durably capture pre-turn bytes only for currently eligible managed files."""

        cas = self._cas(project_id)
        repositories = self._content.repository_roots(project_id, eligible_paths)
        eligible = {path for path in eligible_paths if repositories[path] is None}
        with cas.writer():
            store = self._store(project_id)
            captured: list[tuple[TurnBaseline, ObjectDescriptor, ObjectDescriptor | None]] = []
            for managed in store.managed_files():
                if managed.path not in eligible:
                    continue
                try:
                    stable, object_id, descriptor = self._capture_object(
                        project_id, managed.path, cas
                    )
                except ContentError as exc:
                    if exc.code in ("file_not_found", "file_too_large"):
                        continue
                    raise
                current_pending = store.pending(managed.file_id)
                drifted = managed.object_id != object_id or managed.mode_bits != stable.mode_bits
                if drifted and current_pending is not None and current_pending.needs_review:
                    raise ResourceVersionError(ReviewConflict.CANDIDATE_REVISION.value)
                if drifted:
                    store.accept_working(
                        managed.file_id,
                        SnapshotVersion(
                            path=managed.path,
                            media_type=stable.media_type,
                            revision=stable.revision,
                            object_id=object_id,
                            mode_bits=stable.mode_bits,
                            mtime_ns=stable.mtime_ns,
                            origin=VersionOrigin.EXTERNAL_CONFIRMED,
                        ),
                        descriptor,
                        None,
                        PendingOrigin.EXTERNAL.value,
                    )
                    current_pending = store.pending(managed.file_id)
                captured.append(
                    (
                        TurnBaseline(
                            file_id=managed.file_id,
                            path=managed.path,
                            revision=stable.revision,
                            object_id=object_id,
                            mode_bits=stable.mode_bits,
                            version_id=managed.version_id,
                            pending_origin=current_pending.origin if current_pending else None,
                        ),
                        descriptor,
                        None,
                    )
                )
            store.begin_turn(
                session_id,
                turn_id,
                tuple(captured),
                initial_paths,
                resource_turn_context(store, session_id),
            )
            return store.turn_baselines(session_id, turn_id)

    def turn_baselines(
        self, project_id: str, session_id: str, turn_id: str
    ) -> tuple[TurnBaseline, ...]:
        return self._store(project_id).turn_baselines(session_id, turn_id)

    def turn_state(self, project_id: str, session_id: str, turn_id: str) -> str | None:
        return self._store(project_id).turn_state(session_id, turn_id)

    def discard_turn(
        self, project_id: str, session_id: str, turn_id: str, state: str = "discarded"
    ) -> None:
        self._store(project_id).discard_turn(session_id, turn_id, state)

    def history_for_file(
        self,
        project_id: str,
        file_id: str,
        *,
        before_sequence: int | None = None,
        limit: int = 50,
    ) -> tuple[VersionRef, ...]:
        """Read a page by stable file id."""

        return self._store(project_id).history_for_file(
            file_id, before_sequence=before_sequence, limit=limit
        )

    def history_page(
        self,
        project_id: str,
        file_id: str,
        *,
        before_sequence: int | None = None,
        limit: int = 50,
        query: str = "",
        origin: str | None = None,
        order: str = "newest",
    ) -> tuple[tuple[VersionRef, ...], int]:
        """Read a server-filtered history page for the management surface."""

        if order not in VERSION_HISTORY_ORDERS:
            raise ResourceVersionError("invalid_version_order")
        if origin is not None:
            try:
                VersionOrigin(origin)
            except ValueError as exc:
                raise ResourceVersionError("invalid_version_origin") from exc
        return self._store(project_id).history_page(
            file_id,
            before_sequence=before_sequence,
            limit=limit,
            query=query.strip(),
            origin=origin,
            order=order,
        )

    def update_alias(
        self,
        project_id: str,
        version_id: str,
        alias: str | None,
        expected_revision: int,
        idempotency_key: str,
    ) -> VersionRef:
        """Update only a version's user-facing alias."""

        normalized = alias.strip() if alias is not None else None
        if normalized == "":
            normalized = None
        if normalized is not None and (
            len(normalized) > VERSION_ALIAS_MAX_LENGTH
            or any(category(character).startswith("C") for character in normalized)
        ):
            raise ResourceVersionError("invalid_version_alias")
        digest = sha256(
            f"{version_id}\0{normalized or ''}\0{expected_revision}".encode("utf-8")
        ).hexdigest()
        with self.writer(project_id):
            return self._store(project_id).update_alias(
                version_id,
                normalized,
                expected_revision,
                VERSION_ALIAS_ACTOR,
                idempotency_key,
                digest,
            )

    def preview_delete(self, project_id: str, version_id: str) -> VersionDeletePreview:
        """Describe whether one version can be deleted and all collateral records."""

        return self._store(project_id).preview_delete(version_id)

    def delete_version(
        self,
        project_id: str,
        version_id: str,
        preflight_token: str,
        idempotency_key: str,
    ) -> dict:
        """Delete one historical ledger entry after exact impact confirmation."""

        digest = sha256(f"{version_id}\0{preflight_token}".encode("utf-8")).hexdigest()
        with self.writer(project_id):
            return self._store(project_id).delete_version(
                version_id,
                preflight_token,
                idempotency_key,
                digest,
            )

    def version(self, project_id: str, version_id: str) -> VersionRef:
        """Return one immutable version by stable identity."""

        version = self._store(project_id).version(version_id)
        if version is None:
            raise ResourceVersionError("version_not_found")
        return version

    def diff(
        self,
        project_id: str,
        version_id: str,
        base_version_id: str | None,
    ) -> tuple[str, ...]:
        """Return a line-level unified diff against another version or current disk."""

        version = self.version(project_id, version_id)
        if version.state is not FileState.PRESENT or version.object_id is None:
            raise ResourceVersionError("version_is_tombstone")
        if not self._formats.diffable(version.path):
            raise ResourceVersionError("diff_not_supported")
        historical, _media_type = self.read(project_id, version_id)
        if base_version_id is None:
            current = self._content.stable_snapshot(
                project_id, self._current_path(project_id, version.file_id), VERSION_MAX_BYTES
            ).content
            base_label = "working"
        else:
            base = self.version(project_id, base_version_id)
            if base.file_id != version.file_id:
                raise ResourceVersionError("diff_file_mismatch")
            current, _media_type = self.read(project_id, base_version_id)
            base_label = f"v{base.sequence}"
        try:
            source_lines = historical.decode("utf-8").splitlines(keepends=True)
            base_lines = current.decode("utf-8").splitlines(keepends=True)
        except UnicodeDecodeError as exc:
            raise ResourceVersionError("diff_not_supported") from exc
        return tuple(
            unified_diff(
                source_lines,
                base_lines,
                fromfile=f"v{version.sequence}",
                tofile=base_label,
                lineterm="",
            )
        )

    def observe(self, project_id: str, path: str) -> bool:
        """Capture settled external snapshots without sealing or changing open reviews."""

        if self._git_managed(project_id, path):
            return False
        with self.writer(project_id):
            store = self._store(project_id)
            identity = store.identity(path)
            if identity is None:
                return False
            captured = None
            try:
                captured = self._capture_object(project_id, path, self._cas(project_id))
                current = captured[0]
                observation = DiskObservation(
                    ObservationState.PRESENT,
                    revision=current.revision,
                    size_bytes=current.size,
                    mtime_ns=current.mtime_ns,
                    mode_bits=current.mode_bits,
                )
            except ContentError as exc:
                observation = DiskObservation(
                    ObservationState.TOMBSTONE
                    if exc.code == "file_not_found"
                    else ObservationState.UNAVAILABLE
                )
            changed = store.observe(identity[0], observation)
            head = store.working_snapshot(identity[0])
            available = observation.state is not ObservationState.UNAVAILABLE
            observed = (
                SnapshotIdentity(
                    observation.revision,
                    FileState(observation.state.value),
                    path,
                    observation.mode_bits,
                    None,
                )
                if available
                else None
            )
            drifted = not available or not same_source_identity(head, observed)
            current_pending = store.pending(identity[0])
            if (
                available
                and drifted
                and not (current_pending and current_pending.review)
                and not store.initialization_deferred(path)
            ):
                if observation.state is ObservationState.PRESENT:
                    self._accept_working(
                        project_id,
                        identity[0],
                        path,
                        PendingOrigin.EXTERNAL,
                        captured=captured,
                    )
                else:
                    self._accept_deleted(project_id, identity[0], path, PendingOrigin.EXTERNAL)
            if changed and drifted:
                emit(
                    _log,
                    ResourceVersionEvent.OBSERVE_DRIFT,
                    project_id=project_id,
                    file_id=identity[0],
                    revision=observation.revision,
                    result_code=observation.state.value,
                )
            return changed and drifted

    def capability(self, project_id: str, path: str) -> ResourceCapability:
        """Project current version identity without exposing physical storage."""

        identity = self._store(project_id).identity(path)
        if identity is None:
            disk_revision = None
            state = ManagementState.MANAGED
            try:
                disk_revision = self._capture_metadata(project_id, path).revision
            except ContentError as exc:
                if exc.code == "file_too_large":
                    state = ManagementState.OVERSIZED
                elif exc.code in {"file_not_found", "not_a_file"}:
                    state = ManagementState.UNAVAILABLE
                else:
                    raise
            return ResourceCapability(
                path=path,
                managed=False,
                can_version=True,
                can_diff=False,
                can_preview_history=False,
                max_size_bytes=VERSION_MAX_BYTES,
                management_state=state,
                disk_revision=disk_revision,
            )
        file_id, revision, version_id = identity
        head = self._store(project_id).working_snapshot(file_id)
        drifted = True
        disk_revision = None
        try:
            current = self.disk_identity(project_id, path)
            disk_revision = current.object_id
            drifted = not same_source_identity(head, current)
        except ContentError:
            # Unreadable content is not evidence that disk and working head match.
            drifted = True
        return ResourceCapability(
            path=path,
            managed=True,
            can_version=True,
            can_diff=self._formats.diffable(path),
            can_preview_history=self._formats.versionable(path),
            max_size_bytes=VERSION_MAX_BYTES,
            management_state=ManagementState.MANAGED,
            drifted=drifted,
            file_id=file_id,
            working_revision=revision,
            disk_revision=disk_revision,
            version_id=version_id,
            snapshot_state=self._store(project_id).snapshot_state(file_id),
            pending=self._store(project_id).pending(file_id),
            manual_admitted=self.manual_admitted(project_id, path),
        )

    def capability_states(
        self, project_id: str, paths: tuple[str, ...]
    ) -> dict[str, ResourceCapability]:
        """Project persisted list state without issuing stable reads per row."""

        states = self._store(project_id).capability_states(paths)
        return {
            path: ResourceCapability(
                path=path,
                managed=True,
                can_version=True,
                can_diff=self._formats.diffable(path),
                can_preview_history=self._formats.versionable(path),
                max_size_bytes=VERSION_MAX_BYTES,
                management_state=ManagementState.MANAGED,
                drifted=state.drifted,
                file_id=state.file_id,
                working_revision=state.working_revision,
                disk_revision=state.observed_revision,
                version_id=state.version_id,
                snapshot_state=state.snapshot_state,
                pending=state.pending,
            )
            for path, state in states.items()
        }

    def read(self, project_id: str, version_id: str) -> tuple[bytes, str]:
        """Materialize one present version as complete verified bytes."""

        version = self._store(project_id).version(version_id)
        if version is None:
            raise ResourceVersionError("version_not_found")
        if version.state is not FileState.PRESENT or version.object_id is None:
            raise ResourceVersionError("version_is_tombstone")
        cas = self._cas(project_id)
        if cas.verify(version.object_id).raw_size_bytes > VERSION_INLINE_MAX_BYTES:
            raise ResourceVersionError("version_inline_too_large")
        with cas.open(version.object_id) as stream:
            content = stream.read()
        media_type = guess_media_type(version.path)
        return content, media_type or FALLBACK_MEDIA_TYPE

    def read_revision(self, project_id: str, path: str, revision: str) -> bytes | None:
        """Read an immutable path revision when it is retained in this project's ledger."""

        try:
            version = next(
                (
                    candidate
                    for candidate in self._store(project_id).history(path)
                    if candidate.object_id == revision
                    and candidate.state is FileState.PRESENT
                    and candidate.object_id is not None
                ),
                None,
            )
            if version is None or version.object_id is None:
                return None
            cas = self._cas(project_id)
            if cas.verify(version.object_id).raw_size_bytes > VERSION_INLINE_MAX_BYTES:
                return None
            with cas.open(version.object_id) as stream:
                return stream.read()
        except (OSError, sqlite3.Error, CasCorruptError):
            _log.exception(
                "Resource revision unavailable",
                extra={"project_id": project_id, "path": path, "revision": revision},
            )
            return None

    def read_pair(
        self, project_id: str, before_version_id: str, after_version_id: str
    ) -> VersionPairSnapshot:
        """Copy both verified inputs before retention can remove either version.

        No stream or lock escapes this boundary. Format processing can therefore
        run after this returns without holding up project mutations or GC.
        """

        try:
            cas = self._cas(project_id)
            with cas.writer():
                before = self.version(project_id, before_version_id)
                after = self.version(project_id, after_version_id)
                if before.file_id != after.file_id:
                    raise ResourceVersionError(VERSION_FILE_MISMATCH)
                if before.sequence >= after.sequence:
                    raise ResourceVersionError(VERSION_ORDER_INVALID)
                snapshots = []
                for version in (before, after):
                    if version.state is not FileState.PRESENT or version.object_id is None:
                        raise ResourceVersionError("version_is_tombstone")
                    if cas.verify(version.object_id).raw_size_bytes > VERSION_INLINE_MAX_BYTES:
                        raise ResourceVersionError("version_inline_too_large")
                    with cas.open(version.object_id) as stream:
                        snapshots.append(
                            VersionContentSnapshot(
                                version=version,
                                media_type=guess_media_type(version.path) or FALLBACK_MEDIA_TYPE,
                                content=stream.read(),
                            )
                        )
                return VersionPairSnapshot(before=snapshots[0], after=snapshots[1])
        except ResourceVersionError as exc:
            raise ResourceVersionReadError(exc.code) from exc
        except (OSError, sqlite3.Error, CasCorruptError) as exc:
            _log.exception(
                "Resource version pair unavailable",
                extra={
                    "project_id": project_id,
                    "before_version_id": before_version_id,
                    "after_version_id": after_version_id,
                },
            )
            raise ResourceVersionReadError("resource_versions_unavailable") from exc

    def content(
        self,
        project_id: str,
        version_id: str,
    ) -> tuple[Iterator[bytes], str, int]:
        """Return a verified streaming body and descriptor metadata for one version."""

        version = self._store(project_id).version(version_id)
        if version is None:
            raise ResourceVersionError("version_not_found")
        if version.state is not FileState.PRESENT or version.object_id is None:
            raise ResourceVersionError("version_is_tombstone")
        cas = self._cas(project_id)
        descriptor = cas.verify(version.object_id)
        media_type = guess_media_type(version.path) or FALLBACK_MEDIA_TYPE
        return cas.iter_bytes(version.object_id), media_type, descriptor.raw_size_bytes

    def content_range(
        self,
        project_id: str,
        version_id: str,
        start: int,
        end: int,
    ) -> tuple[Iterator[bytes], str, int]:
        """Return one verified inclusive byte-range stream from a present version."""

        version = self._store(project_id).version(version_id)
        if version is None:
            raise ResourceVersionError("version_not_found")
        if version.state is not FileState.PRESENT or version.object_id is None:
            raise ResourceVersionError("version_is_tombstone")
        cas = self._cas(project_id)
        descriptor = cas.verify(version.object_id)
        media_type = guess_media_type(version.path) or FALLBACK_MEDIA_TYPE
        return cas.iter_range(version.object_id, start, end), media_type, descriptor.raw_size_bytes

    def read_annotation(self, project_id: str, version_id: str) -> bytes:
        """Read the exact canonical annotation sidecar captured by one version."""

        version = self.version(project_id, version_id)
        if version.annotation_object_id is None:
            raise ResourceVersionError("annotations_not_available")
        with self._cas(project_id).open(version.annotation_object_id) as stream:
            return stream.read()

    def _current_path(self, project_id: str, file_id: str) -> str:
        head = self._store(project_id).head(file_id)
        if head is None:
            raise ResourceVersionError("file_not_managed")
        return head[0]

    def _complete_snapshot(
        self,
        path: str,
        stable: StableContentCapture | StableContentSnapshot,
        object_id: str,
        origin: VersionOrigin,
    ) -> SnapshotVersion:
        """Build one source-file snapshot without coupling annotation persistence."""

        return SnapshotVersion(
            path=path,
            media_type=stable.media_type,
            revision=stable.revision,
            object_id=object_id,
            mode_bits=stable.mode_bits,
            mtime_ns=stable.mtime_ns,
            origin=origin,
        )

    def _capture_object(
        self,
        project_id: str,
        path: str,
        cas: CasStore,
    ) -> tuple[StableContentCapture, str, ObjectDescriptor]:
        with cas.spool() as spool:
            stable = self._content.capture_stable(project_id, path, VERSION_MAX_BYTES, spool)
            object_id = cas.put_stream(
                spool,
                raw_size_bytes=stable.size,
                expected_object_id=stable.revision,
                media_hint=stable.media_type,
            )
        return stable, object_id, cas.verify(object_id)

    def _capture_metadata(self, project_id: str, path: str) -> StableContentCapture:
        cas = self._cas(project_id)
        with cas.spool() as spool:
            return self._content.capture_stable(project_id, path, VERSION_MAX_BYTES, spool)

    def _store(self, project_id: str) -> VersionStore:
        database = self._content.resolve(project_id, PROJECT_DB_RELATIVE)
        return VersionStore(database, self._content.project(project_id).root)

    def _cas(self, project_id: str) -> CasStore:
        root = self._content.resolve(project_id, PROJECT_VERSIONS_RELATIVE)
        return CasStore(root, project_root=self._content.project(project_id).root)


class ResourceVersionError(RuntimeError):
    """Stable resource-version error exposed by HTTP adapters."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


__all__ = ["ResourceVersionError", "ResourceVersionService"]
