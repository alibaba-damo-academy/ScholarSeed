"""Deterministic source authorization and durable fork-prefix contracts."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scholarseed_runtime.contract import CapabilitySet, RuntimeBinding
from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_USER_MESSAGE,
)
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import (
    SESSION_FORK_EVENT,
    SESSION_FORK_IMPORTED_KEY,
    SESSION_FORK_KEY,
    ProductEventStore,
)
from service.chat.service.sessions import (
    SESSION_FORK_INCOMPLETE,
    SESSION_FORK_INVALID,
    SESSION_FORK_SOURCE_CHANGED,
    SessionService,
)
from service.platform.activity import Activities


class ForkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.catalog = SessionCatalogStore(self.root / "catalog.db")
        self.events = ProductEventStore(self.catalog.database)
        self.owner = SessionPrincipal(user_id="owner")
        self.source = self.register("source")
        self.service = SessionService(
            self.root,
            {},
            activities=Activities(),
            access=self.catalog,
            events=self.events,
            runtime=SimpleNamespace(runtime_id="codex"),
            workspaces=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
            logger=SimpleNamespace(),
        )

    def register(self, session_id: str):
        return self.catalog.register(
            session_id,
            self.owner,
            runtime_id="codex",
            vendor_thread_id=f"thread-{session_id}",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root),
            codex_version="0.159.0",
            model_id="model",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=1,
            runtime_binding=RuntimeBinding(
                product_session_id=session_id,
                runtime_id="codex",
                adapter_version="0.2.1",
                runtime_version="0.159.0",
                protocol_version="2",
                protocol_schema_hash="schema",
                opaque_session_ref=f"thread-{session_id}",
                capabilities=CapabilitySet(()),
            ),
        )

    def append(self, turn: str, kind: str, payload: dict):
        return self.events.append(
            session_id="source",
            runtime_id="codex",
            vendor_thread_id="thread-source",
            vendor_turn_id=turn,
            vendor_item_id=f"{turn}:{kind}",
            kind=kind,
            payload=payload,
            idempotency_key=f"{turn}:{kind}",
        )

    def open(self, body: dict, principal=None):
        return asyncio.run(self.service.open(body, principal or self.owner, actor_id="owner"))

    def test_source_validation(self) -> None:
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            create.return_value = ({"session_id": "child"}, 200)
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 200
            )
            self.assertEqual(create.call_args.kwargs["fork_origin"].vendor_turn_id, "done")
            self.assertEqual(create.call_args.args[0]["model_id"], "model")
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "missing"})[0]["error"],
                SESSION_FORK_INCOMPLETE,
            )
            self.assertEqual(
                self.open(
                    {"fork_session_id": "source", "fork_turn_id": "done", "model_id": "override"}
                )[0]["error"],
                SESSION_FORK_INVALID,
            )
            with self.assertRaises(SessionAccessError):
                self.open(
                    {"fork_session_id": "source", "fork_turn_id": "done"},
                    SessionPrincipal(user_id="other"),
                )
            with patch.object(
                self.catalog,
                "runtime_binding",
                return_value=SimpleNamespace(opaque_session_ref="moved"),
            ):
                self.assertEqual(
                    self.open({"fork_session_id": "source", "fork_turn_id": "done"})[0]["error"],
                    SESSION_FORK_SOURCE_CHANGED,
                )
            self.assertEqual(create.call_count, 1)

    def test_durable_prefix_is_bounded_and_independent(self) -> None:
        terminals = []
        for turn in ("one", "two", "three"):
            self.append(
                turn,
                PRODUCT_EVENT_USER_MESSAGE,
                {
                    "text": f"question {turn}",
                    "client_turn_id": turn,
                    "references": [{"private": "source-only"}],
                },
            )
            self.append(
                turn,
                PRODUCT_EVENT_MESSAGE_DELTA,
                {"delta": f"answer {turn}", "phase": "final_answer"},
            )
            terminals.append(
                self.append(turn, PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
            )
        target = self.register("child")
        before = self.events.replay("source")
        self.events.inherit_history("source", target, terminals[1].product_seq)
        self.events.inherit_history("source", target, terminals[1].product_seq)
        history = self.events.portable_history("child")
        self.assertEqual(
            [entry.text for entry in history],
            ["question one", "answer one", "question two", "answer two"],
        )
        self.assertEqual(before, self.events.replay("source"))
        self.assertTrue(
            all(record.vendor_thread_id == "thread-child" for record in self.events.replay("child"))
        )
        self.assertNotIn("source-only", str(self.events.replay("child")))
        reopened = ProductEventStore(self.catalog.database)
        self.assertEqual(reopened.portable_history("child"), history)
        self.catalog.release("source", self.owner)
        self.assertEqual(reopened.portable_history("child"), history)

    def test_target_admission_releases_source_lifecycle(self) -> None:
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        lock = asyncio.Lock()
        self.service._sessions["source"] = SimpleNamespace(
            lifecycle_lock=lock, closing=False, running=True
        )

        async def create(*args, **kwargs):
            self.assertFalse(lock.locked())
            return {"session_id": "child"}, 200

        with patch.object(self.service, "_create", side_effect=create):
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 200
            )

    def test_archived_source_cannot_create_task(self) -> None:
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        self.catalog.set_archived("source", self.owner, True)
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 409
            )
            create.assert_not_awaited()

    def test_bound_fork_recovers_interrupted_history_import(self) -> None:
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question"})
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        self.register("child")
        self.events.append(
            session_id="child",
            runtime_id="codex",
            vendor_thread_id="thread-child",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={"source_session_id": "source", "source_product_seq": terminal.product_seq},
            idempotency_key=SESSION_FORK_KEY,
        )
        live = SimpleNamespace(id="child")
        self.service._runtime.ensure_active = AsyncMock()
        with patch.object(self.events, "inherit_history", side_effect=OSError("write failed")):
            with self.assertRaises(OSError):
                asyncio.run(self.service._restore_fork_history(live))
        self.assertIsNone(self.events.by_key("child", SESSION_FORK_IMPORTED_KEY))
        asyncio.run(self.service._restore_fork_history(live))
        self.assertEqual(
            [entry.text for entry in self.events.portable_history("child")], ["question"]
        )
        self.assertIsNotNone(self.events.by_key("child", SESSION_FORK_IMPORTED_KEY))
        with patch.object(
            self.events, "inherit_history", side_effect=AssertionError("already ready")
        ):
            asyncio.run(self.service._restore_fork_history(live))

    def test_prefix_import_rolls_back(self) -> None:
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question"})
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        target = self.register("child")
        append = self.events.append
        calls = 0

        def failing_append(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("write failed")
            return append(**kwargs)

        with patch.object(self.events, "append", side_effect=failing_append):
            with self.assertRaises(OSError):
                self.events.inherit_history("source", target, terminal.product_seq)
        self.assertEqual(self.events.replay("child"), ())


def main() -> int:
    result = unittest.TextTestRunner().run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ForkTests)
    )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
