"""Offline bibliography preflight and failure propagation regressions."""

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "lib")]
import slr_paths  # noqa: E402 - packaged Skill path bootstrap.

slr_paths.bootstrap(__file__)
import slr  # noqa: E402 - packaged Skill path bootstrap.
from main_view import compact  # noqa: E402 - packaged Skill path bootstrap.
from processing.build_bib import preflight  # noqa: E402 - packaged Skill path bootstrap.
from retrieval.adapt_search_output import run, to_corpus_record  # noqa: E402
from search_metadata_eligibility import (  # noqa: E402
    author_issues,
    bind_author_provenance,
    retain_author_structure,
)
from task_contract import atomic_json  # noqa: E402 - packaged Skill path bootstrap.
from workflow import advance  # noqa: E402 - packaged Skill path bootstrap.


class PreflightTest(unittest.TestCase):
    def test_author_verification_survives_adaptation_and_frozen_binding(self):
        self.paper.update(
            authors=[{"name": "Jane Doe"}, {"name": "John Smith"}], library_refs=["literature:p"]
        )
        proof = {
            "format": "structured",
            "raw": "Jane Doe, John Smith",
            "issues": [],
            "source_ref": "literature:p",
            "source": "project_library",
            "verification": {
                "method": "original page 1",
                "source_revision": "sha256:source",
                "result_sha256": "result-hash",
                "original_path": "paper.pdf",
            },
        }
        self.paper["author_metadata"] = copy.deepcopy(proof)
        atomic_json(self.ws / "02_retrieval/metadata.json", {"papers": [self.paper]})
        atomic_json(
            self.ws / "02_retrieval/library_candidates.json",
            {
                "schema": "literature-candidates/v1",
                "scope": "project_literature",
                "sources": [
                    {
                        "ref_id": "literature:p",
                        "title": self.paper["title"],
                        "authors": copy.deepcopy(self.paper["authors"]),
                    }
                ],
            },
        )
        before = (self.ws / "02_retrieval/metadata.json").read_bytes()
        selected, _, _ = run(self.ws)
        self.assertEqual(selected["p"]["author_metadata"], proof)
        self.assertEqual(author_issues(selected["p"]), [])
        self.assertEqual((self.ws / "02_retrieval/metadata.json").read_bytes(), before)
        plain = to_corpus_record(
            "p", {k: v for k, v in self.paper.items() if k != "author_metadata"}
        )
        plain["author_metadata"]["source_ref"] = "old-display-source"
        retain_author_structure(plain, self.paper)
        self.assertEqual(plain["author_metadata"], proof)
        other = to_corpus_record(
            "p", {**self.paper, "authors": ["Different Person"], "author_metadata": {}}
        )
        before = copy.deepcopy(other)
        retain_author_structure(other, self.paper)
        self.assertEqual(other, before)

    def test_verification_annotations_do_not_waive_author_validation(self):
        self.paper["authors"] = "Jane Doe, John Smith"
        self.paper["author_metadata"] = {
            "format": "structured",
            "issues": [],
            "verification": {"method": "claimed"},
        }
        record = to_corpus_record("p", self.paper)
        self.assertTrue(author_issues(record))
        self.paper["authors"] = ["Jane Doe, John Smith"]
        record = to_corpus_record("p", {**self.paper, "library_refs": ["literature:p"]})
        atomic_json(
            self.ws / "02_retrieval/library_candidates.json",
            {
                "schema": "literature-candidates/v1",
                "scope": "project_literature",
                "sources": [
                    {
                        "ref_id": "literature:p",
                        "title": self.paper["title"],
                        "authors": "Jane Doe, John Smith",
                    }
                ],
            },
        )
        bind_author_provenance(record, self.ws)
        self.assertTrue(author_issues(record))

    def test_adapter_rejects_invalid_and_conflicting_ids_without_writing_input(self):
        for value in [True, 1.5, [], {}]:
            atomic_json(
                self.ws / "02_retrieval/metadata.json",
                {"papers": [{**self.paper, "paper_id": value}]},
            )
            selected, _, status = run(self.ws)
            self.assertEqual(status["status"], "FAILED", value)
            self.assertEqual(status["issues"][0]["field"], "papers[0].paper_id")
        atomic_json(
            self.ws / "02_retrieval/metadata.json",
            {"papers": [self.paper, {**self.paper, "title": "Different paper"}]},
        )
        _, _, status = run(self.ws)
        self.assertEqual(status["status"], "FAILED")
        self.assertEqual(status["issues"][0]["code"], "DUPLICATE_PAPER_ID")
        atomic_json(
            self.ws / "02_retrieval/metadata.json", {"papers": [{**self.paper, "paper_id": 123}]}
        )
        selected, _, _ = run(self.ws)
        self.assertEqual(selected["123"]["paperId"], "123")

    def test_readiness_remains_the_root_when_commands_succeeded(self):
        self.save_selection()
        readiness = {
            "status": "FAILED",
            "ready_for_outline": False,
            "issues": [{"paper_id": "p", "reason": "missing_or_empty_card"}],
            "next_action": "inspect_materials",
        }
        with (
            patch("slr.run_command", return_value=(0, '{"status":"SUCCESS"}')),
            patch("paper_materials.readiness", return_value=readiness),
            patch("task_contract.sync_views"),
        ):
            rc, result = self.invoke("processing")
        self.assertEqual(rc, 1)
        self.assertEqual(result["issues"], readiness["issues"])
        self.assertEqual(result["next_action"], readiness["next_action"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ws = Path(self.temp.name)
        self.paper = {
            "paper_id": "p",
            "title": "Evidence",
            "authors": "Doe, Jane",
            "year": 2024,
            "abstract": "Source abstract.",
            "tier": 1,
        }
        atomic_json(self.ws / "01_input/writing_request.json", {"intent": "Review evidence"})

    def save_selection(self):
        path = self.ws / "02_retrieval/selected_paper.json"
        atomic_json(path, {"p": to_corpus_record("p", self.paper)})
        return path

    def invoke(self, stage):
        args = SimpleNamespace(
            profile="fast", workspace=str(self.ws), stage=stage, dry_run=False, tail=0, full=False
        )
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            rc = slr.cmd_run(args)
        return rc, json.loads(stream.getvalue())

    def test_processing_root_failure_survives_material_readiness(self):
        self.paper["authors"] = ["Jane Doe"]
        self.save_selection()
        failure = {
            "status": "FAILED",
            "code": "BIB_RENDER_FAILED",
            "message": "Original failure",
            "status_reason": "Original reason",
            "issues": [{"paper_id": "p", "field": "title"}],
            "next_action": "Repair this field",
        }
        for ready in (False, True):
            with (
                self.subTest(ready=ready),
                patch("slr.run_command", return_value=(1, json.dumps(failure))),
                patch(
                    "paper_materials.readiness",
                    return_value={
                        "status": "SUCCESS" if ready else "PARTIAL_SUCCESS",
                        "issues": [],
                        "ready_for_outline": ready,
                        "usable_card_count": 1,
                        "next_action": "resume_processing",
                    },
                ),
                patch("task_contract.sync_views"),
            ):
                rc, result = self.invoke("processing")
            self.assertEqual(rc, 1)
            self.assertEqual(result["status"], "FAILED")
            for field in ("code", "message", "issues", "next_action", "status_reason"):
                self.assertEqual(result[field], failure[field])
            self.assertEqual(result["usable_card_count"], 1)
            self.assertTrue(result["failed_substep"])
            self.assertEqual(result["invocation"]["code"], failure["code"])
            saved = json.loads((self.ws / "_status/processing.json").read_text())
            self.assertEqual(saved["cumulative"]["invocations"][-1]["code"], failure["code"])

    def test_author_warning_allows_materials_but_blocks_bibliography_and_keeps_files(self):
        path = self.save_selection()
        atomic_json(self.ws / "03_process/paper_cards.json", {"saved": "evidence"})
        atomic_json(self.ws / "03_process/cite_keys.json", {"p": "StableKey"})
        before = {p: p.read_bytes() for p in self.ws.rglob("*.json")}
        real_run = slr.run_command

        calls = []

        def material_fixture(command, *args, **kwargs):
            calls.append(Path(command[1]).name)
            if Path(command[1]).name == "build_bib.py":
                return real_run(command, *args, **kwargs)
            return 0, json.dumps({"status": "SUCCESS"})

        for stage in ("fulltext", "processing"):
            with (
                self.subTest(stage=stage),
                patch("slr.run_command", side_effect=material_fixture),
                patch("task_contract.sync_views"),
                patch("paper_materials.readiness", return_value={"ready_for_outline": True}),
            ):
                calls.clear()
                rc, result = self.invoke(stage)
            if stage == "fulltext":
                self.assertEqual(rc, 0, result)
                self.assertIn("fetch_fulltext.py", calls)
                self.assertEqual(result["bibliography_preflight"]["bibliography_status"], "FAILED")
            else:
                self.assertEqual(rc, 1)
                self.assertIn("paper_card_tools.py", calls)
                self.assertEqual(result["code"], "AUTHOR_METADATA_INVALID")
                self.assertEqual(
                    result["metadata_repair"]["evidence_request"]["requests"][0]["paper_id"], "p"
                )
        for p, data in before.items():
            self.assertEqual(p.read_bytes(), data)
        self.assertEqual(json.loads(path.read_text())["p"]["authors"], [{"name": "Doe, Jane"}])

    def test_retrieval_flags_ambiguity_without_dropping_or_splitting(self):
        atomic_json(self.ws / "02_retrieval/metadata.json", {"papers": [self.paper]})
        selected, report, status = run(self.ws)
        self.assertEqual(list(selected), ["p"])
        self.assertEqual(selected["p"]["authors"], [{"name": "Doe, Jane"}])
        self.assertEqual(report["bibliography_preflight"]["code"], "AUTHOR_METADATA_INVALID")
        self.assertFalse(
            any(row.get("rule") == "bibliography_metadata" for row in report["flagged_for_review"])
        )

    def test_structured_duplicate_survives_higher_ranked_display_record(self):
        self.paper["authors"] = "Jane Doe, John Smith"
        other = {
            **self.paper,
            "paper_id": "other",
            "tier": 2,
            "source": "catalogue",
            "authors": [{"name": "Jane Doe", "authorId": "a"}, {"name": "John Smith"}],
        }
        atomic_json(self.ws / "02_retrieval/metadata.json", {"papers": [self.paper, other]})
        selected, _, _ = run(self.ws)
        self.assertEqual(list(selected), ["p"])
        self.assertEqual(selected["p"]["authors"], other["authors"])
        self.assertEqual(author_issues(selected["p"]), [])

    def test_frozen_structured_authors_restore_wrapped_display_without_guessing(self):
        names = [
            {"name": "Doe, Jane", "authorId": "a"},
            {"name": "{Research, Inc.}"},
            {"name": "王明"},
        ]
        record = to_corpus_record(
            "p",
            {
                **self.paper,
                "authors": ", ".join(a["name"] for a in names),
                "library_refs": ["literature:p"],
            },
        )
        snapshot = {
            "schema": "literature-candidates/v1",
            "scope": "project_literature",
            "sources": [{"ref_id": "literature:p", "title": self.paper["title"], "authors": names}],
        }
        atomic_json(self.ws / "02_retrieval/library_candidates.json", snapshot)
        before = copy.deepcopy(snapshot)
        bind_author_provenance(record, self.ws)
        self.assertEqual(record["authors"], names)
        self.assertEqual(author_issues(record), [])
        self.assertEqual(record["author_metadata"]["source_ref"], "literature:p")
        self.assertEqual(
            json.loads((self.ws / "02_retrieval/library_candidates.json").read_text()), before
        )

    def test_workflow_compact_exposes_root_diagnostics(self):
        failure = {
            "status": "FAILED",
            "code": "AUTHOR_METADATA_INVALID",
            "issues": [{"paper_id": "p"}],
            "failed_substep": {"step": 1, "command": "build_bib.py"},
            "next_action": "Verify source",
        }
        result = compact(
            advance(self.ws, "evidence", "processing", runner=lambda *args: (1, failure))
        )
        for field in ("code", "issues", "next_action", "failed_substep"):
            self.assertEqual(result[field], failure[field])

    def test_secondary_readiness_error_does_not_hide_child_failure(self):
        self.save_selection()
        failure = {"status": "FAILED", "code": "SOURCE_ERROR", "message": "Original source error"}
        with (
            patch("slr.run_command", return_value=(0, json.dumps(failure))) as command,
            patch("paper_materials.readiness", side_effect=ValueError("Invalid cached card store")),
            patch("task_contract.sync_views"),
        ):
            rc, result = self.invoke("processing")
        self.assertEqual(rc, 1)
        self.assertEqual(command.call_count, 1)
        self.assertEqual(result["code"], "SOURCE_ERROR")
        self.assertEqual(result["message"], "Original source error")
        self.assertEqual(result["material_readiness"]["message"], "Invalid cached card store")

    def test_valid_structured_authors_and_upstream_bibtex_need_no_repair(self):
        for authors in (
            [{"name": "Doe, Jane"}, {"name": "{Research, Inc.}"}, {"name": "王明"}],
            ["Jane Doe", "John Smith"],
        ):
            self.paper["authors"] = authors
            path = self.save_selection()
            before = path.read_bytes()
            self.assertEqual(preflight(self.ws)["status"], "SUCCESS")
            self.assertEqual(path.read_bytes(), before)
        self.paper.update(
            authors="Doe, Jane",
            citationStyles={
                "bibtex": "@article{source, author={Doe, Jane}, title={Evidence}, year={2024}}"
            },
        )
        self.save_selection()
        self.assertEqual(preflight(self.ws)["status"], "SUCCESS")

    def test_structure_recovery_rejects_identity_conflicts_and_preserves_explicit_names(self):
        source = {**self.paper, "authors": ["Doe", "Jane"]}
        explicit = to_corpus_record("p", {**self.paper, "authors": [{"name": "Doe, Jane"}]})
        before = copy.deepcopy(explicit)
        retain_author_structure(explicit, source)
        self.assertEqual(explicit, before)
        ambiguous = to_corpus_record("p", self.paper)
        before = copy.deepcopy(ambiguous)
        retain_author_structure(ambiguous, {**source, "title": "Other paper"})
        self.assertEqual(ambiguous, before)
        retain_author_structure(ambiguous, {**source, "authors": ["Different", "Names"]})
        self.assertEqual(ambiguous, before)


if __name__ == "__main__":
    unittest.main()
