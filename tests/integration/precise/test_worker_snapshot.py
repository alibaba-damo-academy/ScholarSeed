"""Snapshot identifier and command rendering must be separator-independent.

Bug 87218960: on Windows the worker's own ``read-output`` pagination command could
never succeed, because ``--input`` was parsed into a ``Path`` and then validated
against a POSIX-separator literal.
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest import mock

SKILL = Path(__file__).resolve().parents[3] / "skills/community/precise-literature-search"
for _ROOT in (SKILL / "scripts", SKILL / "modules/search", SKILL / "modules/search/tools"):
    if str(_ROOT) not in sys.path:
        sys.path.insert(0, str(_ROOT))

import platform_support  # noqa: E402  # skill modules resolve only after the skill roots are on sys.path
import worker  # noqa: E402  # same reason
import worker_actions  # noqa: E402  # same reason

DIGEST = hashlib.sha256(b"synthetic snapshot payload").hexdigest()
SNAPSHOT = f"results/worker-output-{DIGEST}.json"


class PosixFormTests(unittest.TestCase):
    def test_windows_path_keeps_forward_separators(self):
        self.assertEqual(platform_support.posix_form(PureWindowsPath(SNAPSHOT)), SNAPSHOT)

    def test_posix_path_is_unchanged(self):
        self.assertEqual(platform_support.posix_form(PurePosixPath(SNAPSHOT)), SNAPSHOT)

    def test_plain_string_is_unchanged(self):
        self.assertEqual(platform_support.posix_form(SNAPSHOT), SNAPSHOT)


class SnapshotIdentifierTests(unittest.TestCase):
    """The worker emits one identifier form; every platform must accept it back."""

    def test_emitted_form_matches_the_validation_pattern(self):
        self.assertIsNotNone(worker.SNAPSHOT_PATTERN.fullmatch(SNAPSHOT))

    def test_windows_argument_form_is_accepted(self):
        # argparse with type=Path yields this on Windows for the emitted command.
        self.assertEqual(worker.snapshot_identifier(PureWindowsPath(SNAPSHOT)), SNAPSHOT)

    def test_posix_argument_form_is_accepted(self):
        self.assertEqual(worker.snapshot_identifier(PurePosixPath(SNAPSHOT)), SNAPSHOT)

    def test_string_form_is_accepted(self):
        self.assertEqual(worker.snapshot_identifier(SNAPSHOT), SNAPSHOT)

    def test_snapshot_name_is_separator_free(self):
        result = {"evidence_view": {"pool_size": 1}}
        name = worker.snapshot_name(result)
        digest = hashlib.sha256(
            json.dumps(result, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        self.assertEqual(name, f"results/worker-output-{digest}.json")
        self.assertNotIn("\\", name)

    def test_rejected_identifiers(self):
        for invalid in (
            None,
            "",
            "worker-output-" + DIGEST + ".json",
            "results/worker-output-" + DIGEST[:63] + ".json",
            "results/worker-output-" + "g" * 64 + ".json",
            "reviews/worker-output-" + DIGEST + ".json",
            "results/worker-output-" + DIGEST + ".json/extra",
            "../results/worker-output-" + DIGEST + ".json",
            "/absolute/results/worker-output-" + DIGEST + ".json",
            "C:\\absolute\\results\\worker-output-" + DIGEST + ".json",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    worker.snapshot_identifier(invalid)

    def test_rejection_names_the_expected_form(self):
        # The vague original wording made the model guess "stale snapshot" for minutes.
        with self.assertRaises(ValueError) as caught:
            worker.snapshot_identifier("results/not-a-snapshot.json")
        message = str(caught.exception)
        self.assertIn("worker-output-", message)
        self.assertIn("results/", message)

    def test_pattern_is_a_compiled_constant(self):
        self.assertIsInstance(worker.SNAPSHOT_PATTERN, re.Pattern)


class CommandDisplayTests(unittest.TestCase):
    ARGV = [
        "C:\\runtime\\python\\python.exe",
        "D:\\Program Files\\ScholarSeed\\worker.py",
        "read-output",
        "--work-dir",
        "C:\\runs\\r1\\work",
        "--input",
        SNAPSHOT,
        "--cursor",
        "1",
    ]

    def test_windows_rendering_is_directly_executable_in_powershell(self):
        with mock.patch.object(platform_support, "WINDOWS", True):
            rendered = platform_support.command_display(self.ARGV)
        self.assertTrue(rendered.startswith("& "), rendered)
        self.assertIn("'C:\\runtime\\python\\python.exe'", rendered)
        self.assertIn("'D:\\Program Files\\ScholarSeed\\worker.py'", rendered)
        self.assertIn(SNAPSHOT, rendered)

    def test_posix_rendering_is_unchanged(self):
        with mock.patch.object(platform_support, "WINDOWS", False):
            rendered = platform_support.command_display(self.ARGV)
        self.assertEqual(rendered, shlex.join([str(arg) for arg in self.ARGV]))


class ResumeRenderingTests(unittest.TestCase):
    """Resume must rebuild from argv, never re-parse a rendered command."""

    def argv(self):
        return [
            "C:\\runtime\\python\\python.exe",
            "worker.py",
            "retrieve",
            "--work-dir",
            "C:\\runs\\r1\\work",
            "--token",
            "stage_token",
            "--input",
            "retrieval-decisions.json",
        ]

    def test_resume_drops_input_and_keeps_the_call_operator(self):
        resumed = worker_actions.resume_argv(self.argv())
        self.assertNotIn("--input", resumed)
        self.assertNotIn("retrieval-decisions.json", resumed)
        with mock.patch.object(platform_support, "WINDOWS", True):
            rendered = platform_support.command_display(resumed)
        self.assertTrue(rendered.startswith("& "), rendered)
        self.assertNotIn("'&'", rendered)

    def test_resume_without_input_is_stable(self):
        argv = self.argv()
        del argv[argv.index("--input") : argv.index("--input") + 2]
        self.assertEqual(worker_actions.resume_argv(argv), argv)

    def test_guidance_emits_command_without_argv(self):
        argv = ["python", "worker.py", "context"]
        commands = {"context": {"argv": argv, "command": platform_support.command_display(argv)}}
        with tempfile.TemporaryDirectory() as temporary:
            result = worker_actions.guidance(Path(temporary), {"should_finalize": False}, commands)
        self.assertIn("context", result["next_commands"])
        self.assertEqual(result["next_commands"]["context"]["argv"], argv)
        page = worker.controls({**result, "status": "ok"})
        self.assertNotIn("argv", page["next_commands"]["context"])
        self.assertIn("command", page["next_commands"]["context"])


if __name__ == "__main__":
    unittest.main()
