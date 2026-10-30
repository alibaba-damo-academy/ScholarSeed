"""Chapter packet and prerequisite behavior; native end-to-end tests are separate."""

import copy
import json
import unittest

import test_native_pipeline as native
from chapter_plan import compile_plan
from figure_dependencies import context
from manuscript import prepare
from task_contract import atomic_json
from chapter_pipeline import chapter_system
from templates import LATEX_AUTHORING_GUIDANCE
from native_document import load_renderer


class PacketTest(unittest.TestCase):
    def test_template_guidance_covers_both_templates_without_diagram_authoring(self):
        self.assertNotIn('diagrams', LATEX_AUTHORING_GUIDANCE)
        self.assertNotIn('forest', LATEX_AUTHORING_GUIDANCE)
        self.assertNotIn('TikZ', LATEX_AUTHORING_GUIDANCE)
        renderer = load_renderer()
        for language, preamble in (('english', renderer.PREAMBLE_EN), ('chinese', renderer.PREAMBLE_ZH)):
            with self.subTest(language=language):
                prompt = chapter_system({'chapter_kind': 'section', 'output_format': 'latex_pdf',
                                         'output_language': language})
                self.assertIn(LATEX_AUTHORING_GUIDANCE, prompt)
                for package in ('amsmath', 'amssymb', 'bm', 'booktabs', 'array', 'tabularx',
                                'longtable', 'graphicx', 'caption', 'hyperref', 'natbib'):
                    self.assertIn(package, preamble)
                    self.assertIn(package, LATEX_AUTHORING_GUIDANCE)

    def test_latex_capabilities_reach_every_chapter_kind(self):
        for kind in ('abstract', 'section', 'component'):
            with self.subTest(kind=kind):
                prompt = chapter_system({'chapter_kind': kind, 'output_format': 'latex_pdf'})
                self.assertIn('TEMPLATE CAPABILITIES', prompt)
                self.assertIn('amsmath', prompt)
                self.assertIn('uppercase', prompt)
                self.assertNotIn('bbm', prompt)

    def test_markdown_has_no_latex_template_capabilities(self):
        prompt = chapter_system({'chapter_kind': 'section', 'output_format': 'markdown'})
        self.assertNotIn('TEMPLATE CAPABILITIES', prompt)

    def setUp(self):
        self.fixture = native.NativeTest()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
        self.ws = self.fixture.ws

    def test_only_local_test_cases_are_exported(self):
        foreign = {
            name: value.__module__
            for name, value in globals().items()
            if isinstance(value, type)
            and issubclass(value, unittest.TestCase)
            and value.__module__ != __name__
        }
        self.assertEqual(foreign, {})

    def test_terminal_packets_receive_full_corpus_and_raw_protocol(self):
        prepare(self.ws)
        p = json.loads((self.ws / "05_generation/_internal/chapter_packets/0.json").read_text())
        self.assertEqual(p["assigned_paper_ids"], ["p1"])
        self.assertNotIn("response_skeleton", p)
        self.assertIn("conditional mechanism", p["evidence"])
        self.assertEqual(len(p["confirmed_full_outline"]["outline_tree"]), 3)

    def test_dependency_cycle_rejected_before_call(self):
        outline = copy.deepcopy(self.fixture.outline)
        outline["outline_tree"][1]["depends_on"] = ["2"]
        with self.assertRaisesRegex(ValueError, "cycle"):
            compile_plan(outline, {"p1"})

    def test_figure_context_reads_completed_native_chapter(self):
        outline = self.fixture.outline
        outline["outline_tree"][0]["role"] = "foundation"
        outline["outline_tree"][0]["paper_ids"] = ["p1"]
        outline["prerequisites"] = [
            {
                "id": "P1",
                "kind": "notation",
                "requirement": "Define notation",
                "owner_section_id": "0",
            }
        ]
        outline["outline_tree"][1]["requires"] = ["P1"]
        outline["outline_tree"][1]["figures"] = [
            {
                "figure_id": "F1",
                "purpose": "Show relation",
                "content_plan": "Actual relation",
                "caption_draft": "Relation.",
                "visual_guidance": "Simple",
                "paper_ids": ["p1"],
            }
        ]
        atomic_json(self.ws / "04_outline/outline.json", outline)
        prepare(self.ws)
        self.assertEqual(context(self.ws, "F1")["status"], "WAITING")
        p = self.ws / "05_generation/chapters/0.tex"
        p.parent.mkdir(parents=True)
        p.write_text("Actual prerequisite prose.")
        result = context(self.ws, "F1")
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["sections"][0]["body_md"], "Actual prerequisite prose.")


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(PacketTest)
