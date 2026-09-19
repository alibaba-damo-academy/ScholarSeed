from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from argparse import Namespace
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

from browser_pool import BrowserPool, Lease, group_members, stop_process
from browser_pool_support import cleanup_pool, pool_environment
from validate_json import validate_data

ROOT = Path(__file__).resolve().parents[3]
ADAPTER = ROOT / "skills/community/precise-literature-search/modules/paid-download/adapter.py"


class PaidPoolIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.environment = pool_environment(self.root)
        self.environment.update(
            {
                "PAPER_DL_MODE": "interactive",
                "PAPER_DL_EXECUTABLE": str(
                    ROOT / "tests/integration/precise/fixtures/fake_paper_dl.py"
                ),
            }
        )
        self.pool = BrowserPool(self.root / "pool")
        self.processes = []

    def tearDown(self):
        for p in self.processes:
            if p.poll() is None:
                p.terminate()
        for p in self.processes:
            p.communicate(timeout=15)
        cleanup_pool(self.root)
        self.temp.cleanup()

    def launch(self, index, delay="2"):
        run = self.root / f"run-{index}"
        run.mkdir()
        (run / "metadata.json").write_text(
            json.dumps(
                {
                    "papers": [
                        {
                            "id": f"paper-{index}",
                            "title": f"Paper {index}",
                            "doi": f"10.0000/paper-{index}",
                            "open_access": "no",
                        }
                    ]
                }
            )
        )
        (run / "selection.json").write_text(
            json.dumps(
                {
                    "run_id": run.name,
                    "metadata_path": "metadata.json",
                    "selected_paper_ids": [f"paper-{index}"],
                    "download_paid": True,
                    "confirmed_by_user": True,
                }
            )
        )
        env = self.environment.copy()
        env["PAPER_DL_TEST_DOWNLOADER_DELAY"] = delay
        p = subprocess.Popen(
            [
                sys.executable,
                "-B",
                str(ADAPTER),
                "--input",
                str(run / "selection.json"),
                "--output",
                str(run / "downloads/manifest.json"),
                "--run-dir",
                str(run),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.processes.append(p)
        return run, p

    def wait_for_downloads(self, count):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            states = [s for s in self.pool.status() if s and s.get("download")]
            if len(states) == count:
                return states
            time.sleep(0.05)
        self.fail(f"Expected {count} active downloads")

    def test_four_adapters_isolate_output_and_fourth_waits(self):
        first = [self.launch(i) for i in range(3)]
        states = self.wait_for_downloads(3)
        expected_endpoint = {s["run_dir"]: s["endpoint"] for s in states}
        self.assertEqual(len(set(expected_endpoint.values())), 3)
        fourth = self.launch(3, delay="0")
        for run, p in [*first, fourth]:
            out, err = p.communicate(timeout=15)
            self.assertEqual(p.returncode, 0, out + err)
            manifest = json.loads((run / "downloads/manifest.json").read_text())
            index = int(run.name.split("-")[1])
            self.assertEqual(manifest["papers"][0]["paper_id"], f"paper-{index}")
            pdf = run / manifest["papers"][0]["file_path"]
            self.assertTrue(pdf.is_relative_to(run))
            self.assertTrue(pdf.read_bytes().startswith(b"%PDF-"))
            report = json.loads((run / manifest["external_report"]).read_text())
            self.assertEqual(report["results"][0]["identifier"]["value"], f"10.0000/paper-{index}")
            self.assertTrue(manifest["completion_notice"]["browser_pool_released"])
            if index < 3:
                self.assertIn(expected_endpoint[str(run)], out)
            else:
                self.assertIn("Waiting for an available non-arXiv browser slot", out)
        self.assertEqual(self.pool.status(), [None, None, None])

    def test_cancel_active_adapter_cleans_only_its_own_processes(self):
        run0, p0 = self.launch(0, delay="60")
        run1, p1 = self.launch(1, delay="60")
        states = self.wait_for_downloads(2)
        own = next(s for s in states if s["run_dir"] == str(run0))
        other = next(s for s in states if s["run_dir"] == str(run1))
        p0.send_signal(signal.SIGTERM)
        out, err = p0.communicate(timeout=15)
        self.assertEqual(p0.returncode, 143, out + err)
        self.assertFalse(group_members(own["browser"]["pid"]))
        self.assertFalse(group_members(own["download"]["pid"]))
        self.assertEqual(self.pool.state(other["slot"])["lease_id"], other["lease_id"])
        self.assertTrue(group_members(other["download"]["pid"]))
        self.assertIsNone(p1.poll())

    def assert_intervention_failure_preserves_results(self, *, close_browser):
        spec = importlib.util.spec_from_file_location("paid_pool_recovery_test", ADAPTER)
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        run = self.root / "mixed-run"
        run.mkdir()
        papers = [
            {"id": name, "title": name, "doi": f"10.0000/{name}", "open_access": "no"}
            for name in ("success", "manual")
        ]
        (run / "metadata.json").write_text(json.dumps({"papers": papers}))
        selection = run / "selection.json"
        selection.write_text(
            json.dumps(
                {
                    "run_id": run.name,
                    "metadata_path": "metadata.json",
                    "selected_paper_ids": ["success", "manual"],
                    "download_paid": True,
                    "confirmed_by_user": True,
                }
            )
        )
        output = run / "downloads/manifest.json"
        args = Namespace(input=selection, output=output, resume=False)
        original_download = Lease.run_download

        def finish_then_close(lease, *command_args, **kwargs):
            result = original_download(lease, *command_args, **kwargs)
            # Only stop the test's pool-owned fake Chrome after paper-dl has
            # produced one PDF and one pending manual action.
            stop_process(lease.state["browser"])
            return result

        with mock.patch.dict(os.environ, self.environment, clear=True):
            with ExitStack() as stack:
                if close_browser:
                    stack.enter_context(mock.patch.object(Lease, "run_download", finish_then_close))
                else:
                    stack.enter_context(
                        mock.patch.object(
                            adapter,
                            "open_action_papers_in_cdp",
                            side_effect=OSError("CDP action preparation failed"),
                        )
                    )
                self.assertEqual(adapter._run_locked(args, run), 2)
            self.assertTrue(
                output.is_file(), "Persist mixed results before browser intervention setup"
            )
            manifest = json.loads(output.read_text())
            validate_data("download-manifest", manifest)
            self.assertEqual(manifest["status"], "action_required")
            self.assertEqual(manifest["summary"]["downloaded"], 1)
            self.assertEqual(manifest["summary"]["action_required"], 1)
            self.assertFalse(manifest["action"]["all_action_pages_opened"])
            self.assertTrue(any("Results preserved" in warning for warning in manifest["warnings"]))
            self.assertNotIn("completion_notice", manifest)
            self.assertTrue((run / manifest["external_report"]).is_file())
            downloaded = next(p for p in manifest["papers"] if p["paper_id"] == "success")
            pdf = run / downloaded["file_path"]
            before = (pdf.read_bytes(), pdf.stat().st_ino, pdf.stat().st_mtime_ns)
            self.assertTrue(before[0].startswith(b"%PDF-"))
            self.assertEqual(self.pool.status(), [None, None, None])
            args.resume = True
            self.assertEqual(adapter._run_locked(args, run), 0)
            resumed = json.loads(output.read_text())
            validate_data("download-manifest", resumed)
            report = json.loads((run / resumed["external_report"]).read_text())
            self.assertEqual(
                [p["identifier"]["value"] for p in report["results"]], ["10.0000/manual"]
            )
            self.assertEqual((pdf.read_bytes(), pdf.stat().st_ino, pdf.stat().st_mtime_ns), before)

    def test_browser_exit_after_mixed_batch_preserves_manifest_and_retry_skips_success(self):
        self.assert_intervention_failure_preserves_results(close_browser=True)

    def test_action_setup_error_preserves_manifest_and_retry_skips_success(self):
        self.assert_intervention_failure_preserves_results(close_browser=False)


if __name__ == "__main__":
    unittest.main()
