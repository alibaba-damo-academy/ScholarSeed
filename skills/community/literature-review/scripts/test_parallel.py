"""Parallel authoring has content ownership, not model-authored execution edges."""

import contextlib
import copy
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import slr
import test_native_pipeline as native
from chapter_plan import compile_plan
from manuscript import prepare
from operator_cli import figure_plan
from outlining import _example, restore_ids
from task_contract import atomic_json, configure


class ParallelTest(unittest.TestCase):
    def outline(self):
        return {
            "review_thesis": "Compare supported mechanisms",
            "organizing_axis": "Conditions",
            "outline_tree": [
                {
                    "section_id": "1",
                    "title": "Open problems",
                    "role": "synthesis",
                    "description": "Define and compare concrete failures here.",
                    "paper_ids": ["p1"],
                    "analysis_tasks": [],
                }
            ],
        }

    def test_content_jobs_do_not_have_dependency_or_prerequisite_fields(self):
        value = self.outline()
        before = copy.deepcopy(value)
        plan = compile_plan(value, {"p1"})
        for job in plan["jobs"]:
            self.assertNotIn("dependencies", job)
            self.assertNotIn("prerequisites", job)
            self.assertEqual(job["paper_ids"], ["p1"])
        self.assertNotIn("prerequisites", plan)
        self.assertEqual(value, before)

    def test_retired_graph_fields_are_not_silently_migrated(self):
        for field in ("prerequisites", "requires", "depends_on", "owner_section_id"):
            with self.subTest(field=field):
                value = self.outline()
                value[field] = []
                with self.assertRaisesRegex(ValueError, "retired"):
                    compile_plan(value, {"p1"})

    def test_table_example_is_complete_and_uses_the_supplied_identities(self):
        examples = [
            json.loads(line) for line in _example("survey").splitlines() if line.startswith("{")
        ]
        plan = next(value for value in examples if value.get("outline_tree"))
        nodes = plan["outline_tree"]
        self.assertEqual(len(nodes), 3)
        self.assertFalse(nodes[0].get("tables"))
        self.assertFalse(nodes[-1].get("tables"))
        node = nodes[1]
        table = node["tables"][0]
        self.assertFalse(nodes[0].get("figures"))
        self.assertFalse(nodes[-1].get("figures"))
        figure = node["figures"][0]
        self.assertEqual(figure["paper_ids"], ["P01", "P02"])
        self.assertIn("[[paper:P01]]", figure["content_plan"])
        self.assertIn("[[paper:P02]]", figure["visual_guidance"])
        for field in (
            "table_id",
            "purpose",
            "content_plan",
            "caption_draft",
            "paper_ids",
            "row_unit",
            "comparison_dimensions",
        ):
            self.assertTrue(table[field], field)
        adapter = {
            "version": 2,
            "papers": {
                "P01": {"paper_id": "p1", "cite_key": "One"},
                "P02": {"paper_id": "p2", "cite_key": "Two"},
            },
        }
        restored = restore_ids(node, adapter)
        self.assertIn(r"\cite{One}", restored["figures"][0]["content_plan"])
        self.assertIn(r"\cite{Two}", restored["figures"][0]["visual_guidance"])
        self.assertEqual(restored["figures"][0]["paper_ids"], ["p1", "p2"])
        compile_plan(restore_ids(plan, adapter), {"p1", "p2"})
        self.assertEqual(restored["tables"][0]["paper_ids"], ["p1", "p2"])
        compile_plan(
            {
                "review_thesis": "Compare",
                "organizing_axis": "Mechanism",
                "outline_tree": [restored],
            },
            {"p1", "p2"},
        )

    def test_figures_can_be_submitted_without_any_chapter_text(self):
        for output_format in ("latex_pdf", "docx"):
            with self.subTest(output_format=output_format):
                fixture = native.NativeTest()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                configure(
                    fixture.ws,
                    {"writing_strategy": "chapter_delta", "publication": {"format": output_format}},
                )
                outline = fixture.outline
                outline["outline_tree"][2]["figures"] = [
                    {
                        "figure_id": "F1",
                        "purpose": "Explain failure cases",
                        "content_plan": "Show the supported relation under condition A",
                        "caption_draft": "A conditional relation",
                        "visual_guidance": "Simple diagram",
                        "paper_ids": ["p1"],
                    }
                ]
                atomic_json(fixture.ws / "04_outline/outline.json", outline)
                inventory = prepare(fixture.ws)
                self.assertFalse(any((fixture.ws / "05_generation/chapters").glob("*")))
                result = figure_plan(
                    fixture.ws,
                    {
                        "preparation_id": inventory["preparation_id"],
                        "items": [
                            {
                                "figure_id": "F1",
                                "_render_mode": "image",
                                "_prompt": "Show a conditional relation under A.",
                                "_caption": "A conditional relation",
                                "_latex_body": None,
                                "_chart_spec": None,
                                "_image_size": "square",
                            }
                        ],
                    },
                )
                self.assertEqual(result["status"], "SUCCESS")

    def test_no_waiting_interface_or_role_instructions_remain(self):
        root = Path(__file__).resolve().parents[1]
        self.assertFalse((root / "lib/figure_dependencies.py").exists())
        self.assertNotIn(
            "figures context", (root / "references/roles/slr-figure-planner.md").read_text()
        )
        with (
            patch.object(sys, "argv", ["slr", "figures", "context"]),
            patch.object(slr, "cmd_figures", side_effect=AssertionError("retired API dispatched")),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as error,
        ):
            slr.main()
        self.assertEqual(error.exception.code, 2)

    def test_table_example_does_not_override_a_no_table_requirement(self):
        for scope in ("survey", "section"):
            examples = [
                json.loads(line)
                for line in _example(scope, include_table=False).splitlines()
                if line.startswith("{")
            ]
            self.assertNotIn('"tables"', json.dumps(examples))

    def test_figure_example_does_not_override_a_no_figure_requirement(self):
        for scope in ("survey", "section"):
            examples = [
                json.loads(line)
                for line in _example(scope, include_figure=False).splitlines()
                if line.startswith("{")
            ]
            self.assertNotIn('"figures"', json.dumps(examples))
