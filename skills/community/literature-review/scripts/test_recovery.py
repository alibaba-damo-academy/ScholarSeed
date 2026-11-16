"""Offline dependency and process-lifecycle regressions; no product/model calls."""

import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "lib")]
import slr_paths  # noqa: E402 - local Skill bootstrap.

slr_paths.bootstrap(__file__)
import slr  # noqa: E402 - local Skill bootstrap.
from lifecycle import OperationBlocked, operation, read_status  # noqa: E402
from platform_io import child_active, kill_process_tree, run_stream  # noqa: E402
from task_contract import atomic_json  # noqa: E402 - local Skill bootstrap.
from workflow import advance, resume_guard  # noqa: E402 - local Skill bootstrap.


class RecoveryTest(unittest.TestCase):
    def test_workflow_resume_enters_recorded_failed_stage_without_discovery(self):
        atomic_json(self.ws / "_status/workflow.json", {
            "status": "FAILED", "phase": "evidence", "current_stage": "processing",
            "resume_guard": resume_guard(self.ws, "processing")})
        calls = []
        def runner(ws, command):
            calls.append(command)
            return 0, {"status": "SUCCESS"}
        result = advance(self.ws, "evidence", runner=runner, resume=True)
        self.assertEqual(result["boundary"], "outline_display")
        self.assertEqual(calls, [["run", "processing"], ["outline", "generate"], ["outline", "review-packet"]])

    def test_resume_without_record_does_not_guess_or_start_work(self):
        calls = []
        result = advance(self.ws, "evidence", runner=lambda *args: calls.append(args), resume=True)
        self.assertEqual(result["code"], "WORKFLOW_RESUME_UNAVAILABLE")
        self.assertEqual(calls, [])

    def test_resume_rejects_changed_evidence_but_allows_author_repair(self):
        previous = {"status": "FAILED", "phase": "evidence", "current_stage": "processing",
                    "resume_guard": resume_guard(self.ws, "processing")}
        for field, value, allowed in (("authors", [{"name": "Verified Author"}], True),
                                      ("abstract", "Different evidence", False)):
            atomic_json(self.ws / "_status/workflow.json", previous)
            self.paper[field] = value
            atomic_json(self.ws / "02_retrieval/selected_paper.json", {"p": self.paper})
            calls = []
            def runner(ws, command):
                calls.append(command)
                return 0, {"status": "SUCCESS"}
            result = advance(self.ws, "evidence", runner=runner, resume=True)
            self.assertEqual(bool(calls), allowed)
            if not allowed:
                self.assertEqual(result["code"], "WORKFLOW_RESUME_INPUTS_CHANGED")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ws = Path(self.temp.name)
        self.args = SimpleNamespace(
            profile="fast",
            workspace=str(self.ws),
            stage="processing",
            dry_run=False,
            tail=0,
            full=True,
        )
        self.paper = {
            "title": "Evidence",
            "year": 2024,
            "authors": [{"name": "Ada"}],
            "abstract": "Supported source text.",
            "relevance_level": "L1",
        }
        atomic_json(self.ws / "02_retrieval/selected_paper.json", {"p": self.paper})
        atomic_json(
            self.ws / "03_process/paper_cards.json",
            {
                "p": {
                    "paperId": "p",
                    "abstract": self.paper["abstract"],
                    "card": {"method": "A supported method"},
                }
            },
        )
        atomic_json(self.ws / "01_input/writing_request.json", {"intent": "Review evidence"})

    def run_stage(self):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            rc = slr.cmd_run(self.args)
        return rc, json.loads(stream.getvalue())

    def test_author_edit_reuses_cards_and_only_rebuilds_dependent_outputs(self):
        calls = []
        actual = slr.run_command

        def run(command, *args, **kwargs):
            calls.append(Path(command[1]).name)
            if "paper_card_tools.py" in command[1]:
                raise AssertionError("Valid saved cards must not enter extraction")
            return actual(command, *args, **kwargs)

        with patch("slr.run_command", side_effect=run), patch("task_contract.sync_views"):
            rc, first = self.run_stage()
            self.assertEqual(rc, 0, first)
            first_keys = (self.ws / "03_process/cite_keys.json").read_bytes()
            first_card = (self.ws / "03_process/paper_cards.json").read_bytes()
            calls.clear()
            self.assertEqual(self.run_stage()[0], 0)
            self.assertEqual(calls, ["build_bib.py"], "Only cheap preflight should repeat")
            self.paper["authors"] = [{"name": "Ada Revised"}]
            atomic_json(self.ws / "02_retrieval/selected_paper.json", {"p": self.paper})
            calls.clear()
            self.assertEqual(self.run_stage()[0], 0)
            self.assertNotIn("paper_card_tools.py", calls)
            self.assertIn("build_cards_index.py", calls)
            self.assertIn("audit_citation_metadata.py", calls)
            self.assertEqual((self.ws / "03_process/cite_keys.json").read_bytes(), first_keys)
            self.assertEqual((self.ws / "03_process/paper_cards.json").read_bytes(), first_card)

    def test_interruption_is_terminal_and_preserves_completed_work(self):
        with (
            patch("slr.run_command", side_effect=KeyboardInterrupt),
            patch("task_contract.sync_views"),
        ):
            rc, value = self.run_stage()
        self.assertEqual(rc, 1)
        self.assertEqual(value["status"], "INTERRUPTED")
        self.assertEqual(
            json.loads((self.ws / "_status/processing.json").read_text())["status"], "INTERRUPTED"
        )
        self.assertTrue((self.ws / "03_process/paper_cards.json").is_file())

    def test_child_terminal_status_is_not_hidden_by_zero_exit_or_ready_materials(self):
        for status in ("INTERRUPTED", "RECOVERY_REQUIRED"):
            with self.subTest(status=status):
                payload = {"status": status, "code": "CHILD_STOPPED", "message": "fixture"}
                with (
                    patch("slr.run_command", return_value=(0, json.dumps(payload))) as run,
                    patch("task_contract.sync_views"),
                ):
                    rc, result = self.run_stage()
                self.assertEqual(rc, 1)
                self.assertEqual(result["status"], status)
                self.assertEqual(result["code"], "CHILD_STOPPED")
                self.assertEqual(run.call_count, 1)
                # Exercise workflow propagation independently of the stage lock.
                with tempfile.TemporaryDirectory() as folder:
                    result = advance(
                        folder, "evidence", "processing", runner=lambda *_: (0, payload)
                    )
                self.assertEqual(result["status"], status)
                self.assertEqual(result["code"], "CHILD_STOPPED")

    def test_inputs_changed_during_step_keep_outputs_but_cannot_create_receipt(self):
        actual = slr.run_command

        def change_source(command, *args, **kwargs):
            result = actual(command, *args, **kwargs)
            if Path(command[1]).name == "build_bib.py" and "--check-only" not in command:
                self.paper["authors"] = [{"name": "Changed During Build"}]
                atomic_json(self.ws / "02_retrieval/selected_paper.json", {"p": self.paper})
            return result

        with patch("slr.run_command", side_effect=change_source), patch("task_contract.sync_views"):
            rc, result = self.run_stage()
        self.assertEqual(rc, 1)
        self.assertEqual(result["code"], "MATERIAL_INPUTS_CHANGED")
        self.assertNotIn("bibliography", result["checkpoints"])
        self.assertTrue((self.ws / "03_process/references.bib").exists())

    def test_changed_output_is_rebuilt_and_checkpoint_survives_later_failure(self):
        actual = slr.run_command

        def fail_audit(command, *args, **kwargs):
            if Path(command[1]).name == "audit_citation_metadata.py":
                return 1, '{"status":"FAILED","code":"AUDIT_FIXTURE"}'
            return actual(command, *args, **kwargs)

        with patch("slr.run_command", side_effect=fail_audit), patch("task_contract.sync_views"):
            rc, first = self.run_stage()
        self.assertEqual(rc, 1)
        self.assertIn("bibliography", first["checkpoints"])
        calls = []

        def track(command, *args, **kwargs):
            calls.append(Path(command[1]).name)
            return actual(command, *args, **kwargs)

        with patch("slr.run_command", side_effect=track), patch("task_contract.sync_views"):
            self.assertEqual(self.run_stage()[0], 0)
            self.assertEqual(calls, ["build_bib.py", "audit_citation_metadata.py"])
            (self.ws / "03_process/cards_index.jsonl").write_text("corrupt output")
            calls.clear()
            self.assertEqual(self.run_stage()[0], 0)
            self.assertEqual(calls, ["build_bib.py", "build_cards_index.py"])

    def test_changed_evidence_cannot_skip_extraction_or_hide_failure(self):
        with patch("task_contract.sync_views"):
            self.assertEqual(self.run_stage()[0], 0)
        self.paper["abstract"] = "Changed source evidence."
        atomic_json(self.ws / "02_retrieval/selected_paper.json", {"p": self.paper})
        actual = slr.run_command
        calls = []

        def forbid_model(command, *args, **kwargs):
            if Path(command[1]).name == "paper_card_tools.py":
                calls.append("extraction-needed")
                return 1, '{"status":"FAILED","code":"TEST_NO_MODEL"}'
            return actual(command, *args, **kwargs)

        with patch("slr.run_command", side_effect=forbid_model), patch("task_contract.sync_views"):
            rc, result = self.run_stage()
        self.assertEqual(calls, ["extraction-needed"])
        self.assertEqual(rc, 1)
        self.assertEqual(result["code"], "TEST_NO_MODEL")

    def test_legacy_running_and_unobserved_spawn_fail_closed_without_inventing_time(self):
        for execution in (None, {"phase": "starting", "child_pid": None}):
            value = {"stage": "processing", "status": "RUNNING", "elapsed_sec": 2}
            if execution:
                value["execution"] = execution
            atomic_json(self.ws / "_status/processing.json", value)
            result = read_status(self.ws, "processing")
            self.assertEqual(result["status"], "RECOVERY_REQUIRED")
            self.assertFalse(result["cumulative"]["timing_complete"])
            again = read_status(self.ws, "processing")
            self.assertEqual(again["cumulative"], result["cumulative"])
            with self.assertRaises(OperationBlocked):
                with operation(self.ws, "processing"):
                    self.fail("Untracked execution cannot be restarted")

    def test_code_revision_change_invalidates_derived_outputs_but_not_valid_cards(self):
        with patch("task_contract.sync_views"):
            self.assertEqual(self.run_stage()[0], 0)
        calls = []
        actual = slr.run_command

        def track(command, *args, **kwargs):
            calls.append(Path(command[1]).name)
            return actual(command, *args, **kwargs)

        with (
            patch("slr.code_revision", return_value="new-code"),
            patch("slr.run_command", side_effect=track),
            patch("task_contract.sync_views"),
        ):
            self.assertEqual(self.run_stage()[0], 0)
        self.assertEqual(
            calls,
            ["build_bib.py", "build_bib.py", "build_cards_index.py", "audit_citation_metadata.py"],
        )

    def test_native_legacy_card_does_not_hide_new_l1_import(self):
        from recovery import reusable

        with patch("recovery.validation_context", return_value={"assets": {"p": {}}, "maps": {}}):
            self.assertIsNone(reusable(self.ws, {"validator": "paper_cards"}, None, None))

    def test_known_spawn_failure_is_failed_and_does_not_require_manual_recovery(self):
        with self.assertRaises(OSError):
            with operation(self.ws, "processing"):
                run_stream(
                    [str(self.ws / "missing-executable")],
                    self.ws,
                    self.ws / "spawn.log",
                    os.environ,
                    1,
                )
        self.assertEqual(read_status(self.ws, "processing")["status"], "FAILED")
        with operation(self.ws, "processing") as attempt:
            attempt.finish({"status": "SUCCESS"})

    def test_cleanup_failure_does_not_claim_a_live_child_stopped(self):
        with patch("lifecycle.child_active", return_value=True):
            with self.assertRaises(OSError):
                with operation(self.ws, "processing") as attempt:
                    attempt.child("running", 123)
                    raise OSError("fixture cleanup failed")
            result = read_status(self.ws, "processing")
            self.assertEqual(result["status"], "RECOVERY_REQUIRED")
            self.assertIn("cleanup failed", result["message"])


@unittest.skipIf(os.name == "nt", "POSIX signal probe; Windows needs native Job Object acceptance")
class ProcessRecoveryTest(unittest.TestCase):
    setUp = RecoveryTest.setUp

    def launch(self, workflow=False):
        child = self.ws / "child.py"
        child.write_text(
            "import pathlib,time,sys\npathlib.Path(sys.argv[1]).write_text('ready')\ntime.sleep(30)\n"
        )
        program = """
import sys,json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path[:0]=[sys.argv[1]+'/scripts',sys.argv[1]+'/lib']
import slr
ws=Path(sys.argv[2])
stage={'id':'processing','command':[sys.executable,str(ws/'child.py'),str(ws/'ready')], 'status':{'kind':'trailing_json'}}
args=SimpleNamespace(profile='fast',workspace=str(ws),stage='processing',dry_run=False,tail=0,full=True)
with patch('slr.find_stage',return_value=stage),patch('task_contract.sync_views'):
 sys.exit(slr.cmd_run(args))
"""
        if workflow:
            program = """
import sys,json,os
from pathlib import Path
sys.path[:0]=[sys.argv[1]+'/scripts',sys.argv[1]+'/lib']
from workflow import advance
from platform_io import run_stream
ws=Path(sys.argv[2])
def runner(ws, command):
 rc, output = run_stream([sys.executable,'-B','-c',INNER,sys.argv[1],str(ws)],ws,ws/'nested.log',os.environ,30)
 return rc,json.loads(output)
print(json.dumps(advance(ws,'evidence','processing',runner=runner)))
""".replace("INNER", repr(program))
        process = subprocess.Popen(
            [sys.executable, "-B", "-c", program, str(ROOT), str(self.ws)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(self.clean_process, process)
        deadline = time.monotonic() + 8
        while (
            not (self.ws / "ready").exists()
            and process.poll() is None
            and time.monotonic() < deadline
        ):
            time.sleep(0.02)
        self.assertTrue((self.ws / "ready").exists(), "fixture child never started")
        return process

    def clean_process(self, process):
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)
        path = self.ws / "_status/processing.json"
        if path.exists():
            pid = json.loads(path.read_text()).get("execution", {}).get("child_pid")
            if pid and child_active(pid):
                kill_process_tree(pid)  # This PID belongs only to this test's disposable child.

    def test_sigterm_stops_child_and_leaves_one_terminal_attempt(self):
        process = self.launch()
        active = read_status(self.ws, "processing")
        self.assertTrue(active["execution_active"])
        pid = active["execution"]["child_pid"]
        with self.assertRaises(OperationBlocked):
            with operation(self.ws, "fulltext"):
                self.fail("material stages must exclude one another")
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=8)
        result = read_status(self.ws, "processing")
        self.assertEqual(result["status"], "INTERRUPTED", result)
        self.assertFalse(child_active(pid))
        self.assertEqual(len(result["cumulative"]["invocations"]), 1)
        self.assertTrue((self.ws / "03_process/paper_cards.json").exists())

    def test_hard_kill_does_not_restart_over_a_live_child(self):
        process = self.launch()
        active = read_status(self.ws, "processing")
        pid = active["execution"]["child_pid"]
        process.kill()
        process.wait(timeout=5)
        result = read_status(self.ws, "processing")
        self.assertEqual(result["status"], "RECOVERY_REQUIRED")
        with self.assertRaises(OperationBlocked):
            with operation(self.ws, "processing"):
                self.fail("live orphan must prevent duplicate work")
        kill_process_tree(pid)
        deadline = time.monotonic() + 5
        while child_active(pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        result = read_status(self.ws, "processing")
        self.assertEqual(result["status"], "INTERRUPTED", result)
        self.assertEqual(len(result["cumulative"]["invocations"]), 1)
        self.assertFalse(result["cumulative"]["timing_complete"])

    def test_workflow_sigterm_reaches_nested_material_child(self):
        process = self.launch(workflow=True)
        pid = read_status(self.ws, "processing")["execution"]["child_pid"]
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=8)
        self.assertFalse(child_active(pid))
        for stage in ("workflow", "processing"):
            result = read_status(self.ws, stage)
            self.assertEqual(result["status"], "INTERRUPTED", result)
            self.assertEqual(len(result["cumulative"]["invocations"]), 1)


if __name__ == "__main__":
    unittest.main()
