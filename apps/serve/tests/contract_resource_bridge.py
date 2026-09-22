"""Current-project resource listing Bridge contracts with real file-backed content."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from service.cli.bridge import parser
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.bridge import (
    BRIDGE_REQUESTS,
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    RESOURCE_CURSOR_CHARS,
    RESOURCE_ROUTE_PREFIX,
    RESOURCE_SCOPE,
    RESOURCE_UNAVAILABLE_WARNING,
    ResourceList,
)
from service.platform.content import RootKind
from service.resources.api.bridge import register_resource_bridge


class ResourceBridgeContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        workspace = self.root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog)
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
            project_id=self.project.id,
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

    def _client(self, content=None) -> TestClient:
        app = FastAPI()
        register_resource_bridge(app, self.sessions, content or self.content)
        return TestClient(app)

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
            BRIDGE_REQUESTS[("resource", "list")],
            (ResourceList, RESOURCE_ROUTE_PREFIX + "list"),
        )

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
