"""Deterministic report naming contracts; not real product acceptance."""

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import finalize
import run_state
import stage
from io_utils import atomic_write_json, read_json

SEARCH_REPORT = "search_report.md"
READ_REPORT = "read_report.md"
LEGACY_REPORT = "report.md"


class ReportNamingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.run = run_state.initialize_run(self.root, "Find relevant papers")
        state = run_state.read_state(self.run)
        state["search_round"] = 1
        state["status"] = "DOWNLOADING_OPEN"
        state["paths"]["selection"] = "selection.json"
        run_state.write_state(self.run, state)
        atomic_write_json(self.run / "selection.json", {})
        atomic_write_json(
            self.run / "downloads/manifest.json",
            {
                "schema_version": "1.0",
                "run_id": self.run.name,
                "generated_at": state["created_at"],
                "is_placeholder": False,
                "papers": [],
                "summary": dict.fromkeys(
                    ("selected", "downloaded", "action_required", "failed", "skipped"), 0
                ),
                "warnings": [],
            },
        )

    def test_search_finalizer_defaults_to_search_report(self):
        output = self.root / "metadata.json"
        argv = [
            "finalize.py",
            "--input",
            str(self.root / "request.json"),
            "--work-dir",
            str(self.root),
            "--output",
            str(output),
        ]
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(finalize, "read_json", return_value={}),
            mock.patch.object(finalize, "finalize_search") as finish,
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(finalize.main(), 0)
        self.assertEqual(finish.call_args.kwargs["report_path"], self.root / SEARCH_REPORT)

    def test_zero_fulltext_reading_writes_read_report(self):
        result = stage.prepare_reading(self.run, "user_explicit")
        self.assertEqual(result["artifacts"]["report"], READ_REPORT)
        self.assertTrue((self.run / READ_REPORT).read_text(encoding="utf-8").strip())
        self.assertFalse((self.run / LEGACY_REPORT).exists())
        stage.validate_reading(self.run)

    def test_refinement_archives_read_report(self):
        stage.prepare_reading(self.run, "user_explicit")
        review_path = run_state.record_report_review(
            self.run, "refine", feedback="Try a narrower query", decision_source="user_explicit"
        )
        review = read_json(review_path)
        self.assertEqual(review["report_path"], READ_REPORT)
        self.assertEqual(
            review["archived_artifacts"]["report"], f"iterations/round-001/{READ_REPORT}"
        )
        self.assertTrue((review_path.parent / READ_REPORT).is_file())
        self.assertFalse((review_path.parent / LEGACY_REPORT).exists())
