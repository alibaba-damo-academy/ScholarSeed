"""Session admission and real-store taxonomy operations through HTTP."""

from __future__ import annotations

import asyncio
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.runtime.tools import execute_service_tool
from service.chat.service.contracts import describe_contract
from service.cli.bridge import execute
from service.literature.api.taxonomy import register_taxonomy_bridge
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.taxonomy import LiteratureTaxonomyService
from service.platform.taxonomy import TAXONOMY_REQUESTS, CollectionCreate
from service.platform.vocabulary import (
    BRIDGE_ROUTE_PREFIX,
    BRIDGE_SESSION_ENV,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
)

from . import contract_resource_bridge as resource_fixtures


class TaxonomyBridgeContracts(unittest.TestCase):
    def setUp(self):
        resource_fixtures.ResourceBridgeContracts.setUp(self)
        self.live.activation_lock = asyncio.Lock()
        self.live.bridge_activity = self.turn_activity
        self.live.runtime_workdir = self.root
        self.repository = LiteratureRepository(self.root / "literature.sqlite3")
        self.repository.save(LiteratureItem(id="paper", title="Paper"), self.project.id)
        self.repository.save(LiteratureItem(id="foreign", title="Foreign"), self.other_project.id)
        app = FastAPI()
        register_taxonomy_bridge(
            app,
            self.sessions,
            LiteratureTaxonomyService(self.repository),
            activities=self.activities,
        )
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def tearDown(self):
        resource_fixtures.ResourceBridgeContracts.tearDown(self)

    def call(self, operation, payload, headers=None):
        return self.client.post(
            BRIDGE_ROUTE_PREFIX + "literature/" + operation,
            json=payload,
            headers=headers or self.headers,
        )

    def test_management_is_discoverable_without_skill_changes(self):
        for operation in TAXONOMY_REQUESTS:
            contract = describe_contract("literature", operation, project_id=self.project.id)
            self.assertTrue(contract["ok"])
            self.assertIn("global", contract["guidance"])
            self.assertIsNotNone(contract["response_schema"])
            self.assertEqual(contract["approval"], "none")

    def test_create_and_organize_keep_other_relationships_and_reject_foreign_items(self):
        collection = self.call("collection.create", {"name": "Agents"}).json()["items"][0]
        tag = self.call("tag.create", {"name": "Read"}).json()["items"][0]
        response = self.call(
            "organize",
            {
                "literature_ids": ["paper"],
                "collection_ids": [collection["id"]],
                "tag_ids": [tag["id"]],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["literature_ids"], ["paper"])
        response = self.call(
            "organize",
            {"literature_ids": ["paper", "foreign"], "tag_ids": [tag["id"]], "action": "remove"},
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.repository.get("paper").tags, ("Read",))
        self.assertFalse(self.repository.project_collections("foreign", self.project.id))

    def test_stale_turn_and_bad_token_are_denied_before_mutation(self):
        original = CollectionCreate.model_validate

        def parse(payload):
            query = original(payload)
            self.live.ledger.active_turn_id = "changed"
            return query

        with patch.object(CollectionCreate, "model_validate", side_effect=parse):
            response = self.call("collection.create", {"name": "Denied"})
        self.assertEqual(response.status_code, 403)
        response = self.call(
            "tag.create", {"name": "Denied"}, {**self.headers, BRIDGE_TOKEN_HEADER: "bad"}
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.repository.collections(self.project.id), [])
        self.assertEqual(self.repository.tags(), [])

    def test_project_and_unknown_parameters_cannot_be_supplied_by_agent(self):
        self.assertEqual(
            self.call("tag.create", {"name": "Tag", "project_id": "other"}).status_code, 400
        )
        self.live.project_id = ""
        response = self.call("tag.create", {"name": "Tag"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.repository.tags(), [])

    def test_update_transport_preserves_omitted_and_explicit_parent(self):
        payloads = []

        def respond(request):
            payloads.append(json.loads(request.content))
            return httpx.Response(200, json={"ok": True})

        transport = httpx.MockTransport(respond)
        async_client, sync_client = httpx.AsyncClient, httpx.Client
        environment = {
            INTERNAL_BASE_URL_ENV: "http://localhost",
            BRIDGE_SESSION_ENV: "session",
            BRIDGE_TOKEN_ENV: "token",
            BRIDGE_SOCKET_ENV: "",
        }
        for parameters in (
            {"id": "child", "name": "Renamed"},
            {"id": "child", "parent_id": None},
            {"id": "child", "parent_id": "parent"},
        ):
            with (
                patch.dict(os.environ, environment),
                patch(
                    "service.chat.runtime.tools.httpx.AsyncClient",
                    side_effect=lambda **options: async_client(transport=transport),
                ),
            ):
                result = asyncio.run(
                    execute_service_tool(
                        {
                            "capability": "literature",
                            "operation": "collection.update",
                            "request": parameters,
                        },
                        session_id="session",
                        token="token",
                        local_socket=Path("socket"),
                    )
                )
            self.assertTrue(result["ok"])
            self.assertEqual(payloads[-1], parameters)
            with (
                patch.dict(os.environ, environment),
                patch(
                    "service.platform.channel.httpx.Client",
                    side_effect=lambda **options: sync_client(transport=transport),
                ),
            ):
                self.assertTrue(
                    execute("literature", "collection.update", json.dumps(parameters))["ok"]
                )
            self.assertEqual(payloads[-1], parameters)

    def test_rename_keeps_parent_and_move_keeps_name(self):
        parent = self.call("collection.create", {"name": "Parent"}).json()["items"][0]
        child = self.call("collection.create", {"name": "Child", "parent_id": parent["id"]}).json()[
            "items"
        ][0]
        renamed = self.call("collection.update", {"id": child["id"], "name": "Renamed"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["items"][0]["parent_id"], parent["id"])
        moved = self.call("collection.update", {"id": child["id"], "parent_id": None})
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["items"][0]["name"], "Renamed")
        self.assertIsNone(moved.json()["items"][0]["parent_id"])


if __name__ == "__main__":
    unittest.main()
