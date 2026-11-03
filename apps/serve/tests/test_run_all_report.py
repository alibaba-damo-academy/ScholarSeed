import json
import tempfile
import unittest
from pathlib import Path

from tests.run_all import TIMEOUT_EXIT_CODE, write_report


class RunAllReportTests(unittest.TestCase):
    def test_preserves_suite_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "run-all.json"
            report = write_report(
                target,
                ["contract_one", "contract_two"],
                {
                    "contract_one": (0, 125),
                    "contract_two": (TIMEOUT_EXIT_CODE, 600_000),
                },
            )
            self.assertEqual(report["verdict"], "fail")
            self.assertEqual(report["planned"], ["contract_one", "contract_two"])
            self.assertEqual(report["omitted"], [])
            self.assertEqual(
                report["results"][1],
                {
                    "suite": "contract_two",
                    "exitCode": TIMEOUT_EXIT_CODE,
                    "durationMs": 600_000,
                    "timedOut": True,
                    "status": "failed",
                },
            )
            self.assertEqual(json.loads(target.read_text()), report)

    def test_rejects_missing_suite_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = write_report(Path(directory) / "run-all.json", ["contract_one"], {})
            self.assertEqual(report["verdict"], "fail")
            self.assertEqual(report["results"][0]["status"], "missing")

    def test_records_exact_fast_mode_omissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = write_report(
                Path(directory) / "run-all.json",
                ["contract_one"],
                {"contract_one": (0, 10)},
                omitted=["integration_serve"],
            )
            self.assertEqual(report["omitted"], ["integration_serve"])
