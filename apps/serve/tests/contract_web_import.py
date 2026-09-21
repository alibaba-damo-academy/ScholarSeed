"""Contract for URL references and site icons entering the project resource library."""

from __future__ import annotations

import asyncio
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.content import AssetKind, RootKind
from service.platform.resources import DEFAULT_MAX_VERSIONS_PER_FILE, SnapshotState
from service.resources.api.routes import register_resource_routes
from service.resources.persistence.catalog import (
    WEB_SOURCE_SCHEMA_VERSION,
    ResourceWebSource,
    ResourceWebSourceCatalog,
)
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService, TurnOutcome
from service.resources.service.fetcher import (
    WEB_HTTP_STATUS,
    WEB_UNSAFE_URL,
    FetchedImage,
    HtmlFetcher,
    PageFetchError,
    _FetchPolicy,
    _Response,
    _Target,
)
from service.resources.service.history import ResourceVersionService
from service.resources.service.importer import WebImporter
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.resources.service.writer import ResourceWriter
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

SUCCESS_URL = "https://public.example/article"
SITE_ICON_URL = "https://public.example/favicon.ico"
SITE_ICON_FALLBACK_URL = (
    "https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fpublic.example%2F&sz=64"
)
SEARCH_QUERY = "perovskite stability"
CONTRACT_TIMESTAMP = 1_700_000_000.0


class WebImportSettings:
    def max_versions_per_file(self) -> int:
        return DEFAULT_MAX_VERSIONS_PER_FILE

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


class SiteIconFixtureFetcher(HtmlFetcher):
    """Exercise the favicon policy without opening a real socket."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def _request(
        self,
        target: _Target,
        policy: _FetchPolicy,
        *,
        referer: str = "",
    ) -> _Response:
        self.calls.append(target.url)
        if target.url != SITE_ICON_URL:
            raise AssertionError("site icon fetch did not use the conventional origin path")
        if "image/png" not in policy.allowed_content_types or referer:
            raise AssertionError("site icon fetch did not preserve its bounded image policy")
        return _Response(
            status=200,
            headers={},
            payload=b"icon",
            media_type="image/png",
        )


class SiteIconFallbackFixtureFetcher(SiteIconFixtureFetcher):
    """Fail the conventional path and return a controlled provider image."""

    def _request(
        self,
        target: _Target,
        policy: _FetchPolicy,
        *,
        referer: str = "",
    ) -> _Response:
        self.calls.append(target.url)
        if target.url == SITE_ICON_URL:
            raise PageFetchError(WEB_HTTP_STATUS)
        if target.url != SITE_ICON_FALLBACK_URL:
            raise AssertionError("site icon fallback did not preserve the public site origin")
        if "image/png" not in policy.allowed_content_types or referer:
            raise AssertionError("site icon fallback did not preserve its bounded image policy")
        return _Response(
            status=200,
            headers={},
            payload=b"icon",
            media_type="image/png",
        )


class FailingWebSourceCatalog(ResourceWebSourceCatalog):
    """Deterministic persistence failure for compensation contract coverage."""

    def save(self, project_id: str, record: ResourceWebSource) -> ResourceWebSource:
        raise RuntimeError("fixture persistence failure")


class WebImportContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="web-import-")
        root = Path(self.temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.project = registry.create("Web Import")
        self.content = ContentService(registry, catalog)
        self.web_sources = ResourceWebSourceCatalog(self.content)
        settings = WebImportSettings()
        retention = ResourceRetentionService(self.content, settings)
        annotations = PdfRecordStore(self.content)
        self.versions = ResourceVersionService(
            self.content,
            retention,
            WorkbenchFormatPolicy(),
            annotations,
        )
        self.supervisor = ResourceVersionSupervisor(
            self.content,
            self.versions,
            WorkbenchFormatPolicy(),
            settings,
        )
        self.deliveries = ResourceDeliveryService(
            self.content,
            self.versions,
            self.supervisor,
        )
        self.supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                ResourceRecoveryService(
                    self.content,
                    retention,
                    annotations,
                ),
                self.versions,
                self.deliveries,
                retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )
        self.content.bind_resource_changes(self.supervisor)

        app = FastAPI()
        app.state.content = self.content
        app.state.resource_web_sources = self.web_sources
        app.state.web_importer = WebImporter(
            ResourceWriter(self.content),
            self.content,
            self.web_sources,
        )
        self.icon_fetcher = SiteIconFixtureFetcher()
        app.state.web_icon_fetcher = self.icon_fetcher
        register_resource_routes(app)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_literal_private_address_is_rejected_before_http(self) -> None:
        with self.assertRaises(PageFetchError) as raised:
            HtmlFetcher().fetch_site_icon("http://127.0.0.1/private")
        self.assertEqual(raised.exception.code, WEB_UNSAFE_URL)

    def test_site_icon_is_proxied_through_the_bounded_public_network_fetcher(self) -> None:
        address = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("8.8.8.8", 443),
        )
        with patch(
            "service.resources.service.fetcher.socket.getaddrinfo",
            return_value=[address],
        ):
            response = self.client.get(
                "/api/resource/web-icon",
                params={"url": SUCCESS_URL},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"icon")
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.headers["cache-control"], "private, max-age=86400")
        self.assertEqual(response.headers["cross-origin-resource-policy"], "cross-origin")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.icon_fetcher.calls, [SITE_ICON_URL])

    def test_site_icon_proxy_rejects_private_network_targets(self) -> None:
        self.client.app.state.web_icon_fetcher = HtmlFetcher()

        response = self.client.get(
            "/api/resource/web-icon",
            params={"url": "http://127.0.0.1/private"},
        )

        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"], WEB_UNSAFE_URL)

    def test_site_icon_uses_a_controlled_provider_when_the_root_icon_is_missing(self) -> None:
        address = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("8.8.8.8", 443),
        )
        fallback = SiteIconFallbackFixtureFetcher()
        self.client.app.state.web_icon_fetcher = fallback
        with patch(
            "service.resources.service.fetcher.socket.getaddrinfo",
            return_value=[address],
        ):
            response = self.client.get(
                "/api/resource/web-icon",
                params={"url": SUCCESS_URL},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"icon")
        self.assertEqual(fallback.calls, [SITE_ICON_URL, SITE_ICON_FALLBACK_URL])

    def test_default_import_writes_title_and_url_reference_without_fetch(self) -> None:
        response = self.client.post(
            "/api/resource/web-import",
            json={
                "project": self.project.id,
                "query": SEARCH_QUERY,
                "candidates": [{"title": "First", "url": SUCCESS_URL, "snippet": "one"}],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["succeeded"], 1)
        self.assertEqual(body["failed"], 0)
        self.assertEqual(body["items"][0]["status"], "success")
        # 轻路径不出站抓取，snippet/正文/图片都不落盘，正文只剩标题与可点击的 URL 链接。

        path = Path(self.project.root) / body["items"][0]["node"]["path"]
        self.assertEqual(path.name, "First.md")
        saved = path.read_text(encoding="utf-8")
        self.assertEqual(saved, f"# First\n\n[{SUCCESS_URL}](<{SUCCESS_URL}>)\n")
        self.assertNotIn("one", saved)
        self.assertFalse((path.parent / ".web-assets").exists())

        resource_path = body["items"][0]["node"]["path"]
        origin = self.web_sources.get(self.project.id, resource_path)
        self.assertIsNotNone(origin)
        assert origin is not None
        self.assertEqual(
            origin.resource_revision,
            self.content.snapshot(self.project.id, resource_path).revision,
        )
        self.assertEqual(origin.source_title, "First")
        self.assertEqual(origin.source_url, SUCCESS_URL)
        self.assertIsNone(origin.final_url)
        self.assertEqual(origin.search_query, SEARCH_QUERY)
        self.assertIsNotNone(origin.fetched_at)
        self.assertEqual(origin.schema_version, WEB_SOURCE_SCHEMA_VERSION)

        origin_response = self.client.get(
            "/api/resource/web-origin",
            params={"project": self.project.id, "path": resource_path},
        )
        self.assertEqual(origin_response.status_code, 200, origin_response.text)
        self.assertEqual(origin_response.json()["source_url"], SUCCESS_URL)
        self.assertIsNone(origin_response.json()["final_url"])

    def test_reference_link_keeps_parenthesized_url_intact(self) -> None:
        # 维基等真实 URL 含括号; 裸 `(url)` 会被第一个 `)` 截断成坏链接,
        # 轻路径必须用尖括号目标 `[u](<u>)` 保住整条 URL 可点击。
        url = "https://zh.wikipedia.org/wiki/钙钛矿_(矿物)"
        response = self.client.post(
            "/api/resource/web-import",
            json={
                "project": self.project.id,
                "query": SEARCH_QUERY,
                "candidates": [{"title": "Perovskite", "url": url, "snippet": "one"}],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["succeeded"], 1)

        path = Path(self.project.root) / body["items"][0]["node"]["path"]
        saved = path.read_text(encoding="utf-8")
        self.assertEqual(saved, f"# Perovskite\n\n[{url}](<{url}>)\n")
        # 整条带括号 URL 原样保留, 未在 `)` 处被截断。
        self.assertIn(url, saved)

    def test_web_import_during_agent_turn_remains_saved_when_bytes_are_unchanged(self) -> None:
        asyncio.run(self.deliveries.begin_turn("session", "turn", self.project.root))

        response = self.client.post(
            "/api/resource/web-import",
            json={
                "project": self.project.id,
                "query": SEARCH_QUERY,
                "candidates": [{"title": "First", "url": SUCCESS_URL}],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        path = response.json()["items"][0]["node"]["path"]
        before = self.versions.capability(self.project.id, path)
        self.assertIs(before.snapshot_state, SnapshotState.SAVED)
        self.assertIsNone(before.pending)
        captured = asyncio.run(
            self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)
        )
        after = self.versions.capability(self.project.id, path)
        self.assertEqual(captured.file_ids, ())
        self.assertIs(after.snapshot_state, SnapshotState.SAVED)
        self.assertIsNone(after.pending)

    def test_agent_edit_after_web_import_still_requires_review(self) -> None:
        asyncio.run(self.deliveries.begin_turn("session", "edited-turn", self.project.root))
        response = self.client.post(
            "/api/resource/web-import",
            json={
                "project": self.project.id,
                "query": SEARCH_QUERY,
                "candidates": [{"title": "First", "url": SUCCESS_URL}],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        path = response.json()["items"][0]["node"]["path"]
        absolute = Path(self.project.root) / path
        absolute.write_text("Agent changed the imported file\n", encoding="utf-8")

        captured = asyncio.run(
            self.deliveries.finish_turn("session", "edited-turn", TurnOutcome.COMPLETED)
        )

        self.assertEqual(len(captured.file_ids), 1)
        pending = self.versions.pending(self.project.id, captured.file_ids[0])
        self.assertIsNotNone(pending)
        self.assertEqual(pending.review.candidate.path, path)

    def test_ordinary_markdown_has_no_web_origin(self) -> None:
        root = self.content.root(self.project.id, RootKind.RESOURCES)
        ordinary = self.content.create_text(
            self.project.id,
            root.path,
            "ordinary.md",
            "# Existing Markdown\n",
        )

        response = self.client.get(
            "/api/resource/web-origin",
            params={"project": self.project.id, "path": ordinary.path},
        )

        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"], "resource_web_origin_not_found")

    def test_optional_web_metadata_round_trips_as_null(self) -> None:
        root = self.content.root(self.project.id, RootKind.RESOURCES)
        ordinary = self.content.create_text(
            self.project.id,
            root.path,
            "nullable.md",
            "# Nullable provenance\n",
        )
        revision = self.content.snapshot(self.project.id, ordinary.path).revision

        saved = self.web_sources.save(
            self.project.id,
            ResourceWebSource(
                web_source_id="web-source-nullable",
                resource_path=ordinary.path,
                resource_revision=revision,
                source_title=None,
                source_url=SUCCESS_URL,
                final_url=None,
                search_query=None,
                fetched_at=None,
                schema_version=WEB_SOURCE_SCHEMA_VERSION,
                created_at=CONTRACT_TIMESTAMP,
                updated_at=CONTRACT_TIMESTAMP,
            ),
        )

        self.assertIsNone(saved.source_title)
        self.assertIsNone(saved.final_url)
        self.assertIsNone(saved.search_query)
        self.assertIsNone(saved.fetched_at)

    def test_provenance_failure_removes_just_created_markdown(self) -> None:
        failing = FailingWebSourceCatalog(self.content)
        self.client.app.state.web_importer = WebImporter(
            ResourceWriter(self.content),
            self.content,
            failing,
        )

        with self.assertLogs("service.resources.service.importer", level="ERROR"):
            response = self.client.post(
                "/api/resource/web-import",
                json={
                    "project": self.project.id,
                    "query": SEARCH_QUERY,
                    "candidates": [{"title": "First", "url": SUCCESS_URL}],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["succeeded"], 0)
        self.assertEqual(response.json()["failed"], 1)
        resource_root = self.content.root(self.project.id, RootKind.RESOURCES)
        files = self.content.files(self.project.id)
        self.assertFalse(
            any(
                node.path.startswith(f"{resource_root.path}/") and node.name == "First.md"
                for node in files
            )
        )
        hidden_images = Path(self.project.root) / resource_root.path / ".web-assets"
        self.assertEqual(list(hidden_images.glob("*")), [])

    def test_selected_resource_directory_receives_imported_page(self) -> None:
        resource_root = self.content.root(self.project.id, RootKind.RESOURCES)
        target = self.content.create(
            self.project.id,
            resource_root.path,
            "reviewed",
            AssetKind.DIR,
        )

        response = self.client.post(
            "/api/resource/web-import",
            json={
                "project": self.project.id,
                "query": SEARCH_QUERY,
                "parent": target.name,
                "candidates": [{"title": "First", "url": SUCCESS_URL}],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["items"][0]
        path = Path(self.project.root) / item["node"]["path"]
        self.assertEqual(path.parent.name, target.name)
        self.assertTrue(path.is_file())

    def test_missing_target_directory_is_rejected_before_fetch(self) -> None:
        response = self.client.post(
            "/api/resource/web-import",
            json={
                "project": self.project.id,
                "query": SEARCH_QUERY,
                "parent": "deleted-folder",
                "candidates": [{"title": "First", "url": SUCCESS_URL}],
            },
        )

        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"], "parent_not_found")

    def test_request_limit_and_project_validation_happen_before_fetch(self) -> None:
        candidates = [
            {"title": str(index), "url": f"https://example.com/{index}", "snippet": ""}
            for index in range(11)
        ]
        too_many = self.client.post(
            "/api/resource/web-import",
            json={"project": self.project.id, "query": SEARCH_QUERY, "candidates": candidates},
        )
        unknown = self.client.post(
            "/api/resource/web-import",
            json={
                "project": "missing-project",
                "query": SEARCH_QUERY,
                "candidates": [{"title": "First", "url": SUCCESS_URL, "snippet": ""}],
            },
        )

        self.assertEqual(too_many.status_code, 422)
        detail = too_many.json()["detail"]
        self.assertIsInstance(detail, list)
        self.assertIn("candidates", detail[0]["loc"])
        self.assertEqual(unknown.status_code, 404)


if __name__ == "__main__":
    unittest.main()
