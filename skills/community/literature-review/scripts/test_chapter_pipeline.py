"""Chapter packet and prerequisite behavior; native end-to-end tests are separate."""

import copy
import json
import unittest

import test_native_pipeline as native
from chapter_plan import compile_plan
from manuscript import prepare
from task_contract import atomic_json, configure
from chapter_pipeline import chapter_system
from templates import LATEX_AUTHORING_GUIDANCE
from native_document import extension
import layouts as renderer


class PacketTest(unittest.TestCase):
    def test_template_guidance_covers_both_templates_without_diagram_authoring(self):
        self.assertNotIn('diagrams', LATEX_AUTHORING_GUIDANCE)
        self.assertNotIn('forest', LATEX_AUTHORING_GUIDANCE)
        self.assertNotIn('TikZ', LATEX_AUTHORING_GUIDANCE)
        for language, preamble in (('english', renderer.PREAMBLE_EN), ('chinese', renderer.PREAMBLE_ZH)):
            with self.subTest(language=language):
                prompt = chapter_system({'chapter_kind': 'section', 'output_format': 'latex_pdf',
                                         'output_language': language})
                self.assertIn(LATEX_AUTHORING_GUIDANCE, prompt)
                for package in ('amsmath', 'amssymb', 'bm', 'booktabs', 'array', 'tabularx',
                                'longtable', 'graphicx', 'caption', 'hyperref', 'natbib'):
                    self.assertIn(package, preamble)
                    if package in ('amsmath', 'amssymb', 'bm', 'hyperref', 'natbib'):
                        self.assertIn(package, prompt)
                self.assertNotIn('tabularx', prompt)
                self.assertNotIn('CAPTION CONTENT', prompt)
                table_prompt = chapter_system({'chapter_kind': 'section', 'output_format': 'latex_pdf',
                                               'shared_tables': [{'table_id': 'T1'}]})
                self.assertIn('tabularx', table_prompt)
                self.assertIn('CAPTION CONTENT', table_prompt)

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
        self.assertIn("A bounded supported result.", p["evidence"])
        self.assertNotIn("conditional mechanism", p["evidence"])
        self.assertEqual(len(p["confirmed_full_outline"]["outline_tree"]), 3)

    def test_chapters_keep_business_evidence_without_copying_it_to_refinement(self):
        card_path = self.ws / "03_process/paper_cards.json"
        cards = json.loads(card_path.read_text())
        for card in cards.values():
            card["card"]["qualified_result"] = "21 percent on D with 40 labels; only under A"
            card["source_evidence"] = {"sentences": {"1": "LOCAL_SOURCE_SENTINEL"},
                                       "field_sources": {"card.qualified_result": [1]}}
            card["source_coverage"] = {"complete": False, "omissions": [
                {"reason": "LOCAL_REGION_SENTINEL", "page": 1}] * 100}
        atomic_json(card_path, cards)
        before = card_path.read_bytes()
        prepare(self.ws)
        paths = list((self.ws / "05_generation/_internal/chapter_packets").glob("*.json"))
        for path in paths:
            packet = json.loads(path.read_text())
            self.assertIn("21 percent on D with 40 labels; only under A", packet["evidence"])
            self.assertNotIn("LOCAL_SOURCE_SENTINEL", packet["evidence"])
            self.assertNotIn("LOCAL_REGION_SENTINEL", packet["evidence"])
            self.assertNotIn("Some original content was unavailable.", packet["evidence"])
        contract = json.loads((self.ws / "05_generation/_internal/manuscript_contract.json").read_text())
        self.assertNotIn("evidence", contract)
        self.assertNotIn("writing_evidence", contract)
        self.assertEqual(card_path.read_bytes(), before)

    def test_retired_dependency_fields_rejected_before_call(self):
        outline = copy.deepcopy(self.fixture.outline)
        outline["outline_tree"][1]["depends_on"] = ["2"]
        with self.assertRaisesRegex(ValueError, "retired"):
            compile_plan(outline, {"p1"})





def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(PacketTest)
