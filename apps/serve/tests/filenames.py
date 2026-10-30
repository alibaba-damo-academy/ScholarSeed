"""Filename business cases executed only by the guarded contract entry."""

from __future__ import annotations

import re
import unittest
from unittest.mock import patch

from service.literature.domain.utils import paper_filename


class FilenameContracts(unittest.TestCase):
    def test_literal_expectations_and_unchanged_inputs(self) -> None:
        cases = (
            ("plain", "Paper subfolder", "subfolder", "Paper subfolder [subfolder].pdf"),
            ("separator", "A/B: C", "doi:1/2", "A_B_ C [doi_1_2].pdf"),
            ("empty", " . ", "p/1", "p_1 [p_1].pdf"),
            ("unicode", "中文论文", "p1", "中文论文 [p1].pdf"),
            ("controls", "A\x00B\nC", "p?1", "A_B_C [p_1].pdf"),
            ("trim", " ..Title. ", "p1", "Title [p1].pdf"),
        )
        for identity, title, paper_id, expected in cases:
            with self.subTest(case=identity):
                paper = {"title": title, "paper_id": paper_id}
                before = paper.copy()
                self.assertEqual(paper_filename(paper), expected)
                self.assertEqual(paper, before)

    def test_title_and_identity_limits_independently(self) -> None:
        paper = {"title": "A" * 101, "paper_id": "B" * 101}
        self.assertEqual(paper_filename(paper), "A" * 100 + " [" + "B" * 100 + "].pdf")

    def test_literal_oracle_rejects_an_incorrect_sanitizer(self) -> None:
        result = unittest.TestResult()
        with patch("service.literature.domain.utils.SAFE_FILENAME", re.compile(r"(?!x)x")):
            FilenameContracts("test_literal_expectations_and_unchanged_inputs").run(result)
        self.assertGreater(len(result.failures), 0)
        self.assertEqual(result.errors, [])

    def test_storage_network_process_and_write_boundaries_are_unused(self) -> None:
        with (
            patch("sqlite3.connect", side_effect=AssertionError("unexpected database")),
            patch("socket.socket", side_effect=AssertionError("unexpected network")),
            patch("subprocess.Popen", side_effect=AssertionError("unexpected process")),
            patch("builtins.open", side_effect=AssertionError("unexpected file access")),
            patch("io.open", side_effect=AssertionError("unexpected file access")),
        ):
            self.assertEqual(
                paper_filename({"title": "A/B: C", "paper_id": "doi:1/2"}),
                "A_B_ C [doi_1_2].pdf",
            )
