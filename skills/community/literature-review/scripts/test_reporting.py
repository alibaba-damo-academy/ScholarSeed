"""Offline output-boundary checks; no model or product session is executed."""

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "lib")]

import slr  # noqa: E402 - packaged Skill path bootstrap.
from main_view import compact, emit  # noqa: E402 - packaged Skill path bootstrap.
from usage import accumulate, summarize  # noqa: E402 - packaged Skill path bootstrap.


class ReportingTest(unittest.TestCase):
    def report(self, ws):
        receipt = ws / "_logs/llm/chapter-1"
        receipt.mkdir(parents=True)
        (receipt / "request.json").write_text(
            json.dumps({"stage": "chapter_1", "model": "fixture"})
        )
        (receipt / "attempts.json").write_text(
            json.dumps(
                [
                    {
                        "attempt": 1,
                        "ok": False,
                        "error": {"code": "TIMEOUT"},
                        "usage": None,
                        "elapsed_sec": 2,
                    },
                    {
                        "attempt": 2,
                        "ok": True,
                        "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                        "elapsed_sec": 3,
                    },
                ]
            )
        )
        result = {
            "status": "FAILED",
            "code": "BIBLIOGRAPHY_INVALID",
            "issues": [{"cite_key": "Paper2026", "field": "author"}],
            "next_action": "Repair the named entry; preserve completed chapters.",
            "jobs": {"1": {"state": "complete", "path": "chapters/1.tex"}},
            "checks": [{"id": "unknown_citations", "unknown": ["Missing2026"]}],
            "pages_to_read": ["page-1.png"],
            "artifact": "draft.tex",
            "model_usage": summarize(ws),
        }
        result.update(accumulate({}, result, 5))
        result.update(accumulate(result, result, 1))
        return result

    def test_summary_preserves_unknown_cost_failures_and_business_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            full = self.report(Path(tmp))
            before = copy.deepcopy(full)
            projected = compact(full)
            self.assertEqual(full, before)
            self.assertEqual(projected["model_usage"]["totals"], full["model_usage"]["totals"])
            self.assertEqual(projected["model_usage"]["totals"]["failed_attempts"], 1)
            self.assertEqual(
                projected["model_usage"]["totals"]["missing_usage_attempts"]["input_tokens"], 1
            )
            self.assertFalse(projected["model_usage"]["usage_complete"])
            self.assertNotIn("by_stage_model", projected["model_usage"])
            self.assertNotIn("issues", projected["model_usage"])
            self.assertNotIn("invocations", projected["cumulative"])
            self.assertEqual(projected["cumulative"]["invocation_count"], 2)
            for key in (
                "status",
                "code",
                "issues",
                "next_action",
                "jobs",
                "checks",
                "pages_to_read",
                "artifact",
                "invocation",
            ):
                self.assertEqual(projected[key], full[key])
            self.assertEqual(compact(projected), projected)

    def test_nested_reports_stay_bounded_while_full_diagnostics_remain_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = self.report(Path(tmp))
            report["model_usage"]["issues"] = [
                {"request_id": "broken", "code": "USAGE_RECEIPT_INCOMPLETE"}
            ]
            value = {"status": "FAILED", "result": report, "retrieval": copy.deepcopy(report)}
            compact_size = len(json.dumps(compact(value)))
            for nested in (value["result"], value["retrieval"]):
                nested["model_usage"]["by_stage_model"] *= 100
                nested["model_usage"]["issues"] *= 100
                nested["cumulative"]["invocations"] *= 100
            projected = compact(value)
            self.assertLess(len(json.dumps(projected)) - compact_size, 30)
            self.assertEqual(projected["result"]["model_usage"]["issue_count"], 100)
            self.assertEqual(projected["result"]["cumulative"]["invocation_count"], 200)
            for flag in (False, True):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    emit(value, full=flag)
                self.assertEqual(json.loads(out.getvalue()), value if flag else projected)

    def test_cli_persists_complete_report_before_projecting_stdout_and_preserves_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            report = self.report(ws)
            source = ws / "fixture.json"
            source.write_text(json.dumps(report))
            command = [
                sys.executable,
                "-c",
                "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text()); sys.exit(1)",
                str(source),
            ]
            args = SimpleNamespace(workspace=str(ws), full=False, profile="fast")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = slr._exec_main_tool(args, command, "manuscript_generate")
            projected = json.loads(out.getvalue())
            saved = json.loads(Path(projected["cli_report"]).read_text())
            self.assertEqual(rc, 1)
            self.assertEqual(saved["model_usage"], report["model_usage"])
            self.assertEqual(saved["cumulative"], report["cumulative"])
            self.assertEqual(projected["code"], report["code"])
            self.assertNotIn("by_stage_model", projected["model_usage"])
            self.assertIn("by_stage_model", Path(projected["log"]).read_text())
            for stage in ("writing", "workflow"):
                path = ws / "_status" / f"{stage}.json"
                path.write_text(json.dumps(saved))
                before = path.read_bytes()
                for flag in (False, True):
                    out = io.StringIO()
                    with contextlib.redirect_stdout(out):
                        self.assertEqual(
                            slr.cmd_status(
                                SimpleNamespace(workspace=str(ws), stage=stage, full=flag)
                            ),
                            0,
                        )
                    status = json.loads(out.getvalue())
                    self.assertEqual("by_stage_model" in status["model_usage"], flag)
                    self.assertEqual(status["code"], report["code"])
                    self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
