import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_state


class FinalReportFormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.run_dir = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def complete(self, contents):
        (self.run_dir / "final_report.md").write_text(contents, encoding="utf-8")
        state = {
            "status": "FINAL_REPORTING",
            "paths": {"report_review": "review.json"},
            "events": [],
        }
        review = {
            "schema_version": "1.0",
            "run_id": "test-run",
            "search_round": 1,
            "decision": "complete",
            "feedback": None,
            "report_path": "read_report.md",
            "reviewed_at": "2026-09-24T00:00:00Z",
            "archived_artifacts": {},
        }
        with (
            mock.patch.object(run_state, "read_state", return_value=state),
            mock.patch.object(run_state, "read_json", return_value=review),
            mock.patch.object(run_state, "_no_readable_fulltext", return_value=False),
            mock.patch.object(run_state, "write_state"),
        ):
            return run_state.complete_final_report(self.run_dir, _stage_authorized=True)

    def test_adjacent_plain_references_are_rejected(self):
        report = "Claim [1] and claim [2].\n\n## 参考资料\n[1] First paper.\n[2] Second paper."
        with self.assertRaisesRegex(ValueError, "reference entries must be separated"):
            self.complete(report)

    def test_blank_lines_make_plain_references_valid(self):
        report = "Claim [1] and claim [2].\n\n## 参考资料\n[1] First paper.\n\n[2] Second paper."
        self.assertEqual(self.complete(report), self.run_dir / "final_report.md")

    def test_markdown_list_references_remain_valid(self):
        report = (
            "Claim [1] and claim [2].\n\n## References\n- [1] First paper.\n- [2] Second paper."
        )
        self.assertEqual(self.complete(report), self.run_dir / "final_report.md")

    def test_adjacent_abstract_alerts_are_rejected(self):
        report = (
            "Claim [1]. Reminder [A1] and reminder [A2].\n\n"
            "## Highly relevant papers without full text (abstract-level alerts)\n"
            "[A1] First. Evidence level: abstract; full text not read.\n"
            "[A2] Second. Evidence level: abstract; full text not read.\n\n"
            "## References\n[1] Readable paper."
        )
        with self.assertRaisesRegex(ValueError, "abstract-alert entries must be separated"):
            self.complete(report)

    def test_blank_lines_make_abstract_alerts_valid(self):
        report = (
            "Claim [1]. Reminder [A1] and reminder [A2].\n\n"
            "## Highly relevant papers without full text (abstract-level alerts)\n"
            "[A1] First. Evidence level: abstract; full text not read.\n\n"
            "[A2] Second. Evidence level: abstract; full text not read.\n\n"
            "## References\n[1] Readable paper."
        )
        self.assertEqual(self.complete(report), self.run_dir / "final_report.md")


if __name__ == "__main__":
    unittest.main()
