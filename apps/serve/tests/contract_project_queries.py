"""Project query contracts against real content, version and literature stores."""

from __future__ import annotations

import sys
import unittest
from dataclasses import replace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from service.chat.api.queries import register_project_queries
from service.chat.service.contracts import describe_contract, list_contracts
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem, LiteratureNote
from service.literature.service.queries import LiteratureQueries
from service.platform.bridge import BRIDGE_REQUESTS
from service.platform.queries import ContractList
from service.platform.resources import VersionOrigin
from service.platform.vocabulary import BRIDGE_ROUTE_PREFIX
from service.resources.service.history import ResourceVersionService
from service.resources.service.queries import ResourceQueries
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

from . import contract_resource_bridge, run_all
from .contract_resource_versions import VersionSettings


class ProjectQueryContracts(contract_resource_bridge.ResourceBridgeContracts):
    def setUp(self):
        super().setUp()
        self.live.attachment_generation = 1
        self.versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, VersionSettings()),
            WorkbenchFormatPolicy(),
            PdfRecordStore(self.content),
        )
        self.resources = ResourceQueries(self.content, self.versions)
        self.repository = LiteratureRepository(str(self.root / "literature.sqlite3"))
        self.paper = LiteratureItem(
            id="paper",
            title="Alpha paper",
            authors="Author",
            doi="10.123/test",
            abstract="Abstract only",
            notes=(LiteratureNote("note", "private note"),),
        )
        self.repository.save(self.paper, self.project.id)
        self.repository.save(
            replace(self.paper, id="foreign", title="Foreign paper"), self.other_project.id
        )
        self.literature = LiteratureQueries(self.repository)
        self.handlers = {
            ("resource", "search"): self.resources.search,
            ("resource", "stat"): self.resources.stat,
            ("resource", "versions"): self.resources.versions,
            ("resource", "diff"): self.resources.diff,
            ("literature", "search"): self.literature.search,
            ("literature", "detail"): self.literature.detail,
        }

    def _query_client(self):
        app = FastAPI()
        register_project_queries(app, self.sessions, self.handlers, activities=self.activities)
        return TestClient(app)

    def query(self, capability, operation, payload):
        with self._query_client() as client:
            return client.post(
                BRIDGE_ROUTE_PREFIX + capability + "/" + operation,
                json=payload,
                headers=self.headers,
            )

    def test_directory_is_bounded_and_same_registry(self):
        keys = []
        offset = 0
        while True:
            result = list_contracts(ContractList(offset=offset, limit=3))
            keys.extend((item["capability"], item["operation"]) for item in result["entries"])
            offset = result["next_offset"]
            if offset is None:
                break
        self.assertEqual(keys, sorted(BRIDGE_REQUESTS))
        result = list_contracts(ContractList(capability="resource"), project_id="")
        new = next(item for item in result["entries"] if item["operation"] == "stat")
        self.assertEqual(new["availability"]["reason"], "project_required")
        self.assertIsNone(describe_contract("plan", "write")["response_schema"])

    def test_new_response_contracts_match_real_queries(self):
        requests = {
            ("resource", "search"): {"query": "a.md"},
            ("resource", "stat"): {"path": "resources/a.md"},
            ("resource", "versions"): {"path": "resources/a.md"},
            ("literature", "search"): {"query": "Alpha"},
            ("literature", "detail"): {"literature_id": "paper"},
        }
        for key, payload in requests.items():
            with self.subTest(key=key):
                response = self.query(*key, payload)
                self.assertEqual(response.status_code, 200, response.text)
                Draft202012Validator(describe_contract(*key)["response_schema"]).validate(
                    response.json()
                )
                self.assertNotIn("private note", response.text)
                self.assertNotIn(self.other_project.id, response.text)

    def test_query_rejects_no_project_extra_scope_and_anonymous(self):
        for key in self.handlers:
            with self.subTest(key=key):
                response = self.query(*key, {"project_id": self.other_project.id})
                self.assertEqual(response.status_code, 400)
                with self._query_client() as client:
                    self.assertEqual(
                        client.post(BRIDGE_ROUTE_PREFIX + "/".join(key), json={}).status_code, 403
                    )
        self.live.project_id = ""
        self.assertEqual(self.query("literature", "search", {}).json()["error"], "project_required")

    def test_hidden_and_cross_project_targets_are_rejected(self):
        for path in (
            "../foreign.md",
            "resources/.hidden.md",
            ".scholarseed/service/project.sqlite3",
            "resources/foreign.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.query("resource", "stat", {"path": path}).status_code, 400)
        self.assertEqual(
            self.query("literature", "detail", {"literature_id": "foreign"}).status_code, 400
        )
        payload = self.query("literature", "search", {"query": "Foreign"}).json()
        self.assertEqual(payload["items"], [])

    def test_attachment_generation_change_discards_result(self):
        original = self.resources.search

        def changed(project_id, command):
            result = original(project_id, command)
            self.live.attachment_generation += 1
            return result

        self.handlers[("resource", "search")] = changed
        response = self.query("resource", "search", {"query": "alpha"})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("entries", response.json())

    def test_search_rechecks_revoked_roots(self):
        original = self.content.search

        def revoke(project_id, query):
            result = original(project_id, query)
            self.content.revoke_root(self.linked.root_id, project_id)
            return result

        with patch.object(self.content, "search", side_effect=revoke):
            response = self.query("resource", "search", {"query": "linked.md"})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("entries", response.json())

    def test_oversized_metadata_is_rejected_without_content(self):
        self.repository.save(replace(self.paper, abstract="secret" * 20000), self.project.id)
        result = self.query("literature", "detail", {"literature_id": "paper"})
        self.assertEqual(result.status_code, 400)
        self.assertNotIn("secret", result.text)

    def test_queries_never_capture_or_observe_versions(self):
        with patch.object(self.versions, "observe", side_effect=AssertionError("write")):
            for operation in ("stat", "versions"):
                self.assertEqual(
                    self.query("resource", operation, {"path": "resources/a.md"}).status_code, 200
                )

    def test_search_paginates_without_foreign_results(self):
        first = self.query("literature", "search", {"limit": 1}).json()
        self.assertEqual([item["id"] for item in first["items"]], ["paper"])
        self.repository.save(replace(self.paper, id="second"), self.project.id)
        first = self.query("literature", "search", {"limit": 1}).json()
        second = self.query(
            "literature", "search", {"limit": 1, "offset": first["next_offset"]}
        ).json()
        self.assertEqual({first["items"][0]["id"], second["items"][0]["id"]}, {"paper", "second"})
        self.assertIsNone(second["next_offset"])

    def test_literature_detail_returns_project_scoped_navigation_not_fulltext(self):
        response = self.query("literature", "detail", {"literature_id": self.paper.id})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        source = urlsplit(payload["source_url"])
        self.assertEqual(source.path, f"/api/v1/literatures/{self.paper.id}")
        self.assertEqual(parse_qs(source.query), {"project_id": [self.project.id]})
        self.assertEqual(payload["abstract"], "Abstract only")
        self.assertIn("not full-text evidence", payload["notice"])
        self.assertEqual(
            self.query("literature", "detail", {"literature_id": "foreign"}).status_code, 400
        )

    def test_explicit_version_diff_and_paging(self):
        first = self.versions.seal(self.project.id, "resources/a.md", VersionOrigin.USER).version
        self.content.write_text(self.project.id, "resources/a.md", "changed\n")
        second = self.versions.seal(self.project.id, "resources/a.md", VersionOrigin.USER).version
        page = self.query("resource", "versions", {"path": "resources/a.md", "limit": 1})
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["versions"][0]["id"], second.id)
        self.assertIsNotNone(page.json()["next_sequence"])
        result = self.query(
            "resource", "diff", {"version_id": first.id, "base_version_id": second.id, "limit": 5}
        )
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(result.json()["diff"]), 5)
        self.assertEqual(result.json()["next_offset"], 5)
        self.content.rename(self.project.id, "resources/a.md", "renamed.md")
        self.versions.record_moves(self.project.id, (("resources/a.md", "resources/renamed.md"),))
        renamed = self.query(
            "resource", "diff", {"version_id": first.id, "base_version_id": second.id}
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        other = self.versions.seal(
            self.other_project.id, "resources/foreign.md", VersionOrigin.USER
        ).version
        self.assertEqual(
            self.query(
                "resource", "diff", {"version_id": first.id, "base_version_id": other.id}
            ).status_code,
            400,
        )


QUERY_CASES = (
    "test_schema_is_cursor_based_and_excludes_scope_inputs",
    "test_cli_and_transport_map_expose_resource_list",
    "test_cli_and_transport_map_expose_resource_read",
    "test_route_reads_project_and_linked_files_without_exposing_absolute_paths",
    "test_route_reads_bounded_base64_chunks",
    "test_route_rejects_unavailable_and_missing_files",
    "test_route_requires_active_private_session_scope",
    "test_route_requires_a_session_bound_project",
    "test_route_lists_flat_project_relative_pages_without_cross_project_leakage",
    "test_route_warns_when_an_authorized_root_is_unavailable",
    "test_route_rejects_invalid_parameters",
    "test_foreign_read_requires_the_active_frozen_explicit_file",
    "test_read_accepts_optional_project_without_expanding_listing",
    "test_route_discards_a_listing_if_the_turn_changes_during_scan",
    "test_directory_is_bounded_and_same_registry",
    "test_new_response_contracts_match_real_queries",
    "test_query_rejects_no_project_extra_scope_and_anonymous",
    "test_hidden_and_cross_project_targets_are_rejected",
    "test_attachment_generation_change_discards_result",
    "test_search_rechecks_revoked_roots",
    "test_oversized_metadata_is_rejected_without_content",
    "test_queries_never_capture_or_observe_versions",
    "test_search_paginates_without_foreign_results",
    "test_literature_detail_returns_project_scoped_navigation_not_fulltext",
    "test_explicit_version_diff_and_paging",
)


class QueryDiscovery(unittest.TestCase):
    def case_ids(self, suite: unittest.TestSuite) -> list[str]:
        identities = []
        for item in suite:
            if isinstance(item, unittest.TestSuite):
                identities.extend(self.case_ids(item))
            else:
                identities.append(item.id())
        return identities

    def assert_collection(self):
        loaded = unittest.TestLoader().loadTestsFromModule(sys.modules[__name__])
        actual = self.case_ids(loaded)
        expected = [f"{__name__}.ProjectQueryContracts.{name}" for name in QUERY_CASES]
        expected.append(f"{__name__}.QueryDiscovery.test_collection_owns_only_its_cases")
        self.assertEqual(sorted(actual), sorted(expected))

    def test_collection_owns_only_its_cases(self):
        self.assert_collection()
        self.assertIn("contract_resource_bridge", run_all.SUITES)
        self.assertIn("contract_project_queries", run_all.SUITES)
        with patch.dict(
            vars(sys.modules[__name__]),
            {"ImportedBridge": contract_resource_bridge.ResourceBridgeContracts},
        ):
            with self.assertRaises(AssertionError):
                self.assert_collection()
        with patch.object(
            ProjectQueryContracts, "test_directory_is_bounded_and_same_registry", None
        ):
            with self.assertRaises(AssertionError):
                self.assert_collection()


if __name__ == "__main__":
    unittest.main()
