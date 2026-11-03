"""Guard the filename pilot's complete import and business suite in normal CI."""

from __future__ import annotations

import io
import runpy
import sys
import unittest
from unittest.mock import patch

from .logic import SideEffectGuard, SideEffectViolation

SOURCE_MODULE = "service.literature.domain.utils"
BUSINESS_CASE_COUNT = 4


class FilenameEntryContracts(unittest.TestCase):
    def test_import_and_all_business_cases_are_guarded(self) -> None:
        output = io.StringIO()
        with SideEffectGuard():
            namespace = runpy.run_module("tests.filenames")
            self.assertEqual(namespace["paper_filename"].__module__, SOURCE_MODULE)
            suite = unittest.TestLoader().loadTestsFromTestCase(namespace["FilenameContracts"])
            result = unittest.TextTestRunner(stream=output).run(suite)
            self.assertEqual(result.testsRun, BUSINESS_CASE_COUNT)
            self.assertEqual(result.skipped, [])
            self.assertEqual(result.expectedFailures, [])
            self.assertTrue(result.wasSuccessful(), output.getvalue())


class FilenameGuardContracts(unittest.TestCase):
    PROBES = (
        ("database", 'import sqlite3\nsqlite3.connect(":memory:")'),
        ("network", "import socket\nsocket.socket()"),
        ("process", 'import subprocess, sys\nsubprocess.Popen([sys.executable, "-c", "pass"])'),
        ("write", 'import os\nwith open(os.devnull, "w"): pass'),
    )

    def test_top_level_side_effects_are_rejected(self) -> None:
        for name, source in self.PROBES:
            guard = SideEffectGuard()
            previous_bytecode = sys.dont_write_bytecode
            with self.subTest(boundary=name):
                with self.assertRaises(SideEffectViolation):
                    with guard:
                        exec(compile(source, "<filename-import-probe>", "exec"), {})
                self.assertIsNone(guard.token)
                self.assertEqual(sys.dont_write_bytecode, previous_bytecode)

    def test_late_side_effects_are_rejected(self) -> None:
        for name, source in self.PROBES:
            namespace = {}
            body = "def late_branch():\n" + "\n".join("    " + line for line in source.splitlines())
            exec(compile(body, "<filename-branch-probe>", "exec"), namespace)
            with self.subTest(boundary=name):
                with self.assertRaises(SideEffectViolation):
                    with SideEffectGuard():
                        namespace["late_branch"]()

    def test_swallowed_side_effect_is_still_a_failure(self) -> None:
        with self.assertRaises(SideEffectViolation):
            with SideEffectGuard():
                try:
                    exec('import os\nwith open(os.devnull, "w"): pass', {})
                except SideEffectViolation:
                    pass

    def test_normal_entry_rejects_import_and_business_side_effects(self) -> None:
        load_module = runpy.run_module
        for phase in ("import", "business"):
            for boundary, source in self.PROBES:
                with self.subTest(phase=phase, boundary=boundary):

                    def poisoned_module(
                        name: str, *, phase: str = phase, source: str = source
                    ) -> dict:
                        if phase == "import":
                            exec(compile(source, "<entry-import-probe>", "exec"), {})
                        namespace = load_module(name)

                        def prohibited_branch(case) -> None:
                            exec(compile(source, "<entry-business-probe>", "exec"), {})

                        namespace[
                            "FilenameContracts"
                        ].test_literal_expectations_and_unchanged_inputs = prohibited_branch
                        return namespace

                    result = unittest.TestResult()
                    with patch("runpy.run_module", side_effect=poisoned_module):
                        FilenameEntryContracts(
                            "test_import_and_all_business_cases_are_guarded"
                        ).run(result)
                    self.assertFalse(result.wasSuccessful())
                    diagnostics = "\n".join(
                        message for _, message in result.failures + result.errors
                    )
                    self.assertIn("forbidden filename logic side effect", diagnostics)


if __name__ == "__main__":
    unittest.main()
