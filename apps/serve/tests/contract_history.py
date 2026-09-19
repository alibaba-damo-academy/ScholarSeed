"""Deterministic history/CLI contracts; fixtures are not product acceptance."""

from __future__ import annotations

import asyncio
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.assistant.persistence.store import AssistantStore
from service.assistant.service.context import AssistantService
from service.chat.active import RUNTIME_ID
from service.chat.api.artifacts import register_artifact_routes
from service.chat.api.history import register_history_routes
from service.chat.constants import PRODUCT_EVENT_USER_MESSAGE
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.composition import LiveSessionService
from service.chat.service.context import SessionContextProvider
from service.chat.service.history import HistoryError, HistoryService
from service.cli.bridge import main
from service.platform.bridge import (
    ARTIFACT_PUBLISH_ROUTE,
    BRIDGE_MAX_RESPONSE_BYTES,
    BRIDGE_SESSION_ENV,
    BRIDGE_SESSION_HEADER,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    BRIDGE_TOKEN_HEADER,
    HISTORY_ROUTE_PREFIX,
    HISTORY_TEXT_CHARS,
    INTERNAL_BASE_URL_ENV,
    HistoryList,
    HistoryRead,
    HistorySearch,
)
from service.platform.content import ProjectRef
from service.platform.context import (
    ContextRef,
    ContextRefKind,
    HistoryScope,
    ProjectContextPolicy,
    SearchScope,
)
from service.platform.local import (
    PRIVATE_DIRECTORY_MODE,
    PRIVATE_SOCKET_MODE,
    UNIX_SOCKET_FAMILY,
    WINDOWS_PLATFORM,
    local_listener,
)

SOURCE = "history-source"
CALLER = "history-caller"
OUTSIDE = "history-outside"
FOREIGN = "history-foreign"
CAPABILITY = "contract-only-history-capability"
SERVER_START_TIMEOUT = 5
SERVER_POLL_SECONDS = 0.02
CLI_TIMEOUT = 10
UNIX_LISTENER_SUPPORTED = os.name != WINDOWS_PLATFORM and UNIX_SOCKET_FAMILY is not None


class HistoryContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="scholarseed-history-contract-")
        self.catalog = SessionCatalogStore(Path(self.temp.name) / "sessions.sqlite3")
        self.events = ProductEventStore(self.catalog.database)
        for session in (SOURCE, CALLER, OUTSIDE, FOREIGN):
            self.catalog.register(
                session,
                SessionPrincipal("foreign" if session == FOREIGN else "local"),
                runtime_id=RUNTIME_ID,
                vendor_thread_id=session,
                vendor_session_id=None,
                runtime_workdir=self.temp.name,
                project_path=None,
                output_root=self.temp.name,
                codex_version="contract",
                model_id="contract",
                policy_id="ask",
                status=SessionStatus.READY,
                title=session,
                created_at=1.0,
            )
        self.add_message(SOURCE, "first", "先讨论问题")
        self.add_message(SOURCE, "second", "卡片方案：统一 CLI，history 查询后端。")
        self.add_message(SOURCE, "third", "后续讨论")
        self.add_message(OUTSIDE, "private", "不应检索到这里")
        self.add_message(FOREIGN, "foreign", "其他用户的正文")
        self.history = HistoryService(self.catalog, self.events)
        self.assistant = AssistantService(
            AssistantStore(self.catalog.database),
            providers={ContextRefKind.SESSION: SessionContextProvider(self.history)},
        )
        selected = self.assistant.replace_selection(
            session_id=CALLER,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ContextRef("history-ref", ContextRefKind.SESSION, SOURCE, SOURCE),),
        )
        context = self.assistant.freeze(
            session_id=CALLER,
            client_turn_id="query-turn",
            expected_revision=selected.revision,
            question="上次方案是什么？",
        ).context
        assert context is not None
        self.context = context
        self.scope = self.assistant.history_scope(CALLER, context.snapshot.snapshot_id)
        assert self.scope is not None

    def tearDown(self) -> None:
        self.temp.cleanup()

    def add_message(self, session: str, message_id: str, text: str) -> None:
        self.events.append(
            session_id=session,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=session,
            vendor_turn_id=message_id,
            vendor_item_id=message_id,
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"text": text, "client_turn_id": message_id},
            idempotency_key=message_id,
        )

    def test_context_is_reference_not_truncated_transcript(self) -> None:
        self.assertIn("scholarseed-bridge", self.context.model_context)
        self.assertNotIn("统一 CLI", self.context.model_context)

    def test_search_excerpts_keep_original_offsets_and_mark_omissions(self) -> None:
        self.add_message(SOURCE, "unicode", "ß 前面的背景。needle 后面的事实")
        scope = replace(
            self.scope, refs=tuple(replace(ref, source_revision="") for ref in self.scope.refs)
        )
        result = self.history.query(CALLER, scope, HistorySearch(query="needle"))
        excerpt = result["messages"][0]
        self.assertEqual(excerpt["text_offset"], len("ß 前面的背景。"))
        self.assertEqual(excerpt["text"], "needle 后面的事实")
        self.assertTrue(excerpt["truncated"])
        original = self.history.query(
            CALLER,
            scope,
            HistoryRead(session_id=SOURCE, message_id=excerpt["message_id"]),
        )["messages"][0]
        self.assertEqual(original["text"], "ß 前面的背景。needle 后面的事实")
        self.assertEqual(original["text_offset"], 0)
        self.assertFalse(original["truncated"])

    def test_search_and_context_read_share_stable_identity(self) -> None:
        result = self.history.query(CALLER, self.scope, HistorySearch(query="卡片方案"))
        self.assertEqual(len(result["messages"]), 1)
        message = result["messages"][0]
        read = self.history.query(
            CALLER,
            self.scope,
            HistoryRead(
                session_id=SOURCE,
                message_id=message["message_id"],
                before=1,
                after=1,
            ),
        )
        self.assertEqual(len(read["messages"]), 3)
        self.assertIn("统一 CLI", read["messages"][1]["text"])

    def test_pagination_and_cursor_binding(self) -> None:
        first = self.history.query(CALLER, self.scope, HistoryRead(session_id=SOURCE, limit=1))
        second = self.history.query(
            CALLER,
            self.scope,
            HistoryRead(
                session_id=SOURCE,
                limit=1,
                cursor=first["next_cursor"],
            ),
        )
        self.assertEqual(first["messages"][0]["text"], "后续讨论")
        self.assertIn("统一 CLI", second["messages"][0]["text"])
        with self.assertRaises(HistoryError):
            self.history.query(
                CALLER,
                self.scope,
                HistoryRead(
                    session_id=SOURCE,
                    order="asc",
                    cursor=first["next_cursor"],
                ),
            )

    def test_long_message_continuation_loses_no_characters(self) -> None:
        long_text = "中文长消息" * HISTORY_TEXT_CHARS
        self.add_message(SOURCE, "long", long_text)
        scope = replace(self.scope, refs=(replace(self.scope.refs[0], source_revision=None),))
        cursor = ""
        fragments = []
        message = self.history.source(CALLER, SOURCE).entries[-1]
        while True:
            result = self.history.query(
                CALLER,
                scope,
                HistoryRead(
                    session_id=SOURCE,
                    message_id=self.history.message_id(message),
                    cursor=cursor,
                ),
            )
            self.assertLess(
                len(json.dumps(result, ensure_ascii=False).encode()), BRIDGE_MAX_RESPONSE_BYTES
            )
            fragments.extend(row["text"] for row in result["messages"])
            cursor = result["next_cursor"]
            if not cursor:
                break
        self.assertEqual("".join(fragments), long_text)

    def test_unattached_and_other_user_are_rejected(self) -> None:
        with self.assertRaisesRegex(HistoryError, "scope_forbidden"):
            self.history.query(CALLER, self.scope, HistoryRead(session_id=OUTSIDE))
        with self.assertRaisesRegex(HistoryError, "session_forbidden"):
            self.history.source(CALLER, FOREIGN)

    def test_scope_uses_frozen_snapshot_and_requester(self) -> None:
        self.assistant.replace_selection(
            session_id=CALLER,
            expected_revision=1,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ContextRef("outside", ContextRefKind.SESSION, OUTSIDE, OUTSIDE),),
        )
        self.assertEqual(
            self.assistant.history_scope(CALLER, self.context.snapshot.snapshot_id), self.scope
        )
        self.assertEqual(
            self.assistant.history_scope(OUTSIDE, self.context.snapshot.snapshot_id), None
        )

    def test_changed_source_is_explicit_not_silent(self) -> None:
        self.add_message(SOURCE, "changed", "新的结论")
        with self.assertRaisesRegex(HistoryError, "source_revision_changed"):
            self.history.query(CALLER, self.scope, HistorySearch(query="结论"))

    def test_turn_context_recovery_is_exact_and_durable(self) -> None:
        payload = {
            "text": "查询",
            "client_turn_id": "query-turn",
            "assistant_snapshot_id": self.context.snapshot.snapshot_id,
            "assistant_context_revision": 1,
        }
        self.events.append(
            session_id=CALLER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=CALLER,
            vendor_turn_id="native-turn",
            vendor_item_id="query-turn",
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload=payload,
            idempotency_key="bound",
        )
        reopened = ProductEventStore(self.catalog.database)
        self.assertEqual(reopened.turn_context(CALLER, "native-turn"), payload)
        self.assertEqual(reopened.turn_context(CALLER, "other-turn"), {})
        self.assertEqual(reopened.turn_context(OUTSIDE, "native-turn"), {})

    def test_cli_subprocess_queries_real_http_with_fixture_scope(self) -> None:
        """Transport integration with fixture history, explicitly not LLM acceptance."""

        async def publish(kind, payload, **kwargs):
            self.events.append(
                session_id=CALLER,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=CALLER,
                vendor_turn_id="query-turn",
                vendor_item_id=None,
                kind=kind,
                payload=payload,
                idempotency_key=kwargs["idempotency_key"],
            )

        live = SimpleNamespace(
            id=CALLER,
            bridge_token=CAPABILITY,
            active_assistant_snapshot_id=self.context.snapshot.snapshot_id,
            ledger=SimpleNamespace(active_turn_id="query-turn"),
            publish=publish,
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session: live if session == CALLER else None
        )
        app = FastAPI()
        register_history_routes(app, sessions, self.history, self.assistant)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
            server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
            thread = threading.Thread(
                target=server.run, kwargs={"sockets": [listener]}, daemon=True
            )
            thread.start()
            try:
                deadline = time.monotonic() + SERVER_START_TIMEOUT
                while not server.started and time.monotonic() < deadline:
                    time.sleep(SERVER_POLL_SECONDS)
                self.assertTrue(server.started)
                environment = {
                    **os.environ,
                    INTERNAL_BASE_URL_ENV: base_url,
                    BRIDGE_SESSION_ENV: CALLER,
                    BRIDGE_TOKEN_ENV: CAPABILITY,
                }
                command = [sys.executable, "-m", "service.cli.bridge", "history"]
                search = subprocess.run(
                    [*command, "search", "--json", '{"query":"卡片方案"}'],
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=CLI_TIMEOUT,
                )
                self.assertEqual(search.returncode, 0, search.stdout)
                found = json.loads(search.stdout)["messages"][0]
                read = subprocess.run(
                    [
                        *command,
                        "read",
                        "--json",
                        json.dumps({"session_id": SOURCE, "message_id": found["message_id"]}),
                    ],
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=CLI_TIMEOUT,
                )
                self.assertEqual(read.returncode, 0, read.stdout)
                self.assertIn("统一 CLI", json.loads(read.stdout)["messages"][0]["text"])
            finally:
                server.should_exit = True
                thread.join(SERVER_START_TIMEOUT)
            self.assertFalse(thread.is_alive())

    def test_no_match_is_success_not_transport_error(self) -> None:
        result = self.history.query(CALLER, self.scope, HistorySearch(query="unmatched-nonce"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["messages"], [])

    def test_no_project_or_references_returns_empty_success(self) -> None:
        scope = replace(self.scope, refs=())
        for request, key in (
            (HistoryList(), "sessions"),
            (HistorySearch(query="方案"), "messages"),
        ):
            result = self.history.query(CALLER, scope, request)
            self.assertTrue(result["ok"])
            self.assertEqual(result[key], [])
            self.assertFalse(result["has_more"])
            self.assertEqual(result["next_cursor"], "")
        with self.assertRaisesRegex(HistoryError, "scope_forbidden"):
            self.history.query(CALLER, scope, HistoryRead(session_id=SOURCE))

    def test_unavailable_reference_does_not_expand_scope(self) -> None:
        with self.assertRaisesRegex(HistoryError, "history_source_unavailable"):
            self.history.query(CALLER, replace(self.scope, unavailable=True), HistoryList())

    def test_help_works_without_connection_and_context_error_is_json(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            output = io.StringIO()
            with redirect_stdout(output), self.assertRaises(SystemExit) as exit_result:
                main(["--help"])
            self.assertEqual(exit_result.exception.code, 0)
            self.assertIn("history", output.getvalue())
            output = io.StringIO()
            with redirect_stdout(output):
                status = main(["history", "search", "--json", '{"query":"方案"}'])
            self.assertEqual(status, 1)
            self.assertIn("bridge_context_unavailable", json.loads(output.getvalue())["error"])

    def test_launch_environment_preserves_skill_alignment(self) -> None:
        live = SimpleNamespace(
            id=CALLER,
            bridge_token=CAPABILITY,
            process_environment={"SKILL_KEY": "fixture"},
            local_socket=None,
        )
        with patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1:12345"}):
            environment = LiveSessionService._launch_environment(live)
        self.assertEqual(environment[BRIDGE_TOKEN_ENV], CAPABILITY)
        self.assertEqual(live.process_environment, {"SKILL_KEY": "fixture"})

    def test_http_environment_drops_inherited_socket(self) -> None:
        base = {BRIDGE_SOCKET_ENV: "stale.sock"}
        address = "http://127.0.0.1:12345"
        with patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: address}):
            environment = LiveSessionService._bridge_environment(
                base, scope_id=CALLER, token=CAPABILITY, local_socket=None
            )
        self.assertNotIn(BRIDGE_SOCKET_ENV, environment)
        self.assertEqual(environment[INTERNAL_BASE_URL_ENV], address)
        self.assertEqual(environment[BRIDGE_TOKEN_ENV], CAPABILITY)
        self.assertEqual(environment[BRIDGE_SESSION_ENV], CALLER)
        self.assertEqual(base[BRIDGE_SOCKET_ENV], "stale.sock")

    def test_unsupported_unix_listener_uses_existing_http(self) -> None:
        async def check():
            root = Path(self.temp.name) / "unused-listener"
            # Windows may expose AF_UNIX but still has no asyncio Unix server.
            for platform, family in ((WINDOWS_PLATFORM, object()), (os.name, None)):
                with (
                    self.subTest(platform=platform, family=family),
                    patch("service.platform.local.os", SimpleNamespace(name=platform)),
                    patch("service.platform.local.UNIX_SOCKET_FAMILY", family),
                    patch("service.platform.local.socket.socket") as create_socket,
                ):
                    async with local_listener(FastAPI().router, root) as endpoint:
                        self.assertIsNone(endpoint)
                    create_socket.assert_not_called()
                    self.assertFalse(root.exists())

        asyncio.run(check())

    @unittest.skipUnless(UNIX_LISTENER_SUPPORTED, "Unix socket transport is unavailable")
    def test_local_listener_cli_scope_and_lifecycle(self) -> None:
        published = []

        async def publish(kind, payload, **kwargs):
            published.append((kind, payload))

        live = SimpleNamespace(
            id=CALLER,
            bridge_token=CAPABILITY,
            active_assistant_snapshot_id=self.context.snapshot.snapshot_id,
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=publish,
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session: live if session == CALLER else None
        )
        router = register_history_routes(FastAPI(), sessions, self.history, self.assistant)

        async def check():
            # Keep the isolated fixture below the platform's Unix socket path limit.
            with tempfile.TemporaryDirectory(prefix="bridge-", dir="/tmp") as directory:
                async with local_listener(router, Path(directory)) as endpoint:
                    self.assertEqual(endpoint.stat().st_mode & 0o777, PRIVATE_SOCKET_MODE)
                    self.assertEqual(endpoint.parent.stat().st_mode & 0o777, PRIVATE_DIRECTORY_MODE)
                    async with httpx.AsyncClient(
                        transport=httpx.AsyncHTTPTransport(uds=str(endpoint)),
                        base_url="http://localhost",
                        trust_env=False,
                    ) as client:
                        self.assertEqual((await client.get("/api/healthz")).status_code, 404)
                        self.assertEqual(
                            (
                                await client.post(HISTORY_ROUTE_PREFIX + "search", json={})
                            ).status_code,
                            403,
                        )
                    environment = {
                        **os.environ,
                        BRIDGE_SOCKET_ENV: str(endpoint),
                        BRIDGE_SESSION_ENV: CALLER,
                        BRIDGE_TOKEN_ENV: CAPABILITY,
                        INTERNAL_BASE_URL_ENV: "http://127.0.0.1:1",
                    }
                    for operation, payload in (
                        ("list", {}),
                        ("search", {"query": "卡片方案"}),
                        ("read", {"session_id": SOURCE}),
                        ("read", {"session_id": OUTSIDE}),
                    ):
                        result = await asyncio.to_thread(
                            subprocess.run,
                            [
                                sys.executable,
                                "-m",
                                "service.cli.bridge",
                                "history",
                                operation,
                                "--json",
                                json.dumps(payload),
                            ],
                            env=environment,
                            capture_output=True,
                            text=True,
                            timeout=CLI_TIMEOUT,
                        )
                        response = json.loads(result.stdout)
                        if payload.get("session_id") == OUTSIDE:
                            self.assertNotEqual(result.returncode, 0)
                            self.assertFalse(response["ok"])
                        else:
                            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                            self.assertTrue(response["ok"])
                            self.assertTrue(
                                response["sessions" if operation == "list" else "messages"]
                            )
                    self.assertEqual(len(published), 3)
                self.assertFalse(endpoint.exists())
                self.assertFalse(endpoint.parent.exists())

        asyncio.run(check())

    def test_http_requires_live_capability_and_persists_actual_result(self) -> None:
        published = []

        async def publish(kind, payload, **kwargs):
            published.append((kind, payload))

        live = SimpleNamespace(
            id=CALLER,
            bridge_token=CAPABILITY,
            active_assistant_snapshot_id=self.context.snapshot.snapshot_id,
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=publish,
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session: live if session == CALLER else None
        )
        app = FastAPI()
        register_history_routes(app, sessions, self.history, self.assistant)
        with TestClient(app) as client:
            route = HISTORY_ROUTE_PREFIX + "search"
            self.assertEqual(client.post(route, json={"query": "方案"}).status_code, 403)
            headers = {BRIDGE_SESSION_HEADER: CALLER, BRIDGE_TOKEN_HEADER: CAPABILITY}
            response = client.post(route, headers=headers, json={"query": "方案"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["messages"], published[0][1]["messages"])
            live.active_assistant_snapshot_id = "missing-snapshot"
            self.assertEqual(
                client.post(route, headers=headers, json={"query": "方案"}).status_code, 403
            )
            live.active_assistant_snapshot_id = self.context.snapshot.snapshot_id
            response = client.post(
                route, headers=headers, json={"query": "方案", "owner_id": "foreign"}
            )
            self.assertEqual(response.status_code, 400)
            live.bridge_token = ""
            self.assertEqual(
                client.post(route, headers=headers, json={"query": "方案"}).status_code, 403
            )


class ArtifactPublishContract(unittest.TestCase):
    @unittest.skipUnless(UNIX_LISTENER_SUPPORTED, "Unix socket transport is unavailable")
    def test_cli_uses_private_listener_and_active_session(self) -> None:
        published = []

        async def publish_artifact(path, role, *, turn_id):
            artifact = {"path": path, "role": role, "vendor_turn_id": turn_id}
            published.append(artifact)
            return artifact

        live = SimpleNamespace(
            id=CALLER,
            bridge_token=CAPABILITY,
            ledger=SimpleNamespace(active_turn_id="artifact-turn"),
            publication_turn_id="artifact-turn",
            publish_artifact=publish_artifact,
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session: live if session == CALLER else None
        )
        router = register_artifact_routes(FastAPI(), sessions.bridge_caller)

        async def check():
            with tempfile.TemporaryDirectory(prefix="bridge-artifact-", dir="/tmp") as directory:
                async with local_listener(router, Path(directory)) as endpoint:
                    environment = {
                        **os.environ,
                        BRIDGE_SOCKET_ENV: str(endpoint),
                        BRIDGE_SESSION_ENV: CALLER,
                        BRIDGE_TOKEN_ENV: CAPABILITY,
                    }
                    result = await asyncio.to_thread(
                        subprocess.run,
                        [
                            sys.executable,
                            "-m",
                            "service.cli.bridge",
                            "artifact",
                            "publish",
                            "--json",
                            '{"path":"outputs/report.md","role":"final"}',
                        ],
                        env=environment,
                        capture_output=True,
                        text=True,
                        timeout=CLI_TIMEOUT,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(
                        json.loads(result.stdout)["artifact"]["path"], "outputs/report.md"
                    )
                    async with httpx.AsyncClient(
                        transport=httpx.AsyncHTTPTransport(uds=str(endpoint)),
                        base_url="http://localhost",
                        trust_env=False,
                    ) as client:
                        self.assertEqual(
                            (await client.post(ARTIFACT_PUBLISH_ROUTE, json={})).status_code,
                            403,
                        )
            self.assertEqual(len(published), 1)

        asyncio.run(check())


class ProjectHistoryContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="scholarseed-project-history-")
        self.root = str(Path(self.temp.name).resolve())
        self.project = ProjectRef("project", "项目历史", self.root)
        self.catalog = SessionCatalogStore(Path(self.root) / "sessions.sqlite3")
        self.events = ProductEventStore(self.catalog.database)
        self.history = HistoryService(
            self.catalog, self.events, project_for_session=lambda _: self.project
        )
        self.scope = HistoryScope("project-turn", self.project.id, 100.0)
        self.register(CALLER)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def register(
        self,
        session_id: str,
        *,
        owner: str = "local",
        project: str | None = None,
        runtime: str = RUNTIME_ID,
        created_at: float = 1.0,
    ) -> None:
        self.catalog.register(
            session_id,
            SessionPrincipal(owner),
            runtime_id=runtime,
            vendor_thread_id=session_id,
            vendor_session_id=None,
            runtime_workdir=self.root,
            project_path=project or self.root,
            output_root=self.root,
            codex_version="contract",
            model_id="contract",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=created_at,
        )

    def test_project_discovery_is_metadata_only_and_filters_before_pagination(self) -> None:
        expected = [f"source-{index:03}" for index in range(40)]
        for session in expected:
            self.register(session, runtime="other-runtime")
        self.register(FOREIGN, owner="foreign")
        self.register(OUTSIDE, project=str(Path(self.root) / "other"))
        self.register("future", created_at=self.scope.created_at + 1)
        found = []
        cursor = ""
        with patch.object(
            self.events, "portable_history", side_effect=AssertionError("list read body")
        ):
            while True:
                page = self.history.query(CALLER, self.scope, HistoryList(limit=7, cursor=cursor))
                found.extend(row["session_id"] for row in page["sessions"])
                self.assertTrue(all("text" not in row for row in page["sessions"]))
                cursor = page["next_cursor"]
                if not cursor:
                    break
        self.assertEqual(found, expected)
        for target in (FOREIGN, OUTSIDE, CALLER, "future"):
            with self.assertRaisesRegex(HistoryError, "scope_forbidden"):
                self.history.query(CALLER, self.scope, HistoryRead(session_id=target))

    def test_empty_project_and_no_matches_are_success(self) -> None:
        self.assertEqual(self.history.query(CALLER, self.scope, HistoryList())["sessions"], [])
        self.register(SOURCE)
        self.assertEqual(
            self.history.query(CALLER, self.scope, HistorySearch(query="不存在"))["messages"], []
        )
        self.assertEqual(
            self.history.query(CALLER, self.scope, HistoryRead(session_id=SOURCE))["messages"], []
        )

    def test_search_and_read_default_to_current_project(self) -> None:
        self.register(SOURCE)
        self.events.append(
            session_id=SOURCE,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=SOURCE,
            vendor_turn_id="fact",
            vendor_item_id="fact",
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"text": "项目方案：先 list 再 read", "client_turn_id": "fact"},
            idempotency_key="fact",
        )
        search = self.history.query(CALLER, self.scope, HistorySearch(query="项目方案"))
        self.assertEqual(search["messages"][0]["session_id"], SOURCE)
        read = self.history.query(CALLER, self.scope, HistoryRead(session_id=SOURCE))
        self.assertEqual(read["messages"][0]["text"], "项目方案：先 list 再 read")

    def test_explicit_references_do_not_expand_to_project(self) -> None:
        self.register(SOURCE)
        self.register(OUTSIDE)
        scope = replace(
            self.scope, refs=(ContextRef("ref", ContextRefKind.SESSION, SOURCE, SOURCE),)
        )
        self.assertEqual(
            [
                row["session_id"]
                for row in self.history.query(CALLER, scope, HistoryList())["sessions"]
            ],
            [SOURCE],
        )
        with self.assertRaisesRegex(HistoryError, "scope_forbidden"):
            self.history.query(CALLER, scope, HistoryRead(session_id=OUTSIDE))
        with self.assertRaisesRegex(HistoryError, "history_source_unavailable"):
            self.history.query(CALLER, replace(scope, unavailable=True), HistoryList())

    def test_equal_search_scores_prefer_recent_session_then_recent_message(self) -> None:
        for session, created_at in (("older", 1.0), ("newer", 2.0)):
            self.register(session, created_at=created_at)
            for index in range(2):
                message_id = f"{session}-{index}"
                self.events.append(
                    session_id=session,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=session,
                    vendor_turn_id=message_id,
                    vendor_item_id=message_id,
                    kind=PRODUCT_EVENT_USER_MESSAGE,
                    payload={"text": f"方案 {message_id}", "client_turn_id": message_id},
                    idempotency_key=message_id,
                )
        result = self.history.query(CALLER, self.scope, HistorySearch(query="方案"))
        self.assertEqual(
            [row["text"] for row in result["messages"]],
            ["方案 newer-1", "方案 newer-0", "方案 older-1", "方案 older-0"],
        )

    def test_project_identity_and_list_cursor_are_bound(self) -> None:
        self.register(SOURCE)
        self.register(OUTSIDE)
        first = self.history.query(CALLER, self.scope, HistoryList(limit=1))
        with self.assertRaisesRegex(HistoryError, "cursor_invalid_or_stale"):
            self.history.query(
                CALLER,
                replace(self.scope, snapshot_id="other-turn"),
                HistoryList(cursor=first["next_cursor"]),
            )
        self.register("new-source")
        with self.assertRaisesRegex(HistoryError, "cursor_invalid_or_stale"):
            self.history.query(CALLER, self.scope, HistoryList(cursor=first["next_cursor"]))
        self.project = replace(self.project, id="other-project")
        with self.assertRaisesRegex(HistoryError, "history_project_unavailable"):
            self.history.query(CALLER, self.scope, HistoryList())

    def test_shared_ownership_uses_product_policy(self) -> None:
        self.register(FOREIGN, owner="foreign")
        catalog = SessionCatalogStore(self.catalog.database, shared_ownership=True)
        history = HistoryService(catalog, self.events, project_for_session=lambda _: self.project)
        self.assertEqual(
            [
                row["session_id"]
                for row in history.query(CALLER, self.scope, HistoryList())["sessions"]
            ],
            [FOREIGN],
        )
        self.assertTrue(history.query(CALLER, self.scope, HistoryRead(session_id=FOREIGN))["ok"])


if __name__ == "__main__":
    unittest.main()
