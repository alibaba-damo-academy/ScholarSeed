"""Durable Agent turn capture into pending whole-file review candidates."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import asdict
from pathlib import Path

from service.content.domain.model import ContentError
from service.paths import PROJECT_DB_RELATIVE
from service.platform.content import ContentPort, StableContentCapture
from service.platform.resources import (
    GIT_VERSION_DISABLED_ERROR,
    ChangeAttribution,
    FileState,
    ResourceFinalization,
    ResourceTerminalSource,
    ResourceTurnContext,
    ReviewCaptureResult,
    SnapshotState,
    TurnOutcome,
)
from service.resources.domain.version import TurnBaseline
from service.resources.persistence.objects import ObjectDescriptor
from service.resources.persistence.version import (
    OPERATION_KIND_FINALIZATION_RETRY,
    DeliverySnapshot,
    VersionStore,
    VersionStoreConflict,
)
from service.resources.service.events import ResourceVersionEvent, emit, emit_pending
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor

DELIVERY_ID_PREFIX = "delivery-"
CREATED_FILE_ID_PREFIX = "file-"
IDENTIFIER_LENGTH = 32
UTF8_ENCODING = "utf-8"
TOOL_CALL_CHANGE_KIND = "tool_call"
_log = logging.getLogger("scholarseed.resources.deliveries")


def _identity(prefix: str, *parts: str) -> str:
    payload = "\0".join(parts).encode(UTF8_ENCODING)
    return prefix + hashlib.sha256(payload).hexdigest()[:IDENTIFIER_LENGTH]


def _finalization_digest(members: tuple[DeliverySnapshot, ...]) -> str:
    payload = [
        {
            "after_mode": member.snapshot.mode_bits,
            "after_object": member.snapshot.object_id,
            "after_path": member.snapshot.path,
            "after_state": member.snapshot.state.value,
            "before_mode": member.baseline.mode_bits,
            "before_object": member.baseline.object_id,
            "before_path": member.baseline.path,
            "before_state": member.baseline.state.value,
            "change_kind": member.change_kind,
            "attribution": member.attribution.value,
            "file_id": member.baseline.file_id,
        }
        for member in members
    ]
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return "sha256:" + hashlib.sha256(encoded.encode(UTF8_ENCODING)).hexdigest()


class ResourceDeliveryService:
    """Capture pre-turn state and preserve modifications at every confirmed terminal."""

    def __init__(
        self,
        content: ContentPort,
        versions: ResourceVersionService,
        supervisor: ResourceVersionSupervisor,
    ) -> None:
        self._content = content
        self._versions = versions
        self._supervisor = supervisor
        self._projects: dict[tuple[str, str], str] = {}
        self._terminals: ResourceTerminalSource | None = None

    def bind_terminals(self, source: ResourceTerminalSource) -> None:
        """Compose chat-owned evidence before application startup."""

        self._terminals = source

    def recover_project(self, project_id: str, project_root: str) -> None:
        """Replay one project's frozen terminal snapshots and pending publications."""

        self._reconcile_terminals(project_id, project_root)
        for session_id, turn_id in self._store(project_id).pending_finalizations():
            try:
                entry = self._store(project_id).finalization(session_id, turn_id)
                if entry is not None:
                    self._finish(project_id, session_id, turn_id, entry.terminal_outcome)
            except Exception:  # noqa: BLE001 - retain one failure without hiding other turns
                _log.exception(
                    "resource_delivery_recovery_failed",
                    extra={
                        "project_id": project_id,
                        "session_id": session_id,
                        "turn_id": turn_id,
                    },
                )

    def _reconcile_terminals(self, project_id: str, project_root: str) -> None:
        if self._terminals is None:
            return
        with self._versions.writer(project_id):
            store = self._store(project_id)
            for turn in store.unreceived_turns():
                try:
                    evidence = self._terminals.terminal_outcome(project_root, turn)
                    if evidence is None:
                        _log.warning(
                            "resource_terminal_unconfirmed",
                            extra={
                                "project_id": project_id,
                                "session_id": turn.session_id,
                                "turn_id": turn.turn_id,
                            },
                        )
                        continue
                    store.receive_terminal(turn.session_id, turn.turn_id, evidence.outcome)
                    if turn.vendor_turn_id is None and evidence.outcome in (
                        TurnOutcome.FAILED,
                        TurnOutcome.INTERRUPTED,
                    ):
                        store.stage_delivery(
                            turn.session_id, turn.turn_id, _finalization_digest(()), ()
                        )
                    _log.info(
                        "resource_terminal_reconciled",
                        extra={
                            "project_id": project_id,
                            "session_id": turn.session_id,
                            "turn_id": turn.turn_id,
                            "product_seq": evidence.product_seq,
                            "outcome": evidence.outcome.value,
                        },
                    )
                except (
                    Exception
                ):  # noqa: BLE001 - preserve unresolved state and continue other turns
                    _log.exception(
                        "resource_terminal_reconciliation_failed",
                        extra={
                            "project_id": project_id,
                            "session_id": turn.session_id,
                            "turn_id": turn.turn_id,
                        },
                    )

    async def begin_turn(self, session_id: str, turn_id: str, workdir: str) -> ResourceTurnContext:
        """Persist stable pre-write bytes before an Agent turn starts."""

        project = self._content.project_for_path(workdir)
        if project is None:
            return ResourceTurnContext()
        await self._supervisor.prepare_project(project.id)
        self._projects[(session_id, turn_id)] = project.id
        return await asyncio.to_thread(self._begin, project.id, session_id, turn_id)

    async def finish_turn(
        self, session_id: str, turn_id: str, outcome: TurnOutcome
    ) -> ReviewCaptureResult:
        """Capture a confirmed terminal exactly once; no terminal auto-creates versions."""

        project_id = self._project_for_turn(session_id, turn_id)
        if project_id is None:
            return ReviewCaptureResult()
        return await asyncio.to_thread(self._finish, project_id, session_id, turn_id, outcome)

    def finalizations(
        self, project_id: str, session_id: str, *, cursor: str | None, limit: int
    ) -> tuple[tuple[ResourceFinalization, ...], str | None]:
        with self._versions.writer(project_id):
            rows = self._store(project_id).finalizations(session_id, cursor=cursor, limit=limit + 1)
        entries = rows[:limit]
        return entries, entries[-1].turn_id if len(rows) > limit else None

    async def retry_finalization(
        self, project_id: str, session_id: str, turn_id: str, idempotency_key: str
    ) -> ReviewCaptureResult:
        """User-requested retry of frozen bytes; never turns current disk into an old Delivery."""

        return await asyncio.to_thread(
            self._retry_finalization, project_id, session_id, turn_id, idempotency_key
        )

    def _retry_finalization(
        self, project_id: str, session_id: str, turn_id: str, idempotency_key: str
    ) -> ReviewCaptureResult:
        with self._versions.writer(project_id):
            store = self._store(project_id)
            operation_target = hashlib.sha256(
                "\0".join((session_id, turn_id)).encode(UTF8_ENCODING)
            ).hexdigest()
            request_digest = hashlib.sha256(
                "\0".join((OPERATION_KIND_FINALIZATION_RETRY, session_id, turn_id)).encode(
                    UTF8_ENCODING
                )
            ).hexdigest()
            receipt = store.operation_result(
                idempotency_key,
                OPERATION_KIND_FINALIZATION_RETRY,
                operation_target,
                request_digest,
            )
            if receipt is not None:
                return ReviewCaptureResult(
                    tuple(receipt["file_ids"]),
                    tuple(receipt["review_ids"]),
                    receipt.get("batch_id"),
                    receipt.get("project_id"),
                    tuple(receipt.get("paths", ())),
                )
            completed = store.review_result(session_id, turn_id)
            if completed is not None:
                result = completed
            else:
                entry = store.finalization(session_id, turn_id)
                if entry is None:
                    raise VersionStoreConflict("finalization_not_found")
                if not entry.snapshot_available:
                    raise VersionStoreConflict("terminal_snapshot_unavailable")
                if not entry.retryable:
                    raise VersionStoreConflict("terminal_not_retryable")
                result = self._finish(project_id, session_id, turn_id, entry.terminal_outcome)
            stored = store.commit_operation(
                idempotency_key,
                OPERATION_KIND_FINALIZATION_RETRY,
                operation_target,
                request_digest,
                asdict(result),
            )
            if (
                tuple(stored["file_ids"]) != result.file_ids
                or tuple(stored["review_ids"]) != result.review_ids
                or stored.get("batch_id") != result.batch_id
                or stored.get("project_id") != result.project_id
                or tuple(stored.get("paths", ())) != result.paths
            ):
                raise VersionStoreConflict("idempotency_conflict")
            return result

    async def record_change(
        self,
        session_id: str,
        turn_id: str,
        absolute_path: str,
        change_kind: str,
        *,
        generation: str,
    ) -> None:
        """Persist a runtime FILE_CHANGED hint under the admitted turn fence."""

        binding = await asyncio.to_thread(self._runtime_binding, session_id, turn_id, generation)
        if binding is None:
            return
        project_id, turn_id = binding
        path = self._content.project_relative(project_id, absolute_path)
        await asyncio.to_thread(
            self._store(project_id).record_turn_hint,
            session_id,
            turn_id,
            path,
            change_kind,
        )

    async def record_tool_call(
        self,
        session_id: str,
        turn_id: str,
        tool_input: object,
        *,
        generation: str,
    ) -> None:
        """Persist filename matches from one write-capable ToolCall input."""

        binding = await asyncio.to_thread(self._runtime_binding, session_id, turn_id, generation)
        if binding is None:
            return
        project_id, client_turn_id = binding
        store = self._store(project_id)
        serialized = json.dumps(tool_input, ensure_ascii=False, default=str)
        await asyncio.to_thread(
            store.record_turn_tool_call,
            session_id,
            client_turn_id,
            serialized,
        )
        inventory = await asyncio.to_thread(store.turn_inventory, session_id, client_turn_id)
        if not inventory:
            return
        matched_paths = tuple(
            path for path in inventory if Path(path).name and Path(path).name in serialized
        )
        for path in matched_paths:
            await asyncio.to_thread(
                store.record_turn_hint,
                session_id,
                client_turn_id,
                path,
                TOOL_CALL_CHANGE_KIND,
            )

    async def bind_turn(
        self, session_id: str, client_turn_id: str, vendor_turn_id: str, generation: str
    ) -> None:
        project_id = self._project_for_turn(session_id, client_turn_id)
        if project_id is not None:
            await asyncio.to_thread(
                self._store(project_id).bind_runtime_turn,
                session_id,
                client_turn_id,
                vendor_turn_id,
                generation,
            )

    def _runtime_binding(
        self, session_id: str, vendor_turn_id: str, generation: str
    ) -> tuple[str, str] | None:
        # Admission already owns the project; unrelated registered roots must not
        # participate in a live tool's write fence. After restart, discover the
        # persisted binding only in roots that are currently available.
        project_ids = {
            project_id
            for (owner_session_id, _), project_id in self._projects.items()
            if owner_session_id == session_id
        }
        if not project_ids:
            project_ids = {project.id for project in self._content.projects() if project.available}
        for project_id in project_ids:
            client_turn_id = self._store(project_id).runtime_turn(
                session_id, vendor_turn_id, generation
            )
            if client_turn_id is not None:
                return project_id, client_turn_id
        return None

    def _begin(self, project_id: str, session_id: str, turn_id: str) -> ResourceTurnContext:
        with self._versions.writer(project_id):
            store = self._store(project_id)
            if store.turn_state(session_id, turn_id) is not None:
                return ResourceTurnContext(store.turn_model_context(session_id, turn_id))
            self._supervisor.scan_project(project_id)
            eligible_paths = self._supervisor.eligible_paths(project_id)
            self._versions.capture_turn_baselines(
                project_id,
                session_id,
                turn_id,
                eligible_paths,
                eligible_paths,
            )
            context = ResourceTurnContext(
                self._store(project_id).turn_model_context(session_id, turn_id)
            )
            if context.model_context:
                emit(
                    _log,
                    ResourceVersionEvent.CONTEXT_PREPARED,
                    project_id=project_id,
                    session_id=session_id,
                    turn_id=turn_id,
                    context_sha256=hashlib.sha256(
                        context.model_context.encode(UTF8_ENCODING)
                    ).hexdigest(),
                    context_chars=len(context.model_context),
                )
            return context

    def _finish(
        self,
        project_id: str,
        session_id: str,
        turn_id: str,
        outcome: TurnOutcome,
    ) -> ReviewCaptureResult:
        if outcome is TurnOutcome.UNKNOWN:
            return ReviewCaptureResult()
        with self._versions.writer(project_id):
            store = self._store(project_id)
            first_receipt = store.receive_terminal(session_id, turn_id, outcome)
            try:
                return self._finish_locked(project_id, session_id, turn_id, outcome, first_receipt)
            except Exception as exc:
                store.record_finalization_error(
                    session_id, turn_id, getattr(exc, "code", type(exc).__name__)
                )
                raise

    def _finish_locked(
        self,
        project_id: str,
        session_id: str,
        turn_id: str,
        outcome: TurnOutcome,
        first_receipt: bool,
    ) -> ReviewCaptureResult:
        store = self._store(project_id)
        existing = store.review_result(session_id, turn_id)
        if existing is not None:
            return existing

        if not first_receipt:
            staged = store.staged_delivery(session_id, turn_id)
            if staged is None:
                raise VersionStoreConflict("terminal_snapshot_unavailable")
            members = tuple(
                DeliverySnapshot(
                    member.baseline,
                    member.snapshot,
                    (
                        self._versions.verify_object(project_id, member.snapshot.object_id)
                        if member.snapshot.object_id is not None
                        else None
                    ),
                    (
                        self._versions.verify_object(
                            project_id, member.snapshot.annotation_object_id
                        )
                        if member.snapshot.annotation_object_id is not None
                        else None
                    ),
                    member.change_kind,
                    member.attribution,
                )
                for member in staged
            )
            return self._publish(project_id, session_id, turn_id, members)

        baselines = self._versions.turn_baselines(project_id, session_id, turn_id)
        hinted_paths = store.turn_hints(session_id, turn_id)
        tool_calls = store.turn_tool_calls(session_id, turn_id)
        baseline_by_path = {item.path: item for item in baselines}
        initial_paths = store.turn_inventory(session_id, turn_id)
        final_paths = self._supervisor.eligible_paths(
            project_id, include_missing=tuple(baseline_by_path)
        )
        final_snapshots: dict[str, tuple[StableContentCapture, str, ObjectDescriptor]] = {}
        removed: dict[str, TurnBaseline] = {}
        for path in final_paths:
            try:
                final_snapshots[path] = self._versions.capture_agent(project_id, path)
            except ContentError as exc:
                if exc.code == "file_not_found":
                    if path in baseline_by_path:
                        removed[path] = baseline_by_path[path]
                elif exc.code != "file_too_large":
                    raise
        additions = {
            path: snapshot
            for path, (snapshot, _object_id, _descriptor) in final_snapshots.items()
            if path not in baseline_by_path
        }
        moved: dict[str, TurnBaseline] = {}
        for path, snapshot in additions.items():
            candidates = [
                candidate
                for candidate in removed.values()
                if candidate.revision == snapshot.revision
            ]
            if len(candidates) == 1:
                matched = candidates[0]
                moved[path] = matched
                removed.pop(matched.path)

        saved_additions = store.capability_states(tuple(additions))

        prepared: list[DeliverySnapshot] = []
        delivery_id = _identity(DELIVERY_ID_PREFIX, session_id, turn_id)
        for path, (stable, object_id, descriptor) in final_snapshots.items():
            baseline = baseline_by_path.get(path)
            change_kind = "update"
            if baseline is None and (initial_paths is None or path in initial_paths):
                raise VersionStoreConflict("turn_baseline_unavailable")
            if baseline is None and path in moved:
                baseline = moved[path]
                change_kind = "move"
            elif baseline is None:
                saved = saved_additions.get(path)
                if (
                    saved is not None
                    and saved.snapshot_state is SnapshotState.SAVED
                    and saved.working_revision == stable.revision
                    and saved.head_state == FileState.PRESENT.value
                    and saved.head_mode_bits == stable.mode_bits
                ):
                    continue
                prepared_snapshot, descriptor, annotation_descriptor = self._versions.prepare_agent(
                    project_id,
                    path,
                    session_id,
                    turn_id,
                    delivery_id,
                    stable,
                    object_id,
                    descriptor,
                )
                identity = store.identity(path)
                baseline = TurnBaseline(
                    file_id=(
                        identity[0]
                        if identity is not None
                        else _identity(CREATED_FILE_ID_PREFIX, delivery_id, path)
                    ),
                    path=path,
                    revision=None,
                    object_id=None,
                    mode_bits=None,
                    version_id=None,
                    state=FileState.TOMBSTONE,
                )
                prepared.append(
                    DeliverySnapshot(
                        baseline,
                        prepared_snapshot,
                        descriptor,
                        annotation_descriptor,
                        "create",
                        self._attribution(hinted_paths, tool_calls, path),
                    )
                )
                continue
            assert baseline is not None
            if stable.revision == baseline.revision and stable.mode_bits == baseline.mode_bits:
                if change_kind != "move":
                    continue
            prepared_snapshot, descriptor, annotation_descriptor = self._versions.prepare_agent(
                project_id,
                path,
                session_id,
                turn_id,
                delivery_id,
                stable,
                object_id,
                descriptor,
                source_path=baseline.path if change_kind == "move" else None,
            )
            prepared.append(
                DeliverySnapshot(
                    baseline,
                    prepared_snapshot,
                    descriptor,
                    annotation_descriptor,
                    change_kind,
                    self._attribution(hinted_paths, tool_calls, baseline.path, path),
                )
            )

        for baseline in removed.values():
            tombstone = self._versions.prepare_agent_deleted(
                project_id, baseline, session_id, turn_id, delivery_id
            )
            prepared.append(
                DeliverySnapshot(
                    baseline,
                    tombstone,
                    None,
                    None,
                    "delete",
                    self._attribution(hinted_paths, tool_calls, baseline.path),
                )
            )
        members = tuple(
            sorted(prepared, key=lambda member: (member.baseline.file_id, member.snapshot.path))
        )
        store.stage_delivery(session_id, turn_id, _finalization_digest(members), members)
        return self._publish(project_id, session_id, turn_id, members)

    def _publish(
        self, project_id: str, session_id: str, turn_id: str, members: tuple[DeliverySnapshot, ...]
    ) -> ReviewCaptureResult:
        logical_id = _identity(DELIVERY_ID_PREFIX, session_id, turn_id) if members else None
        store = self._store(project_id)
        replay = store.review_result(session_id, turn_id)
        if replay is not None:
            return replay
        before = {
            member.baseline.file_id: store.pending(member.baseline.file_id) for member in members
        }
        paths = tuple(
            path
            for member in members
            for path in (member.baseline.path, member.snapshot.path)
            if path is not None
        )
        if any(
            root is not None for root in self._content.repository_roots(project_id, paths).values()
        ):
            raise ResourceVersionError(GIT_VERSION_DISABLED_ERROR)
        result = store.finalize_review(
            project_id,
            session_id,
            turn_id,
            logical_id,
            _finalization_digest(members),
            members,
        )
        for file_id in dict.fromkeys(member.baseline.file_id for member in members):
            head = store.head(file_id)
            if head is None:
                raise ResourceVersionError("resource_head_not_found")
            emit_pending(
                _log,
                project_id,
                before.get(file_id),
                store.pending(file_id),
                head[1],
            )
        emit(
            _log,
            ResourceVersionEvent.DELIVERY_FINALIZED,
            project_id=project_id,
            session_id=session_id,
            turn_id=turn_id,
            member_count=len(members),
            result_code="pending" if result.file_ids else "unchanged",
        )
        return result

    def _store(self, project_id: str) -> VersionStore:
        return VersionStore(
            self._content.resolve(project_id, PROJECT_DB_RELATIVE),
            self._content.project(project_id).root,
        )

    def _project_for_turn(self, session_id: str, turn_id: str) -> str | None:
        cached = self._projects.get((session_id, turn_id))
        if cached is not None:
            return cached
        for project in self._content.projects():
            if not project.available:
                continue
            if self._versions.turn_state(project.id, session_id, turn_id) is not None:
                self._projects[(session_id, turn_id)] = project.id
                return project.id
        return None

    @staticmethod
    def _attribution(
        hinted_paths: frozenset[str], tool_calls: tuple[str, ...], *candidate_paths: str
    ) -> ChangeAttribution:
        return (
            ChangeAttribution.AGENT
            if any(path in hinted_paths for path in candidate_paths)
            or any(
                Path(path).name and Path(path).name in tool_call
                for path in candidate_paths
                for tool_call in tool_calls
            )
            else ChangeAttribution.UNKNOWN
        )


__all__ = ["ResourceDeliveryService", "TurnOutcome"]
