"""Offline regressions for metadata, captions and resumable reporting."""

import asyncio
import contextlib
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "lib"), str(ROOT / "scripts")]
import slr_paths  # noqa: E402 - packaged Skill imports require the local path bootstrap.

slr_paths.bootstrap(__file__)
import slr  # noqa: E402 - packaged Skill imports require the local path bootstrap.
import test_native_pipeline as native  # noqa: E402 - packaged Skill imports require the local path bootstrap.
from _utils import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    render_bibtex_entry,
)
from chapter_pipeline import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    generate,
)
from compilation import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    bibliography,
)
from figure_caption import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    caption_text,
    has_numbering_prefix,
)
from main_view import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    compact,
)
from manuscript_publication import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    audit,
    publish,
)
from processing.build_bib import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    build,
)
from retrieval.adapt_search_output import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    to_corpus_record,
)
from search_metadata_eligibility import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    author_issues,
    bind_author_provenance,
)
from task_contract import configure  # noqa: E402 - packaged Skill imports require the local path bootstrap.
from usage import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    accumulate,
    summarize,
)
from workflow import (  # noqa: E402 - packaged Skill imports require the local path bootstrap.
    advance,
)


class MetadataTest(unittest.TestCase):
    def test_names_and_all_authors_survive_serialization(self):
        names = [
            "Nadia Anand",
            "Jan van der Sand",
            "Ada",
            "Dan",
            "Ann",
            "Renata",
            "Jordan",
            "Hassan",
            "Morgan",
            "Fernanda",
        ]
        record = {"title": "Names", "year": 2026, "authors": [{"name": n} for n in names]}
        before = copy.deepcopy(record)
        bib = render_bibtex_entry("Names2026", record)
        self.assertIn("author = {" + " and ".join(names) + "}", bib)
        self.assertEqual(record, before)

    def test_explicit_author_separators_are_normalized_without_loss(self):
        raw = "Jane Doe; Jean Dupont\n王明"
        paper = {"title": "Names", "year": 2026, "authors": raw}
        record = to_corpus_record("p", paper)
        self.assertEqual(
            [a["name"] for a in record["authors"]], ["Jane Doe", "Jean Dupont", "王明"]
        )
        self.assertEqual(record["author_metadata"]["raw"], raw)
        self.assertEqual(paper["authors"], raw)

    def test_ambiguous_display_author_is_reported_without_dropping_paper(self):
        raw = "Jane Doe, John Smith, Jean Dupont, 王明"
        record = to_corpus_record("p", {"title": "Names", "authors": raw, "year": 2026})
        with tempfile.TemporaryDirectory() as folder:
            ws = Path(folder)
            (ws / "02_retrieval").mkdir()
            (ws / '01_input').mkdir()
            (ws / '01_input/writing_request.json').write_text(json.dumps({'intent': 'Verify bibliography'}))
            path = ws / "02_retrieval/selected_paper.json"
            path.write_text(json.dumps({"p": record}))
            before = path.read_bytes()
            report, status = build(ws)
            self.assertEqual(status["status"], "FAILED")
            self.assertEqual(status["code"], "AUTHOR_METADATA_INVALID")
            self.assertEqual(status["issues"][0]["paper_id"], "p")
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse((ws / "03_process/references.bib").exists())

    def test_library_display_wrapped_by_search_stays_ambiguous(self):
        raw = "Jane Doe, John Smith"
        record = to_corpus_record(
            "p", {"title": "Names", "authors": [{"name": raw}], "library_refs": ["literature:p"]}
        )
        with tempfile.TemporaryDirectory() as folder:
            ws = Path(folder)
            (ws / "02_retrieval").mkdir()
            snapshot = {
                "schema": "literature-candidates/v1",
                "scope": "project_literature",
                "sources": [{"ref_id": "literature:p", "title": "Names", "authors": raw}],
            }
            (ws / "02_retrieval/library_candidates.json").write_text(json.dumps(snapshot))
            bind_author_provenance(record, ws)
            self.assertTrue(author_issues(record))
            self.assertEqual(record["author_metadata"]["raw"], raw)
            record["authors"] = [{"name": "Jane Doe"}, {"name": "John Smith"}]
            self.assertEqual(author_issues(record), [])

    def test_structured_family_names_and_corporate_names_are_preserved(self):
        record = to_corpus_record(
            "p",
            {
                "title": "Names",
                "authors": [{"name": "Doe, Jane"}, {"name": "{Research and Development Group}"}],
            },
        )
        bib = render_bibtex_entry("Names", record)
        self.assertIn("Doe, Jane and {Research and Development Group}", bib)


class CaptionRegressionTest(unittest.TestCase):
    def test_technical_prose_is_not_a_numbered_caption(self):
        for value in (
            "图一致性框架",
            "图二分结构",
            "表一阶导数的变化",
            "图三角结构",
            "Tabletop experiments",
        ):
            with self.subTest(value=value):
                self.assertEqual(caption_text(value), value)

    def test_unambiguous_numbering_stays_invalid(self):
        for value in (
            "图1展示了关系",
            "图 2：机制",
            "图一：机制",
            "图 一 机制",
            "Figure 2 compares conditions",
            "Table 1.2: Results",
            "表：条件",
        ):
            with self.subTest(value=value):
                self.assertTrue(has_numbering_prefix(value))
                with self.assertRaises(ValueError):
                    caption_text(value)


class ReportingTest(unittest.TestCase):
    def test_workflow_failure_and_resume_keep_history_and_specific_code(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = Path(folder)
            configure(ws, {"intent": "Verify workflow failure and recovery"})
            failure = {
                "status": "FAILED",
                "code": "AUTHOR_METADATA_INVALID",
                "next_action": "Verify authors",
            }
            first = advance(ws, "evidence", "processing", runner=lambda *args: (1, failure))
            self.assertEqual(
                first["cumulative"]["invocations"][0]["code"], "AUTHOR_METADATA_INVALID"
            )
            second = advance(
                ws, "evidence", "processing", runner=lambda *args: (0, {"status": "SUCCESS"})
            )
            self.assertEqual(second["status"], "SUCCESS")
            self.assertEqual(len(second["cumulative"]["invocations"]), 2)
            self.assertEqual(second["cumulative"]["invocations"][0]["status"], "FAILED")
            self.assertIn("precomputed_l1", second["model_usage"]["excluded"])

    def test_stage_cli_preserves_bibliography_diagnostics_and_history(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = Path(folder)
            (ws / "02_retrieval").mkdir()
            (ws / '01_input').mkdir()
            (ws / '01_input/writing_request.json').write_text(json.dumps({'intent': 'Verify bibliography'}))
            record = to_corpus_record(
                "p", {"title": "Names", "authors": "Jane Doe, John Smith", "year": 2026}
            )
            (ws / "02_retrieval/selected_paper.json").write_text(json.dumps({"p": record}))
            stage = {
                "id": "metadata_fixture",
                "command": [sys.executable, str(ROOT / "scripts/processing/build_bib.py"), str(ws)],
                "status": {"kind": "trailing_json"},
            }
            args = SimpleNamespace(
                profile="fast",
                workspace=str(ws),
                stage=stage["id"],
                dry_run=False,
                tail=0,
                full=False,
            )
            for count in (1, 2):
                stream = io.StringIO()
                with (
                    patch("slr.find_stage", return_value=stage),
                    patch("task_contract.sync_views"),
                    contextlib.redirect_stdout(stream),
                ):
                    self.assertEqual(slr.cmd_run(args), 1)
                result = json.loads(stream.getvalue())
                self.assertEqual(result["code"], "AUTHOR_METADATA_INVALID")
                self.assertEqual(result["issues"][0]["paper_id"], "p")
                self.assertEqual(result["steps"][0]["next_action"], result["next_action"])
                self.assertEqual(result["cumulative"]["invocation_count"], count)
                saved = json.loads((ws / "_status" / f"{stage['id']}.json").read_text())
                self.assertEqual(len(saved["cumulative"]["invocations"]), count)
                self.assertEqual(saved["cumulative"]["invocations"][-1]["code"], result["code"])

    def test_resume_keeps_failed_attempts_and_existing_handoff_totals(self):
        native.NativeTest.setUp(self)
        model = native.Model()
        model.fail = "1"
        with self.assertRaises(Exception):
            asyncio.run(generate(self.ws, native.CFG, native.CFG, model))
        first = json.loads((self.ws / "_status/writing.json").read_text())
        model.fail = None
        with patch("chapter_pipeline.precompile", return_value={"status": "SUCCESS"}):
            result = asyncio.run(generate(self.ws, native.CFG, native.CFG, model))
        self.assertEqual(result["model_calls"], 5)
        self.assertEqual(result["invocation"]["model_calls"], 2)
        self.assertGreaterEqual(result["elapsed_sec"], first["elapsed_sec"])
        self.assertEqual(len(result["cumulative"]["invocations"]), 2)
        self.assertEqual(
            result["model_usage"]["totals"]["missing_usage_attempts"]["input_tokens"], 5
        )
        again = asyncio.run(generate(self.ws, native.CFG, native.CFG, model))
        self.assertEqual(again["model_calls"], 5)
        self.assertEqual(again["invocation"]["model_calls"], 0)
        self.assertEqual(len(model.calls), 5)
        # A v2 handed off after a failure may retain an old error in its status;
        # history retains that failure, the successful no-op must not repeat it.
        again.update(status="FAILED", error={"code": "OLD_FAILURE"})
        (self.ws / "_status/writing.json").write_text(json.dumps(again))
        resumed = asyncio.run(generate(self.ws, native.CFG, native.CFG, model))
        self.assertNotIn("error", resumed)
        self.assertIsNone(resumed["invocation"]["code"])
        self.assertEqual(resumed["model_calls"], 5)

    def test_receipts_count_retries_once_and_keep_unknown_usage(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "_logs/llm/r"
            root.mkdir(parents=True)
            (root / "request.json").write_text(
                json.dumps({"stage": "chapter_1", "config": {"model": "fixture"}})
            )
            rows = [
                {"attempt": 1, "error": {"code": "API_TIMEOUT"}, "usage": None, "elapsed_sec": 3},
                {
                    "attempt": 2,
                    "error": None,
                    "usage": {
                        "prompt_tokens": 100,
                        "completion_tokens": 20,
                        "prompt_tokens_details": {"cached_tokens": 60},
                    },
                    "elapsed_sec": 2,
                },
            ]
            (root / "attempts.json").write_text(json.dumps(rows))
            for row in rows:
                (root / ("attempt-" + str(row["attempt"]) + ".json")).write_text(json.dumps(row))
            result = summarize(folder)
            self.assertEqual(result["totals"]["attempts"], 2)
            self.assertEqual(result["totals"]["known_tokens"]["input_tokens"], 100)
            self.assertEqual(result["totals"]["missing_usage_attempts"]["input_tokens"], 1)
            self.assertFalse(result["usage_complete"])
            self.assertEqual(result, summarize(folder))

    def test_images_and_incomplete_receipts_are_separate_from_writer(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "_logs/llm/image-a"
            root.mkdir(parents=True)
            (root / "request.json").write_text(
                json.dumps({"figure_id": "F1", "prompt": "fixture", "size_preset": "landscape"})
            )
            (root / "attempts.json").write_text(
                json.dumps(
                    [
                        {
                            "attempt": 1,
                            "stage": "figures_image",
                            "model": "image-fixture",
                            "ok": True,
                            "usage": {
                                "prompt_tokens": 12,
                                "completion_tokens": 30,
                                "cacheReadInputTokensCompatible": 0,
                            },
                            "elapsed_sec": 4,
                        }
                    ]
                )
            )
            self.assertEqual(summarize(folder)["totals"]["attempts"], 1)
            self.assertEqual(summarize(folder)["by_stage_model"][0]["model"], "image-fixture")
            self.assertEqual(summarize(folder)["by_stage_model"][0]["stage"], "figures_image")
            self.assertEqual(summarize(folder, ("chapter_",))["totals"]["attempts"], 0)
            broken = root.parent / "pending"
            broken.mkdir()
            (broken / "request.json").write_text(json.dumps({"stage": "outline"}))
            result = summarize(folder)
            self.assertFalse(result["usage_complete"])
            self.assertEqual(result["issues"][0]["request_id"], "pending")

    def test_historical_elapsed_is_a_lower_bound_not_a_fabricated_total(self):
        result = accumulate({"elapsed_sec": 50}, {"status": "SUCCESS", "model_calls": 0}, 2)
        self.assertEqual(result["cumulative"]["elapsed_sec"], 52)
        self.assertFalse(result["cumulative"]["timing_complete"])


class PublicationDiagnosticTest(unittest.TestCase):
    def test_compiler_timeout_is_persisted_and_auditable(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = Path(folder)
            gen = ws / "05_generation"
            gen.mkdir()
            source = gen / "full_draft_v2.tex"
            source.write_text(r"\documentclass{article}\begin{document}Text\end{document}")
            with (
                patch("manuscript_publication.shutil.which", return_value="fixture"),
                patch(
                    "manuscript_publication.subprocess.run",
                    side_effect=subprocess.TimeoutExpired(["fixture"], 180),
                ),
            ):
                result = publish(ws)
            self.assertEqual(result["code"], "COMPILER_TIMEOUT")
            self.assertEqual(result["cumulative"]["invocations"][0]["code"], "COMPILER_TIMEOUT")
            self.assertEqual(audit(ws)["status"], "FAILED")
            self.assertFalse((ws / "06_output").exists())

    def test_missing_tool_auxiliary_and_style_errors_are_distinct(self):
        self.assertEqual(
            bibliography(True, False, True, None)["code"], "BIBLIOGRAPHY_TOOL_UNAVAILABLE"
        )
        self.assertEqual(bibliography(True, True, False, None)["code"], "BIBLIOGRAPHY_AUX_MISSING")
        failure = subprocess.CompletedProcess(
            ["bibtex"], 2, stdout="I couldn't open style file missing.bst", stderr=""
        )
        self.assertIn(
            "missing.bst", bibliography(True, True, True, failure)["issues"][0]["message"]
        )
        self.assertEqual(bibliography(False, False, False, None)["status"], "NOT_REQUIRED")

    def test_bibtex_failure_reports_entry_even_when_latex_exits_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = Path(folder)
            gen = ws / "05_generation"
            gen.mkdir()
            source = gen / "full_draft_v2.tex"
            source.write_text(
                r"\documentclass{article}\begin{document}Text\bibliography{citations}\end{document}"
            )
            (gen / "citations.bib").write_text(
                "@article{K,title={Evidence},author={A, B, C, D},year={2026}}"
            )

            def compile(command, *args):
                if command[0] == "bibtex":
                    return subprocess.CompletedProcess(
                        command,
                        2,
                        stdout="Too many commas in name 1 for entry K\nwhile executing---line 25 of style.bst",
                        stderr="",
                    )
                source.with_suffix(".aux").write_text(r"\bibdata{citations}")
                source.with_suffix(".pdf").write_bytes(b"%PDF fixture")
                source.with_suffix(".log").write_text("")
                return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

            with (
                patch("manuscript_publication.shutil.which", return_value="fixture"),
                patch("manuscript_publication._run", side_effect=compile),
            ):
                result = publish(ws)
            self.assertEqual(result["code"], "BIBLIOGRAPHY_COMPILE_ERROR")
            detail = result["compile"]["bibliography"]
            self.assertEqual(detail["returncode"], 2)
            self.assertEqual(detail["issues"][0]["cite_key"], "K")
            self.assertEqual(detail["issues"][0]["field"], "name")
            self.assertEqual(detail["issues"][0]["possible_fields"], ["author", "editor"])
            self.assertEqual(result["compile"]["final_pass_rc"], 0)
            self.assertFalse((ws / "06_output").exists())
            with (
                patch("manuscript_publication.shutil.which", return_value="fixture"),
                patch("manuscript_publication._run", side_effect=compile),
            ):
                again = publish(ws)
            self.assertEqual(len(again["cumulative"]["invocations"]), 2)
            self.assertTrue(
                all(
                    row["code"] == "BIBLIOGRAPHY_COMPILE_ERROR"
                    for row in again["cumulative"]["invocations"]
                )
            )


if __name__ == "__main__":
    unittest.main()
