"""Contract coverage for persistent literature agentic searches."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.invocation.service.skills import InvocationSkillRuntimeError
from service.literature.api.search import register_literature_search_routes
from service.literature.persistence.search import LiteratureSearchError, LiteratureSearchService
from service.paths import LITERATURE_SEARCH_DELETE_FLAG_FILENAME
from service.platform.activity import Activities, MaintenanceActive

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
    async def test_completed_model_without_artifact_projects_failed_event_and_survives_restart(
        self,
    ) -> None:
        async def empty_stream(_prepared):
            yield {
                "schema_version": 1,
                "invocation_id": "invocation-1",
                "seq": 1,
                "type": "result.completed",
                "data": {},
            }

        self.invocations.stream = empty_stream
        task = await self.service.create(
            "https://publisher.example/article/123", owner_id=OWNER_ID, user_id=USER_ID
        )
        await self.service._live[task["id"]].task
        events = [
            event async for event in self.service.events(task["id"], owner_id=OWNER_ID, after_seq=0)
        ]
        self.assertEqual(events[-1]["type"], "invocation.failed")
        self.assertEqual(events[-1]["data"]["error"], "literature_search_result_missing")
        restarted = LiteratureSearchService(
            self.invocations, root=self.root, activities=self.activities
        )
        self.assertEqual(restarted.list(owner_id=OWNER_ID)[0]["status"], "failed")

    def test_untrusted_failure_detail_does_not_reach_user(self) -> None:
        (self.root / "search_failure.json").write_text(
            json.dumps(
                {
                    "schema": "fast_search.failure.v1",
                    "error": "arbitrary upstream secret or content",
                }
            ),
            encoding="utf-8",
        )
        state = {"status": "completed", "error": "", "result_status": "pending", "result": None}
        self.service._resolve_result(self.root, state)
        self.assertEqual(state["error"], "literature_search_result_missing")

    def test_missing_metadata_is_failure_not_successful_empty(self) -> None:
        state = {"status": "completed", "error": "", "result_status": "pending", "result": None}
        self.service._resolve_result(self.root, state)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["error"], "literature_search_result_missing")

    def test_explicit_target_failure_is_preserved(self) -> None:
        (self.root / "search_failure.json").write_text(
            json.dumps(
                {
                    "schema": "fast_search.failure.v1",
                    "error": "fast_search_target_not_found",
                }
            ),
            encoding="utf-8",
        )
        state = {"status": "completed", "error": "", "result_status": "pending", "result": None}
        self.service._resolve_result(self.root, state)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["error"], "fast_search_target_not_found")
        self.assertEqual(self.service._restored(state)["error"], "fast_search_target_not_found")

    def test_valid_empty_metadata_is_not_a_runner_failure(self) -> None:
        (self.root / "metadata.json").write_text(
            json.dumps({"search_summary": {}, "papers": []}), encoding="utf-8"
        )
        state = {"status": "completed", "error": "", "result_status": "pending", "result": None}
        self.service._resolve_result(self.root, state)
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["result_status"], "ready")

    def test_invalid_result_never_counts_as_success(self) -> None:
        (self.root / "metadata.json").write_text("{}", encoding="utf-8")
        state = {"status": "completed", "error": "", "result_status": "pending", "result": None}
        self.service._resolve_result(self.root, state)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["error"], "literature_search_result_invalid")

    def test_multiple_results_are_failed_not_silently_selected(self) -> None:
        for name in ("one", "two"):
            directory = self.root / name
            directory.mkdir()
            (directory / "metadata.json").write_text(
                json.dumps({"search_summary": {}, "papers": []}), encoding="utf-8"
            )
        state = {"status": "completed", "error": "", "result_status": "pending", "result": None}
        self.service._resolve_result(self.root, state)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["error"], "literature_search_result_ambiguous")

    def test_symlink_failure_file_is_not_trusted(self) -> None:
        outside = self.root.parent / "outside.json"
        outside.write_text(
            json.dumps(
                {"schema": "fast_search.failure.v1", "error": "fast_search_target_not_found"}
            ),
            encoding="utf-8",
        )
        (self.root / "search_failure.json").symlink_to(outside)
        state = {"status": "completed", "error": "", "result_status": "pending", "result": None}
        self.service._resolve_result(self.root, state)
        self.assertEqual(state["error"], "literature_search_result_missing")

    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "aisearch"
        self.activities = Activities()
        self.invocations = FakeInvocations()
        self.service = LiteratureSearchService(
            self.invocations, root=self.root, activities=self.activities
        )

    async def asyncTearDown(self) -> None:
        self.temporary.cleanup()

    async def test_drain_rejects_creation_without_leaving_files(self) -> None:
        generation = self.activities.begin()
        with self.assertRaises(MaintenanceActive):
            await self.service.create("new search", owner_id=OWNER_ID, user_id=USER_ID)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.invocations.prepared, [])
        self.assertTrue(self.activities.seal(generation))

    async def test_returned_task_retains_lease_until_result_persisted(self) -> None:
        task = await self.service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        generation = self.activities.begin()
        self.assertEqual(self.activities.snapshot().counts, {"literature": 1})
        self.assertFalse(self.activities.seal(generation))
        await self.service._live[task["id"]].task
        persisted = json.loads((self.root / task["id"] / "search.json").read_text())
        self.assertEqual(persisted["status"], "completed")
        self.assertTrue(self.activities.seal(generation))

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
        service = LiteratureSearchService(
            TranscriptInvocations(), root=self.root, activities=Activities()
        )
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
        service = LiteratureSearchService(
            UnavailableInvocations(), root=self.root, activities=Activities()
        )
        with self.assertRaises(InvocationSkillRuntimeError):
            await service.create("query", owner_id=OWNER_ID, user_id=USER_ID)
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_failed_run_stays_in_memory_and_restarts_as_interrupted(self) -> None:
        service = LiteratureSearchService(
            FailingInvocations(), root=self.root, activities=Activities()
        )
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
        restarted = LiteratureSearchService(
            FailingInvocations(), root=self.root, activities=Activities()
        )
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
        service = LiteratureSearchService(
            FakeInvocations(), root=self.root, activities=Activities()
        )
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
        service = LiteratureSearchService(
            FakeInvocations(), root=self.root, activities=Activities()
        )

        def always_fail(workspace: Path, state: dict) -> None:
            raise PermissionError(13, "The process cannot access the file")

        service._write_state = always_fail
        with self.assertRaises(PermissionError):
            await service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_delete_marks_workspace_when_removal_fails(self) -> None:
        task = await self.service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(self.service._live[task["id"]].task, timeout=2)
        workspace = self.root / task["id"]
        flag = workspace / LITERATURE_SEARCH_DELETE_FLAG_FILENAME

        # Windows 上子进程仍把任务目录当 cwd, 或实时扫描仍持有句柄时, rmtree 会失败。
        with mock.patch(
            "shutil.rmtree", side_effect=PermissionError(13, "used by another process")
        ):
            await self.service.delete(task["id"], owner_id=OWNER_ID)

        # 失败不冒泡成用户可见错误: 目录留下标记, 任务立刻从所有读路径消失。
        self.assertTrue(workspace.is_dir())
        self.assertTrue(flag.is_file())
        self.assertEqual(self.service.list(owner_id=OWNER_ID), [])
        with self.assertRaises(LiteratureSearchError):
            self.service.get(task["id"], owner_id=OWNER_ID)
        with self.assertRaises(LiteratureSearchError):
            await self.service.delete(task["id"], owner_id=OWNER_ID)

    async def test_startup_sweep_removes_only_flagged_workspaces(self) -> None:
        doomed = await self.service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(self.service._live[doomed["id"]].task, timeout=2)
        kept = await self.service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(self.service._live[kept["id"]].task, timeout=2)
        (self.root / doomed["id"] / LITERATURE_SEARCH_DELETE_FLAG_FILENAME).touch()

        restarted = LiteratureSearchService(
            FakeInvocations(), root=self.root, activities=Activities()
        )

        self.assertFalse((self.root / doomed["id"]).exists())
        self.assertTrue((self.root / kept["id"]).is_dir())
        self.assertEqual([row["id"] for row in restarted.list(owner_id=OWNER_ID)], [kept["id"]])

    async def test_startup_sweep_restores_flag_when_removal_fails_again(self) -> None:
        task = await self.service.create("agent systems", owner_id=OWNER_ID, user_id=USER_ID)
        await asyncio.wait_for(self.service._live[task["id"]].task, timeout=2)
        workspace = self.root / task["id"]
        flag = workspace / LITERATURE_SEARCH_DELETE_FLAG_FILENAME
        flag.touch()

        def partially_delete(target, *args, **kwargs) -> None:
            # 部分成功: 标记文件本身已经被吃掉, 但目录仍然删不掉。
            (Path(target) / LITERATURE_SEARCH_DELETE_FLAG_FILENAME).unlink(missing_ok=True)
            raise PermissionError(13, "used by another process")

        with mock.patch("shutil.rmtree", side_effect=partially_delete):
            LiteratureSearchService(FakeInvocations(), root=self.root, activities=Activities())

        self.assertTrue(workspace.is_dir())
        self.assertTrue(flag.is_file())


class LiteratureSearchRouteContract(unittest.TestCase):
    def test_signed_out_search_is_rejected_without_starting_task(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "aisearch"
            app = FastAPI()
            app.state.literature_searches = LiteratureSearchService(
                FakeInvocations(), root=root, activities=Activities()
            )
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
                UnavailableInvocations(), root=root, activities=Activities()
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

    def test_deferred_directory_removal_still_returns_204(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "aisearch"
            app = FastAPI()
            service = LiteratureSearchService(FakeInvocations(), root=root, activities=Activities())
            app.state.literature_searches = service
            register_literature_search_routes(app)

            @app.middleware("http")
            async def authenticated(request, call_next):
                request.state.user_id = USER_ID
                return await call_next(request)

            client = TestClient(app)
            created = client.post("/api/literature/searches", json={"query": "agent systems"})
            self.assertEqual(created.status_code, 202)
            task_id = created.json()["task"]["id"]

            # 目录删不掉(Windows 上子进程仍持有 cwd)不能变成 500, 否则前端关不掉标签页。
            with mock.patch(
                "shutil.rmtree", side_effect=PermissionError(13, "used by another process")
            ):
                removed = client.delete(f"/api/literature/searches/{task_id}")

            self.assertEqual(removed.status_code, 204)
            self.assertTrue((root / task_id / LITERATURE_SEARCH_DELETE_FLAG_FILENAME).is_file())
            self.assertEqual(client.get("/api/literature/searches").json(), {"items": []})
            self.assertEqual(
                client.get(f"/api/literature/searches/{task_id}/events").status_code, 404
            )


if __name__ == "__main__":
    unittest.main()
