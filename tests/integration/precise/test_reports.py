"""Deterministic report naming contracts; not real product acceptance."""

import io
import json
import subprocess
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
from validate_json import ContractError

SEARCH_REPORT = "search_report.md"
READ_REPORT = "read_report.md"
LEGACY_REPORT = "report.md"
INVALID_MANIFESTS = (
    ([], "download manifest must be a JSON object"),
    (None, "download manifest must be a JSON object"),
    ("invalid", "download manifest must be a JSON object"),
    ({}, "download manifest papers must be an array"),
    ({"papers": None}, "download manifest papers must be an array"),
    ({"papers": {}}, "download manifest papers must be an array"),
    ({"papers": [None]}, "papers[0] must be a JSON object"),
    ({"papers": [{"status": "downloaded"}, None]}, "papers[1] must be a JSON object"),
    ({"papers": [{"status": []}]}, "papers[0].status must be a non-empty string"),
)


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

    def test_download_success_requires_native_library_admission_even_when_partial(self):
        manifest_path = self.run / "downloads/manifest.json"
        manifest = read_json(manifest_path)
        manifest["papers"] = [
            {"paper_id": "p1", "status": "downloaded"},
            {"paper_id": "p2", "status": "action_required"},
        ]
        atomic_write_json(manifest_path, manifest)
        result = stage.with_task_activation(
            {"status": "PAID_ACTION_REQUIRED"}, self.run, download_checkpoint=True
        )
        self.assertEqual(
            result["download_admission"],
            {
                "capability": "literature",
                "operation": "ingest",
                "request": {"run": self.run.relative_to(self.root).as_posix()},
            },
        )

    def test_no_download_success_does_not_request_library_admission(self):
        result = stage.with_task_activation({}, self.run, download_checkpoint=True)
        self.assertNotIn("download_admission", result)

    def test_download_checkpoint_rejects_invalid_manifest_structure(self):
        for manifest, reason in INVALID_MANIFESTS:
            with self.subTest(manifest=manifest):
                atomic_write_json(self.run / "downloads/manifest.json", manifest)
                with self.assertRaises(ContractError) as caught:
                    stage.with_task_activation({}, self.run, download_checkpoint=True)
                self.assertEqual(str(caught.exception), reason)

    def test_cli_invalid_manifest_returns_structured_error(self):
        state = run_state.read_state(self.run)
        state["status"] = "REPORT_REVIEW_PENDING"
        run_state.write_state(self.run, state)
        for command in ("download", "status"):
            for manifest, reason in INVALID_MANIFESTS:
                with self.subTest(command=command, manifest=manifest):
                    atomic_write_json(self.run / "downloads/manifest.json", manifest)
                    result = subprocess.run(
                        [sys.executable, stage.__file__, command, "--run-dir", str(self.run)],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(result.stderr, "")
                    self.assertEqual(
                        json.loads(result.stdout), {"status": "blocked", "reason": reason}
                    )

    def test_invalid_manifest_does_not_replace_original_download_error(self):
        for manifest, _reason in INVALID_MANIFESTS:
            with self.subTest(manifest=manifest):
                atomic_write_json(self.run / "downloads/manifest.json", manifest)
                output = io.StringIO()
                with (
                    mock.patch.object(
                        sys, "argv", ["stage.py", "download", "--run-dir", str(self.run)]
                    ),
                    mock.patch.object(
                        stage, "download", side_effect=ValueError("original failure")
                    ),
                    redirect_stdout(output),
                ):
                    self.assertEqual(stage.main(), 2)
                self.assertEqual(
                    json.loads(output.getvalue()),
                    {"status": "blocked", "reason": "original failure"},
                )

    def test_non_download_commands_do_not_request_admission_for_existing_successes(self):
        manifest_path = self.run / "downloads/manifest.json"
        manifest = read_json(manifest_path)
        manifest["papers"] = [{"paper_id": "p1", "status": "downloaded"}]
        atomic_write_json(manifest_path, manifest)
        for command in ("status", "reading", "report", "cancel", "resume"):
            with self.subTest(command=command):
                result = stage.with_task_activation({"command": command}, self.run)
                self.assertIn("task_activation", result)
                self.assertNotIn("download_admission", result)
                self.assertNotIn("download_admission_hint", result)

    def test_cli_only_download_checkpoint_emits_admission_request(self):
        manifest_path = self.run / "downloads/manifest.json"
        manifest = read_json(manifest_path)
        manifest["papers"] = [{"paper_id": "p1", "status": "downloaded"}]
        atomic_write_json(manifest_path, manifest)
        for command in ("status", "download"):
            with self.subTest(command=command):
                output = io.StringIO()
                with (
                    mock.patch.object(
                        sys, "argv", ["stage.py", command, "--run-dir", str(self.run)]
                    ),
                    mock.patch.object(stage, "stats", return_value={}),
                    mock.patch.object(stage, "download", return_value={}),
                    redirect_stdout(output),
                ):
                    self.assertEqual(stage.main(), 0)
                self.assertEqual('"download_admission"' in output.getvalue(), command == "download")

    def test_download_error_keeps_success_admission_and_original_error(self):
        manifest_path = self.run / "downloads/manifest.json"
        manifest = read_json(manifest_path)
        manifest["papers"] = [{"paper_id": "p1", "status": "downloaded"}]
        atomic_write_json(manifest_path, manifest)
        output = io.StringIO()
        with (
            mock.patch.object(sys, "argv", ["stage.py", "download", "--run-dir", str(self.run)]),
            mock.patch.object(stage, "download", side_effect=ValueError("browser cleanup failed")),
            redirect_stdout(output),
        ):
            self.assertEqual(stage.main(), 2)
        self.assertIn('"download_admission"', output.getvalue())
        self.assertIn('"status": "blocked"', output.getvalue())
        self.assertIn("browser cleanup failed", output.getvalue())

    def test_download_error_without_success_has_no_admission(self):
        output = io.StringIO()
        with (
            mock.patch.object(sys, "argv", ["stage.py", "download", "--run-dir", str(self.run)]),
            mock.patch.object(stage, "download", side_effect=OSError("browser setup failed")),
            redirect_stdout(output),
        ):
            self.assertEqual(stage.main(), 2)
        self.assertNotIn('"download_admission"', output.getvalue())

    def test_non_download_error_never_requests_admission(self):
        manifest = read_json(self.run / "downloads/manifest.json")
        manifest["papers"] = [{"paper_id": "p1", "status": "downloaded"}]
        atomic_write_json(self.run / "downloads/manifest.json", manifest)
        output = io.StringIO()
        with (
            mock.patch.object(sys, "argv", ["stage.py", "status", "--run-dir", str(self.run)]),
            mock.patch.object(stage, "stats", side_effect=ValueError("status unavailable")),
            redirect_stdout(output),
        ):
            self.assertEqual(stage.main(), 2)
        self.assertNotIn('"download_admission"', output.getvalue())

    def test_download_error_with_invalid_manifest_preserves_original_error(self):
        (self.run / "downloads/manifest.json").write_text("invalid JSON", encoding="utf-8")
        output = io.StringIO()
        with (
            mock.patch.object(sys, "argv", ["stage.py", "download", "--run-dir", str(self.run)]),
            mock.patch.object(stage, "download", side_effect=ValueError("original failure")),
            redirect_stdout(output),
        ):
            self.assertEqual(stage.main(), 2)
        self.assertIn("original failure", output.getvalue())
        self.assertNotIn('"download_admission"', output.getvalue())

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
