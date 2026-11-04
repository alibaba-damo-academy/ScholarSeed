"""Product turn outcomes, admission uncertainty and incident delivery ledger."""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, replace
from typing import Any, Callable, Mapping

from scholarseed_runtime.contract import CommandState, DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.command import ThreadReplacementProof
from scholarseed_runtime.contract.history import TurnStatus
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.session import TurnConfirmationReceipt
from service.chat.constants import (
    AUTOMATIC_CRASH_RETRY,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_MESSAGE_REMOVED,
    PRODUCT_EVENT_RUNTIME_ERROR,
    PRODUCT_EVENT_RUNTIME_INCIDENT,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_RECONCILED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_SESSION_STATE_RUNNING,
    PRODUCT_TURN_OUTCOME_COMPLETED,
    PRODUCT_TURN_OUTCOME_CONFIRMED,
    PRODUCT_TURN_OUTCOME_FAILED,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
    RUNTIME_INCIDENT_IDEMPOTENCY_PREFIX,
    RUNTIME_INCIDENT_INVALID,
    RUNTIME_LEGACY_ERROR,
    TURN_CONTROLLED_INTERRUPT_RESOLUTION,
)
from service.chat.persistence.catalog import (
    UNCERTAINTY_RUNTIME_EVENT_KEY,
    UNCERTAINTY_THREAD_REPLACEMENT_KEY,
    QueuedMessageState,
    SessionCatalogStore,
    SessionStatus,
    SessionUncertaintyRecord,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.worker import PersistenceWorker
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.incidents import event_incident, incident_data
from service.chat.runtime.interaction import ProductPublisher, interaction_snapshot
from service.chat.runtime.projection import (
    INTERNAL_EVENT_KEY_PREFIX,
    PRODUCT_EVENT_KEY_PREFIX,
    TERMINAL_TURN_OUTCOMES,
)


class SessionLedger:
    def __init__(
        self,
        session_id: str,
        catalog: SessionCatalogStore,
        publish: ProductPublisher,
        trace: SessionTrace,
        logger: logging.Logger,
        lock: asyncio.Lock,
        persistence: PersistenceWorker,
    ) -> None:
        self.id = session_id
        self._catalog = catalog
        self.publish = publish
        self._trace = trace
        self._logger = logger
        self.lock = lock
        self._persistence = persistence
        self._turn_outcomes: dict[str, tuple[str, int]] = {}
        self._terminal_waiters: dict[str, set[asyncio.Future[str]]] = {}
        self._unknown_admission: dict[str, tuple[int, str]] = {}
        self._active_vendor_turn_id = ""
        self._active_turn_generation = 0
        self._runtime_incidents: dict[str, RuntimeIncident] = {}
        record = self._catalog.get(self.id)
        persisted_uncertainties = self._catalog.uncertainties(self.id)
        persisted_turn_correlations = {
            row.correlation_id
            for row in persisted_uncertainties
            if row.kind == UncertaintyKind.TURN
        }
        if (
            record is not None
            and record.last_turn_id
            and record.last_turn_status in TERMINAL_TURN_OUTCOMES
        ):
            self._turn_outcomes[record.last_turn_id] = (record.last_turn_status, 0)
            if (
                record.last_turn_status == PRODUCT_TURN_OUTCOME_UNKNOWN
                and record.last_turn_id not in persisted_turn_correlations
            ):
                self._unknown_admission[record.last_turn_id] = (0, "")
                self._catalog.claim_uncertainty(
                    self.id,
                    UncertaintyKind.TURN,
                    record.last_turn_id,
                    state=UncertaintyState.UNKNOWN,
                    payload={"outcome": PRODUCT_TURN_OUTCOME_UNKNOWN},
                )
        for uncertainty in persisted_uncertainties:
            if uncertainty.kind != UncertaintyKind.TURN:
                if uncertainty.state == UncertaintyState.EXECUTING:
                    self._catalog.transition_uncertainty(
                        self.id,
                        uncertainty.kind,
                        uncertainty.correlation_id,
                        UncertaintyState.UNKNOWN,
                        payload=uncertainty.payload,
                    )
                continue
            if uncertainty.state not in {UncertaintyState.EXECUTING, UncertaintyState.UNKNOWN}:
                continue
            self._turn_outcomes[uncertainty.correlation_id] = (
                PRODUCT_TURN_OUTCOME_UNKNOWN,
                uncertainty.process_generation,
            )
            self._unknown_admission[uncertainty.correlation_id] = (
                uncertainty.process_generation,
                uncertainty.incident_id or "",
            )

    @property
    def active_turn_id(self) -> str:
        return self._active_vendor_turn_id

    @property
    def has_unknown_outcome(self) -> bool:
        return bool(self._unknown_admission)

    async def activate_turn(self, turn_id: str) -> None:
        await self._persistence.run(
            self._catalog.update_status,
            self.id,
            SessionStatus.RUNNING,
            turn_id=turn_id,
            turn_status=PRODUCT_SESSION_STATE_RUNNING,
        )
        self._active_vendor_turn_id = turn_id
        self._active_turn_generation = 0

    async def wait_terminal(self, turn_id: str) -> str:
        """Wait until one exact vendor turn has completed all product terminal effects."""

        identity = turn_id.strip()
        if not identity:
            raise ValueError("terminal wait requires a turn identity")
        existing = self._turn_outcomes.get(identity)
        if existing is not None:
            return existing[0]
        waiter = asyncio.get_running_loop().create_future()
        waiting = self._terminal_waiters.setdefault(identity, set())
        waiting.add(waiter)
        try:
            return await waiter
        finally:
            current = self._terminal_waiters.get(identity)
            if current is not None:
                current.discard(waiter)
                if not current:
                    self._terminal_waiters.pop(identity, None)

    def _release_terminal_waiters(self, turn_id: str, outcome: str) -> None:
        for waiter in self._terminal_waiters.pop(turn_id, set()):
            if not waiter.done():
                waiter.set_result(outcome)

    async def started(self, event: RuntimeEvent) -> None:
        await self._publish_resolved_incidents(event, await self._release_resolved_unknown(event))
        await self.activate_turn(event.native_turn_id)
        self._active_turn_generation = self._process_generation(event)

    def uncertainty_snapshot(self) -> list[dict[str, Any]]:
        return [
            self._uncertainty_payload(row)
            for row in self._catalog.uncertainties(self.id, unresolved_only=True)
        ]

    @staticmethod
    def _uncertainty_payload(row: SessionUncertaintyRecord) -> dict[str, Any]:
        card = row.payload.get("card")
        return {
            "kind": row.kind.value,
            "uncertainty_kind": row.kind.value,
            "correlation_id": row.correlation_id,
            "incident_id": row.incident_id or "",
            "process_generation": row.process_generation,
            "state": row.state.value,
            "operation_state": row.state.value,
            "retryable": False,
            "execution_count": int(row.payload.get("execution_count", 0) or 0),
            "safe_error": str(row.payload.get("safe_error") or ""),
            "turn_id": str(row.payload.get("turn_id") or ""),
            "item_id": str(row.payload.get("item_id") or ""),
            "hil": dict(card) if isinstance(card, Mapping) else None,
            "resolved_at": row.resolved_at,
        }

    async def confirm_unknown_turn(
        self,
        turn_id: str,
        *,
        expected_uncertainty: tuple[int, str] | None = None,
        confirmation_receipt: TurnConfirmationReceipt | None = None,
        automatic_retry: bool = False,
    ) -> bool:
        """Authorize further work while preserving the original unknown outcome."""

        async with self.lock:
            current = self._unknown_admission.get(turn_id)
            if current is None or (
                expected_uncertainty is not None and current != expected_uncertainty
            ):
                return False
            _generation, incident_id = current
            confirmation = self._turn_confirmation_provenance(
                turn_id, current, confirmation_receipt
            )
            confirmed = await self._persistence.run(
                self._catalog.confirm_turn_uncertainty,
                self.id,
                turn_id,
                turn_status=PRODUCT_TURN_OUTCOME_CONFIRMED,
                resolution=AUTOMATIC_CRASH_RETRY if automatic_retry else "continue_without_replay",
                expected_uncertainty=expected_uncertainty,
                runtime_confirmation=confirmation,
            )
            if not confirmed:
                return False
            self._unknown_admission.pop(turn_id, None)
            await self._publish_turn_confirmation(
                turn_id, incident_id, automatic_retry=automatic_retry
            )
            return True

    async def republish_confirmed_turn(
        self,
        turn_id: str,
        *,
        expected_uncertainty: tuple[int, str] | None = None,
        confirmation_receipt: TurnConfirmationReceipt | None = None,
        automatic_retry: bool = False,
    ) -> bool:
        async with self.lock:
            current = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id)
            if current is None or current.state is not UncertaintyState.CONFIRMED:
                return False
            identity = (current.process_generation, current.incident_id or "")
            if expected_uncertainty is not None and expected_uncertainty != identity:
                return False
            if confirmation_receipt is not None:
                confirmation = self._turn_confirmation_provenance(
                    turn_id, identity, confirmation_receipt
                )
                if not await self._persistence.run(
                    self._catalog.confirm_turn_uncertainty,
                    self.id,
                    turn_id,
                    turn_status=PRODUCT_TURN_OUTCOME_CONFIRMED,
                    resolution=(
                        AUTOMATIC_CRASH_RETRY if automatic_retry else "continue_without_replay"
                    ),
                    expected_uncertainty=identity,
                    runtime_confirmation=confirmation,
                ):
                    return False
            await self._publish_turn_confirmation(
                turn_id, current.incident_id or "", automatic_retry=automatic_retry
            )
            return True

    async def confirm_thread_replacement(self, proof: ThreadReplacementProof) -> bool:
        async with self.lock:
            confirmed = await self._persistence.run(self._catalog.confirm_thread_replacement, proof)
            if not confirmed:
                return False
            for turn_id in tuple(self._unknown_admission):
                uncertainty = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id)
                provenance = (
                    uncertainty.payload.get(UNCERTAINTY_THREAD_REPLACEMENT_KEY)
                    if uncertainty is not None
                    else None
                )
                if (
                    uncertainty is not None
                    and uncertainty.state is UncertaintyState.CONFIRMED
                    and isinstance(provenance, Mapping)
                    and provenance.get("proof_id") == proof.proof_id
                ):
                    self._unknown_admission.pop(turn_id, None)
                    await self._publish_turn_confirmation(
                        turn_id, uncertainty.incident_id or "", automatic_retry=True
                    )
            return True

    def _turn_confirmation_provenance(
        self, turn_id: str, identity: tuple[int, str], receipt: TurnConfirmationReceipt | None
    ) -> dict[str, Any] | None:
        if receipt is None:
            return None
        target = receipt.ticket.target
        if (
            receipt.state is not CommandState.APPLIED
            or target.product_session_id != self.id
            or target.client_submission_id != turn_id
            or (target.process_generation, target.incident_id) != identity
        ):
            raise ValueError("runtime turn confirmation identity mismatch")
        return asdict(receipt.ticket)

    async def _publish_turn_confirmation(
        self, turn_id: str, incident_id: str, *, automatic_retry: bool = False
    ) -> None:
        await self.publish(
            PRODUCT_EVENT_TURN_RECONCILED,
            {
                "turn_id": turn_id,
                "incident_id": incident_id,
                "resolution": (
                    AUTOMATIC_CRASH_RETRY if automatic_retry else "user_confirmed_continue"
                ),
                "outcome": PRODUCT_TURN_OUTCOME_UNKNOWN,
            },
            turn_id=turn_id,
            idempotency_key=f"{INTERNAL_EVENT_KEY_PREFIX}:turn-confirmed:{turn_id}",
        )

    async def reconcile_controlled_interrupt(self, turn_id: str) -> bool:
        """Resolve uncertainty when ScholarSeed initiated and completed the interrupt."""

        async with self.lock:
            current = self._unknown_admission.get(turn_id)
            if current is None:
                return False
            _generation, incident_id = current
            reconciled = await self._persistence.run(
                self._catalog.reconcile_interrupted_turn_uncertainty,
                self.id,
                turn_id,
                resolution=TURN_CONTROLLED_INTERRUPT_RESOLUTION,
            )
            if not reconciled:
                return False
            self._unknown_admission.pop(turn_id, None)
            await self.publish(
                PRODUCT_EVENT_TURN_RECONCILED,
                {
                    "turn_id": turn_id,
                    "incident_id": incident_id,
                    "resolution": TURN_CONTROLLED_INTERRUPT_RESOLUTION,
                    "outcome": PRODUCT_TURN_OUTCOME_INTERRUPTED,
                },
                turn_id=turn_id,
                idempotency_key=(f"{INTERNAL_EVENT_KEY_PREFIX}:controlled-interrupt:{turn_id}"),
            )
            return True

    def _terminal_key(self, event: RuntimeEvent, suffix: str = "") -> str:
        turn_id = self._terminal_turn_id(event)
        base = f"{PRODUCT_EVENT_KEY_PREFIX}:terminal:{self.id}:" f"{turn_id}:{event.kind.value}"
        return f"{base}:{suffix}" if suffix else base

    def _terminal_turn_id(self, event: RuntimeEvent) -> str:
        incident = event_incident(event)
        incident_turn_id = incident.vendor_turn_id if incident is not None else ""
        return event.native_turn_id.strip() or incident_turn_id.strip() or event.correlation_id

    @staticmethod
    def _process_generation(event: RuntimeEvent) -> int:
        return event.process_generation

    @staticmethod
    def _terminal_safe_error(event: RuntimeEvent) -> str:
        payload = event.payload if isinstance(event.payload, Mapping) else {}
        incident = event_incident(event)
        return str(
            payload.get("safe_error")
            or (incident.safe_error if incident is not None else "")
            or payload.get("error")
            or ""
        )

    async def _accept_terminal(self, event: RuntimeEvent, outcome: str) -> bool:
        payload = event.payload if isinstance(event.payload, Mapping) else {}
        turn_id = self._terminal_turn_id(event)
        if not turn_id:
            return True
        generation = self._process_generation(event)
        if outcome == PRODUCT_TURN_OUTCOME_UNKNOWN:
            uncertainty = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id)
            latest = self._catalog.get(self.id)
            if (
                uncertainty is not None
                and uncertainty.state in {UncertaintyState.CONFIRMED, UncertaintyState.RECONCILED}
                and latest is not None
                and latest.last_turn_id != turn_id
            ):
                return False
        existing = self._turn_outcomes.get(turn_id)
        if existing is None:
            return True
        existing_outcome, existing_generation = existing
        if existing_outcome == outcome:
            return False
        if (
            existing_outcome == PRODUCT_TURN_OUTCOME_UNKNOWN
            and outcome
            in {
                PRODUCT_TURN_OUTCOME_COMPLETED,
                PRODUCT_TURN_OUTCOME_FAILED,
                PRODUCT_TURN_OUTCOME_INTERRUPTED,
            }
            and (
                (
                    generation == existing_generation
                    and (generation > 0 or payload.get("reconciled_from_history") is True)
                )
                or (
                    bool(payload.get("resolved_ambiguous_incident_id"))
                    and str(payload.get("resolved_ambiguous_incident_id"))
                    == self._unknown_admission.get(turn_id, (0, ""))[1]
                )
            )
        ):
            return True
        self._logger.error(
            "codex_terminal_outcome_conflict",
            extra={
                "session_id": self.id,
                "turn_id": turn_id,
                "existing_outcome": existing_outcome,
                "incoming_outcome": outcome,
                "existing_generation": existing_generation,
                "incoming_generation": generation,
            },
        )
        incident = RuntimeIncident(
            incident_id=uuid.uuid5(
                uuid.NAMESPACE_URL,
                (
                    f"scholarseed:{self.id}:{turn_id}:{existing_outcome}:"
                    f"{outcome}:{existing_generation}:{generation}"
                ),
            ).hex,
            scope=RuntimeIncidentScope.PROTOCOL,
            state=RuntimeIncidentState.FAILED,
            kind=RuntimeIncidentKind.TERMINAL_CONFLICT,
            strategy=RuntimeRecoveryStrategy.NONE,
            retryability=RuntimeRetryability.TERMINAL,
            safe_error="codex_terminal_outcome_conflict",
            process_generation=generation,
            vendor_thread_id=event.native_session_id,
            vendor_turn_id=turn_id,
        )
        incident_event = replace(
            event,
            kind=RuntimeEventKind.RUNTIME_INCIDENT,
            payload={
                "incident": incident_data(incident),
                "existing_outcome": existing_outcome,
                "incoming_outcome": outcome,
                "existing_generation": existing_generation,
                "incoming_generation": generation,
            },
        )
        self._trace.runtime_event(incident_event)
        await self.incident(incident_event, incident)
        return False

    async def _remember_terminal(self, event: RuntimeEvent, outcome: str) -> None:
        turn_id = self._terminal_turn_id(event)
        if not turn_id:
            return
        generation = self._process_generation(event)
        if outcome == PRODUCT_TURN_OUTCOME_UNKNOWN:
            uncertainty = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id)
            if uncertainty is not None and uncertainty.state is UncertaintyState.CONFIRMED:
                self._turn_outcomes[turn_id] = (outcome, generation)
                self._unknown_admission.pop(turn_id, None)
                self._active_vendor_turn_id = ""
                self._release_terminal_waiters(turn_id, outcome)
                return
            recorded = await self._persistence.run(
                self._catalog.record_unknown_turn,
                self.id,
                turn_id,
                event,
                safe_error=self._terminal_safe_error(event),
            )
            if recorded.state in {UncertaintyState.EXECUTING, UncertaintyState.UNKNOWN}:
                self._unknown_admission[turn_id] = (
                    recorded.process_generation,
                    recorded.incident_id or "",
                )
            else:
                self._unknown_admission.pop(turn_id, None)
        else:
            self._unknown_admission.pop(turn_id, None)
            self._active_vendor_turn_id = ""
        self._turn_outcomes[turn_id] = (outcome, generation)
        self._release_terminal_waiters(turn_id, outcome)

    async def refine_unknown(self, event: RuntimeEvent) -> None:
        turn_id = self._terminal_turn_id(event)
        current = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id)
        previous = self._unknown_admission.get(turn_id)
        if (
            event.kind is not RuntimeEventKind.TURN_UNKNOWN
            or current is None
            or current.state is not UncertaintyState.UNKNOWN
            or not isinstance(current.payload.get(UNCERTAINTY_RUNTIME_EVENT_KEY), Mapping)
            or previous != (current.process_generation, current.incident_id or "")
        ):
            return
        recorded = await self._persistence.run(
            self._catalog.record_unknown_turn,
            self.id,
            turn_id,
            replace(event, native_turn_id=turn_id),
            safe_error=self._terminal_safe_error(event),
        )
        if (
            recorded.state is UncertaintyState.UNKNOWN
            and self._unknown_admission.get(turn_id) == previous
        ):
            self._unknown_admission[turn_id] = (
                recorded.process_generation,
                recorded.incident_id or "",
            )

    async def _release_resolved_unknown(self, event: RuntimeEvent) -> tuple[str, ...]:
        payload = event.payload if isinstance(event.payload, Mapping) else {}
        resolved_incident_id = str(payload.get("resolved_ambiguous_incident_id") or "")
        if not resolved_incident_id and event.kind in {
            RuntimeEventKind.TURN_COMPLETED,
            RuntimeEventKind.TURN_FAILED,
            RuntimeEventKind.TURN_INTERRUPTED,
        }:
            generation, incident_id = self._unknown_admission.get(
                self._terminal_turn_id(event), (0, "")
            )
            if generation == event.process_generation and (
                generation > 0 or payload.get("reconciled_from_history") is True
            ):
                if not incident_id:
                    turn_id = self._terminal_turn_id(event)
                    await self._persistence.run(
                        self._catalog.transition_uncertainty,
                        self.id,
                        UncertaintyKind.TURN,
                        turn_id,
                        UncertaintyState.RECONCILED,
                        payload={"resolved_event_id": event.event_id},
                    )
                    await self.publish(
                        PRODUCT_EVENT_TURN_RECONCILED,
                        {"turn_id": turn_id, "resolution": event.kind.value},
                        turn_id=turn_id,
                        idempotency_key=self._terminal_key(event, "reconciled"),
                    )
                    self._unknown_admission.pop(turn_id, None)
                    return ()
                resolved_incident_id = incident_id
        if not resolved_incident_id:
            return ()
        resolved = tuple(
            turn_id
            for turn_id, (_generation, incident_id) in self._unknown_admission.items()
            if incident_id == resolved_incident_id
        )
        for turn_id in resolved:
            await self._persistence.run(
                self._catalog.transition_uncertainty,
                self.id,
                UncertaintyKind.TURN,
                turn_id,
                UncertaintyState.RECONCILED,
                payload={"resolved_incident_id": resolved_incident_id},
            )
            self._unknown_admission.pop(turn_id, None)
        return tuple(
            incident_id for incident_id in (resolved_incident_id,) if incident_id and resolved
        )

    async def _publish_resolved_incidents(
        self, event: RuntimeEvent, incident_ids: tuple[str, ...]
    ) -> None:
        for incident_id in incident_ids:
            previous = self._runtime_incidents.get(incident_id)
            if (
                previous is None
                or previous.scope is RuntimeIncidentScope.PROCESS
                or previous.state is RuntimeIncidentState.RECOVERED
            ):
                continue
            recovered = replace(
                previous,
                state=RuntimeIncidentState.RECOVERED,
                safe_error="",
                retryability=RuntimeRetryability.TERMINAL,
            )
            observation = replace(
                event,
                kind=RuntimeEventKind.RUNTIME_INCIDENT,
                payload={"incident": incident_data(recovered)},
            )
            self._trace.runtime_event(observation)
            await self.incident(observation, recovered)

    async def broadcast_expired_hil(self, *, reason: str) -> None:
        """Expire pending HIL and emit `hil_resolved(state=stale)` per record so
        the front-end permission overlay dismisses along with the terminal turn
        event. Turn-level `settlePendingHil` alone is insufficient: a released
        bridge plan (or any HIL whose vendor_turn_id disagrees with the
        interrupted turn_id) never matches the front-end's per-turn filter.

        公开入口: 事件泵之外的异常终态路径 (如 `turns._fail_queued` 的
        unknown 分支) 也走这里, 与 `terminal()` 保持同一不变量: 会话终态
        推进时, 所有 pending HIL 必须过期广播, 否则卡残留且点击报
        `hil_request_stale`."""
        try:
            expired = await self._persistence.run(self._catalog.expire_pending_hil, self.id)
        except TypeError:
            # 兼容 legacy 存根 (仅 tests): 老 mock 返回 None, 无事件可广播。
            return
        if not expired:
            return
        for record in expired:
            snapshot = interaction_snapshot(record)
            snapshot["state"] = "stale"
            try:
                await self.publish(
                    PRODUCT_EVENT_HIL_RESOLVED,
                    snapshot,
                    turn_id=record.vendor_turn_id or "",
                    item_id=record.vendor_item_id or "",
                    idempotency_key=f"{reason}:hil:{record.product_request_id}:stale",
                )
            except Exception:  # noqa: BLE001 - 广播失败不得阻断终态推进
                self._logger.warning(
                    "hil_resolved_broadcast_failed session_id=%s request_id=%s reason=%s",
                    self.id,
                    record.product_request_id,
                    reason,
                )

    async def record_unknown_submission(self, turn_id: str, *, safe_error: str) -> bool:
        """Persist a product submission uncertainty without inventing a native event."""

        if not turn_id.strip():
            raise ValueError("submission uncertainty requires a turn identity")
        async with self.lock:
            existing = self._turn_outcomes.get(turn_id)
            if existing is not None and existing[0] != PRODUCT_TURN_OUTCOME_UNKNOWN:
                return False
            previous = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id)
            if previous is not None and previous.state not in {
                UncertaintyState.EXECUTING,
                UncertaintyState.UNKNOWN,
            }:
                return False
            if turn_id in self._unknown_admission:
                return False
            await self._persistence.run(
                self._catalog.claim_uncertainty,
                self.id,
                UncertaintyKind.TURN,
                turn_id,
                state=UncertaintyState.UNKNOWN,
                process_generation=(
                    self._active_turn_generation if self._active_vendor_turn_id == turn_id else 0
                ),
                payload={"outcome": PRODUCT_TURN_OUTCOME_UNKNOWN, "safe_error": safe_error},
            )
            if previous is not None and previous.state is UncertaintyState.EXECUTING:
                await self._persistence.run(
                    self._catalog.transition_uncertainty,
                    self.id,
                    UncertaintyKind.TURN,
                    turn_id,
                    UncertaintyState.UNKNOWN,
                )
            current = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id)
            if current is None or current.state is not UncertaintyState.UNKNOWN:
                return False
            await self._persistence.run(
                self._catalog.update_status,
                self.id,
                SessionStatus.ERROR,
                turn_id=turn_id,
                turn_status=PRODUCT_TURN_OUTCOME_UNKNOWN,
            )
            if self._active_vendor_turn_id == turn_id:
                self._active_vendor_turn_id = ""
            await self.broadcast_expired_hil(reason=PRODUCT_TURN_OUTCOME_UNKNOWN)
            await self.publish(
                PRODUCT_EVENT_TURN_UNKNOWN,
                {"status": PRODUCT_TURN_OUTCOME_UNKNOWN, "message": safe_error},
                turn_id=turn_id,
                idempotency_key=f"{INTERNAL_EVENT_KEY_PREFIX}:submission-unknown:{turn_id}",
            )
            self._turn_outcomes[turn_id] = (
                PRODUCT_TURN_OUTCOME_UNKNOWN,
                current.process_generation,
            )
            self._unknown_admission[turn_id] = (
                current.process_generation,
                current.incident_id or "",
            )
            self._release_terminal_waiters(turn_id, PRODUCT_TURN_OUTCOME_UNKNOWN)
            return True

    async def record_turn_failure(self, turn_id: str, *, code: str, message: str) -> bool:
        """Persist a Service-side adapter failure unless a Surface terminal already won."""

        async with self.lock:
            if turn_id.strip() and turn_id in self._turn_outcomes:
                return False
            if self._active_vendor_turn_id == turn_id:
                self._active_vendor_turn_id = ""
            await self.publish(
                PRODUCT_EVENT_TURN_FAILED,
                {"code": code, "message": message},
                turn_id=turn_id,
                idempotency_key=(
                    f"{INTERNAL_EVENT_KEY_PREFIX}:terminal:{self.id}:"
                    f"{turn_id}:{PRODUCT_EVENT_TURN_FAILED}"
                ),
            )
            await self._persistence.run(
                self._catalog.update_status,
                self.id,
                SessionStatus.ERROR,
                turn_id=turn_id,
                turn_status=PRODUCT_TURN_OUTCOME_FAILED,
            )
            if turn_id.strip():
                self._turn_outcomes[turn_id] = (PRODUCT_TURN_OUTCOME_FAILED, 0)
                self._release_terminal_waiters(turn_id, PRODUCT_TURN_OUTCOME_FAILED)
            return True

    @staticmethod
    def _incident_payload(
        incident: RuntimeIncident,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "incident_id": incident.incident_id,
            "scope": incident.scope.value,
            "state": incident.state.value,
            "kind": incident.kind.value,
            "strategy": incident.strategy.value,
            "retryability": incident.retryability.value,
            "safe_error": incident.safe_error,
            "process_generation": incident.process_generation,
            "attempt": incident.attempt,
            "max_attempts": incident.max_attempts,
            "rpc_latency_ms": incident.rpc_latency_ms,
            "ambiguous_commit": incident.ambiguous_commit,
        }
        if incident.process_exit_code is not None:
            payload["process_exit_code"] = incident.process_exit_code
        if incident.rpc_method:
            payload["rpc_method"] = incident.rpc_method
        if incident.rpc_code is not None:
            payload["rpc_code"] = incident.rpc_code
        # 供应商归因（含 bridge 恢复回填的真实上游码）随产品事件投影，与 Trace incident
        # span 保持一致；空值不投影，避免把「无归因」写成显式空字段。
        if incident.provider_error_code:
            payload["provider_error_code"] = incident.provider_error_code
        if incident.provider_http_status is not None:
            payload["provider_http_status"] = incident.provider_http_status
        return payload

    async def incident(
        self,
        event: RuntimeEvent,
        incident: RuntimeIncident,
    ) -> None:
        if not incident.incident_id.strip():
            await self.publish(
                PRODUCT_EVENT_RUNTIME_ERROR,
                {"code": RUNTIME_INCIDENT_INVALID, "message": RUNTIME_INCIDENT_INVALID},
                idempotency_key=f"runtime:{event.event_id}:invalid-incident",
            )
            return
        if incident.vendor_thread_id and incident.vendor_thread_id != event.native_session_id:
            self._logger.error(
                "codex_incident_binding_mismatch",
                extra={
                    "session_id": self.id,
                    "incident_id": incident.incident_id,
                },
            )
            return
        self._runtime_incidents[incident.incident_id] = incident
        incident_payload = self._incident_payload(incident)
        if incident.kind == RuntimeIncidentKind.TERMINAL_CONFLICT:
            payload = event.payload if isinstance(event.payload, Mapping) else {}
            incident_payload.update(
                {
                    name: payload.get(name)
                    for name in (
                        "existing_outcome",
                        "incoming_outcome",
                        "existing_generation",
                        "incoming_generation",
                    )
                }
            )
        await self.publish(
            PRODUCT_EVENT_RUNTIME_INCIDENT,
            incident_payload,
            turn_id=(
                incident.vendor_turn_id
                if incident.scope is RuntimeIncidentScope.PROCESS
                else (
                    event.native_turn_id
                    or incident.vendor_turn_id
                    or (event.correlation_id if event.kind == RuntimeEventKind.TURN_UNKNOWN else "")
                )
            ),
            item_id=(
                "" if incident.scope is RuntimeIncidentScope.PROCESS else event.native_item_id
            ),
            idempotency_key=(
                f"{RUNTIME_INCIDENT_IDEMPOTENCY_PREFIX}:{incident.incident_id}:"
                f"{incident.state.value}:{incident.attempt}"
            ),
        )

    async def terminal(
        self,
        event: RuntimeEvent,
        *,
        fallback_submission_id: str,
        finish_messages: Callable[[str], None],
    ) -> bool:
        incident = event_incident(event)
        event = replace(
            event,
            native_turn_id=event.native_turn_id.strip()
            or (incident.vendor_turn_id.strip() if incident else "")
            or fallback_submission_id,
        )
        payload = dict(event.payload) if isinstance(event.payload, Mapping) else {}
        item_id = event.native_item_id
        terminal = {
            RuntimeEventKind.TURN_COMPLETED: (
                SessionStatus.COMPLETED,
                PRODUCT_EVENT_TURN_COMPLETED,
                PRODUCT_TURN_OUTCOME_COMPLETED,
            ),
            RuntimeEventKind.TURN_FAILED: (
                SessionStatus.ERROR,
                PRODUCT_EVENT_TURN_FAILED,
                PRODUCT_TURN_OUTCOME_FAILED,
            ),
            RuntimeEventKind.TURN_INTERRUPTED: (
                SessionStatus.INTERRUPTED,
                PRODUCT_EVENT_TURN_INTERRUPTED,
                PRODUCT_TURN_OUTCOME_INTERRUPTED,
            ),
            RuntimeEventKind.TURN_UNKNOWN: (
                SessionStatus.ERROR,
                PRODUCT_EVENT_TURN_UNKNOWN,
                PRODUCT_TURN_OUTCOME_UNKNOWN,
            ),
        }.get(event.kind)
        if terminal is not None:
            status, product_kind, outcome = terminal
            retry_attempts = payload.get("automatic_retry_attempts")
            if not await self._accept_terminal(event, outcome):
                if (
                    self._active_vendor_turn_id == self._terminal_turn_id(event)
                    and self._turn_outcomes.get(self._terminal_turn_id(event), ("", 0))[0]
                    == outcome
                ):
                    self._active_vendor_turn_id = ""
                return True
            key = self._terminal_key(event)
            turn_id = self._terminal_turn_id(event)
            confirmed_unknown = outcome == PRODUCT_TURN_OUTCOME_UNKNOWN and bool(
                (uncertainty := self._catalog.uncertainty(self.id, UncertaintyKind.TURN, turn_id))
                and uncertainty.state is UncertaintyState.CONFIRMED
            )
            if outcome != PRODUCT_TURN_OUTCOME_UNKNOWN:
                finish_messages(turn_id)
            resolved = await self._release_resolved_unknown(event)
            await self._publish_resolved_incidents(event, resolved)
            if outcome in {PRODUCT_TURN_OUTCOME_INTERRUPTED, PRODUCT_TURN_OUTCOME_UNKNOWN}:
                await self.broadcast_expired_hil(reason=outcome)
            await self.publish(
                product_kind,
                {
                    "status": str(payload.get("status") or outcome),
                    "message": self._terminal_safe_error(event),
                    "resolved_incident_ids": list(resolved),
                    **(
                        {"reason": RuntimeIncidentKind.PROCESS_EXIT.value}
                        if outcome == PRODUCT_TURN_OUTCOME_INTERRUPTED
                        and (
                            incident is not None
                            and incident.scope is RuntimeIncidentScope.PROCESS
                            and incident.kind is RuntimeIncidentKind.PROCESS_EXIT
                            or payload.get("reconciled_from_history") is True
                            and payload.get("reason") == RuntimeIncidentKind.PROCESS_EXIT.value
                        )
                        else {}
                    ),
                    **({"confirmed": True} if confirmed_unknown else {}),
                    **(
                        {
                            "code": str(payload.get("error_code") or RUNTIME_LEGACY_ERROR),
                            "retryable": (
                                str(payload.get("retryability") or "")
                                in {"", RuntimeRetryability.USER_RETRYABLE.value}
                            ),
                        }
                        if outcome == PRODUCT_TURN_OUTCOME_FAILED
                        else {}
                    ),
                    **(
                        {"automatic_retry_attempts": retry_attempts}
                        if outcome == PRODUCT_TURN_OUTCOME_FAILED
                        and isinstance(retry_attempts, int)
                        and not isinstance(retry_attempts, bool)
                        and retry_attempts > 1
                        else {}
                    ),
                },
                turn_id=turn_id or event.correlation_id,
                item_id=item_id,
                idempotency_key=key,
            )
            await self._persistence.run(
                self._catalog.update_status,
                self.id,
                status,
                turn_id=turn_id or event.correlation_id,
                turn_status=(PRODUCT_TURN_OUTCOME_CONFIRMED if confirmed_unknown else outcome),
            )
            await self._remember_terminal(event, outcome)
            self._active_vendor_turn_id = ""
            return True
        return False

    async def reconcile(
        self,
        snapshot: object,
        *,
        runtime_id: str,
        native_session_id: str,
        finish_messages: Callable[[str], None],
    ) -> None:
        """Resolve one typed, unambiguous persisted identity from exact resume."""

        if not isinstance(snapshot, Mapping):
            raise ValueError("runtime snapshot must be an object")
        active_turn_id = str(snapshot.get("active_turn_id") or "")
        if active_turn_id:
            self._active_vendor_turn_id = active_turn_id
            await self._persistence.run(
                self._catalog.update_status,
                self.id,
                SessionStatus.RUNNING,
                turn_id=active_turn_id,
                turn_status=PRODUCT_SESSION_STATE_RUNNING,
            )
        snapshots = snapshot.get("resume_turns", [])
        if not isinstance(snapshots, list):
            raise ValueError("runtime resume turns must be an array")
        if any(not isinstance(row, Mapping) for row in snapshots):
            raise ValueError("runtime resume turn must be an object")
        for correlation_id, (outcome, _generation) in tuple(self._turn_outcomes.items()):
            if outcome != PRODUCT_TURN_OUTCOME_UNKNOWN:
                continue
            uncertainty = self._catalog.uncertainty(self.id, UncertaintyKind.TURN, correlation_id)
            if uncertainty is None or uncertainty.state is UncertaintyState.CONFIRMED:
                continue
            incident_id = self._unknown_admission.get(correlation_id, (0, ""))[1]
            evidence = uncertainty.payload.get(UNCERTAINTY_RUNTIME_EVENT_KEY)
            expected_native = ""
            expected_client = ""
            queues = [
                row
                for row in self._catalog.queued_messages(self.id)
                if row.native_turn_id == correlation_id or row.queued_message_id == correlation_id
            ]
            if len(queues) > 1:
                continue
            if queues:
                expected_native = queues[0].native_turn_id or ""
                expected_client = queues[0].queued_message_id
            if isinstance(evidence, Mapping):
                if (
                    evidence.get("product_session_id") != self.id
                    or evidence.get("native_session_id") != native_session_id
                    or evidence.get("native_turn_id") != correlation_id
                ):
                    continue
                values = evidence.get("payload")
                client_id = (
                    values.get("client_user_message_id") if isinstance(values, Mapping) else None
                )
                if client_id is not None:
                    if (
                        not isinstance(client_id, str)
                        or not client_id
                        or expected_client
                        and client_id != expected_client
                    ):
                        continue
                    expected_client = client_id
                if expected_client != correlation_id:
                    if expected_native and expected_native != correlation_id:
                        continue
                    expected_native = correlation_id
                elif not queues:
                    continue
            elif (
                evidence is None
                and uncertainty.state is UncertaintyState.RECONCILED
                and uncertainty.payload.get("vendor_turn_id") == correlation_id
            ):
                expected_native = correlation_id
            elif evidence is not None or not queues:
                continue
            matches = [
                row
                for row in snapshots
                if row.get("client_id") == correlation_id or row.get("turn_id") == correlation_id
            ]
            if len(matches) != 1:
                continue
            resumed_turn = matches[0]
            native_turn_id = str(resumed_turn.get("turn_id") or "")
            if (
                not native_turn_id
                or expected_native
                and native_turn_id != expected_native
                or expected_client
                and resumed_turn.get("client_id") != expected_client
            ):
                continue
            if resumed_turn.get("terminal_status") is None:
                self._active_vendor_turn_id = native_turn_id
                await self._persistence.run(
                    self._catalog.update_status,
                    self.id,
                    SessionStatus.RUNNING,
                    turn_id=native_turn_id,
                    turn_status=PRODUCT_SESSION_STATE_RUNNING,
                )
                await self.publish(
                    PRODUCT_EVENT_SESSION_STATE,
                    {
                        "state": PRODUCT_SESSION_STATE_RUNNING,
                        "runtime_id": runtime_id,
                        "active_turn_id": native_turn_id,
                        "reconciled": True,
                    },
                    turn_id=native_turn_id,
                    idempotency_key=f"{INTERNAL_EVENT_KEY_PREFIX}:resume-active:{correlation_id}",
                )
                continue
            kind_by_status = {
                TurnStatus.COMPLETED.value: RuntimeEventKind.TURN_COMPLETED,
                TurnStatus.FAILED.value: RuntimeEventKind.TURN_FAILED,
                TurnStatus.INTERRUPTED.value: RuntimeEventKind.TURN_INTERRUPTED,
            }
            terminal_status = resumed_turn.get("terminal_status")
            if not isinstance(terminal_status, str):
                raise ValueError("runtime resume terminal status must be a string")
            kind = kind_by_status.get(terminal_status)
            if kind is None:
                continue
            original_payload = evidence.get("payload") if isinstance(evidence, Mapping) else None
            original_incident = (
                original_payload.get("incident") if isinstance(original_payload, Mapping) else None
            )
            reason = (
                RuntimeIncidentKind.PROCESS_EXIT.value
                if isinstance(original_incident, Mapping)
                and original_incident.get("scope") == RuntimeIncidentScope.PROCESS.value
                and original_incident.get("kind") == RuntimeIncidentKind.PROCESS_EXIT.value
                else ""
            )
            event = RuntimeEvent(
                schema_version=1,
                event_id=f"resume:{self.id}:{native_turn_id}:{kind.value}",
                runtime_id=runtime_id,
                product_session_id=self.id,
                native_session_id=native_session_id,
                process_generation=_generation,
                sequence=0,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="",
                kind=kind,
                native_turn_id=native_turn_id,
                payload={
                    "process_generation": _generation,
                    "resolved_ambiguous_incident_id": incident_id,
                    "reconciled_from_history": True,
                    "reason": reason,
                },
            )
            self._trace.runtime_event(event)
            await self.terminal(
                event,
                fallback_submission_id=correlation_id,
                finish_messages=finish_messages,
            )
            if self._turn_outcomes.get(native_turn_id, ("", 0))[0] != terminal_status:
                continue
            await self._persistence.run(
                self._catalog.transition_uncertainty,
                self.id,
                UncertaintyKind.TURN,
                correlation_id,
                UncertaintyState.RECONCILED,
                payload={"vendor_turn_id": native_turn_id},
            )
        for queued in self._catalog.queued_messages(self.id):
            if queued.state is not QueuedMessageState.OUTCOME_UNKNOWN:
                continue
            matches = [
                row
                for row in snapshots
                if row.get("client_id") == queued.queued_message_id
                and row.get("turn_id")
                and (not queued.native_turn_id or row.get("turn_id") == queued.native_turn_id)
            ]
            if len(matches) != 1 or matches[0].get("terminal_status") not in {
                TurnStatus.COMPLETED.value,
                TurnStatus.FAILED.value,
                TurnStatus.INTERRUPTED.value,
            }:
                continue
            native_turn_id = str(matches[0]["turn_id"])
            uncertainty = self._catalog.uncertainty(
                self.id, UncertaintyKind.TURN, queued.native_turn_id or queued.queued_message_id
            )
            if uncertainty is None or uncertainty.state is not UncertaintyState.RECONCILED:
                continue
            if await self._persistence.run(
                self._catalog.remove_reconciled_unknown_message,
                self.id,
                queued.queued_message_id,
                int(queued.operation_seq or 0),
            ):
                await self.publish(
                    PRODUCT_EVENT_MESSAGE_REMOVED,
                    {
                        "queued_message_id": queued.queued_message_id,
                        "reason": QueuedMessageState.COMPLETED.value,
                    },
                    turn_id=native_turn_id,
                    idempotency_key=f"queue:{queued.queued_message_id}:native-reconciled:{queued.operation_seq}",
                )
