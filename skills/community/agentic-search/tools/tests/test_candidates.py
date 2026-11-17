"""Zero-model contracts for optional project candidates in the existing pool."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import dedup
import finalize
import quick_finalize
import search_round
import state


class CandidatesTest(unittest.TestCase):
    def test_quick_search_honors_small_explicit_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            session = str(Path(directory) / "session")
            state.init_state(session, "Only the requested papers", mode="quick")
            papers = [
                {
                    "paper_id": str(index),
                    "title": f"Paper {index}",
                    "found_by": [f"title:Paper {index}"],
                }
                for index in range(6)
            ]
            with patch.object(state, "read_pool", return_value=papers):
                for count in (1, 2, 5):
                    result = quick_finalize.finalize_quick(session, directory, count=count)
                    metadata = json.loads(Path(result["output"]).read_text())
                    self.assertEqual(len(metadata["papers"]), count)
                    self.assertEqual(sum(metadata["search_summary"]["tier_budget"]), count)
                result = quick_finalize.finalize_quick(
                    session, directory, count=2, titles=["Paper 1", "Paper 4"]
                )
                metadata = json.loads(Path(result["output"]).read_text())
                self.assertEqual(
                    {paper["title"] for paper in metadata["papers"]}, {"Paper 1", "Paper 4"}
                )
                result = quick_finalize.finalize_quick(
                    session, directory, count=2, titles=["Paper 1", "Missing"]
                )
                metadata = json.loads(Path(result["output"]).read_text())
                self.assertEqual(metadata["search_summary"]["result_status"], "partial")
                for count in (0, -1, 26):
                    with self.assertRaises(ValueError):
                        quick_finalize.finalize_quick(session, directory, count=count)

    def test_selection_preserves_canonical_identity_and_local_refs(self):
        base = {
            "paper_id": "123",
            "paperhub_id": "123",
            "title": "Paper",
            "library_refs": ["literature:a"],
            "source": "paperhub",
        }
        papers, _ = finalize._hydrate(
            [{"paper_id": 123, "paperhub_id": 123, "tier": 2}], {"123": base}
        )
        self.assertEqual(papers[0]["paper_id"], "123")
        self.assertEqual(papers[0]["paperhub_id"], "123")
        self.assertEqual(papers[0]["library_refs"], base["library_refs"])
        for field, value in [
            ("paperhub_id", "456"),
            ("library_refs", ["literature:wrong"]),
            ("paper_id", "wrong"),
        ]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                finalize._hydrate(
                    [{"paper_id": "123", "title": "Paper", field: value}], {"123": base}
                )
        for value in [True, 123.0, [], {}]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "paper_id"):
                finalize._hydrate([{"paper_id": value, "title": "Paper"}], {"123": base})
        self.assertEqual(base["paper_id"], "123")

    def test_pool_merges_real_provider_identity_and_library_origin(self):
        local = {
            "paper_id": "literature:a",
            "title": "Original title",
            "doi": "https://doi.org/10.1/a",
            "source": "project_library",
            "library_refs": ["literature:a"],
            "abstract": "Full abstract",
            "citation_count": None,
        }
        remote = {
            "paper_id": "123",
            "title": "Revised title",
            "doi": "10.1/a",
            "source": "paperhub",
            "found_by": ["title:Original title"],
            "citation_count": 50,
        }
        for rows in ([local, remote], [remote, local]):
            pool = {}
            state._merge_papers(pool, rows)
            self.assertEqual(len(pool), 1)
            paper = next(iter(pool.values()))
            self.assertEqual(
                (paper["paper_id"], paper["paperhub_id"], paper["source"]),
                ("123", "123", "paperhub"),
            )
            self.assertEqual(paper["library_refs"], ["literature:a"])
            self.assertEqual(paper["abstract"], "Full abstract")
            hydrated, _ = finalize._hydrate([{"paper_id": "123", "tier": 2}], pool)
            self.assertEqual(hydrated[0]["library_refs"], ["literature:a"])

    def test_abstract_and_truncation_marker_stay_with_their_source(self):
        local = {
            "title": "Paper",
            "source": "project_library",
            "abstract": "Cut…",
            "abstract_truncated": True,
        }
        remote = {
            "title": "Paper",
            "source": "paperhub",
            "paper_id": "123",
            "abstract": "Complete source abstract.",
        }
        merged = dedup.merge_records(local, remote)
        self.assertEqual(merged["abstract"], remote["abstract"])
        self.assertNotIn("abstract_truncated", merged)
        local.update(abstract="Complete library abstract.", abstract_truncated=False)
        remote["abstract"] = "No abstract available"
        self.assertEqual(dedup.merge_records(local, remote)["abstract"], local["abstract"])

    def test_local_abstract_survives_no_provider_match_and_tracks_its_source(self):
        local = {
            "paper_id": "literature:a",
            "title": "Local paper",
            "source": "project_library",
            "authors": ["Ada Author"],
            "year": 2024,
            "library_refs": ["literature:a"],
            "abstract": "Complete locally recovered abstract.",
            "abstract_provenance": {"kind": "local_pdf_abstract", "source_revision": "sha256:abc"},
        }
        pool = {}
        state._merge_papers(pool, [local])
        papers, unmatched = finalize._hydrate([{"paper_id": "literature:a", "tier": 2}], pool)
        self.assertFalse(unmatched)
        self.assertEqual(papers[0]["abstract_provenance"], local["abstract_provenance"])
        self.assertNotIn("paperhub_id", papers[0])
        self.assertFalse(finalize._validate(papers, "")[0])
        for abstract, expected in (
            ("Remote complete abstract.", False),
            ("No abstract available", True),
        ):
            remote = {
                "paper_id": "123",
                "title": "Local paper",
                "source": "paperhub",
                "abstract": abstract,
            }
            for rows in ((local, remote), (remote, local)):
                merged = dedup.merge_records(*rows)
                self.assertEqual("abstract_provenance" in merged, expected)
                if expected:
                    self.assertEqual(merged["abstract_provenance"], local["abstract_provenance"])
                self.assertEqual(merged["library_refs"], ["literature:a"])

    def test_conflicting_identifiers_and_ambiguous_titles_stay_separate(self):
        papers = [
            {
                "paper_id": str(i),
                "title": "同一标题",
                "doi": f"10.1/{i}",
                "tier": 2,
                "reason": "Relevant",
            }
            for i in range(2)
        ]
        pool = {}
        state._merge_papers(pool, papers)
        self.assertEqual(len(pool), 2)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            finalize._hydrate([{"title": "同一标题", "tier": 2}], pool)
        errors, _, _ = finalize._validate(papers, "")
        self.assertFalse(any("duplicate" in error for error in errors))
        self.assertFalse(
            dedup.same_paper({"arxiv_id": "2401.00001v1"}, {"arxiv_id": "2401.00001v2"})
        )

    def test_snapshot_is_optional_complete_and_never_a_citation_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "candidates.json"
            paper = {
                "paper_id": "literature:a",
                "title": "Library research",
                "source": "project_library",
            }
            value = {
                "schema": "literature-candidates/v1",
                "scope": "project_literature",
                "sources": [paper],
                "next_offset": None,
            }
            path.write_text(json.dumps(value))
            session = str(Path(tmp) / "session")
            result = state.init_state(session, mode="balanced", candidates=str(path))
            self.assertEqual(result["candidate_input_count"], 1)
            self.assertEqual(len(state.read_pool(session)), 1)
            self.assertEqual(search_round.select_auto_citation_anchors([paper], concepts=[]), [])
            value["next_offset"] = 1
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                state.load_candidates(path)
            empty = str(Path(tmp) / "empty")
            state.init_state(empty, mode="balanced")
            self.assertEqual(state.read_pool(empty), {})


if __name__ == "__main__":
    unittest.main()
