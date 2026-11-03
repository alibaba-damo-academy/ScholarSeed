"""Current-project resource listing Bridge contracts with real file-backed content."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from service.cli.bridge import parser
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
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


class ResourceBridgeContracts(unittest.TestCase):
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

    def test_read_accepts_optional_project_without_expanding_listing(self) -> None:
        query = ResourceRead.model_validate(
            {"path": "resources/foreign.md", "project_id": self.other_project.id}
        )
        self.assertEqual(query.project_id, self.other_project.id)
        with self.assertRaises(ValidationError):
            ResourceList.model_validate({"project_id": self.other_project.id})

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
