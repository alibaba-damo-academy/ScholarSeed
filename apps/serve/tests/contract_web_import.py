"""Contract for bounded HTML pages entering the project resource library."""

from __future__ import annotations

import asyncio
import base64
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
    WEB_CONTENT_UNAVAILABLE,
    WEB_FETCH_TIMEOUT,
    WEB_HTTP_STATUS,
    WEB_IMAGE_REFERENCE_PREFIX,
    WEB_UNSAFE_URL,
    FetchedImage,
    FetchedPage,
    HtmlFetcher,
    PageFetchError,
    _FetchPolicy,
    _Response,
    _Target,
    extract_html,
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
FAILURE_URL = "https://slow.example/article"
UNEXPECTED_FAILURE_URL = "https://broken.example/article"
IMAGE_URL = "https://public.example/images/chart.png"
IMAGE_REFERENCE = "scholarseed-web-image:fixture"
SITE_ICON_URL = "https://public.example/favicon.ico"
SITE_ICON_FALLBACK_URL = (
    "https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fpublic.example%2F&sz=64"
)
IMAGE_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
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


class FixtureFetcher:
    """Deterministic contract fixture; real acceptance uses `HtmlFetcher`."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def fetch(self, url: str) -> FetchedPage:
        self.calls.append(url)
        if url == FAILURE_URL:
            raise PageFetchError(WEB_FETCH_TIMEOUT)
        if url == UNEXPECTED_FAILURE_URL:
            raise ValueError("unexpected parser failure")
        return FetchedPage(
            source_url=url,
            final_url="https://public.example/final",
            title="Windows: compatible? title",
            markdown=(
                "Complete article body with evidence and references.\n\n"
                f"![Chart]({IMAGE_REFERENCE})\n"
            ),
            images=(
                FetchedImage(
                    reference=IMAGE_REFERENCE,
                    source_url=IMAGE_URL,
                    final_url=IMAGE_URL,
                    media_type="image/png",
                    content=IMAGE_BYTES,
                ),
            ),
        )


class NetworkFixtureFetcher(HtmlFetcher):
    """Exercise HtmlFetcher orchestration without opening a real socket."""

    def __init__(self, image_error: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self.image_error = image_error

    def _request(
        self,
        target: _Target,
        policy: _FetchPolicy,
        *,
        referer: str = "",
    ) -> _Response:
        self.calls.append((target.url, referer))
        if target.url == SUCCESS_URL:
            return _Response(
                status=200,
                headers={},
                payload=b"""
                    <html><head><title>Image article</title></head><body><main>
                    <h1>Image article</h1>
                    <p>A complete article with enough readable content to verify that its
                    referenced raster image is fetched through the same bounded public-network
                    policy before the page is handed to the resource importer.</p>
                    <img alt="Chart" src="/images/chart.png">
                    </main></body></html>
                """,
                media_type="text/html",
            )
        self.assert_image_policy(policy, referer)
        if self.image_error:
            raise PageFetchError(WEB_FETCH_TIMEOUT)
        return _Response(
            status=200,
            headers={},
            payload=IMAGE_BYTES,
            media_type="image/png",
        )

    @staticmethod
    def assert_image_policy(policy: _FetchPolicy, referer: str) -> None:
        if "image/png" not in policy.allowed_content_types or referer != SUCCESS_URL:
            raise AssertionError("image request did not preserve its bounded policy and referer")


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
            payload=IMAGE_BYTES,
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
            payload=IMAGE_BYTES,
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
        self.fetcher = FixtureFetcher()
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
            self.fetcher,
            self.content,
            self.web_sources,
        )
        self.icon_fetcher = SiteIconFixtureFetcher()
        app.state.web_icon_fetcher = self.icon_fetcher
        register_resource_routes(app)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_html_extraction_prefers_main_content_and_removes_page_noise(self) -> None:
        title, markdown = extract_html(b"""
            <html><head><title>Full page</title><style>hidden style</style></head>
            <body>
              <nav>Navigation links and section overview</nav>
              <main><h1>Research article</h1><p>Body with a quoted reference and enough
                readable content to pass the minimum content threshold for a useful static
                HTML page.</p></main>
              <footer>Copyright and citation footer</footer>
              <script>secret script payload</script><noscript>fallback noise</noscript>
              <template>template noise</template><svg><text>vector noise</text></svg>
            </body></html>
            """)

        self.assertEqual(title, "Full page")
        self.assertIn("# Research article", markdown)
        self.assertIn("Body with a quoted reference", markdown)
        self.assertNotIn("Navigation links", markdown)
        self.assertNotIn("citation footer", markdown)
        self.assertNotIn("secret script", markdown)
        self.assertNotIn("fallback noise", markdown)
        self.assertNotIn("template noise", markdown)
        self.assertNotIn("vector noise", markdown)
        self.assertNotIn("<main>", markdown)

    def test_html_extraction_preserves_inline_text_and_markdown_structure(self) -> None:
        _, markdown = extract_html(
            b"""
            <html><head><title>Structured page</title></head><body><main>
              <h2>Equipment</h2>
              <p>A <span>piece</span> of <a href="/equipment">equipment</a>
                with <strong>straps</strong> and enough supporting prose to make this a useful
                article rather than an empty dynamic page.</p>
              <ul><li>First item</li><li>Second item</li></ul>
              <img alt="Equipment diagram" src="../images/equipment.png">
              <pre><code>x = 1\n\ny = 2</code></pre>
            </main></body></html>
            """,
            base_url="https://example.com/articles/structured",
        )

        self.assertIn("## Equipment", markdown)
        self.assertIn(
            "A piece of [equipment](https://example.com/equipment) with **straps**",
            markdown,
        )
        self.assertIn("* First item", markdown)
        self.assertIn(
            "![Equipment diagram](https://example.com/images/equipment.png)",
            markdown,
        )
        self.assertIn("```\nx = 1\n\ny = 2\n```", markdown)
        self.assertNotIn("A\n\npiece", markdown)

    def test_html_fetcher_collects_bounded_remote_images_for_localization(self) -> None:
        address = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443))
        fetcher = NetworkFixtureFetcher()

        with patch(
            "service.resources.service.fetcher.socket.getaddrinfo",
            return_value=[address],
        ):
            page = fetcher.fetch(SUCCESS_URL)

        self.assertEqual(page.title, "Image article")
        self.assertEqual(len(page.images), 1)
        self.assertEqual(page.images[0].source_url, IMAGE_URL)
        self.assertEqual(page.images[0].content, IMAGE_BYTES)
        self.assertIn(page.images[0].reference, page.markdown)
        self.assertEqual(
            fetcher.calls,
            [(SUCCESS_URL, ""), (IMAGE_URL, SUCCESS_URL)],
        )

    def test_html_fetcher_restores_remote_url_when_image_fetch_fails(self) -> None:
        address = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("8.8.8.8", 443),
        )
        fetcher = NetworkFixtureFetcher(image_error=True)

        with patch(
            "service.resources.service.fetcher.socket.getaddrinfo",
            return_value=[address],
        ):
            page = fetcher.fetch(SUCCESS_URL)

        self.assertEqual(page.images, ())
        self.assertIn(f"![Chart]({IMAGE_URL})", page.markdown)
        self.assertNotIn(WEB_IMAGE_REFERENCE_PREFIX, page.markdown)

    def test_html_extraction_recovers_streamed_h1_fragment_from_empty_main(self) -> None:
        _, markdown = extract_html(b"""
            <html><body>
              <main id="streaming-shell"></main>
              <div hidden id="streamed-content"><div>
                <h1>Streamed article heading</h1>
                <p>The streamed article paragraph contains enough readable content to select
                  this cohesive fragment even before client JavaScript moves it into main.</p>
              </div></div>
              <div><p>Unrelated recommendations contain enough text to be mistaken for the
                article when the whole body is flattened without structural selection.</p></div>
            </body></html>
            """)

        self.assertTrue(markdown.startswith("# Streamed article heading\n\n"))
        self.assertIn("The streamed article paragraph", markdown)
        self.assertNotIn("Unrelated recommendations", markdown)

    def test_html_extraction_falls_back_to_body_without_semantic_content(self) -> None:
        _, markdown = extract_html(b"""
            <html><body>
              <main id="streaming-shell"></main>
              <p>A complete body-only article with enough readable text to remain importable
                when a legacy website does not expose main, article, or role-main elements.</p>
              <p>The second paragraph remains separate and readable after conversion.</p>
            </body></html>
            """)

        self.assertIn("A complete body-only article", markdown)
        self.assertIn("\n\nThe second paragraph", markdown)

    def test_html_extraction_rejects_dynamic_shell_without_useful_text(self) -> None:
        with self.assertRaises(PageFetchError) as raised:
            extract_html(
                b"<html><body><div id='app'>Loading</div><script>render()</script></body></html>"
            )
        self.assertEqual(raised.exception.code, WEB_CONTENT_UNAVAILABLE)

    def test_literal_private_address_is_rejected_before_http(self) -> None:
        with self.assertRaises(PageFetchError) as raised:
            HtmlFetcher().fetch("http://127.0.0.1/private")
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
        self.assertEqual(response.content, IMAGE_BYTES)
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
        self.assertEqual(response.content, IMAGE_BYTES)
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
        self.assertEqual(self.fetcher.calls, [])

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
        self.assertEqual(self.fetcher.calls, [])

        path = Path(self.project.root) / body["items"][0]["node"]["path"]
        saved = path.read_text(encoding="utf-8")
        self.assertEqual(saved, f"# Perovskite\n\n[{url}](<{url}>)\n")
        # 整条带括号 URL 原样保留, 未在 `)` 处被截断。
        self.assertIn(url, saved)

    def test_full_page_batch_keeps_success_when_another_page_fails(self) -> None:
        # 备用整页抓取路径：逐页失败隔离仍由该路径承担，置开关后复验。
        with patch("service.resources.service.importer.WEB_IMPORT_FETCH_FULL_PAGE", True):
            response = self.client.post(
                "/api/resource/web-import",
                json={
                    "project": self.project.id,
                    "query": SEARCH_QUERY,
                    "candidates": [
                        {"title": "First", "url": SUCCESS_URL, "snippet": "one"},
                        {"title": "Second", "url": FAILURE_URL, "snippet": "two"},
                    ],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["succeeded"], 1)
        self.assertEqual(body["failed"], 1)
        self.assertEqual(body["items"][0]["status"], "success")
        self.assertEqual(body["items"][1]["status"], "failed")
        self.assertEqual(body["items"][1]["error"], WEB_FETCH_TIMEOUT)

        path = Path(self.project.root) / body["items"][0]["node"]["path"]
        self.assertEqual(path.name, "Windows_ compatible_ title.md")
        saved = path.read_text(encoding="utf-8")
        self.assertTrue(saved.startswith("# Windows: compatible? title\n\n"))
        self.assertNotIn("scholarseed_schema", saved)
        self.assertNotIn(SUCCESS_URL, saved)
        self.assertNotIn("## 来源", saved)
        self.assertNotIn("## 网页全文", saved)
        self.assertIn("Complete article body", saved)
        image_line = next(line for line in saved.splitlines() if line.startswith("![Chart]("))
        relative_image = image_line.removeprefix("![Chart](").removesuffix(")")
        self.assertTrue(relative_image.startswith(".web-assets/"))
        self.assertNotIn(IMAGE_URL, saved)
        self.assertEqual((path.parent / relative_image).read_bytes(), IMAGE_BYTES)

        resource_path = body["items"][0]["node"]["path"]
        origin = self.web_sources.get(self.project.id, resource_path)
        self.assertIsNotNone(origin)
        assert origin is not None
        self.assertEqual(
            origin.resource_revision,
            self.content.snapshot(self.project.id, resource_path).revision,
        )
        self.assertEqual(origin.source_title, "Windows: compatible? title")
        self.assertEqual(origin.source_url, SUCCESS_URL)
        self.assertEqual(origin.final_url, "https://public.example/final")
        self.assertEqual(origin.search_query, SEARCH_QUERY)
        self.assertIsNotNone(origin.fetched_at)
        self.assertEqual(origin.schema_version, WEB_SOURCE_SCHEMA_VERSION)
        capability = self.versions.capability(self.project.id, resource_path)
        self.assertIs(capability.snapshot_state, SnapshotState.SAVED)
        self.assertIsNone(capability.pending)
        self.assertEqual(len(self.versions.history(self.project.id, resource_path)), 1)

        response = self.client.get(
            "/api/resource/web-origin",
            params={"project": self.project.id, "path": resource_path},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["source_url"], SUCCESS_URL)
        self.assertEqual(response.json()["search_query"], SEARCH_QUERY)

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
            self.fetcher,
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
        self.assertEqual(self.fetcher.calls, [])

    def test_unexpected_item_failure_is_logged_and_does_not_abort_later_pages(self) -> None:
        # 逐项隔离的未预期异常路径在备用整页抓取下复验：抓取器抛出非 PageFetchError。
        with (
            patch("service.resources.service.importer.WEB_IMPORT_FETCH_FULL_PAGE", True),
            self.assertLogs(
                "service.resources.service.importer",
                level="ERROR",
            ),
        ):
            response = self.client.post(
                "/api/resource/web-import",
                json={
                    "project": self.project.id,
                    "query": SEARCH_QUERY,
                    "candidates": [
                        {"title": "Broken", "url": UNEXPECTED_FAILURE_URL},
                        {"title": "Healthy", "url": SUCCESS_URL},
                    ],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["succeeded"], 1)
        self.assertEqual(body["failed"], 1)
        self.assertEqual(body["items"][0]["error"], "web_import_failed")
        self.assertEqual(body["items"][1]["status"], "success")

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
        self.assertEqual(self.fetcher.calls, [])


if __name__ == "__main__":
    unittest.main()
