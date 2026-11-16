"""Deterministic message prediction lifecycle contracts; not model acceptance."""

import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from scholarseed_runtime.contract import (
    AppliedState,
    CapabilitySet,
    CapabilityState,
    CommandState,
    RuntimeCapability,
    RuntimeCapabilityName,
    RuntimeControlKind,
)
from service.chat.persistence.catalog import SessionPrincipal
from service.chat.runtime.live import LiveSession
from service.chat.service.sessions import PREDICTION_SOURCE_UNAVAILABLE, SessionService
from service.inference.source import ContentSource


def fixture():
    record = SimpleNamespace(archived=False, last_turn_id="turn", last_turn_status="completed")
    control = AsyncMock(
        return_value=AppliedState(
            "sample",
            "sample",
            CommandState.APPLIED,
            values={"source_turn_id": "turn", "text": " Compare the methods. ", "input_tokens": 12},
        )
    )
    session = SimpleNamespace(
        control=control,
        capabilities=CapabilitySet(
            (RuntimeCapability(RuntimeCapabilityName.TEXT_SAMPLE.value, CapabilityState.SUPPORTED),)
        ),
    )
    live = SimpleNamespace(
        running=False,
        turn_active=False,
        current_task=None,
        active_product_turn_id="",
        terminating=False,
        terminated=False,
        runtime_session=session,
        prediction_task=None,
        prediction_turn_id="",
        prediction_result=None,
    )
    service = object.__new__(SessionService)
    service.require_access = Mock()
    service._sessions = {"session": live}
    service._access = SimpleNamespace(get=lambda _id: record)
    service._logger = logging.getLogger(__name__)
    return service, live, record, control


def test_prediction_uses_neutral_control_and_caches_only_its_source():
    async def run():
        service, live, record, control = fixture()
        principal = SessionPrincipal("owner")
        first = await service.predict_message("session", "turn", principal)
        assert first == {"source_turn_id": "turn", "text": "Compare the methods."}
        assert await service.predict_message("session", "turn", principal) == first
        assert control.await_count == 1
        assert control.call_args.args[0].kind is RuntimeControlKind.TEXT_SAMPLE
        assert service.require_access.call_count == 2
        assert live.prediction_task is None
        record.last_turn_id = "new-turn"
        with pytest.raises(ValueError, match=PREDICTION_SOURCE_UNAVAILABLE):
            await service.predict_message("session", "turn", principal)

    asyncio.run(run())


def test_busy_and_changed_sources_do_not_publish_suggestions():
    async def run():
        service, live, record, control = fixture()
        live.running = True
        with pytest.raises(ValueError, match=PREDICTION_SOURCE_UNAVAILABLE):
            await service.predict_message("session", "turn", SessionPrincipal("owner"))
        control.assert_not_awaited()
        live.running = False

        async def changed(_request):
            record.last_turn_id = "new-turn"
            return AppliedState(
                "sample",
                "sample",
                CommandState.APPLIED,
                values={"source_turn_id": "turn", "text": "stale"},
            )

        control.side_effect = changed
        with pytest.raises(ValueError, match=PREDICTION_SOURCE_UNAVAILABLE):
            await service.predict_message("session", "turn", SessionPrincipal("owner"))
        assert live.prediction_result is None
        assert live.prediction_task is None

    asyncio.run(run())


def test_prediction_cancellation_waits_for_runtime_cleanup():
    async def run():
        service, live, _record, control = fixture()
        started, cleaned = asyncio.Event(), asyncio.Event()

        async def pending(_request):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        control.side_effect = pending
        task = asyncio.create_task(
            service.predict_message("session", "turn", SessionPrincipal("owner"))
        )
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cleaned.is_set() and live.prediction_task is None
        assert live.prediction_result is None
        assert live.auxiliary_model_request_id == ""
        assert live.auxiliary_model_source is None

    asyncio.run(run())


def test_auxiliary_model_context_never_relabels_the_main_turn():
    live = object.__new__(LiveSession)
    live.active_product_turn_id = "main-turn"
    live.auxiliary_model_request_id = "sample-request"
    live.auxiliary_model_source = ContentSource("Suggest the next user message")
    live.id = "session"
    live._events = SimpleNamespace(by_key=Mock(return_value=None))
    assert live.model_request_id == "sample-request"
    assert live.content_source("sample-request") == live.auxiliary_model_source
    assert live.content_source("unrelated") is None
    assert live.active_product_turn_id == "main-turn"
    live.auxiliary_model_request_id = ""
    live.auxiliary_model_source = None
    assert live.model_request_id == "main-turn"


def main():
    test_prediction_uses_neutral_control_and_caches_only_its_source()
    test_busy_and_changed_sources_do_not_publish_suggestions()
    test_prediction_cancellation_waits_for_runtime_cleanup()
    test_auxiliary_model_context_never_relabels_the_main_turn()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
