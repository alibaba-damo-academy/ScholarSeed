#!/usr/bin/env scholarseed-skill-python
"""Regression tests for the public outline-check wrapper contract."""
from __future__ import annotations

import pathlib
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import slr  # noqa: E402
import validate_outline
from task_fixtures import planned_asset, planned_outline
from outline.render_outline_md import render


def _args(**overrides):
    values = {
        "action": "check",
        "workspace": None,
        "requirements": None,
        "min_figures": None,
        "max_figures": None,
        "min_tables": None,
        "max_tables": None,
        "min_papers_per_subsection": None,
        "max_papers_per_subsection": None,
        "min_papers_per_section": None,
        "required_section": [],
        "json": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class OutlineCliContractTest(unittest.TestCase):
    def _capture(self, args, workspace: pathlib.Path):
        captured: list[list[str]] = []

        def fake_exec(command: list[str]) -> int:
            captured.append(command)
            return 0

        with patch.object(slr, "_resolve_workspace", return_value=workspace), patch.object(
            slr, "_exec_tool", side_effect=fake_exec
        ):
            rc = slr.cmd_outline(args)
        return rc, captured

    def test_wrapper_uses_workspace_without_legacy_requirement_argument(self):
        ws=pathlib.Path('/tmp/outline-contract-workspace')
        rc, captured=self._capture(_args(),ws)
        self.assertEqual(rc,0)
        self.assertEqual(captured[0][-1],str(ws))
        self.assertNotIn('--requirements',captured[0])

    def test_removed_legacy_flag_is_rejected(self):
        result=subprocess.run([str(ROOT/'scripts/slr'),'outline','check','--requirements','unused'],capture_output=True,text=True)
        self.assertEqual(result.returncode,2)
        self.assertIn('unrecognized arguments',result.stderr)


class CompactOutlineTest(unittest.TestCase):
    def outline(self):
        return {"survey_title": "Methods", "topic": "Optimization", "outline_tree": [
            {"section_id": "1", "title": "Problem and methods", "description": "Compare assumptions and guarantees.",
             "subsections": [{"section_id": "1.1", "title": "Guarantees", "description": "Explain when the methods converge."}]},
            {"section_id": "2", "title": "Open questions", "description": "Identify gaps supported by the evidence."}]}

    def check(self, outline, limits=None):
        return validate_outline.validate(planned_outline(outline), {"p1", "p2"}, limits or {}, {"Paper2026": "p1"})[0]

    def test_default_compact_outline_needs_no_assignments_assets_or_quotas(self):
        outline = self.outline()
        self.assertEqual(self.check(outline), [])
        rendered = render(outline, {}, None)
        self.assertIn("1.1 Guarantees", rendered)
        self.assertIn("    - 1.1 Guarantees", rendered)
        self.assertNotIn("Explain when", rendered)
        for absent in ("0 papers", "0 paper", "None planned", "Nothing is waiting", "## Shape"):
            self.assertNotIn(absent, rendered)

    def test_optional_assignments_are_checked_at_both_levels_and_on_assets(self):
        for target in ("l1", "l2", "figure", "table"):
            with self.subTest(target=target):
                outline = self.outline()
                section = outline["outline_tree"][0]
                if target == "l1":
                    node = section
                elif target == "l2":
                    node = section["subsections"][0]
                else:
                    node = {f"{target}_id": "F1" if target == "figure" else "T1", "caption": "Evidence"}
                    section[target + "s"] = [node]
                node["paper_ids"] = ["p1"]
                node["cite_keys"] = ["Paper2026"]
                self.assertEqual(self.check(outline), [])
                node["paper_ids"] = ["invented"]
                self.assertIn("absent", " ".join(self.check(outline)))
                node["paper_ids"] = ["Paper2026"]
                self.assertIn("CITE KEYS", " ".join(self.check(outline)))
                node["paper_ids"] = ["p1"]
                node["cite_keys"] = ["Fake2026"]
                self.assertIn("cite_keys absent", " ".join(self.check(outline)))

    def test_explicit_constraints_remain_effective(self):
        outline = self.outline()
        self.assertIn("at least 2", " ".join(self.check(outline, {"min_figures": 2})))
        self.assertIn("at least 1", " ".join(self.check(outline, {"min_papers_per_subsection": 1})))
        self.assertIn("at least 2", " ".join(self.check(outline, {"min_papers_per_section": 2})))
        self.assertIn("FIRST", " ".join(self.check(outline, {"required_sections": [{"title": "Open questions", "position": "first"}]})))
        outline["outline_tree"][0]["figures"] = [{"figure_id": "F1", "caption": "Geometry"}]
        self.assertEqual(self.check(outline, {"min_figures": 1, "max_figures": 1}), [])
        self.assertIn("at most 0", " ".join(self.check(outline, {"max_figures": 0})))

    def test_identity_and_shape_fail_with_actionable_errors(self):
        for mutation in (
            lambda x: x["outline_tree"].append(copy.deepcopy(x["outline_tree"][0])),
            lambda x: x["outline_tree"][0]["subsections"][0].update(section_id="9.1"),
            lambda x: x["outline_tree"][0].update(description=""),
            lambda x: x["outline_tree"][0].update(paper_ids="p1"),
            lambda x: x["outline_tree"][0].update(figures=["invalid"]),
            lambda x: x["outline_tree"][0]["subsections"][0].update(subsections=[{}]),
        ):
            outline = self.outline()
            mutation(outline)
            self.assertTrue(self.check(outline))
        outline = self.outline()
        outline["outline_tree"][0]["figures"] = [{"figure_id": "F1", "caption": "First"}, {"figure_id": "F1", "caption": "Second"}]
        self.assertIn("duplicate figure", " ".join(self.check(outline)))

    def test_language_is_top_level_enum_and_subsections_inherit(self):
        outline=self.outline();outline['outline_tree'][0]['language']='english'
        self.assertEqual(self.check(outline),[])
        outline['outline_tree'][0]['language']='russian'
        self.assertIn('language must be', ' '.join(self.check(outline)))
        for language in ('english', 'default', None):
            outline=self.outline();outline['outline_tree'][0]['language']='english'
            outline['outline_tree'][0]['subsections'][0]['language']=language
            self.assertIn('must inherit', ' '.join(self.check(outline)))

    def test_cli_defaults_and_requirements_derived_count(self):
        with tempfile.TemporaryDirectory() as d:
            ws = pathlib.Path(d)
            (ws / "04_outline").mkdir()
            (ws / "01_input").mkdir()
            (ws / "04_outline/outline.json").write_text(json.dumps(self.outline()))
            command = [sys.executable, str(ROOT / "scripts/validate_outline.py"), str(ws), "--json"]
            from task_fixtures import task
            from task_contract import atomic_json
            atomic_json(ws/"01_input/writing_request.json",task())
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertIsNone(report["limits"]["max_figures"])
            from task_fixtures import task
            from task_contract import atomic_json
            atomic_json(ws/'01_input/writing_request.json', task({'user_instructions':'At least one figure.',
                'constraints':[*task()['constraints'],{'id':'F','kind':'figure_count','value':{'min':1},'verbatim':'At least one figure.'}]}))
            result=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(result.returncode,1,result.stdout+result.stderr)
            self.assertIn('at least 1',result.stdout)



if __name__ == "__main__":
    unittest.main()
