"""Read accepted turn evidence for cross-domain crash reconciliation."""

from __future__ import annotations

from pathlib import Path

from scholarseed_runtime.contract.incident import RuntimeIncidentKind
from service.chat.constants import (
    PRODUCT_EVENT_RUNTIME_INCIDENT,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
    USER_MESSAGE_BINDING_ADMITTED,
    USER_MESSAGE_BINDING_BOUND,
)
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.platform.resources import ResourceTurn, TurnOutcome, TurnTerminalEvidence

TERMINAL_OUTCOMES = {
    PRODUCT_EVENT_TURN_COMPLETED: TurnOutcome.COMPLETED,
    PRODUCT_EVENT_TURN_FAILED: TurnOutcome.FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED: TurnOutcome.INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN: TurnOutcome.UNKNOWN,
}


class TurnTerminalReader:
    """Interpret product facts without reading vendor history or mutable disk state."""

    def __init__(self, catalog: SessionCatalogStore, events: ProductEventStore) -> None:
        self._catalog = catalog
        self._events = events

    def terminal_outcome(
        self, project_root: str, turn: ResourceTurn
    ) -> TurnTerminalEvidence | None:
        session = self._catalog.get(turn.session_id)
        if (
            session is None
            or not session.project_path
            or Path(session.project_path).resolve() != Path(project_root).resolve()
        ):
            return None
        # Old product terminals omit the numeric process generation. Verify the
        # runtime/thread envelope; never invent a generation from missing data.
        prefix, separator, generation = turn.runtime_generation.rpartition(":")
        if turn.vendor_turn_id is not None and (
            not separator
            or not generation.isdecimal()
            or prefix != f"{session.runtime_id}:{session.vendor_thread_id}"
        ):
            return None
        admitted = False
        evidence = None
        for event in self._events.turn_records(
            turn.session_id,
            turn.turn_id,
            turn.vendor_turn_id,
            kinds=(*TERMINAL_OUTCOMES, PRODUCT_EVENT_USER_MESSAGE, PRODUCT_EVENT_RUNTIME_INCIDENT),
        ):
            if (event.runtime_id, event.vendor_thread_id) != (
                session.runtime_id,
                session.vendor_thread_id,
            ):
                return None
            if event.kind == PRODUCT_EVENT_USER_MESSAGE:
                client = event.payload.get("client_turn_id")
                binding = event.payload.get("binding")
                if binding == USER_MESSAGE_BINDING_ADMITTED and client == turn.turn_id:
                    if event.vendor_turn_id != turn.turn_id:
                        return None
                    admitted = True
                elif (
                    binding == USER_MESSAGE_BINDING_BOUND
                    and client == turn.turn_id
                    and event.vendor_turn_id != turn.vendor_turn_id
                ):
                    return None
            if (
                event.kind == PRODUCT_EVENT_RUNTIME_INCIDENT
                and event.payload.get("kind") == RuntimeIncidentKind.TERMINAL_CONFLICT.value
            ):
                return None
            outcome = TERMINAL_OUTCOMES.get(event.kind)
            if outcome is None:
                continue
            if not admitted:
                return None
            if evidence is not None and evidence.outcome is not TurnOutcome.UNKNOWN:
                if outcome is not evidence.outcome:
                    return None
            evidence = TurnTerminalEvidence(outcome, event.product_seq)
        if not admitted or evidence is None or evidence.outcome is TurnOutcome.UNKNOWN:
            return None
        # Pre-runtime failures close admission; success requires an execution binding.
        if turn.vendor_turn_id is None and evidence.outcome is TurnOutcome.COMPLETED:
            return None
        return evidence
