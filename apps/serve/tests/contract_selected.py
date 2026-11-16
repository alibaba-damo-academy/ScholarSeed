"""Exact-selection preparation against real isolated SQLite; no model or network."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from functools import partial
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from service.literature.domain.model import LITERATURE_VERSION_CONFLICT, LiteratureError
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service import enrichment
from service.literature.service.bibliography import (
    NETWORK_FAILED,
    QUOTA_EXHAUSTED,
    BibliographyError,
    fetch_bibliography,
)
from service.literature.service.queries import LiteratureQueries
from service.literature.service.selected import SelectedSources
from service.platform.activity import Activities, ActivityDomain
from service.platform.queries import LiteratureSearch, ProjectQueryError


class SelectedContracts(unittest.IsolatedAsyncioTestCase):
    async def test_standard_reuses_machine_asset_without_abstract_but_quick_stays_pending(self):
        self.paper("machine")
        self.repository.add_attachment(
            "machine",
            "paper.pdf",
            "/owned/paper.pdf",
            revision="sha256:" + "a" * 64,
            media_type="application/pdf",
            attachment_id="pdf",
        )
        self.select("machine")
        with (
            patch.object(self.service, "_complete", new_callable=AsyncMock),
            patch(
                "service.literature.persistence.analysis.AnalysisStore.reading_metadata",
                return_value={"l1": {"paper_type": "method"}},
            ),
        ):
            standard = self.manifest(await self.prepare())
        self.assertEqual(standard["ready"], ["literature:machine"])
        self.assertEqual(self.repository.get("machine").abstract, "")
        request = self.workspace / "01_input/writing_request.json"
        data = json.loads(request.read_text())
        data["execution"] = {"mode": "quick"}
        request.write_text(json.dumps(data))
        with patch.object(self.service, "_complete", new_callable=AsyncMock):
            quick = self.manifest(await self.prepare())
        self.assertEqual(quick["pending"], ["literature:machine"])

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "survey"
        (self.workspace / "01_input").mkdir(parents=True)
        self.repository = LiteratureRepository(self.root / "library.sqlite3")
        self.activities = Activities()
        self.turn = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(self.turn.close)
        self.service = SelectedSources(self.repository, self.activities)

    def paper(self, identity, abstract="", project="project", **values):
        self.repository.save(
            LiteratureItem(
                id=identity,
                title="Study " + identity,
                authors="Ada Author",
                year=2024,
                abstract=abstract,
                **values,
            ),
            project_id=project,
        )

    def select(self, *identities):
        refs = ["literature:" + identity for identity in identities]
        (self.workspace / "01_input/writing_request.json").write_text(
            json.dumps(
                {
                    "sources": {"policy": "supplement", "refs": refs},
                    "execution": {"mode": "standard"},
                }
            )
        )
        return refs

    async def prepare(self, revision=1, current=lambda: None):
        return await self.service.prepare("project", self.root, "survey", "run", revision, current)

    def manifest(self, response):
        receipt = response["selected_sources"]
        return json.loads((self.root / receipt["path"]).read_text())

    async def test_exact_batch_completes_and_writes_only_selected_empty_fields(self):
        self.paper("ready", "Original ready abstract.")
        self.paper("fill", doi="10.1234/fill")
        self.paper("pending", doi="10.1234/pending")
        self.paper("unselected", doi="10.1234/unselected")
        refs = self.select("ready", "fill", "pending")

        async def fetch(kind, identifier, **kwargs):
            return {
                "success": True,
                "fields": {
                    "title": "Study " + identifier.rsplit("/", 1)[-1],
                    "authors": "Wrong Replacement",
                    "year": 2025,
                    "abstract": (
                        "Upstream original abstract." if identifier.endswith("fill") else ""
                    ),
                },
            }

        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new=AsyncMock(side_effect=fetch),
        ) as fetcher:
            response = await self.prepare()
        manifest = self.manifest(response)
        self.assertEqual(manifest["selection"]["refs"], refs)
        self.assertEqual(manifest["ready"], refs[:2])
        self.assertEqual(manifest["pending"], refs[2:])
        self.assertEqual(fetcher.await_count, 2)
        self.assertEqual(self.repository.get("fill").abstract, "")
        self.assertEqual(
            manifest["entries"][1]["metadata"]["abstract"], "Upstream original abstract."
        )
        self.assertEqual(self.repository.get("fill").authors, "Ada Author")
        self.assertEqual(self.repository.get("fill").year, 2024)
        self.assertEqual(self.repository.get("unselected").abstract, "")
        self.assertEqual(response["selected_sources"]["display"], "message")
        self.assertEqual(response["selected_sources"]["model_calls"], 0)

    async def test_ready_batch_is_idempotent_without_metadata_calls(self):
        self.paper("one", "Actual original abstract.")
        self.select("one")
        with patch(
            "service.literature.service.enrichment.search_by_title", new_callable=AsyncMock
        ) as fetch:
            first, second = await asyncio.gather(self.prepare(), self.prepare())
        self.assertEqual(first, second)
        fetch.assert_not_awaited()
        self.assertEqual(self.repository.get("one").version, 1)

    async def test_concurrent_missing_selection_has_one_completion_and_job(self):
        self.paper("fill", doi="10.1234/fill")
        initial_version = self.repository.get("fill").version
        self.select("fill")
        entered, release = asyncio.Event(), asyncio.Event()

        async def lookup(*args, **kwargs):
            entered.set()
            await release.wait()
            return {
                "success": True,
                "fields": {
                    "title": "Study fill",
                    "doi": "10.1234/fill",
                    "abstract": "Original upstream evidence.",
                },
            }

        with patch(
            "service.literature.service.enrichment.fetch_bibliography", side_effect=lookup
        ) as fetch:
            first = asyncio.create_task(self.prepare())
            await asyncio.wait_for(entered.wait(), 2)
            second = asyncio.create_task(self.prepare())
            await asyncio.sleep(0)
            release.set()
            a, b = await asyncio.gather(first, second)
        self.assertEqual(fetch.await_count, 1)
        self.assertEqual(a["selected_sources"]["job_id"], b["selected_sources"]["job_id"])
        self.assertEqual(a["selected_sources"]["sha256"], b["selected_sources"]["sha256"])
        self.assertEqual(self.repository.get("fill").version, initial_version)

    async def test_placeholder_and_generated_summary_do_not_become_original_abstract(self):
        for identity, abstract in (
            ("placeholder", "No abstract available."),
            ("ellipsis", "..."),
            ("generated", ""),
        ):
            self.paper(identity, abstract, doi="10.1234/" + identity)
        refs = self.select("placeholder", "ellipsis", "generated")

        async def lookup(kind, query, **kwargs):
            fields = {
                "title": "Study " + query.rsplit("/", 1)[-1],
                "doi": query,
                "summary": "A generated interpretation of the work.",
            }
            if not query.endswith("generated"):
                fields["abstract"] = "The original publisher abstract is available."
            return {"success": True, "fields": fields}

        with patch("service.literature.service.enrichment.fetch_bibliography", side_effect=lookup):
            response = await self.prepare()
        manifest = self.manifest(response)
        self.assertEqual(manifest["ready"], refs[:2])
        self.assertEqual(manifest["pending"], refs[2:])
        self.assertEqual(self.repository.get("generated").abstract, "")
        self.assertEqual(response["selected_sources"]["model_calls"], 0)

    async def test_metadata_workers_are_bounded(self):
        rows = [
            {"title": "Study", "authors": ["Ada Author"], "year": 2024, "doi": "10.1234/" + str(i)}
            for i in range(9)
        ]
        active = maximum = 0
        entered, release = asyncio.Event(), asyncio.Event()

        async def lookup(kind, query, **kwargs):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            if active == enrichment.METADATA_CONCURRENCY:
                entered.set()
            try:
                await release.wait()
                return {
                    "success": True,
                    "fields": {"title": "Study", "doi": query, "abstract": "Original evidence."},
                }
            finally:
                active -= 1

        with patch.object(enrichment, "fetch_bibliography", side_effect=lookup) as fetch:
            task = asyncio.create_task(enrichment.complete_metadata(rows, selected=True))
            await asyncio.wait_for(entered.wait(), 2)
            self.assertEqual(fetch.await_count, enrichment.METADATA_CONCURRENCY)
            release.set()
            await task
        self.assertEqual(maximum, enrichment.METADATA_CONCURRENCY)
        self.assertEqual(fetch.await_count, len(rows))
        self.assertTrue(all(row["metadata_completion"]["status"] == "completed" for row in rows))

    async def test_generated_summary_field_cannot_supply_an_original_abstract(self):
        self.paper("generated", doi="10.1234/generated")
        refs = self.select("generated")
        with patch.object(
            enrichment,
            "fetch_bibliography",
            return_value={
                "success": True,
                "fields": {
                    "title": "Study generated",
                    "doi": "10.1234/generated",
                    "summary": "A generated interpretation is not a publisher abstract.",
                },
            },
        ):
            response = await self.prepare()
        manifest = self.manifest(response)
        self.assertEqual(manifest["ready"], [])
        self.assertEqual(manifest["pending"], refs)
        self.assertEqual(self.repository.get("generated").abstract, "")
        self.assertEqual(response["selected_sources"]["model_calls"], 0)

    async def test_shared_deadline_prevents_later_dispatch_and_late_write(self):
        rows = [
            {"title": "Study", "authors": ["Ada Author"], "year": 2024, "doi": "10.1234/" + str(i)}
            for i in range(3)
        ]
        cancelled = []

        async def lookup(kind, query, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(query)

        with (
            patch.object(enrichment, "METADATA_CONCURRENCY", 1),
            patch.object(enrichment, "fetch_bibliography", side_effect=lookup) as fetch,
        ):
            await enrichment.complete_metadata(rows, selected=True, total_seconds=0.04)
        self.assertEqual(fetch.await_count, 1)
        self.assertEqual(cancelled, ["10.1234/0"])
        self.assertEqual(rows[0]["metadata_completion"]["reason"], "timeout")
        self.assertEqual(
            [row["metadata_completion"]["reason"] for row in rows[1:]], ["budget_exhausted"] * 2
        )
        self.assertTrue(all(not row.get("abstract") for row in rows))

    async def test_explicit_context_prevents_substitution_with_another_project_source(self):
        self.paper("selected", "Selected original abstract.")
        self.paper("other", "Other original abstract.")
        self.select("other")
        with self.assertRaisesRegex(ValueError, "context_mismatch"):
            await self.service.prepare(
                "project",
                self.root,
                "survey",
                "run",
                1,
                lambda: None,
                selected_refs=("literature:selected",),
            )
        self.assertFalse((self.workspace / "02_retrieval/_selected").exists())

    async def test_collection_snapshot_keeps_all_members_and_overlapping_selection(self):
        collection = self.repository.create_collection("Selected", project_id="project")
        identities = [f"paper-{index:02d}" for index in range(24)]
        for identity in identities:
            self.paper(identity, "Original abstract " + identity)
        self.repository.organize("project", tuple(identities), (collection["id"],), (), "add")
        collection_ref = "literature_collection:" + collection["id"]
        refs = [collection_ref, "literature:" + identities[0]]
        self.select(*identities)
        path = self.workspace / "01_input/writing_request.json"
        request = json.loads(path.read_text())
        request["sources"]["refs"] = refs
        path.write_text(json.dumps(request))
        first = await self.prepare()
        manifest = self.manifest(first)
        self.assertEqual(manifest["schema"], "selected-sources/v3")
        self.assertEqual(manifest["selection"]["refs"], refs)
        self.assertEqual(len(manifest["ready"]), 24)
        self.assertEqual(manifest["selection"]["expanded_refs"], manifest["ready"])
        self.assertEqual(manifest["pending"], [])
        self.assertEqual(first, await self.prepare())
        self.paper("added", "A newly added original abstract.")
        self.repository.organize("project", ("added",), (collection["id"],), (), "add")
        changed = await self.prepare()
        self.assertEqual(len(self.manifest(changed)["ready"]), 25)
        self.assertNotEqual(
            first["selected_sources"]["sha256"], changed["selected_sources"]["sha256"]
        )
        (self.workspace / "02_retrieval/material_papers.json").write_text(
            json.dumps({"preparation": changed["selected_sources"]})
        )
        (self.workspace / "02_retrieval/selected_paper.json").write_text('{"frozen": {}}')
        self.repository.organize("project", ("added",), (collection["id"],), (), "remove")
        self.service = SelectedSources(self.repository, self.activities)
        self.assertEqual(await self.prepare(), changed)

    async def test_collection_snapshot_includes_descendants_but_not_other_project_members(self):
        parent = self.repository.create_collection("Parent", project_id="project")
        child = self.repository.create_collection(
            "Child", parent_id=parent["id"], project_id="project"
        )
        self.paper("included", "Original abstract.")
        self.paper("foreign", "Foreign original abstract.", project="other")
        self.repository.organize("project", ("included",), (child["id"],), (), "add")
        members = self.repository.collection_members("project", (parent["id"], child["id"]), 2000)
        self.assertEqual(members, {parent["id"]: ("included",), child["id"]: ("included",)})

    async def test_collection_rejects_foreign_missing_empty_and_overflow(self):
        foreign = self.repository.create_collection("Foreign", project_id="other")
        empty = self.repository.create_collection("Empty", project_id="project")
        for identity in (foreign["id"], "missing", empty["id"]):
            self.select("placeholder")
            path = self.workspace / "01_input/writing_request.json"
            request = json.loads(path.read_text())
            request["sources"]["refs"] = ["literature_collection:" + identity]
            path.write_text(json.dumps(request))
            with self.assertRaisesRegex(ValueError, "scope_invalid|collection_empty"):
                await self.prepare()
        self.paper("one", "Original one.")
        self.paper("two", "Original two.")
        self.repository.organize("project", ("one", "two"), (empty["id"],), (), "add")
        with patch("service.literature.service.selected.MAX_BATCH_RECORDS", 1):
            with self.assertRaisesRegex(ValueError, "too_large"):
                await self.prepare()

    async def test_late_completion_preserves_user_edit(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")

        async def fetch(*args, **kwargs):
            self.repository.update("one", {"abstract": "User's newer abstract."})
            return {"success": True, "fields": {"title": "Study one", "abstract": "Late response."}}

        with patch("service.literature.service.enrichment.fetch_bibliography", side_effect=fetch):
            manifest = self.manifest(await self.prepare())
        self.assertEqual(self.repository.get("one").abstract, "User's newer abstract.")
        self.assertEqual(manifest["pending"], ["literature:one"])
        self.assertIn("source_revision_changed", manifest["entries"][0]["issues"])

    async def test_removed_project_membership_is_not_resurrected(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")

        async def fetch(*args, **kwargs):
            self.repository.unlink_project(("one",), "project")
            return {"success": True, "fields": {"title": "Study one", "abstract": "Late response."}}

        with patch("service.literature.service.enrichment.fetch_bibliography", side_effect=fetch):
            result = await self.prepare()
        self.assertEqual(result["selected_sources"]["ready_count"], 0)
        self.assertEqual(self.repository.projects("one"), ())
        self.assertEqual(self.repository.get("one").abstract, "")

    async def test_network_failure_is_diagnostic_and_retryable(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            side_effect=BibliographyError(NETWORK_FAILED, 502),
        ) as fetch:
            first = await self.prepare()
            await self.prepare()
        self.assertEqual(fetch.await_count, 4)
        self.assertIn(NETWORK_FAILED, self.manifest(first)["entries"][0]["issues"])

    async def test_transient_metadata_failure_recovers_inside_the_same_job(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")
        response = {
            "success": True,
            "fields": {"title": "Study one", "abstract": "Original source abstract."},
        }
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new=AsyncMock(side_effect=[BibliographyError(NETWORK_FAILED, 502), response]),
        ) as fetch:
            result = await self.prepare()
        self.assertEqual(fetch.await_count, 2)
        self.assertEqual(result["selected_sources"]["ready_count"], 1)
        self.assertEqual(self.repository.get("one").abstract, "")
        self.assertEqual(
            self.manifest(result)["entries"][0]["metadata"]["abstract"], "Original source abstract."
        )

    async def test_metadata_retry_does_not_restart_the_per_record_deadline(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")

        async def slow(*args, **kwargs):
            await asyncio.sleep(1)

        with (
            patch("service.literature.service.enrichment.METADATA_REQUEST_SECONDS", 0.02),
            patch(
                "service.literature.service.enrichment.fetch_bibliography",
                new=AsyncMock(side_effect=slow),
            ) as fetch,
        ):
            result = await self.prepare()
        self.assertEqual(fetch.await_count, 1)
        self.assertEqual(result["selected_sources"]["ready_count"], 0)

    async def test_optional_abstract_rate_limit_is_not_cached_as_absent(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")
        requests = []

        def respond(request):
            requests.append(request.url.host)
            if request.url.host == "doi.org":
                return httpx.Response(
                    200,
                    text="@article{key,title={Study one},author={Ada Author},year={2024},doi={10.1234/one}}",
                )
            return httpx.Response(429)

        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            partial(fetch_bibliography, transport=httpx.MockTransport(respond)),
        ):
            first = await self.prepare()
            await self.prepare()
        self.assertEqual(len(requests), 4)
        self.assertEqual(first["selected_sources"]["ready_count"], 0)
        self.assertIn(QUOTA_EXHAUSTED, first["selected_sources"]["pending"][0]["reasons"])
        self.assertEqual(self.repository.get("one").abstract, "")

    async def test_fallback_abstract_retains_its_actual_provider(self):
        self.paper("one", doi="10.1234/one", arxiv="2401.00001")
        self.select("one")

        def respond(request):
            if request.url.host == "doi.org":
                return httpx.Response(
                    200,
                    text="@article{key,title={Study one},author={Ada Author},year={2024},doi={10.1234/one}}",
                )
            if request.url.host == "api.crossref.org":
                return httpx.Response(200, json={"message": {}})
            return httpx.Response(
                200,
                text='<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.00001v1</id><summary>Actual upstream abstract.</summary></entry></feed>',
            )

        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            partial(fetch_bibliography, transport=httpx.MockTransport(respond)),
        ):
            manifest = self.manifest(await self.prepare())
        self.assertEqual(manifest["ready"], ["literature:one"])
        provenance = manifest["entries"][0]["metadata"]["field_provenance"]["abstract"]
        self.assertEqual(provenance["source"], "arxiv")
        self.assertEqual(provenance["query"], "2401.00001")
        self.assertEqual(self.repository.get("one").abstract, "")
        self.assertEqual(
            manifest["entries"][0]["metadata"]["abstract"], "Actual upstream abstract."
        )

    async def test_empty_bibtex_abstract_still_uses_the_original_abstract_endpoint(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")

        def respond(request):
            if request.url.host == "doi.org":
                return httpx.Response(
                    200,
                    text="@article{key,title={Study one},author={Ada Author},year={2024},abstract={}}",
                )
            return httpx.Response(200, json={"message": {"abstract": "Actual source abstract."}})

        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            partial(fetch_bibliography, transport=httpx.MockTransport(respond)),
        ):
            result = await self.prepare()
        self.assertEqual(result["selected_sources"]["ready_count"], 1)
        self.assertEqual(self.repository.get("one").abstract, "")
        self.assertEqual(
            self.manifest(result)["entries"][0]["metadata"]["abstract"], "Actual source abstract."
        )

    async def test_ambiguous_title_stays_pending(self):
        self.paper("one")
        self.select("one")
        with patch(
            "service.literature.service.enrichment.search_by_title",
            new_callable=AsyncMock,
            return_value={"success": False, "reason": "title_identity_ambiguous"},
        ) as fetch:
            result = await self.prepare()
        self.assertTrue(fetch.call_args.kwargs["require_unique"])
        self.assertIn("title_identity_ambiguous", self.manifest(result)["entries"][0]["issues"])

    async def test_whitespace_abstract_is_an_empty_field(self):
        self.paper("one", "  \n ", doi="10.1234/one")
        self.select("one")
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            return_value={
                "success": True,
                "fields": {"title": "Study one", "abstract": "Actual source abstract."},
            },
        ):
            result = await self.prepare()
        self.assertEqual(result["selected_sources"]["ready_count"], 1)
        self.assertEqual(self.repository.get("one").abstract, "  \n ")
        self.assertEqual(
            self.manifest(result)["entries"][0]["metadata"]["abstract"], "Actual source abstract."
        )

    async def test_identity_conflict_is_visible_and_does_not_fill_abstract(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            return_value={
                "success": True,
                "fields": {"title": "A different paper", "abstract": "Other abstract."},
            },
        ):
            result = await self.prepare()
        self.assertEqual(result["selected_sources"]["ready_count"], 0)
        self.assertIn("identity_conflict", result["selected_sources"]["pending"][0]["reasons"])
        self.assertEqual(self.repository.get("one").abstract, "")

    async def test_foreign_record_remains_pending_without_network(self):
        self.paper("foreign", "Actual abstract.", project="other")
        self.select("foreign")
        with patch(
            "service.literature.service.selected.complete_metadata", new_callable=AsyncMock
        ) as complete:
            result = await self.prepare()
        self.assertEqual(complete.call_args.args[0], [])
        self.assertEqual(result["selected_sources"]["ready_count"], 0)

    async def test_malformed_selection_fails_before_any_scope_expansion(self):
        (self.workspace / "01_input/writing_request.json").write_text('{"sources":{"refs":0}}')
        with patch(
            "service.literature.service.selected.complete_metadata", new_callable=AsyncMock
        ) as complete:
            with self.assertRaisesRegex(ValueError, "selected_sources_request_invalid"):
                await self.prepare()
        complete.assert_not_awaited()

    async def test_stale_selection_cannot_write_or_publish(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")
        active = True

        def current():
            if not active:
                raise ValueError("task_context_stale")

        async def fetch(*args, **kwargs):
            nonlocal active
            active = False
            return {"success": True, "fields": {"title": "Study one", "abstract": "Late response."}}

        with patch("service.literature.service.enrichment.fetch_bibliography", side_effect=fetch):
            with self.assertRaisesRegex(ValueError, "task_context_stale"):
                await self.prepare(current=current)
        self.assertEqual(self.repository.get("one").abstract, "")
        self.assertFalse((self.workspace / "02_retrieval/_selected").exists())

    async def test_interrupt_closes_pending_metadata_request_before_writes(self):
        self.paper("one", doi="10.1234/one")
        self.select("one")
        entered, closed = asyncio.Event(), asyncio.Event()
        active = True

        def current():
            if not active:
                raise ValueError("task_context_stale")

        async def fetch(*args, **kwargs):
            entered.set()
            try:
                await asyncio.sleep(10)
            finally:
                closed.set()

        with patch("service.literature.service.enrichment.fetch_bibliography", side_effect=fetch):
            running = asyncio.create_task(self.prepare(current=current))
            await entered.wait()
            active = False
            with self.assertRaisesRegex(ValueError, "task_context_stale"):
                await asyncio.wait_for(running, 1)
        self.assertTrue(closed.is_set())
        self.assertEqual(self.repository.get("one").abstract, "")
        self.assertFalse((self.workspace / "02_retrieval/_selected").exists())

    async def test_cas_rejects_stale_version(self):
        self.paper("one", "Original abstract.")
        self.repository.update("one", {"title": "User title"})
        with self.assertRaises(LiteratureError) as caught:
            self.repository.update(
                "one", {"abstract": "Stale abstract"}, expected_version=1, project_id="project"
            )
        self.assertEqual(caught.exception.code, LITERATURE_VERSION_CONFLICT)
        self.assertEqual(self.repository.get("one").abstract, "Original abstract.")

    async def test_frozen_manifest_survives_late_library_edit_and_service_restart(self):
        self.paper("one", "Original abstract.")
        self.select("one")
        first = await self.prepare()
        receipt = first["selected_sources"]
        (self.workspace / "02_retrieval/material_papers.json").write_text(
            json.dumps({"preparation": receipt})
        )
        (self.workspace / "02_retrieval/selected_paper.json").write_text(
            '{"one": {"paperId": "one"}}'
        )
        self.repository.update("one", {"abstract": "New library abstract."})
        self.service = SelectedSources(self.repository, self.activities)
        second = await self.prepare(revision=2)
        self.assertEqual(first, second)
        self.assertEqual(
            self.manifest(second)["entries"][0]["metadata"]["abstract"], "Original abstract."
        )
        self.assertEqual(self.repository.get("one").abstract, "New library abstract.")

    async def test_completed_manifest_is_reused_after_restart_before_freeze(self):
        self.paper("one", "Original abstract.")
        self.select("one")
        first = await self.prepare()
        (self.workspace / "02_retrieval/material_papers.json").write_text(
            json.dumps({"preparation": first["selected_sources"]})
        )
        self.service = SelectedSources(self.repository, self.activities)
        with patch(
            "service.literature.service.selected.complete_metadata", new_callable=AsyncMock
        ) as complete:
            second = await self.prepare()
        complete.assert_not_awaited()
        self.assertEqual(first, second)

    async def test_metadata_only_collection_search_is_scoped_and_paginated(self):
        collection = self.repository.create_collection("Selected", project_id="project")
        other = self.repository.create_collection("Foreign", project_id="other")
        for identity in ("one", "two", "unselected"):
            self.paper(identity, "Original abstract.")
        self.repository.organize("project", ("one", "two"), (collection["id"],), (), "add")
        queries = LiteratureQueries(self.repository)
        first = queries.search(
            "project", LiteratureSearch(collection_ids=[collection["id"]], limit=1)
        )
        second = queries.search(
            "project",
            LiteratureSearch(collection_ids=[collection["id"]], offset=first.next_offset, limit=1),
        )
        self.assertEqual({first.items[0].id, second.items[0].id}, {"one", "two"})
        self.assertIsNone(second.next_offset)
        with self.assertRaises(ProjectQueryError):
            queries.search("project", LiteratureSearch(collection_ids=[other["id"]]))


if __name__ == "__main__":
    unittest.main()
