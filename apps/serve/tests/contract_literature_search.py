"""Contract coverage for persistent literature agentic searches."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.invocation.service.skills import InvocationSkillRuntimeError
from service.literature.api.search import register_literature_search_routes
from service.literature.persistence.search import LiteratureSearchError, LiteratureSearchService

OWNER_ID = "owner-1"
USER_ID = "user-1"


class FakeInvocations:
    def __init__(self) -> None:
        self.prepared: list[dict] = []
        self.interrupted: list[str] = []

    async def prepare(self, command, **kwargs):
        self.prepared.append({"command": command, **kwargs})
        return SimpleNamespace(record=SimpleNamespace(invocation_id="invocation-1"))

    async def stream(self, prepared):
        workspace = self.prepared[-1]["trusted_workspace"].path
        result = workspace / "fast-search-results" / "topic"
        result.mkdir(parents=True)
        (result / "metadata.json").write_text(
            json.dumps(
                {
                    "search_summary": {"query": "agent systems"},
                    "papers": [{"title": "A Paper", "authors": ["A"]}],
                }
            ),
            encoding="utf-8",
        )
        yield {
            "schema_version": 1,
            "invocation_id": "invocation-1",
            "seq": 1,
            "type": "content.delta",
            "data": {"text": "searching"},
        }
        yield {
            "schema_version": 1,
            "invocation_id": "invocation-1",
            "seq": 2,
            "type": "result.completed",
            "data": {"text": "done"},
        }

    async def interrupt(self, invocation_id: str, *, owner_id: str) -> bool:
        self.interrupted.append(invocation_id)
        return True


class UnavailableInvocations(FakeInvocations):
    async def prepare(self, command, **kwargs):
        raise InvocationSkillRuntimeError


class TranscriptInvocations(FakeInvocations):
    """复刻真实事件流：推理通道里带字面定界符，完成事件重发同一段用户可见文本。"""

    async def stream(self, prepared):
        workspace = self.prepared[-1]["trusted_workspace"].path
        result = workspace / "fast-search-results" / "topic"
        result.mkdir(parents=True)
        (result / "metadata.json").write_text(
            json.dumps(
                {
                    "search_summary": {"query": "agent systems"},
                    "papers": [{"title": "A Paper", "authors": ["A"]}],
                }
            ),
            encoding="utf-8",
        )
        for seq, event_type, data in (
            (1, "content.delta", {"role": "reasoning", "text": " wrap progress in <<< and >>>."}),
            (
                2,
                "content.delta",
                {"role": "assistant", "phase": "commentary", "text": "<<<开始检索>>>\n\n"},
            ),
            (
                3,
                "content.completed",
                {"role": "assistant", "phase": "commentary", "text": "<<<开始检索>>>"},
            ),
            (4, "result.completed", {"text": "<<<开始检索>>>"}),
        ):
            yield {
                "schema_version": 1,
                "invocation_id": "invocation-1",
                "seq": seq,
                "type": event_type,
                "data": data,
            }


class FailingInvocations(FakeInvocations):
    """运行到一半失败: 用户可见进度已经产生, 但终态不是 completed。"""

    async def stream(self, prepared):
        for seq, event_type, data in (
            (1, "content.delta", {"role": "assistant", "text": "<<<starting>>>"}),
            (2, "invocation.failed", {"error": "invocation_runtime_failed"}),
        ):
            yield {
                "schema_version": 1,
                "invocation_id": "invocation-1",
                "seq": seq,
                "type": event_type,
                "data": data,
            }


class LiteratureSearchContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "aisearch"
        self.invocations = FakeInvocations()
        self.service = LiteratureSearchService(self.invocations, root=self.root)

    async def asyncTearDown(self) -> None:
        self.temporary.cleanup()

    async def test_create_persists_stream_and_strict_result(self) -> None:
        task = await self.service.create(" agent systems ", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(self.service._live[task["id"]].task, timeout=2)

        workspace = self.root / task["id"]
        self.assertEqual((workspace / "query.txt").read_text("utf-8"), "agent systems\n")
        command = self.invocations.prepared[0]["command"]
        self.assertEqual(command.skill.id, "builtin:fast-search")
        self.assertFalse(command.developer_prompt)
        self.assertIn("keywords are **finalized by the user**", command.prompt)
        self.assertIn("Do not request clarification.", command.prompt)
        self.assertIn("`Veryfast` workflow of the `fast-search` skill", command.prompt)
        self.assertTrue(command.prompt.endswith("**Search Keywords:** `agent systems`\n"))
        restored = self.service.list(owner_id=OWNER_ID)
        self.assertEqual(restored[0]["status"], "completed")
        self.assertGreaterEqual(restored[0]["completed_at"], restored[0]["created_at"])
        self.assertEqual(restored[0]["output"], "searching")
        self.assertEqual(restored[0]["result_status"], "ready")
        events = [
            event async for event in self.service.events(task["id"], owner_id=OWNER_ID, after_seq=0)
        ]
        self.assertEqual([event["seq"] for event in events], [1, 2])
        # 运行期不再逐事件写盘: 目录里只有创建记录、成功终态快照与 skill 自己的结果。
        self.assertEqual(
            sorted(row.name for row in workspace.iterdir()),
            ["fast-search-results", "query.txt", "search.json"],
        )
        persisted = json.loads((workspace / "search.json").read_text("utf-8"))
        self.assertEqual(persisted["status"], "completed")
        self.assertEqual(persisted["invocation_id"], "invocation-1")
        await self.service.delete(task["id"], owner_id=OWNER_ID)
        self.assertFalse(workspace.exists())

    async def test_output_keeps_only_user_visible_deltas(self) -> None:
        service = LiteratureSearchService(TranscriptInvocations(), root=self.root)
        task = await service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(service._live[task["id"]].task, timeout=2)

        restored = service.list(owner_id=OWNER_ID)
        # 推理通道里的字面定界符、以及完成事件重发的同一段文本，都不得进入用户可见 output。
        self.assertEqual(restored[0]["output"], "<<<开始检索>>>\n\n")
        self.assertEqual(restored[0]["result_status"], "ready")
        # 原始事件流在内存里保持完整，重连按 after_seq 重放不受这层投影影响。
        events = [
            event async for event in service.events(task["id"], owner_id=OWNER_ID, after_seq=0)
        ]
        self.assertEqual([event["seq"] for event in events], [1, 2, 3, 4])
        tail = [event async for event in service.events(task["id"], owner_id=OWNER_ID, after_seq=2)]
        self.assertEqual([event["seq"] for event in tail], [3, 4])

    async def test_rejects_blank_and_foreign_owner(self) -> None:
        with self.assertRaises(LiteratureSearchError):
            await self.service.create(" ", owner_id=OWNER_ID, user_id=USER_ID)
        task = await self.service.create("query", owner_id=OWNER_ID, user_id=USER_ID)
        with self.assertRaises(LiteratureSearchError):
            self.service.get(task["id"], owner_id="other")

    async def test_runtime_unavailable_removes_unstarted_task(self) -> None:
        service = LiteratureSearchService(UnavailableInvocations(), root=self.root)
        with self.assertRaises(InvocationSkillRuntimeError):
            await service.create("query", owner_id=OWNER_ID, user_id=USER_ID)
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_failed_run_stays_in_memory_and_restarts_as_interrupted(self) -> None:
        service = LiteratureSearchService(FailingInvocations(), root=self.root)
        task = await service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(service._live[task["id"]].task, timeout=2)

        # 同一进程内仍看到真实终态与错误码，不被投影掩盖。
        live = service.list(owner_id=OWNER_ID)[0]
        self.assertEqual(live["status"], "failed")
        self.assertEqual(live["error"], "invocation_runtime_failed")
        self.assertEqual(live["output"], "<<<starting>>>")

        workspace = self.root / task["id"]
        persisted = json.loads((workspace / "search.json").read_text("utf-8"))
        # 失败不写终态：磁盘上只留创建时已经确定的信息，供重启恢复与 trace 归因。
        self.assertEqual(persisted["status"], "running")
        self.assertEqual(persisted["query"], "agent systems")
        self.assertEqual(persisted["owner_id"], OWNER_ID)
        self.assertEqual(persisted["invocation_id"], "invocation-1")
        self.assertEqual(persisted["output"], "")
        self.assertIsNone(persisted["completed_at"])

        # 重启后由新进程投影：状态是 search_interrupted，query 等已知信息仍可恢复。
        restarted = LiteratureSearchService(FailingInvocations(), root=self.root)
        restored = restarted.list(owner_id=OWNER_ID)[0]
        self.assertEqual(restored["status"], "search_interrupted")
        self.assertEqual(restored["query"], "agent systems")
        self.assertEqual(restored["created_at"], persisted["created_at"])
        self.assertEqual(restored["error"], "")
        self.assertIsNone(restored["result"])
        # 投影是只读的：不把内部错误码或 unknown 回写进磁盘。
        self.assertEqual(
            json.loads((workspace / "search.json").read_text("utf-8"))["status"], "running"
        )
        # 归属仍然生效：别人的 owner 看不到这条任务。
        self.assertEqual(restarted.list(owner_id="other"), [])

    async def test_transient_state_write_failure_is_retried(self) -> None:
        service = LiteratureSearchService(FakeInvocations(), root=self.root)
        original = service._write_state
        attempts = {"count": 0}

        def flaky(workspace: Path, state: dict) -> None:
            attempts["count"] += 1
            if attempts["count"] < 3:
                raise PermissionError(13, "The process cannot access the file")
            original(workspace, state)

        service._write_state = flaky
        task = await service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(service._live[task["id"]].task, timeout=5)

        # Windows 共享冲突可重试：两次失败后仍然成功落盘，检索不被判死。
        self.assertGreaterEqual(attempts["count"], 3)
        persisted = json.loads((self.root / task["id"] / "search.json").read_text("utf-8"))
        self.assertEqual(persisted["status"], "completed")
        self.assertEqual(service.list(owner_id=OWNER_ID)[0]["status"], "completed")

    async def test_unwritable_state_fails_create_without_leaving_workspace(self) -> None:
        service = LiteratureSearchService(FakeInvocations(), root=self.root)

        def always_fail(workspace: Path, state: dict) -> None:
            raise PermissionError(13, "The process cannot access the file")

        service._write_state = always_fail
        with self.assertRaises(PermissionError):
            await service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        self.assertEqual(list(self.root.iterdir()), [])


class LiteratureSearchRouteContract(unittest.TestCase):
    def test_signed_out_search_is_rejected_without_starting_task(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "aisearch"
            app = FastAPI()
            app.state.literature_searches = LiteratureSearchService(FakeInvocations(), root=root)
            register_literature_search_routes(app)
            response = TestClient(app).post(
                "/api/literature/searches", json={"query": "agent systems"}
            )
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json(), {"detail": "login_required"})
            self.assertEqual(list(root.iterdir()), [])

    def test_runtime_unavailable_returns_json_503(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "aisearch"
            app = FastAPI()
            app.state.literature_searches = LiteratureSearchService(
                UnavailableInvocations(), root=root
            )
            register_literature_search_routes(app)

            @app.middleware("http")
            async def authenticated(request, call_next):
                request.state.user_id = USER_ID
                return await call_next(request)

            response = TestClient(app).post(
                "/api/literature/searches", json={"query": "agent systems"}
            )

            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json(), {"detail": "invocation_runtime_unavailable"})
            self.assertEqual(list(root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
