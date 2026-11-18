"""Only the current writing pipeline is executable or advertised."""

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import slr

ROOT = Path(__file__).resolve().parents[1]
RETIRED = (
    "scripts/writing.py",
    "scripts/produce.py",
    "scripts/asset_wrappers.py",
    "scripts/review_reading.py",
    "scripts/refine_scan.py",
    "scripts/validate_refinement.py",
    "scripts/legacy_stage.py",
    "scripts/component_document.py",
    "scripts/generation/drafting/_fast/collect_drafting_worklist.py",
    "scripts/generation/drafting/_fast/validate_drafts.py",
    "scripts/generation/merge/_fast/phase05_merge_full_draft.py",
    "scripts/generation/merge/_fast/phase05b_insert_assets.py",
    "scripts/generation/publish/_fast/phase06_quality_check.py",
    "scripts/generation/publish/_fast/phase08_finalize.py",
    "scripts/generation/publish/_fast/phase07_compile_latex.py",
)


class RetirementTest(unittest.TestCase):
    def test_old_engine_and_coordinators_are_absent(self):
        self.assertEqual([name for name in RETIRED if (ROOT / name).exists()], [])

    def test_old_commands_are_rejected_before_execution(self):
        for command in ("corpus", "context", "draft", "produce", "review", "apply"):
            with (
                self.subTest(command=command),
                patch.object(sys, "argv", ["slr", "writing", command]),
            ):
                with (
                    contextlib.redirect_stderr(io.StringIO()),
                    self.assertRaises(SystemExit) as error,
                ):
                    slr.main()
                self.assertEqual(error.exception.code, 2)

    def test_current_management_remains_visible(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["slr", "writing", "--help"]),
            contextlib.redirect_stdout(output),
        ):
            with self.assertRaises(SystemExit) as error:
                slr.main()
        self.assertEqual(error.exception.code, 0)
        for command in ("configure", "plan-packet", "plan-resolve", "approve", "review-complete"):
            self.assertIn(command, output.getvalue())

    def test_no_old_stages_or_agent_instructions(self):
        for path in (ROOT / "config/profiles").glob("*.json"):
            stages = json.loads(path.read_text())["stages"]
            self.assertFalse(any(stage.get("legacy") for stage in stages))
        files = [
            ROOT / "SKILL.md",
            ROOT / "README.md",
            ROOT / "README_zh.md",
            *(ROOT / "references").rglob("*.md"),
        ]
        for path in files:
            text = path.read_text()
            for instruction in (
                "writing draft",
                "writing produce",
                "writing context",
                "writing.py",
                "generation_prep",
                "generation_merge",
                "section_drafts",
            ):
                with self.subTest(path=path, instruction=instruction):
                    self.assertNotIn(instruction, text)
