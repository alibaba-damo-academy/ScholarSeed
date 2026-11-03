"""Candidate report presentation preserves internal selection identities."""

from __future__ import annotations

import copy
import unittest

from finalize import _result_summary, render_report


class PresentationTests(unittest.TestCase):
    def test_group_counts_and_global_numbers_preserve_selection(self):
        papers = [
            {"id": "second", "title": "Expansion", "tier": 2},
            {"id": "first", "title": "Core", "tier": 1},
            {"id": "third", "title": "Reference", "tier": 3},
            {"id": "fourth", "title": "Another core", "tier": 1},
        ]
        original = copy.deepcopy(papers)
        summary = _result_summary(papers, "Coverage remains uncertain.")
        report = render_report({}, {}, {}, {"papers": papers, "result_summary": summary}, "")
        headings = [line for line in report.splitlines() if line.startswith("### ")]
        self.assertEqual(
            headings,
            [
                "### 1. Core",
                "### 2. Another core",
                "### 3. Expansion",
                "### 4. Reference",
            ],
        )
        for label, count in (
            ("Core matches / 核心相关", 2),
            ("Broader matches / 拓展相关", 1),
            ("Supporting references / 补充参考", 1),
        ):
            self.assertIn(f"## {label} ({count})", report)
            self.assertIn(f"{label}: {count}", summary)
        self.assertNotIn("Tier", report)
        self.assertIn("Full texts not read / 未读取原文", summary)
        self.assertEqual(papers, original)

    def test_empty_groups_do_not_consume_paper_numbers(self):
        papers = [{"id": "only", "title": "Reference", "tier": 3}]
        report = render_report({}, {}, {}, {"papers": papers}, "")
        self.assertIn("## Core matches / 核心相关 (0)", report)
        self.assertIn("### 1. Reference", report)
        self.assertNotIn("### 2.", report)

    def test_empty_results_do_not_claim_fulltext_verification(self):
        summary = _result_summary([], "")
        report = render_report({}, {}, {}, {"papers": [], "result_summary": summary}, "")
        self.assertIn("No eligible candidate papers", summary)
        self.assertNotIn("### ", report)
        self.assertNotIn("Tier", report)
