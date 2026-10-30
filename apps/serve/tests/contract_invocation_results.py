"""Deterministic contracts for resource-only result readiness and real cleanup."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
from hashlib import sha256
from pathlib import Path
from typing import Any
from unittest.mock import patch

from scholarseed_runtime.contract import ActorKind, DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome, RuntimeTurnResult
from service.chat.runtime.composition import OneShotRuntimeResult
from service.chat.service.receipts import SEARCH_RECEIPT_PREFIX, SEARCH_RECEIPT_SCHEMA
from service.chat.service.search import SEARCH_MAX_BYTES, SearchError
from service.invocation.service.metadata import InvocationMetadata
from service.invocation.service.model import InvocationCommand, InvocationStatus
from service.invocation.service.results import RESULT_CONTRACT_SATISFIED
from service.invocation.service.runtime import InvocationService
from service.platform.activity import Activities
from service.resources.service.fallback import (
    FALLBACK_BROWSER_ARTIFACT,
    FALLBACK_BROWSER_PROVIDER,
    ResourceSearchResultPolicy,
)

QUERY = "attention"
OWNER = "local"
TURN = "search-turn"
ITEM = "browser-tool"
CANDIDATE = {
    "title": "Attention Is All You Need",
    "url": "https://arxiv.org/abs/1706.03762",
    "description": "Transformer paper",
}


def result_payload(**overrides: Any) -> dict[str, Any]:
    return {
        "schema": SEARCH_RECEIPT_SCHEMA,
        "provider": FALLBACK_BROWSER_PROVIDER,
        "query": QUERY,
        "status": "completed",
        "candidates": [dict(CANDIDATE)],
        "error": None,
        **overrides,
    }


def receipt_output(**overrides: Any) -> str:
    return SEARCH_RECEIPT_PREFIX + json.dumps(result_payload(truncated=False, **overrides))


def provider_output(status: str, **overrides: Any) -> str:
    common = {
        "component": "web_search.invoke",
        "provider": FALLBACK_BROWSER_PROVIDER,
        "artifact_path": FALLBACK_BROWSER_ARTIFACT,
        **overrides,
    }
    return "\n".join(
        (
            json.dumps({**common, "event": "web_search_provider_started"}),
            json.dumps(
                {
                    **common,
                    "event": "web_search_provider_finished",
                    "result_status": status,
                    "write_exit_code": 0,
                }
            ),
        )
    )


def runtime_event(
    kind: RuntimeEventKind,
    *,
    sequence: int = 1,
    payload: dict[str, Any] | None = None,
    turn_id: str = TURN,
    item_id: str = ITEM,
    actor_kind: ActorKind = ActorKind.MAIN,
) -> RuntimeEvent:
    return RuntimeEvent(
        schema_version=1,
        event_id=f"event-{sequence}",
        runtime_id="codex",
        product_session_id="fixture",
        native_session_id="search-thread",
        process_generation=1,
        sequence=sequence,
        kind=kind,
        delivery=DeliveryClass.MUST_PERSIST,
        observed_at="now",
        native_turn_id=turn_id,
        native_item_id=item_id,
        actor_kind=actor_kind,
        payload=payload or {},
    )


class SettingsFixture:
    @staticmethod
    def runtime_executable() -> str:
        return "codex"


async def environment(_user_id: str) -> dict[str, str]:
    return {}


class SearchRuntimeFixture:
    def __init__(self) -> None:
        self.payload = result_payload()
        self.output = receipt_output()
        self.file_kind = "regular"
        self.outcome = RuntimeTurnOutcome.INTERRUPTED
        self.hold_terminal = True
        self.stop_requested = asyncio.Event()
        self.release_terminal = asyncio.Event()
        self.cancel_accepted = True
        self.cancel_error = False
        self.cleanup_error = False
        self.calls: list[dict[str, Any]] = []
        self.cancel_calls: list[tuple[str, str]] = []

    async def invoke_once(self, **kwargs: Any) -> OneShotRuntimeResult:
        self.calls.append(kwargs)
        workspace = Path(kwargs["cwd"])
        artifact = workspace / FALLBACK_BROWSER_ARTIFACT
        encoded = json.dumps(self.payload).encode()
        if self.file_kind == "symlink":
            outside = workspace.parent / "outside.json"
            outside.write_bytes(encoded)
            artifact.symlink_to(outside)
        elif self.file_kind == "oversize":
            with artifact.open("wb") as handle:
                handle.truncate(SEARCH_MAX_BYTES + 1)
        elif self.file_kind != "missing":
            artifact.write_bytes(encoded)
        observer = kwargs["observer"]
        await observer(runtime_event(RuntimeEventKind.TURN_STARTED))
        await observer(runtime_event(RuntimeEventKind.TOOL_STARTED, sequence=2))
        midpoint = len(self.output) // 2
        for sequence, chunk in enumerate((self.output[:midpoint], self.output[midpoint:]), 3):
            await observer(
                runtime_event(
                    RuntimeEventKind.TOOL_PROGRESS, sequence=sequence, payload={"output": chunk}
                )
            )
        await observer(
            runtime_event(
                RuntimeEventKind.TOOL_COMPLETED,
                sequence=5,
                payload={"status": "completed", "exit_code": 0},
            )
        )
        if self.hold_terminal:
            await self.release_terminal.wait()
        if self.cleanup_error:
            raise RuntimeError("runtime cleanup failed")
        return OneShotRuntimeResult(
            model_key="configured-model",
            vendor_thread_id="search-thread",
            turn=RuntimeTurnResult(
                command_id=kwargs["invocation_id"],
                native_turn_id=TURN,
                outcome=self.outcome,
                final_text="runtime final text",
            ),
        )

    async def cancel_once(self, invocation_id: str, *, owner_id: str) -> bool:
        self.cancel_calls.append((invocation_id, owner_id))
        self.stop_requested.set()
        if self.cancel_error:
            raise RuntimeError("runtime stop failed")
        return self.cancel_accepted


class InvocationResultContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.activities = Activities()
        self.runtime = SearchRuntimeFixture()
        self.current = True
        self.service = InvocationService(
            activities=self.activities,
            runtime=self.runtime,
            settings=SettingsFixture(),
            skills=None,
            environment=environment,
            root=Path(self.temporary.name) / "invocations",
        )
        self.prepared = await self.service.prepare(
            InvocationCommand(prompt="bounded search", skill=None, developer_prompt=True),
            owner_id=OWNER,
            user_id="",
            result_policy=ResourceSearchResultPolicy(QUERY, 10, lambda: self.current),
        )
        self.events: list[dict[str, Any]] = []
        self.ready = asyncio.Event()

    async def collect(self) -> None:
        async for event in self.service.stream(self.prepared):
            if event is not None:
                self.events.append(event)
                if event["type"] == "result.ready":
                    self.ready.set()

    async def begin_ready(self) -> asyncio.Task[None]:
        task = asyncio.create_task(self.collect())
        await asyncio.wait_for(self.ready.wait(), timeout=3)
        await asyncio.wait_for(self.runtime.stop_requested.wait(), timeout=3)
        return task

    def metadata(self):
        return InvocationMetadata().read(
            self.prepared.record.invocation_id, Path(self.prepared.record.workspace)
        )

    async def test_ready_is_published_before_confirmed_stop_and_real_terminal(self) -> None:
        task = await self.begin_ready()
        self.assertFalse(task.done())
        self.assertNotIn("result.completed", [event["type"] for event in self.events])
        record = self.metadata()
        self.assertIsNotNone(record)
        self.assertEqual(record.status, InvocationStatus.RUNNING)
        self.assertTrue(self.activities.snapshot().counts)
        artifact_event = next(
            event for event in self.events if event["type"] == "artifact.published"
        )
        ready_event = next(event for event in self.events if event["type"] == "result.ready")
        self.assertLess(artifact_event["seq"], ready_event["seq"])
        self.assertEqual(artifact_event["data"], ready_event["data"]["artifacts"][0])
        self.assertEqual(len(self.runtime.cancel_calls), 1)
        self.assertEqual(self.runtime.cancel_calls[0], (self.prepared.record.invocation_id, OWNER))
        artifact, handle = await self.service.artifact(
            self.prepared.record.invocation_id,
            artifact_event["data"]["artifact_id"],
            owner_id=OWNER,
        )
        with handle:
            content = handle.read()
        self.assertEqual(artifact.content_sha256, sha256(content).hexdigest())
        self.assertEqual(json.loads(content), result_payload())
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        terminal = self.events[-1]
        self.assertEqual(terminal["type"], "result.completed")
        self.assertEqual(terminal["data"]["runtime_outcome"], "interrupted")
        self.assertEqual(terminal["data"]["completion_reason"], RESULT_CONTRACT_SATISFIED)
        self.assertEqual(json.loads(terminal["data"]["text"]), result_payload())
        self.assertEqual(self.metadata().execution["runtime_outcome"], "interrupted")
        self.assertTrue(self.metadata().execution["host_stop_accepted"])
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_user_cancel_after_ready_is_not_success(self) -> None:
        task = await self.begin_ready()
        self.assertTrue(
            await self.service.interrupt(self.prepared.record.invocation_id, owner_id=OWNER)
        )
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.interrupted")
        self.assertEqual(self.metadata().status, InvocationStatus.INTERRUPTED)

    async def test_identity_change_after_ready_is_not_success(self) -> None:
        task = await self.begin_ready()
        self.current = False
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.interrupted")

    async def test_unknown_runtime_outcome_after_ready_is_not_success(self) -> None:
        self.runtime.outcome = RuntimeTurnOutcome.UNKNOWN
        task = await self.begin_ready()
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.unknown")

    async def test_natural_completion_uses_validated_result_without_claiming_interrupt(
        self,
    ) -> None:
        self.runtime.outcome = RuntimeTurnOutcome.COMPLETED
        self.runtime.cancel_accepted = False
        task = await self.begin_ready()
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "result.completed")
        self.assertEqual(self.events[-1]["data"]["runtime_outcome"], "completed")
        self.assertFalse(self.metadata().execution["host_stop_accepted"])

    async def test_no_policy_preserves_regular_invocation_completion(self) -> None:
        self.prepared = await self.service.prepare(
            InvocationCommand(prompt="ordinary invocation", skill=None),
            owner_id=OWNER,
            user_id="",
        )
        self.runtime.hold_terminal = False
        self.runtime.outcome = RuntimeTurnOutcome.COMPLETED
        await asyncio.wait_for(self.collect(), timeout=3)
        self.assertEqual(self.runtime.cancel_calls, [])
        self.assertFalse(any(event["type"] == "result.ready" for event in self.events))
        self.assertEqual(self.events[-1]["type"], "result.completed")
        self.assertEqual(self.events[-1]["data"]["text"], "runtime final text")
        self.assertNotIn("completion_reason", self.events[-1]["data"])

    async def test_failed_runtime_outcome_after_ready_is_not_success(self) -> None:
        self.runtime.outcome = RuntimeTurnOutcome.FAILED
        task = await self.begin_ready()
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.failed")

    async def test_unconfirmed_host_stop_does_not_promote_interrupted_runtime(self) -> None:
        self.runtime.cancel_accepted = False
        task = await self.begin_ready()
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.interrupted")

    async def test_runtime_cleanup_exception_after_ready_is_not_success(self) -> None:
        self.runtime.cleanup_error = True
        task = await self.begin_ready()
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.unknown")

    async def test_host_stop_exception_after_ready_is_not_success(self) -> None:
        self.runtime.cancel_error = True
        task = await self.begin_ready()
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.unknown")

    async def test_file_mutation_after_ready_invalidates_final_success(self) -> None:
        task = await self.begin_ready()
        artifact = Path(self.prepared.record.workspace) / FALLBACK_BROWSER_ARTIFACT
        artifact.write_text(json.dumps(result_payload(query="different query")), encoding="utf-8")
        self.runtime.release_terminal.set()
        await asyncio.wait_for(task, timeout=3)
        self.assertEqual(self.events[-1]["type"], "invocation.failed")

    async def test_cancel_during_publication_waits_worker_and_reconciles_metadata(self) -> None:
        entered = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        publish = self.service._artifacts.publish

        def blocked_publish(*args: Any, **kwargs: Any):
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(timeout=3):
                raise TimeoutError("publication worker was not released")
            return publish(*args, **kwargs)

        self.runtime.cancel_accepted = False
        with patch.object(self.service._artifacts, "publish", blocked_publish):
            task = asyncio.create_task(self.collect())
            try:
                await asyncio.wait_for(entered.wait(), timeout=3)
                task.cancel()
                await asyncio.wait_for(self.runtime.stop_requested.wait(), timeout=3)
                self.assertFalse(task.done())
                self.assertTrue(self.activities.snapshot().counts)
                self.assertEqual(self.metadata().status, InvocationStatus.RUNNING)
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=3)
        record = self.metadata()
        self.assertEqual(record.status, InvocationStatus.UNKNOWN)
        self.assertEqual(len(record.artifacts), 1)
        artifact = Path(record.workspace) / FALLBACK_BROWSER_ARTIFACT
        self.assertEqual(
            record.artifacts[0].content_sha256, sha256(artifact.read_bytes()).hexdigest()
        )
        self.assertFalse(any(event["type"] == "result.ready" for event in self.events))
        self.assertEqual(self.activities.snapshot().counts, {})
        self.assertIsNone(self.service.bridge_caller(record.invocation_id))

    async def test_invalid_file_or_receipt_never_publishes_ready(self) -> None:
        variants = {
            "missing": {"file_kind": "missing"},
            "symlink": {"file_kind": "symlink"},
            "oversize": {"file_kind": "oversize"},
            "query": {"payload": result_payload(query="different query")},
            "provider": {"payload": result_payload(provider="official-api")},
            "schema": {"payload": result_payload(schema="different-schema")},
            "url": {
                "payload": result_payload(
                    candidates=[{**CANDIDATE, "url": "https://example.com/other"}]
                )
            },
            "receipt": {"output": receipt_output(query="unrelated query")},
            "malformed": {"output": SEARCH_RECEIPT_PREFIX + "not-json"},
        }
        for name, overrides in variants.items():
            with self.subTest(name=name):
                runtime = SearchRuntimeFixture()
                runtime.hold_terminal = False
                runtime.outcome = RuntimeTurnOutcome.COMPLETED
                for key, value in overrides.items():
                    setattr(runtime, key, value)
                self.service._runtime = runtime
                self.prepared = await self.service.prepare(
                    InvocationCommand(prompt="bounded search", skill=None),
                    owner_id=OWNER,
                    user_id="",
                    result_policy=ResourceSearchResultPolicy(QUERY, 10, lambda: True),
                )
                self.events = []
                await asyncio.wait_for(self.collect(), timeout=3)
                self.assertFalse(
                    any(
                        event["type"] in {"artifact.published", "result.ready"}
                        for event in self.events
                    )
                )
                self.assertEqual(runtime.cancel_calls, [])
                self.assertEqual(self.metadata().artifacts, ())

    async def test_provider_failures_stop_deterministically_without_becoming_success(self) -> None:
        for status in ("failed", "unavailable", "action_required"):
            with self.subTest(status=status):
                self.runtime = SearchRuntimeFixture()
                self.runtime.payload = result_payload(
                    status=status, candidates=[], error={"code": "browser_provider_failed"}
                )
                self.runtime.output = provider_output(status)
                self.service._runtime = self.runtime
                self.prepared = await self.service.prepare(
                    InvocationCommand(prompt="bounded search", skill=None),
                    owner_id=OWNER,
                    user_id="",
                    result_policy=ResourceSearchResultPolicy(QUERY, 10, lambda: True),
                )
                self.events = []
                self.ready = asyncio.Event()
                task = await self.begin_ready()
                ready = next(event for event in self.events if event["type"] == "result.ready")
                self.assertFalse(ready["data"]["succeeded"])
                self.assertEqual(ready["data"]["error_code"], "browser_provider_failed")
                self.assertFalse(task.done())
                self.runtime.release_terminal.set()
                await asyncio.wait_for(task, timeout=3)
                self.assertEqual(self.events[-1]["type"], "invocation.failed")
                self.assertEqual(self.events[-1]["data"]["error"], "browser_provider_failed")
                self.assertEqual(self.metadata().status, InvocationStatus.FAILED)
                self.assertEqual(self.metadata().execution["runtime_outcome"], "interrupted")
                self.assertEqual(len(self.runtime.cancel_calls), 1)


class SearchResultPolicyContract(unittest.TestCase):
    def completed(self, policy: ResourceSearchResultPolicy, **payload: Any):
        policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
        policy.observe(
            runtime_event(RuntimeEventKind.TOOL_PROGRESS, payload={"output": receipt_output()})
        )
        return policy.observe(
            runtime_event(
                RuntimeEventKind.TOOL_COMPLETED, payload={"status": "completed", **payload}
            )
        )

    def test_receipt_is_bound_to_main_actor_turn_and_tool(self) -> None:
        for field, value in (
            ("actor_kind", ActorKind.SUBAGENT),
            ("turn_id", "other-turn"),
            ("item_id", "other-tool"),
        ):
            with self.subTest(field=field):
                policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
                policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
                policy.observe(
                    runtime_event(
                        RuntimeEventKind.TOOL_PROGRESS,
                        payload={"output": receipt_output()},
                        **{field: value},
                    )
                )
                self.assertIsNone(
                    policy.observe(
                        runtime_event(
                            RuntimeEventKind.TOOL_COMPLETED, payload={"status": "completed"}
                        )
                    )
                )

    def test_failed_tool_never_accepts_success_receipt(self) -> None:
        for payload in ({"status": "failed"}, {"ok": False}, {"success": False}, {"exit_code": 1}):
            with self.subTest(payload=payload):
                self.assertIsNone(
                    self.completed(ResourceSearchResultPolicy(QUERY, 10, lambda: True), **payload)
                )

    def test_duplicate_completion_does_not_publish_twice(self) -> None:
        policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
        artifact = self.completed(policy)
        self.assertIsNotNone(artifact)
        self.assertEqual(
            json.loads(artifact.validate(json.dumps(result_payload()).encode()).text),
            result_payload(),
        )
        self.assertIsNone(
            policy.observe(
                runtime_event(RuntimeEventKind.TOOL_COMPLETED, payload={"status": "completed"})
            )
        )

    def test_completed_output_only_receipt_is_accepted(self) -> None:
        policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
        policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
        artifact = policy.observe(
            runtime_event(
                RuntimeEventKind.TOOL_COMPLETED,
                payload={"status": "completed", "output": receipt_output()},
            )
        )
        self.assertIsNotNone(artifact)
        self.assertEqual(
            json.loads(artifact.validate(json.dumps(result_payload()).encode()).text),
            result_payload(),
        )

    def test_nontruncated_receipt_rejects_missing_or_extra_artifact_candidates(self) -> None:
        extra = {**CANDIDATE, "url": "https://example.com/other"}
        for candidates, artifact_candidates in (
            ([], [CANDIDATE]),
            ([CANDIDATE], [CANDIDATE, extra]),
            ([CANDIDATE], []),
        ):
            with self.subTest(
                receipt_count=len(candidates), artifact_count=len(artifact_candidates)
            ):
                policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
                policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
                artifact = policy.observe(
                    runtime_event(
                        RuntimeEventKind.TOOL_COMPLETED,
                        payload={
                            "status": "completed",
                            "output": receipt_output(candidates=candidates),
                        },
                    )
                )
                self.assertIsNotNone(artifact)
                with self.assertRaises(SearchError):
                    artifact.validate(
                        json.dumps(result_payload(candidates=artifact_candidates)).encode()
                    )

    def test_explicit_truncated_receipt_accepts_matching_prefix(self) -> None:
        policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
        policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
        output = SEARCH_RECEIPT_PREFIX + json.dumps(result_payload(truncated=True))
        artifact = policy.observe(
            runtime_event(
                RuntimeEventKind.TOOL_COMPLETED,
                payload={"status": "completed", "output": output},
            )
        )
        self.assertIsNotNone(artifact)
        payload = result_payload(
            candidates=[CANDIDATE, {**CANDIDATE, "url": "https://example.com/other"}]
        )
        self.assertEqual(json.loads(artifact.validate(json.dumps(payload).encode()).text), payload)

    def test_failure_logs_must_match_provider_path_and_complete_lifecycle(self) -> None:
        valid = provider_output("failed")
        for output in (
            provider_output("failed", provider="official-api"),
            provider_output("failed", artifact_path="different.json"),
            provider_output("failed", component="other.component"),
            valid.splitlines()[0],
            valid.splitlines()[1],
            valid.replace('"write_exit_code": 0', '"write_exit_code": 1'),
        ):
            with self.subTest(output=output):
                policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
                policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
                self.assertIsNone(
                    policy.observe(
                        runtime_event(
                            RuntimeEventKind.TOOL_COMPLETED,
                            payload={"status": "completed", "output": output},
                        )
                    )
                )

    def test_failure_file_must_match_log_status_query_schema_provider_and_error(self) -> None:
        for overrides in (
            {"query": "different query"},
            {"schema": "different-schema"},
            {"provider": "official-api"},
            {"status": "unavailable"},
            {"error": None},
            {"error": {}},
            {"error": {"code": ""}},
        ):
            with self.subTest(overrides=overrides):
                policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
                policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
                artifact = policy.observe(
                    runtime_event(
                        RuntimeEventKind.TOOL_COMPLETED,
                        payload={"status": "completed", "output": provider_output("failed")},
                    )
                )
                self.assertIsNotNone(artifact)
                payload = result_payload(
                    status="failed", candidates=[], error={"code": "browser_failed"}
                )
                payload.update(overrides)
                with self.assertRaises(SearchError):
                    artifact.validate(json.dumps(payload).encode())

    def test_provider_and_query_mismatches_are_ignored(self) -> None:
        for overrides in (
            {"provider": "official-api"},
            {"query": "unrelated query"},
            {"query": "att"},
        ):
            with self.subTest(overrides=overrides):
                policy = ResourceSearchResultPolicy(QUERY, 10, lambda: True)
                policy.observe(runtime_event(RuntimeEventKind.TOOL_STARTED))
                policy.observe(
                    runtime_event(
                        RuntimeEventKind.TOOL_PROGRESS,
                        payload={"output": receipt_output(**overrides)},
                    )
                )
                self.assertIsNone(
                    policy.observe(
                        runtime_event(
                            RuntimeEventKind.TOOL_COMPLETED, payload={"status": "completed"}
                        )
                    )
                )


if __name__ == "__main__":
    unittest.main()
