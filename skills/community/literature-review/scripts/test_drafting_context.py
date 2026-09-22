#!/usr/bin/env scholarseed-skill-python
"""Regression tests for section-local drafting evidence and insight contracts."""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
GEN_FAST = ROOT / "scripts" / "generation" / "_fast"
DRAFT_FAST = ROOT / "scripts" / "generation" / "drafting" / "_fast"
sys.path.insert(0, str(GEN_FAST))
sys.path.insert(0, str(DRAFT_FAST))

from _utils import Workspace, format_paper_card_nested  # noqa: E402
from collect_drafting_worklist import (  # noqa: E402
    _build_evidence_overview,
    _insight_contract,
)


class DraftingEvidenceTest(unittest.TestCase):
    def test_every_selected_paper_card_value_survives_without_limits(self) -> None:
        formulas = [f"$f_{i}=" + ("x" * 600) + "$ — variables" for i in range(8)]
        claims = [f"claim {i}: " + ("c" * 500) for i in range(8)]
        card = {
            "title": "A method paper",
            "paper_type": "method",
            "abstract": "a" * 900,
            "common_fields": {
                "core_contribution": "A contribution",
                "claims": claims,
            },
            "card": {
                "method": {
                    "name": "Method",
                    "description": "d" * 700,
                    "key_components": ["encoder", "policy"],
                    "key_formulas": formulas,
                    "novelty": "new",
                    "implementation_secret": "must not reach the writer",
                },
                "experiments": {
                    "datasets": ["D"],
                    "baselines": ["B"],
                    "metrics": ["M"],
                    "ablation_findings": "Removing the policy hurts.",
                },
                "raw_appendix": "must not reach the writer",
            },
        }

        out = format_paper_card_nested(card, {}, depth="drafting", scope="speed")
        method = out["card"]["method"]
        self.assertEqual(out["abstract"], "a" * 900)
        self.assertEqual(out["common_fields"]["claims"], claims)
        self.assertEqual(method["key_formulas"], formulas)
        self.assertEqual(method["description"], "d" * 700)
        self.assertEqual(method["key_components"], ["encoder", "policy"])
        self.assertNotIn("implementation_secret", method)
        self.assertEqual(
            out["card"]["experiments"]["ablation_findings"],
            "Removing the policy hurts.",
        )
        self.assertNotIn("raw_appendix", out["card"])

    def test_survey_theory_and_benchmark_evidence_reaches_writer(self) -> None:
        card = {
            "title": "Mixed evidence fixture",
            "card": {
                "summary": {
                    "scope": "solver learning",
                    "taxonomy": "solver component",
                    "key_themes": ["branching", "cuts"],
                    "total_papers_reviewed": "42",
                },
                "analysis": {
                    "trends": "more online learning",
                    "comparisons": "Prior review A omits cut deletion.",
                    "open_problems": ["transfer"],
                },
                "survey_outline": {
                    "sections": [{"title": "Introduction"}, {"title": "Methods"}]
                },
                "theorem_proof": {
                    "main_results": ["A finite-sample bound"],
                    "key_assumptions": ["bounded coefficients"],
                    "key_formulas": ["$R_n \\le C/\\sqrt{n}$ — variables"],
                    "proof_technique": "covering numbers",
                    "formal_guarantees": "generalization bound",
                },
                "implication": {
                    "theoretical_impact": "connects capacity and branching",
                    "practical_implications": "limits transfer claims",
                    "connections": "statistical learning theory",
                },
                "dataset": {
                    "name": "Bench",
                    "description": "diverse MIPs",
                    "size": "1000",
                    "source": "public",
                    "splits": "train/validation/test",
                },
                "metrics": {
                    "primary_metrics": ["wall-clock time"],
                    "evaluation_protocol": "same solver and time limit",
                },
            },
        }

        out = format_paper_card_nested(card, {}, depth="drafting", scope="deep")
        inner = out["card"]
        self.assertEqual(inner["analysis"]["comparisons"],
                         "Prior review A omits cut deletion.")
        self.assertEqual(len(inner["survey_outline"]["sections"]), 2)
        self.assertIn("key_formulas", inner["theorem_proof"])
        self.assertEqual(inner["dataset"]["splits"], "train/validation/test")
        self.assertEqual(
            inner["metrics"]["evaluation_protocol"],
            "same solver and time limit",
        )


class InsightContractTest(unittest.TestCase):
    def test_speed_and_deep_receive_the_same_required_contract(self) -> None:
        speed = _insight_contract("speed", "english")
        deep = _insight_contract("deep", "english")
        self.assertEqual(speed, deep)
        self.assertEqual(speed[0], "required")
        self.assertTrue(speed[1])

    def test_chinese_contract_is_also_required(self) -> None:
        requirement, definition = _insight_contract("speed", "chinese")
        self.assertEqual(requirement, "required")
        self.assertIn("洞察", definition)


class EvidenceOverviewTest(unittest.TestCase):
    def test_compact_search_and_corpus_context_is_available_to_writers(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ws = Workspace(temp_dir)
            ws.process.mkdir(parents=True)
            ws.retrieval.mkdir(parents=True)
            (ws.process / "corpus_summary.json").write_text(json.dumps({
                "total_papers": 40,
                "fulltext_coverage": 0.775,
                "by_year": {"2024": 4},
                "by_paper_type": {"survey": 2, "method": 38},
            }))
            (ws.retrieval / "retrieval_report.json").write_text(json.dumps({
                "output_count": 40,
                "screens_applied": ["topic exclusion"],
                "degradations": ["nine abstract-only papers"],
                "search_summary": {
                    "query": "find solver-learning literature",
                    "total_rounds": 4,
                    "total_queries": 75,
                    "pool_size": 423,
                    "selected_count": 40,
                    "subtopics": ["branching", "cuts"],
                    "coverage_assessment": "strong except interpretability",
                },
            }))

            overview = _build_evidence_overview(ws)

        self.assertEqual(overview["corpus_size"], 40)
        self.assertEqual(overview["fulltext_coverage"], 0.775)
        self.assertEqual(overview["search"]["candidate_pool_size"], 423)
        self.assertEqual(overview["search"]["selected_count"], 40)
        self.assertEqual(overview["search"]["subtopics"], ["branching", "cuts"])
        self.assertEqual(overview["screens_applied"], ["topic exclusion"])


if __name__ == "__main__":
    unittest.main()
