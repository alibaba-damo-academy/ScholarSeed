"""Offline catalogue-to-search metadata contracts; never uses a provider or user data."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from functools import partial
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx

from service.literature.schema import LiteratureItem
from service.literature.service.bibliography import fetch_bibliography
from service.literature.service.candidates import complete_candidates, prepare_candidates
from service.literature.service.enrichment import candidate_metadata, complete_metadata
from service.literature.service.openalex import search_by_title


class CandidateMetadataContract(unittest.IsolatedAsyncioTestCase):
    async def test_exact_selection_title_lookup_does_not_choose_first_ambiguous_hit(self):
        response = await search_by_title(
            "Shared title",
            require_unique=True,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={
                        "meta": {"count": 2},
                        "results": [{"title": "Shared title"}],
                    },
                )
            ),
        )
        self.assertEqual(response, {"success": False, "reason": "title_identity_ambiguous"})

    async def test_existing_bibtex_service_is_consumed_without_real_network(self):
        requests = []

        def handler(request):
            requests.append(str(request.url))
            return httpx.Response(
                200,
                text="@article{key, title={A study of learning}, "
                "author={Ada Author and Li Ming}, year={2024}, "
                "doi={10.1234/one}, abstract={Source abstract.}, volume={12}}",
            )

        row = self.paper(doi="10.1234/one")
        row.update(authors=[], year=None)
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            partial(fetch_bibliography, transport=httpx.MockTransport(handler)),
        ):
            await complete_metadata([row])
        self.assertEqual(len(requests), 1)
        self.assertEqual(row["authors"], ["Ada Author", "Li Ming"])
        self.assertEqual(row["year"], 2024)
        self.assertEqual(row["metadata_completion"]["status"], "completed")

    async def test_source_date_supplies_year_without_provider(self):
        row = candidate_metadata(
            LiteratureItem(
                id="one",
                title="Paper",
                authors="Ada Author",
                abstract="Source abstract",
                published_date="2024-04-01",
            )
        )
        with patch(
            "service.literature.service.enrichment.search_by_title", new_callable=AsyncMock
        ) as fetch:
            await complete_metadata([row])
        fetch.assert_not_awaited()
        self.assertEqual(row["year"], 2024)

    def paper(self, **values):
        return {
            "paper_id": "literature:one",
            "library_refs": ["literature:one"],
            "source": "project_library",
            **candidate_metadata(
                LiteratureItem(
                    id="one",
                    title="A study of learning",
                    authors="Ada Author, 李明",
                    year=2024,
                    abstract="An original abstract.",
                    **values,
                )
            ),
        }

    async def test_author_boundaries_and_complete_fields(self):
        item = LiteratureItem(
            id="one",
            title="Paper",
            authors="Ada Author, 李明, Zoë van Meer",
            year=2024,
            journal="Journal",
            volume="12",
            number="2",
            pages="1–9",
            publisher="Publisher",
            address="City",
            isbn="123",
            citation_key="source-key",
            published_date="2024-03-01",
            doi="10.1/one",
            arxiv="2401.00001v2",
        )
        row = candidate_metadata(item)
        self.assertEqual(row["authors"], ["Ada Author", "李明", "Zoë van Meer"])
        self.assertEqual(row["author_metadata"]["raw"], row["authors"])
        self.assertEqual(row["external_ids"], {"DOI": "10.1/one", "ArXiv": "2401.00001v2"})
        for name in ("volume", "number", "pages", "publisher", "address", "isbn", "citation_key"):
            self.assertEqual(row[name], getattr(item, name))
        self.assertEqual(row["publication_date"], item.published_date)
        self.assertEqual(row["journal_name"], "Journal")
        self.assertNotIn("paperhub_id", row)

    async def test_explicit_names_preserve_commas_and_corporations(self):
        row = candidate_metadata(
            LiteratureItem(
                id="one",
                title="Paper",
                authors="Smith, John; Ludwig van Beethoven; {Research, Inc.}",
            )
        )
        self.assertEqual(
            row["authors"], ["Smith, John", "Ludwig van Beethoven", "{Research, Inc.}"]
        )
        self.assertEqual(
            candidate_metadata(LiteratureItem(id="a", title="P", authors="Smith, John"))["authors"],
            "Smith, John",
        )
        self.assertEqual(
            candidate_metadata(
                LiteratureItem(
                    id="a", title="P", authors="{Research, Inc.}, Ada Author, {Other, Group}"
                )
            )["authors"],
            ["{Research, Inc.}", "Ada Author", "{Other, Group}"],
        )

    async def test_complete_records_never_fetch(self):
        rows = [self.paper()]
        before = json.dumps(rows)
        with patch(
            "service.literature.service.enrichment.fetch_bibliography", new_callable=AsyncMock
        ) as fetch:
            await complete_metadata(rows)
        fetch.assert_not_awaited()
        self.assertEqual(json.dumps(rows), before)

    async def test_fill_only_missing_fields_and_keep_identity_and_evidence(self):
        row = self.paper(doi="10.1/one")
        row.update(
            authors=[],
            year=None,
            selection_evidence={"kind": "local_pdf_excerpt", "revision": "sha256:a"},
        )
        response = {
            "success": True,
            "fields": {
                "title": row["title"],
                "doi": "10.1/one",
                "authors": "Ada Author, 李明",
                "year": 2024,
                "abstract": "Different abstract",
                "volume": "12",
            },
        }
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new_callable=AsyncMock,
            return_value=response,
        ) as fetch:
            await complete_metadata([row])
        self.assertEqual(fetch.await_count, 1)
        self.assertEqual(row["authors"], ["Ada Author", "李明"])
        self.assertEqual(row["year"], 2024)
        self.assertEqual(row["abstract"], "An original abstract.")
        self.assertEqual(row["volume"], "12")
        self.assertEqual(row["paper_id"], "literature:one")
        self.assertEqual(row["selection_evidence"]["revision"], "sha256:a")
        self.assertEqual(row["metadata_completion"]["status"], "completed")

    async def test_mismatch_and_failure_leave_missing_fields_visible(self):
        row = self.paper(doi="10.1/one")
        row["authors"] = []
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new_callable=AsyncMock,
            return_value={
                "success": True,
                "fields": {"title": row["title"], "doi": "10.1/other", "authors": "Wrong Author"},
            },
        ):
            await complete_metadata([row])
        self.assertEqual(row["authors"], [])
        self.assertEqual(row["metadata_completion"]["status"], "identity_conflict")
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new_callable=AsyncMock,
            side_effect=TimeoutError,
        ):
            await complete_metadata([row])
        self.assertEqual(row["authors"], [])
        self.assertEqual(row["metadata_completion"]["status"], "unavailable")

    async def test_title_lookup_requires_exact_identity(self):
        row = self.paper()
        row["authors"] = []
        with patch(
            "service.literature.service.enrichment.search_by_title",
            new_callable=AsyncMock,
            return_value={
                "success": True,
                "fields": {"title": "Another study of learning", "authors": "Wrong Author"},
            },
        ):
            await complete_metadata([row])
        self.assertEqual(row["authors"], [])
        self.assertEqual(row["metadata_completion"]["status"], "identity_conflict")

    async def test_local_preview_avoids_abstract_recovery(self):
        row = self.paper()
        row.update(abstract="", selection_evidence={"kind": "local_pdf_excerpt"})
        with patch(
            "service.literature.service.enrichment.search_by_title", new_callable=AsyncMock
        ) as fetch:
            await complete_metadata([row])
        fetch.assert_not_awaited()
        self.assertEqual(row["abstract"], "")

    async def test_snapshot_resume_never_refetches_and_does_not_write_catalogue(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "survey/02_retrieval").mkdir(parents=True)
            evidence = Mock()
            row = self.paper(doi="10.1/one")
            row["authors"] = []
            evidence.catalog.return_value = {"sources": [row], "next_offset": None}
            fetch = AsyncMock(
                return_value={
                    "success": True,
                    "fields": {"title": row["title"], "authors": "Ada Author"},
                }
            )
            with patch("service.literature.service.enrichment.fetch_bibliography", fetch):
                prepared = await complete_candidates(
                    prepare_candidates(evidence, "project", root, "survey", "run")
                )
                prepared.publish()
                again = await complete_candidates(
                    prepare_candidates(evidence, "project", root, "survey", "run")
                )
            self.assertEqual(fetch.await_count, 1)
            self.assertEqual(again.payload, prepared.payload)
            self.assertEqual(evidence.catalog.call_count, 1)
            self.assertEqual(row["authors"], [])

    async def test_cancellation_propagates(self):
        row = self.paper(doi="10.1/one")
        row["authors"] = []
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new_callable=AsyncMock,
            side_effect=asyncio.CancelledError,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await complete_metadata([row])

    async def test_completion_preserves_order_with_bounded_concurrency(self):
        rows = [self.paper(doi=f"10.1/{index}") for index in range(9)]
        for row in rows:
            row["authors"] = []
        active = maximum = 0

        async def fetch(kind, query, **kwargs):
            nonlocal active, maximum
            active += 1
            maximum = max(active, maximum)
            await asyncio.sleep(0)
            active -= 1
            return {"success": True, "fields": {"title": rows[0]["title"], "authors": "Ada Author"}}

        with patch("service.literature.service.enrichment.fetch_bibliography", side_effect=fetch):
            await complete_metadata(rows)
        self.assertLessEqual(maximum, 4)
        self.assertEqual([row["doi"] for row in rows], [f"10.1/{index}" for index in range(9)])
        self.assertTrue(all(row["metadata_completion"]["status"] == "completed" for row in rows))

    async def test_budget_exhaustion_reports_every_unresolved_record(self):
        row = self.paper(doi="10.1/one")
        row["authors"] = []
        with (
            patch("service.literature.service.enrichment.METADATA_TOTAL_SECONDS", 0),
            patch(
                "service.literature.service.enrichment.fetch_bibliography", new_callable=AsyncMock
            ) as fetch,
        ):
            await complete_metadata([row])
        fetch.assert_not_awaited()
        self.assertEqual(row["metadata_completion"]["reason"], "budget_exhausted")
        self.assertEqual(row["metadata_completion"]["missing_fields"], ["authors"])

    async def test_incomplete_response_does_not_synthesize_required_fields(self):
        row = self.paper(arxiv="2401.00001v2")
        row.update(year=None, abstract="No abstract available")
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new_callable=AsyncMock,
            return_value={
                "success": True,
                "fields": {"title": row["title"], "authors": "Wrong Name"},
            },
        ):
            await complete_metadata([row])
        self.assertEqual(row["authors"], ["Ada Author", "李明"])
        self.assertEqual(row["metadata_completion"]["status"], "partial")
        self.assertEqual(row["metadata_completion"]["missing_fields"], ["year", "abstract"])

    async def test_explicit_arxiv_version_conflict_does_not_fill(self):
        row = self.paper(arxiv="2401.00001v2")
        row["authors"] = []
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new_callable=AsyncMock,
            return_value={
                "success": True,
                "fields": {
                    "title": row["title"],
                    "arxiv": "2401.00001v3",
                    "authors": "Other Author",
                },
            },
        ):
            await complete_metadata([row])
        self.assertEqual(row["authors"], [])
        self.assertEqual(row["metadata_completion"]["status"], "identity_conflict")

    async def test_the_other_identifier_on_the_row_joins_the_abstract_chain(self):
        """批量补全与单条查询同一口径: 行上另一个标识符作为摘要备用来源一起送下去。"""

        row = self.paper(doi="10.1234/one", arxiv="1706.03762v2")
        row.update(authors=[], year=None)
        with patch(
            "service.literature.service.enrichment.fetch_bibliography",
            new_callable=AsyncMock,
            return_value={
                "success": True,
                "fields": {"title": row["title"], "doi": "10.1234/one", "authors": "Ada Author"},
            },
        ) as fetch:
            await complete_metadata([row])
        self.assertEqual(fetch.await_args.args, ("doi", "10.1234/one"))
        self.assertEqual(
            fetch.await_args.kwargs["abstract_chain"],
            (("doi", "10.1234/one"), ("arxiv", "1706.03762v2")),
        )


if __name__ == "__main__":
    unittest.main()
