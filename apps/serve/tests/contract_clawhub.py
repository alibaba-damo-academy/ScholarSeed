"""Anonymous marketplace protocol and download trust-boundary contracts."""

from __future__ import annotations

import io
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.api.routes import register_capability_routes
from service.capabilities.service.attribution import (
    MAX_REGISTRATION_BYTES,
    parse_attribution,
    read_attribution,
)
from service.capabilities.service.clawhub import CLAWHUB_URL_ENV, ClawHub, ClawHubError
from service.capabilities.service.install import (
    SkillDuplicateError,
    SkillPackageError,
    install_skill_archive,
    preview_skill_upload,
    update_skill_archive,
)
from service.capabilities.service.skills import SkillCatalog, SkillProductState
from service.platform.activity import Activities
from service.platform.storage import DirectoryHandle

BASE = "http://hub.example"
SLUG = "paper-tools"
VERSION = "1.2.3"


def item() -> dict:
    return {
        "slug": SLUG,
        "namespace": "global",
        "publishedVersion": {"version": VERSION},
        "downloadCount": 3,
        "displayName": "Paper tools",
        "summary": "Read papers",
        "latestVersion": {"version": VERSION},
        "stats": {"downloads": 3},
    }


def catalogue(rows, page=0, total=None):
    return {"items": rows, "page": page, "size": 30, "total": len(rows) if total is None else total}


class ClawHubContract(unittest.IsolatedAsyncioTestCase):
    def test_upload_metadata_is_excluded_from_preview_and_installed_content(self):
        document = "---\nname: metadata-skill\ndescription: Metadata regression\n---\nRead me.\n"
        for prefix in ("", "wrapped/"):
            with self.subTest(prefix=prefix), tempfile.TemporaryDirectory() as directory:
                output = io.BytesIO()
                with zipfile.ZipFile(output, "w") as archive:
                    archive.writestr(prefix + "SKILL.md", document)
                    archive.writestr(prefix + "references/guide.md", "reference")
                    archive.writestr(prefix + ".config/settings.json", "{}")
                    archive.writestr(".DS_Store", "finder")
                    archive.writestr(prefix + "references/.DS_Store", "finder")
                    archive.writestr("__MACOSX/" + prefix + "._SKILL.md", "sidecar")
                    archive.writestr(prefix + "._SKILL.md", "sidecar")
                    archive.writestr(prefix + "references/._guide.md", "sidecar")
                payload = output.getvalue()
                preview = preview_skill_upload(payload, "metadata.zip")
                self.assertEqual(preview["name"], "metadata-skill")
                self.assertEqual(preview["document"], document)
                installed = install_skill_archive(payload, Path(directory) / "skills")
                self.assertEqual(
                    {
                        entry.relative_to(installed.path).as_posix()
                        for entry in installed.path.rglob("*")
                        if entry.is_file()
                    },
                    {"SKILL.md", "references/guide.md", ".config/settings.json"},
                )
                self.assertEqual((installed.path / "SKILL.md").read_text(), document)
                with self.assertRaises(SkillDuplicateError):
                    install_skill_archive(payload, Path(directory) / "skills")

    def test_upload_metadata_does_not_bypass_safety_checks(self):
        for unsafe in ("__MACOSX/../escape", "__MACOSX/C:/escape", "__MACOSX/link", ".DS_Store"):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as directory:
                output = io.BytesIO()
                with zipfile.ZipFile(output, "w") as archive:
                    archive.writestr(
                        "wrapped/SKILL.md", "---\nname: safe\ndescription: test\n---\nBody"
                    )
                    entry = zipfile.ZipInfo(unsafe)
                    if unsafe == "__MACOSX/link":
                        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(entry, "unsafe")
                    if unsafe == ".DS_Store":
                        archive.writestr(".ds_store", "duplicate")
                with self.assertRaises(SkillPackageError):
                    preview_skill_upload(output.getvalue(), "unsafe.zip")
                with self.assertRaises(SkillPackageError):
                    install_skill_archive(output.getvalue(), Path(directory) / "skills")
                self.assertFalse((Path(directory) / "skills").exists())

    def test_upload_metadata_still_counts_toward_archive_limits(self):
        output = io.BytesIO()
        document = "---\nname: safe\ndescription: test\n---\nBody"
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("SKILL.md", document)
            archive.writestr("__MACOSX/._SKILL.md", "metadata")
        for limit, value in (("MAX_UPLOAD_ENTRIES", 1), ("MAX_UNCOMPRESSED_BYTES", len(document))):
            with (
                self.subTest(limit=limit),
                patch("service.capabilities.service.install." + limit, value),
            ):
                with self.assertRaises(SkillPackageError):
                    preview_skill_upload(output.getvalue(), "oversized.zip")

    def test_upload_metadata_does_not_hide_an_extra_content_root(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("wrapped/SKILL.md", "---\nname: safe\ndescription: test\n---\nBody")
            archive.writestr("__MACOSX/._SKILL.md", "metadata")
            archive.writestr("other/readme.md", "another content root")
        with self.assertRaises(SkillPackageError):
            preview_skill_upload(output.getvalue(), "multiple.zip")

    async def test_local_copy_reuses_marketplace_language_without_changing_identity(self):
        origin = {
            "source": "clawhub",
            "registry": BASE,
            "namespace": "global",
            "slug": SLUG,
            "version": VERSION,
        }
        descriptions = {"zh": "Package summary", "fr": "Résumé local"}
        row = {
            "name": "local-id",
            "display_name": "Old title",
            "description": "Original summary",
            "descriptions": descriptions,
            "hub": origin,
        }
        for locale, title, summary in (
            ("zh", "论文工具", "中文市场说明"),
            ("en", "Paper tools", "English marketplace summary"),
            ("zh-CN", "论文工具", "简体中文市场说明"),
        ):
            with self.subTest(locale=locale):

                def handle(request, title=title, locale=locale, summary=summary):
                    self.assertEqual(request.headers["accept-language"], locale)
                    metadata = {**item(), "displayName": title, "summary": summary, "labels": []}
                    if request.url.path == "/api/web/skills":
                        return httpx.Response(200, json=catalogue([metadata]))
                    return httpx.Response(200, json=metadata)

                hub = ClawHub(url=BASE, locale=locale, transport=httpx.MockTransport(handle))
                market = (await hub.list())["items"][0]
                local = (await hub.enrich_local([row]))[0]
                self.assertEqual(local["display_name"], market["name"])
                self.assertEqual(local["descriptions"][locale.lower()], market["description"])
                self.assertEqual(local["descriptions"]["fr"], "Résumé local")
                self.assertEqual(local["description"], "Original summary")
                self.assertEqual(local["name"], row["name"])
                self.assertEqual(local["hub"], origin)
                self.assertEqual(row["display_name"], "Old title")
                self.assertEqual(row["descriptions"], descriptions)
                self.assertEqual(descriptions["zh"], "Package summary")

    async def test_local_descriptions_preserve_fallback_when_summary_is_unavailable(self):
        row = {
            "name": "local-id",
            "description": "Original summary",
            "descriptions": {"zh": "本地说明"},
            "hub": {
                "source": "clawhub",
                "registry": BASE,
                "namespace": "global",
                "slug": SLUG,
            },
        }
        for summary in (None, "", "   ", 42):
            with self.subTest(summary=summary):
                hub = ClawHub(
                    url=BASE,
                    locale="zh",
                    transport=httpx.MockTransport(
                        lambda request, summary=summary: httpx.Response(
                            200,
                            json={**item(), "summary": summary, "labels": []},
                        )
                    ),
                )
                result = (await hub.enrich_local([row]))[0]
                self.assertEqual(result["descriptions"], row["descriptions"])
                self.assertEqual(result["description"], row["description"])
        failed = await ClawHub(
            url=BASE,
            locale="zh",
            transport=httpx.MockTransport(lambda request: httpx.Response(503)),
        ).enrich_local([row])
        self.assertEqual(failed[0]["descriptions"], row["descriptions"])
        self.assertEqual(failed[0]["description"], row["description"])

    async def test_local_titles_preserve_fallback_when_unmapped_or_metadata_unavailable(self):
        origin = {
            "source": "clawhub",
            "registry": BASE,
            "namespace": "team",
            "slug": "team--" + SLUG,
        }
        rows = [
            {"name": "local", "display_name": "Local title"},
            {"name": "installed", "display_name": "Saved title", "hub": origin},
            {"name": "other", "hub": {**origin, "registry": BASE + "/other"}},
        ]
        for title in (None, "", "Remote title"):
            with self.subTest(title=title):
                hub = ClawHub(
                    url=BASE,
                    transport=httpx.MockTransport(
                        lambda request, title=title: httpx.Response(
                            200,
                            json={
                                "slug": SLUG,
                                "namespace": "team",
                                "displayName": title,
                                "labels": [],
                            },
                        )
                    ),
                )
                result = await hub.enrich_local(rows)
                self.assertEqual(result[0]["display_name"], "Local title")
                self.assertEqual(result[1]["display_name"], title or "Saved title")
                self.assertNotIn("display_name", result[2])
        failed = await ClawHub(
            url=BASE, transport=httpx.MockTransport(lambda request: httpx.Response(503))
        ).enrich_local(rows)
        self.assertEqual(failed[1]["display_name"], "Saved title")

    async def test_local_updates_distinguish_available_current_unknown_and_unmapped(self):
        origin = {
            "source": "clawhub",
            "registry": BASE,
            "namespace": "global",
            "slug": SLUG,
            "version": "1.0.0",
        }
        rows = [{"name": SLUG, "group": "user", "hub": origin}, {"name": "local", "hub": None}]
        for published, expected in (
            (VERSION, "available"),
            ("1.0.0", "current"),
            (None, "unavailable"),
        ):

            def handle(request, published=published):
                return httpx.Response(
                    200,
                    json={
                        "namespace": "global",
                        "slug": SLUG,
                        "labels": [],
                        "publishedVersion": {"version": published},
                    },
                )

            result = await ClawHub(url=BASE, transport=httpx.MockTransport(handle)).enrich_local(
                rows
            )
            self.assertEqual(result[0]["updateStatus"], expected)
            self.assertEqual(result[1]["updateStatus"], "unmapped")
        failed = await ClawHub(
            url=BASE, transport=httpx.MockTransport(lambda _: httpx.Response(503))
        ).enrich_local(rows)
        self.assertEqual(failed[0]["updateStatus"], "unavailable")
        self.assertIsNone(failed[0]["latestVersion"])

    def test_update_archive_preserves_old_content_on_validation_and_publication_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            origin = {
                "source": "clawhub",
                "registry": BASE,
                "namespace": "global",
                "slug": SLUG,
                "version": "1.0.0",
            }

            def package(name, text):
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w") as archive:
                    archive.writestr(
                        "SKILL.md", f"---\nname: {name}\ndescription: {text}\n---\n{text}"
                    )
                return buffer.getvalue()

            install_skill_archive(package(SLUG, "old"), root, origin=origin)
            updated = {**origin, "version": VERSION}
            for payload in (b"broken", package("different-name", "new")):
                with self.assertRaises(SkillPackageError):
                    update_skill_archive(
                        payload, root, name=SLUG, expected_origin=origin, origin=updated
                    )
                self.assertIn("old", (root / SLUG / "SKILL.md").read_text())
            original_rename = DirectoryHandle.rename_directory
            calls = []

            def publish(directory, source, destination, **kwargs):
                calls.append(source)
                if len(calls) == 2:
                    raise OSError("busy")
                return original_rename(directory, source, destination, **kwargs)

            with patch.object(DirectoryHandle, "rename_directory", publish):
                with self.assertRaises(SkillPackageError):
                    update_skill_archive(
                        package(SLUG, "new"),
                        root,
                        name=SLUG,
                        expected_origin=origin,
                        origin=updated,
                    )
            self.assertIn("old", (root / SLUG / "SKILL.md").read_text())
            result = update_skill_archive(
                package(SLUG, "new"), root, name=SLUG, expected_origin=origin, origin=updated
            )
            self.assertEqual(result.name, SLUG)
            self.assertIn("new", (root / SLUG / "SKILL.md").read_text())
            with self.assertRaises(SkillPackageError):
                update_skill_archive(
                    package(SLUG, "other"), root, name=SLUG, expected_origin=origin, origin=updated
                )

    def test_update_api_checks_origin_versions_and_moderation_without_changing_preferences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            user = root / "skills"
            payload = io.BytesIO()
            with zipfile.ZipFile(payload, "w") as archive:
                archive.writestr("SKILL.md", f"---\nname: {SLUG}\ndescription: papers\n---\n")
            origin = {
                "source": "clawhub",
                "registry": BASE,
                "namespace": "global",
                "slug": SLUG,
                "version": "1.0.0",
            }
            installed = install_skill_archive(payload.getvalue(), user, origin=origin)
            runtime = SimpleNamespace(
                skill_inventory=AsyncMock(
                    return_value=SkillInventory(
                        cwd=root,
                        skills=(
                            SkillView(
                                name=SLUG,
                                path=installed.path / "SKILL.md",
                                description="papers",
                                availability=SkillAvailability.DISABLED,
                                enabled=False,
                            ),
                        ),
                    )
                ),
                invalidate_skill_inventory=Mock(),
                configure_skills=AsyncMock(),
            )
            app = FastAPI()
            app.state.skill_catalog = SkillCatalog(bundled_root=root / "bundled", user_root=user)
            app.state.runtime_service = runtime
            register_capability_routes(app, activities=Activities(), workspace=root)
            remote = SimpleNamespace(
                base=BASE,
                registry_aliases=[BASE],
                detail=AsyncMock(
                    return_value={
                        "namespace": "global",
                        "version": VERSION,
                        "moderation": "blocked",
                    }
                ),
                download=AsyncMock(return_value=payload.getvalue()),
            )
            with (
                patch("service.capabilities.service.management.ClawHub", return_value=remote),
                patch("service.capabilities.service.management.SERVICE_SKILLS_DIR", user),
                TestClient(app) as client,
            ):
                endpoint = f"/api/capabilities/skills/{SLUG}/update"
                request = {"expectedVersion": "1.0.0", "version": VERSION}
                self.assertEqual(
                    client.post(endpoint, json={**request, "expectedVersion": "old"}).status_code,
                    409,
                )
                self.assertEqual(client.post(endpoint, json=request).status_code, 422)
                remote.download.assert_not_awaited()
                remote.detail.return_value["moderation"] = "clean"
                remote.detail.return_value["namespace"] = "other"
                self.assertEqual(client.post(endpoint, json=request).status_code, 409)
                remote.detail.return_value["namespace"] = "global"
                response = client.post(endpoint, json=request)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(
                    json.loads((user / SLUG / ".origin.json").read_text())["version"], VERSION
                )
                runtime.configure_skills.assert_not_awaited()
                runtime.invalidate_skill_inventory.assert_called_once_with(cwd=root)
                self.assertEqual(client.post(endpoint, json=request).status_code, 409)

    def test_registration_projects_declared_authors_and_github_repository(self):
        registration = {
            "slug": SLUG,
            "authors": ["Research Team", "Contributor"],
            "source": {
                "kind": "adapted",
                "repository_url": "https://github.com/deepseek-ai/deepseek-harness.git",
                "path": "skills/papers",
                "revision": "a" * 40,
            },
            "code": 42,
        }
        result = parse_attribution(json.dumps(registration).encode(), SLUG)
        self.assertEqual(result["attributionStatus"], "ready")
        self.assertEqual(result["attribution"]["authors"], registration["authors"])
        self.assertEqual(result["attribution"]["repository_name"], "deepseek-ai/deepseek-harness")
        self.assertEqual(
            result["attribution"]["repository_url"],
            "https://github.com/deepseek-ai/deepseek-harness",
        )
        self.assertEqual(result["attribution"]["revision"], "a" * 40)
        for url in (
            "javascript:alert(1)",
            "https://github.com.evil.test/owner/repo",
            "https://user@github.com/owner/repo",
            "https://github.com/owner/repo/tree/main",
            "https://github.com/owner/repo?redirect=evil",
            "https://github.com:8443/owner/repo",
        ):
            with self.subTest(url=url):
                registration["source"]["repository_url"] = url
                projected = parse_attribution(json.dumps(registration).encode(), SLUG)
                self.assertEqual(projected["attributionStatus"], "invalid")
                self.assertIsNone(projected["attribution"])
        self.assertEqual(parse_attribution(None, SLUG)["attributionStatus"], "missing")
        for payload in (b"{", b"[]", b"x" * (MAX_REGISTRATION_BYTES + 1)):
            self.assertEqual(parse_attribution(payload, SLUG)["attributionStatus"], "invalid")

    def test_local_registration_survives_archive_install_without_origin_copy(self):
        registration = {
            "slug": SLUG,
            "authors": ["Declared author"],
            "source": {"kind": "imported", "repository_url": "https://github.com/team/papers"},
        }
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("SKILL.md", f"---\nname: {SLUG}\ndescription: Read papers\n---\n")
            archive.writestr("registry.json", json.dumps(registration))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installed = install_skill_archive(
                payload.getvalue(),
                root / "skills",
                origin={"source": "clawhub", "provider": "Platform Admin"},
            )
            catalog = SkillCatalog(bundled_root=root / "bundled", user_root=root / "skills")
            inventory = SkillInventory(
                cwd=root,
                skills=(
                    SkillView(
                        name=SLUG,
                        path=installed.path,
                        description="Read papers",
                        availability=SkillAvailability.AVAILABLE,
                        enabled=True,
                    ),
                ),
            )
            row = catalog.payloads(inventory, SkillProductState())[0]
            self.assertEqual(row["attribution"]["repository_name"], "team/papers")
            self.assertEqual(row["attribution"]["authors"], ["Declared author"])
            self.assertNotIn("authors", row["hub"])
            (installed.path / "registry.json").unlink()
            self.assertIsNone(catalog.payloads(inventory, SkillProductState())[0]["attribution"])
            self.assertEqual(read_attribution(installed.path, SLUG)["attributionStatus"], "missing")

    async def test_market_registration_is_version_and_namespace_bound_raw_json(self):
        seen = []

        def handle(request):
            seen.append(str(request.url))
            if request.url.path == "/api/web/skills":
                return httpx.Response(200, json=catalogue([{**item(), "namespace": "research"}]))
            if request.url.path.endswith("/file"):
                self.assertEqual(
                    request.url.path, f"/api/v1/skills/research/{SLUG}/versions/{VERSION}/file"
                )
                self.assertEqual(request.url.params["path"], "registry.json")
                return httpx.Response(
                    200,
                    json={
                        "code": 42,
                        "slug": SLUG,
                        "authors": ["Original"],
                        "source": {
                            "kind": "imported",
                            "repository_url": "https://github.com/team/papers",
                        },
                    },
                )
            return httpx.Response(
                200,
                json={
                    "slug": SLUG,
                    "namespace": "research",
                    "ownerDisplayName": "Platform Admin",
                    "labels": [],
                },
            )

        page = await ClawHub(url=BASE, transport=httpx.MockTransport(handle)).list()
        row = page["items"][0]
        self.assertEqual(row["slug"], "research--" + SLUG)
        self.assertEqual(row["attribution"]["repository_name"], "team/papers")
        self.assertEqual(row["attribution"]["authors"], ["Original"])
        self.assertEqual(row["labelsStatus"], "ready")
        self.assertEqual(len(seen), 3)

    async def test_registration_failure_does_not_change_labels_or_moderation(self):
        for status, body, expected in (
            (404, b"", "missing"),
            (503, b"", "unavailable"),
            (200, b"not-json", "invalid"),
            (200, json.dumps({"slug": "other", "authors": []}).encode(), "invalid"),
        ):

            def handle(request, status=status, body=body):
                if request.url.path == "/api/web/skills":
                    return httpx.Response(200, json=catalogue([item()]))
                if request.url.path.endswith("/file"):
                    return httpx.Response(status, content=body)
                return httpx.Response(200, json={"slug": SLUG, "namespace": "global", "labels": []})

            with self.subTest(status=status, expected=expected):
                row = (await ClawHub(url=BASE, transport=httpx.MockTransport(handle)).list())[
                    "items"
                ][0]
                self.assertEqual(row["attributionStatus"], expected)
                self.assertIsNone(row["attribution"])
                self.assertEqual(row["labelsStatus"], "ready")
                self.assertEqual(row["moderation"], "unknown")

    def test_duplicate_guidance_uses_chinese_field_description(self):
        message = str(SkillDuplicateError("paper-tools"))
        self.assertIn("请调整技能标识后重新上传", message)
        self.assertNotIn("name", message)

    async def test_metadata_failure_is_not_an_empty_label_set_or_a_download_permission(self):
        def handle(request):
            if request.url.path == "/api/web/skills":
                return httpx.Response(200, json=catalogue([item()]))
            return httpx.Response(503)

        hub = ClawHub(url=BASE, transport=httpx.MockTransport(handle))
        row = (await hub.list())["items"][0]
        self.assertIsNone(row["labels"])
        self.assertEqual(row["labelsStatus"], "unavailable")
        self.assertEqual(row["moderation"], "unknown")
        for cursor in ("next", "-1", "１"):
            with self.assertRaises(ClawHubError):
                await hub.list(cursor=cursor)
        with self.assertRaises(ClawHubError):
            ClawHub(url=BASE, locale="zh\r\nCookie: secret")

    def test_marketplace_routes_forward_category_and_language_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = FastAPI()
            app.state.skill_catalog = SkillCatalog(
                bundled_root=root / "bundled", user_root=root / "skills"
            )
            register_capability_routes(app, activities=Activities(), workspace=root)
            remote = SimpleNamespace(
                labels=AsyncMock(return_value=[]),
                list=AsyncMock(return_value={"items": [], "total": 0}),
            )
            with (
                patch(
                    "service.capabilities.service.management.ClawHub", return_value=remote
                ) as factory,
                TestClient(app) as client,
            ):
                response = client.get("/api/capabilities/skills/marketplace/labels?locale=zh")
                self.assertEqual(response.json(), {"labels": []})
                factory.assert_called_with(locale="zh")
                response = client.get(
                    "/api/capabilities/skills/marketplace?query=paper&label=research&cursor=2&locale=en"
                )
                self.assertEqual(response.status_code, 200)
                factory.assert_called_with(locale="en")
                remote.list.assert_awaited_once_with(query="paper", label="research", cursor="2")

    async def test_native_classification_search_keeps_pagination_locale_and_identity(self):
        requests = []
        label = {"slug": "research", "type": "RECOMMENDED", "displayName": "研究"}

        def handle(request):
            requests.append(request)
            self.assertNotIn("cookie", request.headers)
            self.assertNotIn("authorization", request.headers)
            if request.url.path == "/api/web/skills":
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "data": {
                            "items": [
                                {
                                    "slug": SLUG,
                                    "namespace": "team",
                                    "displayName": "Tools",
                                    "publishedVersion": {"version": VERSION},
                                    "downloadCount": 0,
                                }
                            ],
                            "page": 1,
                            "size": 30,
                            "total": 61,
                        },
                    },
                )
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "slug": SLUG,
                        "namespace": "team",
                        "ownerDisplayName": "Author",
                        "labels": [label],
                    },
                },
            )

        result = await ClawHub(url=BASE, locale="zh", transport=httpx.MockTransport(handle)).list(
            query="paper & data", cursor="1", label="research"
        )
        self.assertEqual(result["total"], 61)
        self.assertEqual(result["nextCursor"], "2")
        self.assertEqual(result["items"][0]["slug"], "team--" + SLUG)
        self.assertEqual(result["items"][0]["labels"], [label])
        self.assertEqual(result["items"][0]["downloads"], 0)
        self.assertEqual(requests[0].url.params["label"], "research")
        self.assertEqual(requests[0].url.params["q"], "paper & data")
        self.assertEqual(requests[0].headers["accept-language"], "zh")

    async def test_label_definitions_are_remote_ordered_and_failures_are_explicit(self):
        labels = [{"slug": "research", "type": "RECOMMENDED", "displayName": "Research"}]
        hub = ClawHub(
            url=BASE,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={"code": 0, "data": labels})
            ),
        )
        self.assertEqual(await hub.labels(), labels)
        hub = ClawHub(
            url=BASE,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(503, text="private upstream error")
            ),
        )
        with self.assertRaises(ClawHubError):
            await hub.labels()

    async def test_local_labels_require_registered_origin_not_same_name(self):
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(
                200, json={"code": 0, "data": {"slug": SLUG, "namespace": "team", "labels": []}}
            )

        hub = ClawHub(url=BASE, transport=httpx.MockTransport(handle))
        origin = {
            "source": "clawhub",
            "registry": BASE,
            "namespace": "team",
            "slug": "team--" + SLUG,
        }
        rows = [
            {"name": SLUG},
            {"name": "local", "hub": origin},
            {"name": "other", "hub": {**origin, "registry": BASE + "/other"}},
        ]
        result = await hub.enrich_local(rows)
        self.assertIsNone(result[0]["labels"])
        self.assertEqual(result[1]["labels"], [])
        self.assertIsNone(result[2]["labels"])
        self.assertEqual(len(requests), 1)

    def test_upload_accepts_large_zip_without_installing_and_rejects_invalid_metadata(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr(
                "SKILL.md",
                "---\nname: large-upload\ndescription: Large archive\n---\nInstructions\n",
            )
            archive.writestr("reference.txt", b"x" * (21 * 1024 * 1024))
        self.assertEqual(
            preview_skill_upload(output.getvalue(), "large.zip")["name"], "large-upload"
        )
        for document in (
            b"---\nname: missing\n---\nBody",
            b"---\nname: wrong\ndescription: []\n---\nBody",
            b"---\nname: empty\ndescription: Empty\n---\n",
        ):
            with self.assertRaises(SkillPackageError):
                preview_skill_upload(document, "SKILL.md")

    async def test_list_resolves_provider_from_identity_bound_native_metadata(self):
        def handle(request):
            if request.url.path == "/api/web/skills":
                return httpx.Response(200, json=catalogue([item()]))
            return httpx.Response(
                200,
                json={"slug": SLUG, "namespace": "global", "ownerDisplayName": "Research author"},
            )

        result = await ClawHub(url=BASE, transport=httpx.MockTransport(handle)).list()
        self.assertEqual(result["items"][0]["provider"], "Research author")

    async def test_download_counts_preserve_zero_and_reject_invalid_values(self):
        for count in (0, 124500, None, -1, True, "3", 1.5):
            with self.subTest(count=count):
                transport = httpx.MockTransport(
                    lambda request, count=count: httpx.Response(
                        200, json=catalogue([{**item(), "downloadCount": count}])
                    )
                )
                result = await ClawHub(url=BASE, transport=transport).list()
                expected = (
                    count
                    if isinstance(count, int) and not isinstance(count, bool) and count >= 0
                    else None
                )
                self.assertEqual(result["items"][0]["downloads"], expected)

    async def test_detail_reads_native_download_count_when_compatibility_stats_are_empty(self):
        def handle(request):
            if request.url.path == f"/api/v1/skills/{SLUG}":
                return httpx.Response(
                    200,
                    json={"skill": {**item(), "stats": {}}, "latestVersion": {"version": VERSION}},
                )
            if request.url.path == f"/api/v1/skills/global/{SLUG}":
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "data": {
                            "slug": SLUG,
                            "namespace": "global",
                            "downloadCount": 12,
                            "ownerDisplayName": "Native author",
                        },
                    },
                )
            return httpx.Response(200, json={"version": VERSION, "status": "PUBLISHED"})

        result = await ClawHub(url=BASE, transport=httpx.MockTransport(handle)).detail(SLUG)
        self.assertEqual(result["downloads"], 12)
        self.assertEqual(result["provider"], "Native author")

    async def test_native_download_metadata_is_identity_bound_and_missing_is_unknown(self):
        for namespace, count in (("global", None), ("other", 12)):
            with self.subTest(namespace=namespace):

                def handle(request, namespace=namespace, count=count):
                    if request.url.path == f"/api/v1/skills/{SLUG}":
                        return httpx.Response(
                            200,
                            json={
                                "skill": {**item(), "stats": {}},
                                "latestVersion": {"version": VERSION},
                            },
                        )
                    if request.url.path == f"/api/v1/skills/global/{SLUG}":
                        return httpx.Response(
                            200,
                            json={
                                "code": 0,
                                "data": {
                                    "slug": SLUG,
                                    "namespace": namespace,
                                    "downloadCount": count,
                                },
                            },
                        )
                    return httpx.Response(200, json={"version": VERSION, "status": "PUBLISHED"})

                hub = ClawHub(url=BASE, transport=httpx.MockTransport(handle))
                if namespace == "global":
                    self.assertIsNone((await hub.detail(SLUG))["downloads"])
                else:
                    with self.assertRaises(ClawHubError):
                        await hub.detail(SLUG)

    def test_api_install_honors_disabled_preference_and_rejects_non_boolean(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("SKILL.md", f"---\nname: {SLUG}\ndescription: Read papers\n---\n")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = SkillCatalog(bundled_root=root / "bundled", user_root=root / "skills")
            runtime = SimpleNamespace(
                skill_inventory=AsyncMock(return_value=SkillInventory(cwd=root)),
                configure_skills=AsyncMock(),
            )
            app = FastAPI()
            app.state.skill_catalog = catalog
            app.state.runtime_service = runtime
            register_capability_routes(app, activities=Activities(), workspace=root)
            remote = SimpleNamespace(
                base=BASE,
                detail=AsyncMock(return_value={"moderation": "clean", "namespace": "global"}),
                download=AsyncMock(return_value=payload.getvalue()),
            )
            with (
                patch("service.capabilities.service.management.ClawHub", return_value=remote),
                patch(
                    "service.capabilities.service.management.SERVICE_SKILLS_DIR", root / "skills"
                ),
                patch(
                    "service.capabilities.service.management.load_skill_state",
                    return_value=SkillProductState(),
                ),
                TestClient(app) as client,
            ):
                endpoint = f"/api/capabilities/skills/marketplace/items/{SLUG}/install"
                for invalid in ("false", 0, None):
                    self.assertEqual(
                        client.post(
                            endpoint, json={"version": VERSION, "enabled": invalid}
                        ).status_code,
                        422,
                    )
                remote.download.assert_not_awaited()
                response = client.post(endpoint, json={"version": VERSION, "enabled": False})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn(
                    SLUG, runtime.configure_skills.call_args.kwargs["state"].disabled_skills
                )

    async def test_base_path_and_trailing_slash_preserve_every_initial_endpoint(self):
        for base in (BASE, BASE + "/", BASE + "/skillhub", BASE + "/skillhub/"):
            with self.subTest(base=base):
                prefix = "/skillhub" if "skillhub" in base else ""
                paths = []

                def handle(request, paths=paths):
                    paths.append(request.url.path)
                    self.assertNotIn("authorization", request.headers)
                    if request.url.path.endswith("/download"):
                        return httpx.Response(200, content=b"package")
                    if request.url.path.endswith("/search"):
                        return httpx.Response(200, json={"results": [item()]})
                    if request.url.path.endswith("/versions/" + VERSION):
                        return httpx.Response(200, json={"version": VERSION, "status": "PUBLISHED"})
                    if request.url.path.endswith("/" + SLUG):
                        return httpx.Response(
                            200, json={"skill": item(), "latestVersion": {"version": VERSION}}
                        )
                    if request.url.path.endswith("/api/web/skills"):
                        return httpx.Response(200, json=catalogue([item()]))
                    return httpx.Response(
                        200, json={"slug": SLUG, "namespace": "global", "labels": []}
                    )

                hub = ClawHub(url=base, transport=httpx.MockTransport(handle))
                self.assertEqual(hub.origin, BASE)
                self.assertEqual(hub.base, base.rstrip("/"))
                self.assertEqual((await hub.list())["registry"], base.rstrip("/"))
                await hub.list(query="paper")
                await hub.detail(SLUG)
                await hub.download(SLUG, VERSION)
                self.assertEqual(
                    paths,
                    [
                        prefix + path
                        for path in (
                            "/api/web/skills",
                            f"/api/v1/skills/global/{SLUG}",
                            f"/api/v1/skills/global/{SLUG}/versions/{VERSION}/file",
                            "/api/web/skills",
                            f"/api/v1/skills/global/{SLUG}",
                            f"/api/v1/skills/global/{SLUG}/versions/{VERSION}/file",
                            f"/api/v1/skills/{SLUG}",
                            f"/api/v1/skills/global/{SLUG}/versions/{VERSION}",
                            f"/api/v1/skills/global/{SLUG}",
                            f"/api/v1/skills/global/{SLUG}/versions/{VERSION}/file",
                            "/api/v1/download",
                        )
                    ],
                )

    async def test_default_and_environment_override_keep_distinct_registry_paths(self):
        response = httpx.MockTransport(lambda request: httpx.Response(200, json=catalogue([])))
        with patch.dict("os.environ", {}, clear=True):
            default = ClawHub(transport=response)
        self.assertEqual(default.base, "https://scholarseed.damo.alibaba.com/skillhub")
        aliases = (await default.list())["registryAliases"]
        self.assertIn("http://120.26.99.45", aliases)
        self.assertIn(default.base, aliases)
        with patch.dict("os.environ", {CLAWHUB_URL_ENV: BASE + "/other/"}):
            override = ClawHub(transport=response)
        self.assertEqual(override.base, BASE + "/other")
        self.assertEqual((await override.list())["registryAliases"], [BASE + "/other"])
        old = ClawHub(url="http://120.26.99.45/", transport=response)
        self.assertEqual((await old.list())["registryAliases"], aliases)
        different_path = ClawHub(
            url="https://scholarseed.damo.alibaba.com/other", transport=response
        )
        self.assertNotIn(default.base, (await different_path.list())["registryAliases"])

    async def test_subpath_download_redirects_use_origin_not_base_and_drop_cross_origin_cookies(
        self,
    ):
        paths = []

        def handle(request):
            paths.append((request.url.host, request.url.path))
            self.assertNotIn("authorization", request.headers)
            if request.url.path.endswith("/download"):
                return httpx.Response(
                    302, headers={"location": "bundle", "set-cookie": "anon=ok; Path=/"}
                )
            if request.url.path.endswith("/api/v1/bundle"):
                self.assertIn("anon=ok", request.headers.get("cookie", ""))
                return httpx.Response(302, headers={"location": "/bundle"})
            if request.url.host == "hub.example":
                self.assertIn("anon=ok", request.headers.get("cookie", ""))
                return httpx.Response(302, headers={"location": "https://cdn.example/bundle.zip"})
            self.assertNotIn("cookie", request.headers)
            return httpx.Response(200, content=b"package")

        hub = ClawHub(
            url=BASE + "/skillhub/",
            download_hosts={"cdn.example"},
            transport=httpx.MockTransport(handle),
        )
        self.assertEqual(await hub.download(SLUG, VERSION), b"package")
        self.assertEqual(
            paths,
            [
                ("hub.example", "/skillhub/api/v1/download"),
                ("hub.example", "/skillhub/api/v1/bundle"),
                ("hub.example", "/bundle"),
                ("cdn.example", "/bundle.zip"),
            ],
        )

    async def test_api_redirects_stay_disabled_for_a_subpath(self):
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(302, headers={"location": "/api/v1/skills"})

        hub = ClawHub(url=BASE + "/skillhub/", transport=httpx.MockTransport(handle))
        with self.assertRaises(ClawHubError):
            await hub.list()
        self.assertEqual(len(requests), 1)

    async def test_backend_root_relative_download_redirect_keeps_the_gateway_prefix(self):
        for location in (
            f"/api/v1/skills/global/{SLUG}/versions/{VERSION}/download",
            f"/skillhub/api/v1/skills/global/{SLUG}/versions/{VERSION}/download",
        ):
            with self.subTest(location=location):
                paths = []

                def handle(request, paths=paths, location=location):
                    paths.append(request.url.path)
                    if request.url.path == "/skillhub/api/v1/download":
                        return httpx.Response(302, headers={"location": location})
                    if (
                        request.url.path
                        == f"/skillhub/api/v1/skills/global/{SLUG}/versions/{VERSION}/download"
                    ):
                        return httpx.Response(200, content=b"package")
                    return httpx.Response(404)

                hub = ClawHub(url=BASE + "/skillhub/", transport=httpx.MockTransport(handle))
                self.assertEqual(await hub.download(SLUG, VERSION), b"package")
                self.assertEqual(len(paths), 2)

    async def test_subpath_download_redirect_limit_is_unchanged(self):
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(302, headers={"location": "/api/v1/skills/loop/download"})

        hub = ClawHub(url=BASE + "/skillhub", transport=httpx.MockTransport(handle))
        with self.assertRaisesRegex(ClawHubError, "redirect limit"):
            await hub.download(SLUG, VERSION)
        self.assertEqual(len(requests), 5)

    async def test_anonymous_listing_search_and_cursor(self):
        requests = []

        def handle(request):
            requests.append(request)
            self.assertNotIn("authorization", request.headers)
            self.assertNotIn("x-scholarseed-host-process", request.headers)
            if request.url.path == "/api/web/skills":
                return httpx.Response(
                    200, json=catalogue([item()], page=int(request.url.params["page"]), total=61)
                )
            return httpx.Response(200, json={"slug": SLUG, "namespace": "global", "labels": []})

        hub = ClawHub(url=BASE, transport=httpx.MockTransport(handle))
        listed = await hub.list(cursor="1")
        self.assertEqual(listed["items"][0]["version"], VERSION)
        self.assertEqual(listed["nextCursor"], "2")
        self.assertEqual(listed["items"][0]["moderation"], "unknown")
        self.assertEqual(requests[0].url.params["page"], "1")
        self.assertNotIn("cursor", requests[0].url.params)
        searched = await hub.list(query="paper & data")
        self.assertEqual(searched["nextCursor"], "1")
        searched_request = next(
            request
            for request in requests
            if request.url.path == "/api/web/skills" and request.url.params.get("q")
        )
        self.assertEqual(searched_request.url.params["q"], "paper & data")

    async def test_detail_reads_published_version_without_downloading(self):
        def handle(request):
            self.assertNotIn("download", request.url.path)
            if request.url.path.endswith(VERSION):
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "data": {
                            "version": VERSION,
                            "status": "PUBLISHED",
                            "parsedMetadataJson": json.dumps({"body": "# Paper tools"}),
                        },
                    },
                )
            return httpx.Response(
                200,
                json={
                    "skill": item(),
                    "latestVersion": {"version": VERSION},
                    "moderation": {
                        "isMalwareBlocked": False,
                        "isSuspicious": False,
                        "verdict": "clean",
                    },
                },
            )

        result = await ClawHub(url=BASE, transport=httpx.MockTransport(handle)).detail(SLUG)
        self.assertEqual(result["document"], "# Paper tools")
        self.assertEqual(result["version"], VERSION)
        self.assertEqual(result["namespace"], "global")

    async def test_namespaced_compatibility_identity_reads_the_native_version(self):
        qualified = f"research--{SLUG}"
        paths = []

        def handle(request):
            paths.append(request.url.path)
            self.assertNotIn("authorization", request.headers)
            if request.url.path == f"/api/v1/skills/{qualified}":
                return httpx.Response(
                    200,
                    json={
                        "skill": {**item(), "slug": qualified},
                        "latestVersion": {"version": VERSION},
                    },
                )
            if request.url.path == f"/api/v1/skills/research/{SLUG}/versions/{VERSION}":
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "data": {
                            "version": VERSION,
                            "status": "PUBLISHED",
                            "parsedMetadataJson": json.dumps({"body": "# Namespaced skill"}),
                        },
                    },
                )
            return httpx.Response(404)

        hub = ClawHub(url=BASE, transport=httpx.MockTransport(handle))
        result = await hub.detail(qualified, VERSION)
        self.assertEqual(result["slug"], qualified)
        self.assertEqual(result["document"], "# Namespaced skill")
        self.assertEqual(result["namespace"], "research")
        self.assertEqual(
            paths,
            [
                f"/api/v1/skills/{qualified}",
                f"/api/v1/skills/research/{SLUG}/versions/{VERSION}",
                f"/api/v1/skills/research/{SLUG}",
                f"/api/v1/skills/research/{SLUG}/versions/{VERSION}/file",
            ],
        )

    async def test_anonymous_cookie_redirect_and_version_pinning(self):
        def handle(request):
            self.assertNotIn("authorization", request.headers)
            if request.url.path == "/api/v1/download":
                self.assertEqual(request.url.params["version"], VERSION)
                return httpx.Response(
                    302, headers={"location": "/bundle", "set-cookie": "anon=ok; Path=/"}
                )
            if request.url.path == "/bundle":
                self.assertIn("anon=ok", request.headers.get("cookie", ""))
                return httpx.Response(
                    302, headers={"location": "https://cdn.example/bundle.zip?signature=secret"}
                )
            self.assertNotIn("cookie", request.headers)
            return httpx.Response(200, content=b"PK-package")

        hub = ClawHub(
            url=BASE, download_hosts={"cdn.example"}, transport=httpx.MockTransport(handle)
        )
        self.assertEqual(await hub.download(SLUG, VERSION), b"PK-package")

    async def test_redirects_cannot_escape_approved_https_hosts(self):
        for target in (
            "http://cdn.example/file",
            "https://evil.example/file",
            "http://127.0.0.1/file",
            "https://user:pass@cdn.example/file",
            "https://@cdn.example/file",
            "https://cdn.example:444/file",
            "https://cdn.example/file#fragment",
            "https://hub.example.evil/file",
        ):
            with self.subTest(target=target):
                hub = ClawHub(
                    url=BASE,
                    download_hosts={"cdn.example"},
                    transport=httpx.MockTransport(
                        lambda request, target=target: httpx.Response(
                            302, headers={"location": target}
                        )
                    ),
                )
                with self.assertRaises(ClawHubError) as caught:
                    await hub.download(SLUG, VERSION)
                self.assertNotIn("pass", str(caught.exception))

    async def test_failures_are_not_empty_catalogues_or_secret_leaks(self):
        responses = (
            httpx.Response(401, json={"msg": "login secret"}),
            httpx.Response(200, text="html"),
            httpx.Response(200, json={"items": "invalid"}),
            httpx.Response(200, json={"items": [{"slug": "../bad"}]}),
        )
        for response in responses:
            hub = ClawHub(
                url=BASE, transport=httpx.MockTransport(lambda request, response=response: response)
            )
            with self.assertRaises(ClawHubError) as caught:
                await hub.list()
            self.assertNotIn("secret", str(caught.exception))

    async def test_size_limit_applies_to_streamed_download(self):
        hub = ClawHub(
            url=BASE,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, content=b"too large")
            ),
        )
        with patch("service.capabilities.service.clawhub.MAX_PACKAGE_BYTES", 2):
            with self.assertRaises(ClawHubError):
                await hub.download(SLUG, VERSION)

    async def test_configuration_and_identifiers_reject_url_injection(self):
        for url in (
            "file:///etc/passwd",
            "https://user:pass@hub.example",
            "https://hub.example/?token=x",
            "https://hub.example/skillhub?token=x",
            "https://hub.example/skillhub#fragment",
            "https://hub.example/a/../skillhub",
            "https://hub.example/a/%2e%2e/skillhub",
            "https://hub.example/a%2fskillhub",
            "https://hub.example/a\\skillhub",
            "https://hub.example/a//skillhub",
            "https://hub.example/skillhub\n",
            "https://hub.example/./skillhub",
            "https://hub.example/skillhub?",
            "https://hub.example/skillhub#",
            "https://@hub.example/skillhub",
            "https://[invalid/skillhub",
        ):
            with self.assertRaises(ClawHubError):
                ClawHub(url=url)
        hub = ClawHub(url=BASE)
        for slug in ("../evil", "https://evil.example", "x/y", "%2f"):
            with self.assertRaises(ClawHubError):
                await hub.detail(slug)

    async def test_detail_rejects_wrong_identity_or_version(self):
        hub = ClawHub(
            url=BASE,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={
                        "skill": {**item(), "slug": "different"},
                        "latestVersion": {"version": VERSION},
                    },
                )
            ),
        )
        with self.assertRaises(ClawHubError):
            await hub.detail(SLUG)

    def test_remote_archive_rejects_windows_and_posix_traversal(self):
        for filename in (
            "../escape",
            "..\\escape",
            "C:/escape",
            "\\\\server\\share\\escape",
            "data:stream",
            "NUL",
            "folder./escape",
        ):
            payload = io.BytesIO()
            with zipfile.ZipFile(payload, "w") as archive:
                archive.writestr("SKILL.md", "---\nname: safe\ndescription: test\n---\n")
                archive.writestr(filename, "unsafe")
            with self.assertRaises(SkillPackageError):
                install_skill_archive(payload.getvalue(), Path("must-not-be-created"))

    def test_api_install_persists_source_and_refuses_duplicates_and_blocked_skills(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("SKILL.md", f"---\nname: {SLUG}\ndescription: Read papers\n---\n")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            user = root / "skills"
            catalog = SkillCatalog(bundled_root=root / "bundled", user_root=user)
            app = FastAPI()
            app.state.skill_catalog = catalog
            runtime = SimpleNamespace(
                configure_skills=AsyncMock(),
                skill_inventory=AsyncMock(return_value=SkillInventory(cwd=root, skills=())),
            )
            app.state.runtime_service = runtime
            register_capability_routes(app, activities=Activities(), workspace=root)
            remote = SimpleNamespace(
                base=BASE + "/skillhub",
                detail=AsyncMock(return_value={"moderation": "unknown", "namespace": "research"}),
                download=AsyncMock(return_value=payload.getvalue()),
                list=AsyncMock(
                    return_value={"items": [item()], "nextCursor": None, "registry": BASE}
                ),
            )
            with (
                patch("service.capabilities.service.management.ClawHub", return_value=remote),
                patch("service.capabilities.service.management.SERVICE_SKILLS_DIR", user),
                patch(
                    "service.capabilities.service.management.load_skill_state",
                    return_value=SkillProductState(),
                ),
                TestClient(app) as client,
            ):
                self.assertEqual(
                    client.get("/api/capabilities/skills/marketplace").status_code, 200
                )
                qualified = f"research--{SLUG}"
                endpoint = f"/api/capabilities/skills/marketplace/items/{qualified}/install"
                self.assertEqual(
                    client.get("/api/capabilities/skills/marketplace/document").status_code, 404
                )
                response = client.post(endpoint, json={"version": VERSION})
                self.assertEqual(response.status_code, 200, response.text)
                runtime.configure_skills.assert_awaited_once()
                origin = json.loads((user / SLUG / ".origin.json").read_text())
                self.assertEqual(origin["registry"], BASE + "/skillhub")
                self.assertEqual(origin["version"], VERSION)
                self.assertEqual(origin["namespace"], "research")
                self.assertEqual(origin["slug"], qualified)
                inventory = SkillInventory(
                    cwd=root,
                    skills=(
                        SkillView(
                            name=SLUG,
                            path=user / SLUG / "SKILL.md",
                            description="Read papers",
                            availability=SkillAvailability.AVAILABLE,
                            enabled=True,
                        ),
                    ),
                )
                restored = catalog.payloads(inventory, SkillProductState())
                self.assertEqual(restored[0]["hub"]["source"], "clawhub")
                self.assertEqual(restored[0]["hub"]["namespace"], "research")
                self.assertEqual(restored[0]["hub"]["slug"], qualified)
                self.assertEqual(restored[0]["group"], "user")
                self.assertEqual(
                    client.post(endpoint, json={"version": VERSION}).json()["detail"]["code"],
                    "duplicate_name",
                )
                self.assertEqual(client.post(endpoint, json={}).status_code, 422)
                remote.detail.return_value = {"moderation": "blocked"}
                before = remote.download.await_count
                self.assertEqual(client.post(endpoint, json={"version": VERSION}).status_code, 422)
                self.assertEqual(remote.download.await_count, before)

    def test_marketplace_cannot_shadow_a_reserved_bundled_skill(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("SKILL.md", f"---\nname: {SLUG}\ndescription: Read papers\n---\n")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(SkillPackageError):
                install_skill_archive(payload.getvalue(), root, reserved_names=frozenset({SLUG}))
            self.assertFalse((root / SLUG).exists())


def main() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ClawHubContract)
    return int(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())


if __name__ == "__main__":
    raise SystemExit(main())
