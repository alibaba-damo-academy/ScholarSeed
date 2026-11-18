"""Model-facing context projections preserve science, not execution bookkeeping."""

import copy
import json
import unittest

from authoring import abstract_card, authoring_task, context_message
from chapter_pipeline import chapter_messages
from figure_authoring import authoring_packet
from quick import draft_messages


class ContextTest(unittest.TestCase):
    def test_task_keeps_requirements_but_not_execution_bookkeeping(self):
        task = {
            "original_user_requests": ["Only compare the supplied papers since 2023."],
            "effective_requirements": "Compare mechanisms, not complete research systems.",
            "constraints": [
                {
                    "kind": "excluded_topic",
                    "value": "End-to-end science",
                    "verbatim": "not complete systems",
                    "enforcement": {"mode": "validator"},
                }
            ],
            "sources": {"policy": "provided_only", "refs": ["literature:private-id"]},
            "execution": {"budget_seconds": 2400, "confirmation": "timeout_auto"},
            "query_settings": {"query": "Duplicate query", "time_range": {"start_year": 2023}},
            "section_instructions": {"1": "Retain assumptions"},
        }
        before = copy.deepcopy(task)
        view = authoring_task(task)
        self.assertNotIn("execution", view)
        self.assertNotIn("query_settings", view)
        self.assertNotIn("private-id", json.dumps(view))
        self.assertNotIn("enforcement", json.dumps(view))
        self.assertEqual(view["sources"], {"policy": "provided_only"})
        self.assertEqual(view["research_scope"]["time_range"], {"start_year": 2023})
        self.assertEqual(view["original_user_requests"], task["original_user_requests"])
        self.assertEqual(view["section_instructions"], task["section_instructions"])
        self.assertEqual(task, before)

    def test_long_material_is_not_a_json_string(self):
        text = 'Quoted "finding"\nFormula \\alpha < 1'
        message = context_message({"language": "chinese"}, text)
        self.assertIn(text, message)
        self.assertNotIn('\\"finding\\"', message)

    def test_chapter_plan_and_assets_have_one_complete_representation(self):
        table = {
            "table_id": "T1",
            "section_id": "1.1",
            "label": "tab:T1",
            "purpose": "UNIQUE_ASSET_PURPOSE",
            "content_plan": "Only under condition A",
            "caption_draft": "Supported comparison",
            "comparison_dimensions": ["Mechanism"],
        }
        node = {
            "section_id": "1",
            "title": "Methods",
            "description": "UNIQUE_CHAPTER_PURPOSE",
            "subsections": [{"section_id": "1.1", "title": "Compare", "tables": [table]}],
        }
        packet = {
            "chapter_ids": ["1"],
            "chapter_kind": "section",
            "chapter_opening": "## Methods\n",
            "task": {"execution": {"budget_seconds": 2400}},
            "confirmed_full_outline": {"survey_title": "Review", "outline_tree": [node]},
            "assigned_sections": [node],
            "shared_tables": [table],
            "shared_figures": [],
            "document_asset_assignments": [{"asset_id": "T2", "section_id": "2",
                                             "section_title": "Synthesis"}],
            "evidence": 'A "supported" claim\nwith \\alpha',
        }
        before = copy.deepcopy(packet)
        messages = chapter_messages(packet)
        content = messages[1]["content"]
        self.assertEqual(content.count("UNIQUE_CHAPTER_PURPOSE"), 1)
        self.assertEqual(content.count("UNIQUE_ASSET_PURPOSE"), 1)
        self.assertIn("Only under condition A", content)
        self.assertIn(packet["evidence"], content)
        self.assertNotIn("confirmed_full_outline", content)
        self.assertNotIn("completed_dependency_sections", content)
        self.assertIn('"document_asset_assignments"', content)
        self.assertIn('"section_title": "Synthesis"', content)
        self.assertEqual(packet, before)

    def test_abstract_views_preserve_results_and_conditions_by_paper_type(self):
        cases = {
            "method": {
                "experiments": {
                    "key_results": "Gains only on D under budget B",
                    "results": ["PER_DATASET_DETAIL"],
                    "conditions": ["Budget B"],
                },
                "method": {"description": "DETAILED_MECHANISM", "assumptions": ["Assumption Z"]},
                "conclusion": "Conditional gain",
            },
            "benchmark": {
                "experiments": {"key_findings": ["Weakness under C"]},
                "metrics": {"evaluation_protocol": "Condition C"},
                "dataset": {"name": "D", "splits": "DETAILED_SPLITS"},
            },
            "survey": {
                "analysis": {"trends": ["Trend under C"], "open_problems": ["DETAIL"]},
                "summary": {"scope": "Scope C", "taxonomy": "DETAILED_TAXONOMY"},
            },
            "theory": {
                "theorem_proof": {
                    "main_results": ["Bound under A"],
                    "key_assumptions": ["A"],
                    "proof_technique": "DETAILED_PROOF",
                }
            },
        }
        for kind, card in cases.items():
            with self.subTest(kind=kind):
                record = {
                    "title": kind,
                    "paper_type": kind,
                    "abstract": "RAW_ABSTRACT",
                    "card": card,
                    "common_fields": {
                        "core_contribution": "CORE",
                        "tldr": "REDUNDANT_TLDR",
                        "limitations": ["Author-stated limit"],
                    },
                }
                before = copy.deepcopy(record)
                view = abstract_card(record)
                text = json.dumps(view)
                self.assertIn("CORE", text)
                self.assertIn("Author-stated limit", text)
                self.assertNotIn("RAW_ABSTRACT", text)
                self.assertNotIn("REDUNDANT_TLDR", text)
                self.assertNotIn("DETAILED_", text)
                self.assertNotIn("PER_DATASET_DETAIL", text)
                self.assertEqual(record, before)
                if kind == "theory":
                    self.assertEqual(view["card"]["theorem_proof"]["key_assumptions"], ["A"])
                if kind == "method":
                    self.assertEqual(view["card"]["method"]["assumptions"], ["Assumption Z"])

    def test_abstract_falls_back_to_original_abstract_without_invention(self):
        record = {"title": "Sparse paper", "abstract": "Only supported evidence"}
        self.assertEqual(abstract_card(record)["abstract"], record["abstract"])

    def test_figure_packet_does_not_duplicate_shared_rules_or_choose_image_mode(self):
        item = {
            "figure_id": "F2",
            "section_id": "1",
            "cite_keys": ["Key"],
            "purpose": "Retain every relationship",
            "language": "chinese",
        }
        packet = authoring_packet(item, "evidence.json", "preparation")
        for field in ("task", "prompt_guidance", "caption_guidance"):
            self.assertNotIn(field, packet)
        self.assertNotIn("_render_mode", packet["output"])
        self.assertNotIn("_image_size", packet["output"])
        self.assertEqual(packet["figure"]["purpose"], item["purpose"])

    def test_quick_abstracts_are_raw_and_complete_tokens_are_the_only_identity(self):
        abstract = 'An "observed" finding\nonly under A with \\alpha < 1.'
        packet = {
            "task": {"original_user_requests": ["Compare only supplied papers."]},
            "papers": [
                {
                    "cite_key": "Key2024",
                    "title": "Paper",
                    "year": 2024,
                    "authors": ["UNNEEDED_AUTHOR"],
                    "abstract": abstract,
                }
            ],
        }
        before = copy.deepcopy(packet)
        messages = draft_messages(packet)
        self.assertIn(abstract, messages[1]["content"])
        self.assertNotIn("UNNEEDED_AUTHOR", str(messages))
        self.assertIn(r"citation_token: \cite{Key2024}", messages[1]["content"])
        self.assertNotIn("allowed_cite_keys", messages[1]["content"])
        self.assertEqual(packet, before)
