"""Current-project resource listing Bridge contracts with real file-backed content."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.runtime.interaction import SessionInteractions
from service.chat.service.sessions import SessionService
from service.cli.bridge import parser
from service.content.persistence.catalog import ContentCatalog
from service.content.service import external
from service.content.service.context import ContentContextProvider
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    BLOCKING_OPERATIONS,
    BRIDGE_REQUESTS,
    RESOURCE_CURSOR_CHARS,
    RESOURCE_ROUTE_PREFIX,
    RESOURCE_SCOPE,
    RESOURCE_UNAVAILABLE_WARNING,
    ResourceList,
    ResourceRead,
)
from service.platform.content import RootKind
from service.platform.context import ContextOrigin, ContextRefKind, ContextResolutionState
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
from service.resources.api.bridge import register_resource_bridge


class ResourceBridgeFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        workspace = self.root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.activities = Activities()
        self.turn_activity = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(self.turn_activity.close)
        self.content = ContentService(registry, catalog, activities=self.activities)
        self.project = self.content.create_project("当前项目")
        self.other_project = self.content.create_project("其他项目")

        self.content.write_text(
            self.project.id,
            self.content.within_root(self.project.id, RootKind.RESOURCES, "a.md"),
            "alpha",
        )
        self.content.write_text(
            self.project.id,
            self.content.within_root(self.project.id, RootKind.RESOURCES, "b.txt"),
            "bravo",
        )
        self.content.write_text(
            self.other_project.id,
            self.content.within_root(self.other_project.id, RootKind.RESOURCES, "foreign.md"),
            "foreign",
        )

        self.external = self.root / "external"
        self.external.mkdir()
        (self.external / "linked.md").write_text("linked", encoding="utf-8")
        self.linked = self.content.authorize_root(self.project.id, str(self.external), "linked")

        unavailable_source = self.root / "unavailable"
        unavailable_source.mkdir()
        self.unavailable = self.content.authorize_root(
            self.project.id, str(unavailable_source), "unavailable"
        )
        unavailable_source.rename(self.root / "moved-unavailable")

        resources_root = Path(
            self.content.resolve(
                self.project.id, self.content.root(self.project.id, RootKind.RESOURCES).path
            )
        )
        (resources_root / ".hidden.md").write_text("hidden", encoding="utf-8")

        self.live = SimpleNamespace(
            id="session",
            bridge_token="token",
            turn_activity=self.turn_activity,
            project_id=self.project.id,
            active_assistant_snapshot_id="",
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=AsyncMock(),
        )
        self.sessions = SimpleNamespace(
            bridge_caller=lambda session_id: self.live if session_id == self.live.id else None
        )
        self.headers = {
            BRIDGE_SESSION_HEADER: self.live.id,
            BRIDGE_TOKEN_HEADER: self.live.bridge_token,
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _client(self, content=None, **options) -> TestClient:
        app = FastAPI()
        register_resource_bridge(
            app, self.sessions, content or self.content, activities=self.activities, **options
        )
        return TestClient(app)


class ResourceBridgeContracts(ResourceBridgeFixture):
    def external_client(self, *, mode="ask", answer="allow_file_read", explicit=True, change=None):
        self.external_file = self.root / "outside.txt"
        if not self.external_file.exists():
            self.external_file.write_text("external evidence", encoding="utf-8")
        self.live.applied_permission_mode = mode
        self.live.active_product_turn_id = "product-turn"
        self.live.interrupt_generation = 0
        self.live.attachment_generation = 0
        self.live.last_submission_id = "submission"
        self.live.terminating = False
        self.live.terminated = False
        catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        self.approval_catalog = catalog
        catalog.register(
            self.live.id,
            SessionPrincipal("owner"),
            runtime_id="codex",
            runtime_workdir=str(self.root),
            project_path=self.project.root,
            output_root=str(self.root),
            model_id="test-model",
            vendor_thread_id="native-thread",
            vendor_session_id=None,
            codex_version=None,
            policy_id=mode,
            status=SessionStatus.READY,
            title="External read",
            created_at=1.0,
        )
        self.approvals = []

        async def publish(kind, payload, **kwargs):
            if kind != "hil_requested":
                return
            self.approvals.append(payload)
            if payload.get("state") == "resolved":
                return
            question = payload["questions"][0]
            if change is not None:
                change()
            decision = {"answers": {question["id"]: answer}}
            catalog.resolve_hil(question["id"], decision)
            asyncio.get_running_loop().call_soon(
                self.live.interactions._product_waiters[question["id"]].set_result, decision
            )

        self.live.interactions = SessionInteractions(self.live.id, catalog, publish)
        return self._client(
            user_message=lambda session, turn: (
                f"Read `{self.external_file}`" if explicit else "Read references"
            )
        )

    def test_external_read_waits_for_approval_and_does_not_register_a_mount(self):
        with self.external_client() as client:
            before = self.content.external_roots(self.project.id)
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(self.external_file)},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["content"], "external evidence")
        self.assertNotIn("source_url", response.json())
        self.assertEqual(self.content.external_roots(self.project.id), before)
        self.assertEqual(len(self.approvals), 1)
        self.assertEqual(
            self.approvals[0]["questions"][0]["question"], str(self.external_file.resolve())
        )

    def test_external_read_denial_is_reused_after_mode_switch(self):
        with self.external_client(answer="deny_file_read") as client:
            for mode in ("ask", "safe_auto", "bypassPermissions"):
                self.live.applied_permission_mode = mode
                response = client.post(
                    RESOURCE_ROUTE_PREFIX + "read-external",
                    headers=self.headers,
                    json={"path": str(self.external_file)},
                )
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(response.json()["error"], "external_read_denied")
        self.assertEqual(len(self.approvals), 1)

    def test_external_safe_auto_uses_resolved_receipt_for_explicit_document(self):
        with self.external_client(mode="safe_auto", answer="deny_file_read") as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(self.external_file)},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.approvals[0]["state"], "resolved")

    def test_external_safe_auto_without_user_path_falls_back_to_manual(self):
        with self.external_client(
            mode="safe_auto", explicit=False, answer="deny_file_read"
        ) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(self.external_file)},
            )
        self.assertEqual(response.status_code, 403, response.text)
        self.assertNotEqual(self.approvals[0].get("state"), "resolved")

    def test_external_approval_responses_require_the_trusted_host(self):
        with self.external_client() as client:
            client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(self.external_file)},
            )
        request_id = self.approvals[0]["questions"][0]["id"]
        service = SimpleNamespace(_access=self.approval_catalog)
        self.assertTrue(SessionService.requires_host_for_hil(service, request_id))

    def test_external_chunks_reuse_permission_but_other_files_do_not(self):
        with self.external_client() as client:
            for offset in (0, 3):
                response = client.post(
                    RESOURCE_ROUTE_PREFIX + "read-external",
                    headers=self.headers,
                    json={"path": str(self.external_file), "offset": offset, "limit": 3},
                )
                self.assertEqual(response.status_code, 200, response.text)
            other = self.root / "second.txt"
            other.write_text("second", encoding="utf-8")
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(other)},
            )
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.approvals), 2)

    def test_external_read_rejects_replacement_during_approval(self):
        def replace():
            self.external_file.rename(self.root / "old.txt")
            self.external_file.write_text("replacement", encoding="utf-8")

        with self.external_client(change=replace) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(self.external_file)},
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["error"], "external_file_changed")

    def test_external_read_rejects_cancelled_task_after_approval(self):
        def cancel():
            self.live.interrupt_generation += 1

        with self.external_client(change=cancel) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(self.external_file)},
            )
        self.assertEqual(response.status_code, 403, response.text)

    def test_external_read_rejects_directories_symlinks_and_relative_paths(self):
        with self.external_client() as client:
            linked = self.root / "symlink.txt"
            linked.symlink_to(self.external_file)
            for path in (str(self.root), str(linked), "outside.txt"):
                response = client.post(
                    RESOURCE_ROUTE_PREFIX + "read-external",
                    headers=self.headers,
                    json={"path": path},
                )
                self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.approvals, [])

    def test_project_read_rejects_external_path_with_actionable_error(self):
        with self._client() as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read",
                headers=self.headers,
                json={"path": str(self.external / "linked.md")},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("read-external", response.json()["error"])

    def test_external_contract_and_cli_are_registered_as_long_wait(self):
        command = parser().parse_args(
            ["resource", "read-external", "--json", '{"path":"/example.txt"}']
        )
        self.assertEqual((command.capability, command.operation), ("resource", "read-external"))
        self.assertIn(("resource", "read-external"), BLOCKING_OPERATIONS)
        contract = BRIDGE_REQUESTS[("resource", "read-external")]
        with self.assertRaises(ValidationError):
            contract.request_type.model_validate({"path": "/example.txt", "authorized": True})

    def test_external_new_turn_does_not_inherit_approval(self):
        with self.external_client() as client:
            for turn in ("turn", "next-turn"):
                self.live.ledger.active_turn_id = turn
                response = client.post(
                    RESOURCE_ROUTE_PREFIX + "read-external",
                    headers=self.headers,
                    json={"path": str(self.external_file)},
                )
                self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.approvals), 2)

    def test_external_changed_file_cannot_reuse_prior_approval(self):
        with self.external_client() as client:
            request = {"path": str(self.external_file)}
            self.assertEqual(
                client.post(
                    RESOURCE_ROUTE_PREFIX + "read-external", headers=self.headers, json=request
                ).status_code,
                200,
            )
            self.external_file.write_text("changed content", encoding="utf-8")
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external", headers=self.headers, json=request
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["error"], "external_file_changed")
        self.assertEqual(len(self.approvals), 1)

    def test_external_sensitive_file_requires_manual_approval_in_safe_auto(self):
        with self.external_client(mode="safe_auto", answer="deny_file_read") as client:
            sensitive = self.root / ".private.txt"
            sensitive.write_text("private", encoding="utf-8")
            self.external_file = sensitive
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(sensitive)},
            )
        self.assertEqual(response.status_code, 403, response.text)
        self.assertNotEqual(self.approvals[0].get("state"), "resolved")

    def test_external_product_private_file_is_not_approvable(self):
        with self.external_client(mode="bypassPermissions") as client:
            private = self.root / ".scholarseed"
            private.mkdir()
            target = private / "secret.txt"
            target.write_text("secret", encoding="utf-8")
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(target)},
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["error"], "external_file_forbidden")
        self.assertEqual(self.approvals, [])

    def test_external_parent_replacement_cannot_change_approved_file(self):
        def replace():
            parent = self.external_file.parent
            parent.rename(parent.with_name("previous-parent"))
            parent.mkdir()
            self.external_file.write_text("replacement", encoding="utf-8")

        with self.external_client(change=replace) as client:
            parent = self.root / "parent"
            parent.mkdir()
            self.external_file = parent / "test.txt"
            self.external_file.write_text("approved", encoding="utf-8")
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(self.external_file)},
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["error"], "external_file_changed")

    def test_external_private_directory_case_alias_is_forbidden(self):
        with self.external_client(mode="bypassPermissions") as client:
            private = self.root / ".ScholarSeed"
            private.mkdir()
            target = private / "secret.txt"
            target.write_text("private", encoding="utf-8")
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-external",
                headers=self.headers,
                json={"path": str(target)},
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["error"], "external_file_forbidden")
        self.assertEqual(self.approvals, [])

    def test_external_invalid_platform_names_fail_without_approval(self):
        with self.external_client(mode="bypassPermissions") as client:
            for name in ("document.txt:stream", "document.txt.", "CON"):
                response = client.post(
                    RESOURCE_ROUTE_PREFIX + "read-external",
                    headers=self.headers,
                    json={"path": str(self.root / name)},
                )
                self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.approvals, [])

    def test_external_read_does_not_equate_windows_path_and_handle_change_times(self):
        target = self.root / "timestamps.txt"
        target.write_text("partial content", encoding="utf-8")
        actual_fstat = external.os.fstat

        def handle_stat(descriptor):
            observed = actual_fstat(descriptor)
            return SimpleNamespace(
                st_mode=observed.st_mode,
                st_nlink=observed.st_nlink,
                st_dev=observed.st_dev,
                st_ino=observed.st_ino,
                st_size=observed.st_size,
                st_mtime_ns=observed.st_mtime_ns,
                st_ctime_ns=observed.st_ctime_ns + 1,
            )

        with patch.object(external, "PATH_CHANGE_TIME_COMPARABLE", False, create=True):
            snapshot = self.content.external_file_snapshot(str(target))
            with patch.object(external.os, "fstat", side_effect=handle_stat):
                self.assertEqual(self.content.read_external_file(snapshot, 0, 7), b"partial")

    def test_read_accepts_optional_project_without_expanding_listing(self) -> None:
        query = ResourceRead.model_validate(
            {"path": "resources/foreign.md", "project_id": self.other_project.id}
        )
        self.assertEqual(query.project_id, self.other_project.id)
        with self.assertRaises(ValidationError):
            ResourceList.model_validate({"project_id": self.other_project.id})

    def test_text_read_keeps_valid_files_when_failed_file_is_removed(self) -> None:
        self.live.interactions = SimpleNamespace(
            request_product_input=AsyncMock(return_value={"cancelled": True})
        )
        with self._client(context_provider=ContentContextProvider(self.content)) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-text",
                headers=self.headers,
                json={"paths": ["resources/a.md", "resources/missing.pdf"]},
            )
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["files"][0]["text"], "alpha")
        self.assertEqual(result["removed"], ["resources/missing.pdf"])
        self.assertEqual(result["failures"][0]["path"], "resources/missing.pdf")
        self.assertEqual(self.content.read_text(self.project.id, "resources/a.md"), "alpha")

    def test_text_read_retry_reopens_only_original_failed_file(self) -> None:
        async def recover(question, **kwargs):
            self.content.write_text(self.project.id, "resources/repaired.txt", "repaired")
            return {"answers": {question["id"]: "retry_file"}}

        self.live.interactions = SimpleNamespace(
            request_product_input=AsyncMock(side_effect=recover)
        )
        with self._client(context_provider=ContentContextProvider(self.content)) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-text",
                headers=self.headers,
                json={"paths": ["resources/a.md", "resources/repaired.txt"]},
            )
        self.assertEqual([item["text"] for item in response.json()["files"]], ["alpha", "repaired"])
        self.assertEqual(self.live.interactions.request_product_input.await_count, 1)

    def test_repeated_parse_failures_have_distinct_interaction_items(self) -> None:
        requests = []

        async def recover(question, **kwargs):
            requests.append((question, kwargs))
            if len(requests) == 1:
                return {"answers": {question["id"]: "retry_file"}}
            return {"cancelled": True}

        self.live.interactions = SimpleNamespace(
            request_product_input=AsyncMock(side_effect=recover)
        )
        with self._client(context_provider=ContentContextProvider(self.content)) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-text",
                headers=self.headers,
                json={"paths": ["resources/a.md", "resources/missing.pdf"]},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(requests), 2)
        self.assertNotEqual(requests[0][1]["item_id"], requests[1][1]["item_id"])
        self.assertEqual(requests[0][0]["question"], requests[1][0]["question"])
        self.assertEqual(response.json()["files"][0]["text"], "alpha")

    def test_text_read_stale_turn_cannot_retry(self) -> None:
        async def recover(question, **kwargs):
            self.live.ledger.active_turn_id = "new-turn"
            return {"answers": {question["id"]: "retry_file"}}

        self.live.interactions = SimpleNamespace(
            request_product_input=AsyncMock(side_effect=recover)
        )
        with self._client(context_provider=ContentContextProvider(self.content)) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read-text",
                headers=self.headers,
                json={"paths": ["resources/missing.pdf"]},
            )
        self.assertEqual(response.status_code, 403)

    def test_text_read_rejects_absolute_and_parent_paths_before_provider(self) -> None:
        with self._client(context_provider=ContentContextProvider(self.content)) as client:
            for path in ("/etc/passwd", "../foreign.md", "C:/secret.txt", "resources/../secret"):
                with self.subTest(path=path):
                    response = client.post(
                        RESOURCE_ROUTE_PREFIX + "read-text",
                        headers=self.headers,
                        json={"paths": [path]},
                    )
                    self.assertEqual(response.status_code, 400)

    def test_foreign_read_requires_the_active_frozen_explicit_file(self) -> None:
        path = "resources/foreign.md"
        self.live.project_id = ""
        self.live.active_assistant_snapshot_id = "snapshot"
        reference = SimpleNamespace(
            kind=ContextRefKind.FILE,
            origin=ContextOrigin.EXPLICIT,
            project_id=self.other_project.id,
            source_id=path,
            source_revision=self.content.snapshot(self.other_project.id, path).revision,
            anchor=None,
        )
        snapshot = SimpleNamespace(
            session_id=self.live.id,
            items=(SimpleNamespace(ref=reference, state=ContextResolutionState.READY),),
        )

        def snapshot_by_id(session_id, snapshot_id):
            return snapshot if (session_id, snapshot_id) == (self.live.id, "snapshot") else None

        payload = {"path": path, "project_id": self.other_project.id}
        with self._client(snapshot_by_id=snapshot_by_id) as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read", json=payload, headers=self.headers
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["content"], "foreign")
            for field, forbidden in (
                ("origin", ContextOrigin.CURRENT_DOCUMENT),
                ("anchor", object()),
                ("kind", ContextRefKind.DIR),
                ("project_id", self.project.id),
            ):
                with self.subTest(field=field):
                    original = getattr(reference, field)
                    setattr(reference, field, forbidden)
                    denied = client.post(
                        RESOURCE_ROUTE_PREFIX + "read", json=payload, headers=self.headers
                    )
                    self.assertEqual(denied.status_code, 403)
                    setattr(reference, field, original)
            snapshot.session_id = "another-session"
            denied = client.post(RESOURCE_ROUTE_PREFIX + "read", json=payload, headers=self.headers)
            self.assertEqual(denied.status_code, 403)
            snapshot.session_id = self.live.id
            denied = client.post(
                RESOURCE_ROUTE_PREFIX + "read",
                json={**payload, "path": "resources/unselected.md"},
                headers=self.headers,
            )
            self.assertEqual(denied.status_code, 403)
            self.content.write_text(self.other_project.id, path, "changed")
            changed = client.post(
                RESOURCE_ROUTE_PREFIX + "read", json=payload, headers=self.headers
            )
            self.assertEqual(changed.status_code, 400)
            self.assertEqual(changed.json()["error"], "source_revision_changed")
            self.live.active_assistant_snapshot_id = "expired"
            expired = client.post(
                RESOURCE_ROUTE_PREFIX + "read", json=payload, headers=self.headers
            )
            self.assertEqual(expired.status_code, 403)

    def test_schema_is_cursor_based_and_excludes_scope_inputs(self) -> None:
        request = ResourceList.model_validate({"limit": 2})
        self.assertEqual(request.model_dump(), {"cursor": "", "limit": 2})
        self.assertNotIn("project_id", ResourceList.model_fields)
        self.assertNotIn("path", ResourceList.model_fields)
        self.assertNotIn("query", ResourceList.model_fields)
        for payload in (
            {"project_id": self.other_project.id},
            {"path": "foreign.md"},
            {"query": "alpha"},
            {"limit": 0},
            {"limit": 51},
            {"cursor": "x" * (RESOURCE_CURSOR_CHARS + 1)},
        ):
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                ResourceList.model_validate(payload)

    def test_cli_and_transport_map_expose_resource_list(self) -> None:
        command = parser().parse_args(["resource", "list", "--json", '{"limit":2}'])
        self.assertEqual((command.capability, command.operation), ("resource", "list"))
        self.assertEqual(
            (
                BRIDGE_REQUESTS[("resource", "list")].request_type,
                BRIDGE_REQUESTS[("resource", "list")].route,
            ),
            (ResourceList, RESOURCE_ROUTE_PREFIX + "list"),
        )

    def test_cli_and_transport_map_expose_resource_read(self) -> None:
        command = parser().parse_args(["resource", "read", "--json", '{"path":"resources/a.md"}'])
        self.assertEqual((command.capability, command.operation), ("resource", "read"))
        self.assertEqual(
            (
                BRIDGE_REQUESTS[("resource", "read")].request_type,
                BRIDGE_REQUESTS[("resource", "read")].route,
            ),
            (ResourceRead, RESOURCE_ROUTE_PREFIX + "read"),
        )

    def test_route_reads_project_and_linked_files_without_exposing_absolute_paths(self) -> None:
        with self._client() as client:
            local = client.post(
                RESOURCE_ROUTE_PREFIX + "read",
                json={"path": "resources/a.md"},
                headers=self.headers,
            )
            linked = client.post(
                RESOURCE_ROUTE_PREFIX + "read",
                json={"path": f"{self.linked.mount_path}/linked.md"},
                headers=self.headers,
            )

        self.assertEqual(local.status_code, 200, local.text)
        self.assertEqual(local.json()["content"], "alpha")
        self.assertEqual(local.json()["encoding"], "text")
        source = urlsplit(local.json()["source_url"])
        self.assertEqual(source.path, "/api/resource/raw")
        self.assertEqual(
            parse_qs(source.query), {"project": [self.project.id], "path": ["resources/a.md"]}
        )
        self.assertEqual(linked.status_code, 200, linked.text)
        self.assertEqual(linked.json()["content"], "linked")
        self.assertNotIn(str(self.external), linked.text)
        self.assertEqual(self.live.publish.await_count, 2)

    def test_route_reads_bounded_base64_chunks(self) -> None:
        with self._client() as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "read",
                json={
                    "path": "resources/b.txt",
                    "offset": 1,
                    "limit": 2,
                    "encoding": "base64",
                },
                headers=self.headers,
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["content"], "cmE=")
        self.assertFalse(payload["eof"])
        self.assertEqual(payload["size"], 5)

    def test_route_rejects_unavailable_and_missing_files(self) -> None:
        with self._client() as client:
            unavailable = client.post(
                RESOURCE_ROUTE_PREFIX + "read",
                json={"path": f"{self.unavailable.mount_path}/gone.md"},
                headers=self.headers,
            )
            missing = client.post(
                RESOURCE_ROUTE_PREFIX + "read",
                json={"path": "resources/missing.md"},
                headers=self.headers,
            )

        self.assertEqual(unavailable.status_code, 400)
        self.assertEqual(
            unavailable.json(),
            {"ok": False, "error": RESOURCE_UNAVAILABLE_WARNING},
        )
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.json(), {"ok": False, "error": "file_not_found"})

    def test_route_requires_active_private_session_scope(self) -> None:
        with self._client() as client:
            self.assertEqual(
                client.post(RESOURCE_ROUTE_PREFIX + "list", json={}).status_code,
                403,
            )
            self.live.ledger.active_turn_id = ""
            denied = client.post(RESOURCE_ROUTE_PREFIX + "list", json={}, headers=self.headers)
            self.assertEqual(denied.status_code, 403)

    def test_route_requires_a_session_bound_project(self) -> None:
        self.live.project_id = ""
        with self._client() as client:
            response = client.post(RESOURCE_ROUTE_PREFIX + "list", json={}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"ok": False, "error": "resource_project_required"})

    def test_route_lists_flat_project_relative_pages_without_cross_project_leakage(self) -> None:
        with self._client() as client:
            first = client.post(
                RESOURCE_ROUTE_PREFIX + "list",
                json={"limit": 2},
                headers=self.headers,
            )
            self.assertEqual(first.status_code, 200, first.text)
            first_payload = first.json()
            second = client.post(
                RESOURCE_ROUTE_PREFIX + "list",
                json={"cursor": first_payload["next_cursor"], "limit": 2},
                headers=self.headers,
            )
            self.assertEqual(second.status_code, 200, second.text)
            second_payload = second.json()

        entries = first_payload["entries"] + second_payload["entries"]
        paths = [entry["path"] for entry in entries]
        self.assertEqual(first_payload["scope"], RESOURCE_SCOPE)
        self.assertEqual(
            paths,
            [
                self.content.within_root(self.project.id, RootKind.RESOURCES, "a.md"),
                self.content.within_root(self.project.id, RootKind.RESOURCES, "b.txt"),
                f"{self.linked.mount_path}/linked.md",
            ],
        )
        self.assertEqual([entry["size"] for entry in entries], [5, 5, 6])
        self.assertIsNone(second_payload["next_cursor"])
        self.assertNotIn("foreign.md", str(entries))
        self.assertNotIn(".hidden.md", str(entries))
        self.assertNotIn(str(self.external), first.text + second.text)
        self.assertNotIn("project_id", first.text + second.text)

    def test_route_warns_when_an_authorized_root_is_unavailable(self) -> None:
        with self._client() as client:
            response = client.post(RESOURCE_ROUTE_PREFIX + "list", json={}, headers=self.headers)
        self.assertEqual(
            response.json()["warnings"],
            [
                {
                    "code": RESOURCE_UNAVAILABLE_WARNING,
                    "path": self.unavailable.mount_path,
                }
            ],
        )
        event, payload = self.live.publish.await_args.args
        self.assertEqual(event, "resource.listed")
        self.assertEqual(payload["warning_codes"], [RESOURCE_UNAVAILABLE_WARNING])
        self.assertNotIn(str(self.root), str(payload))

    def test_route_rejects_invalid_parameters(self) -> None:
        with self._client() as client:
            response = client.post(
                RESOURCE_ROUTE_PREFIX + "list",
                json={"project_id": self.other_project.id},
                headers=self.headers,
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"ok": False, "error": "bridge_invalid_parameters"})

    def test_route_discards_a_listing_if_the_turn_changes_during_scan(self) -> None:
        owner = self

        class SwitchingContent:
            def enumerate_resources(self, project_id: str, cursor: str | None, limit: int):
                page = owner.content.enumerate_resources(project_id, cursor, limit)
                owner.live.ledger.active_turn_id = "next-turn"
                return page

            def external_roots(self, project_id: str):
                return owner.content.external_roots(project_id)

        with self._client(SwitchingContent()) as client:
            response = client.post(RESOURCE_ROUTE_PREFIX + "list", json={}, headers=self.headers)
        self.assertEqual(response.status_code, 403)
        self.live.publish.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
