"""Pagination instruction and sentinel contracts, not product acceptance."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills/community/precise-literature-search"


class PaginationLifecycleTests(unittest.TestCase):
    def test_argument_failure_is_terminal_json_without_state_access(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pagination-arguments-") as directory:
            home = Path(directory) / "unused-home"
            environment = {**os.environ, "SCHOLARSEED_HOME": str(home)}
            for arguments in (
                ["read-output", "--cursor"],
                [
                    "read-output",
                    "--work-dir",
                    directory,
                    "--token",
                    "test-stage-token",
                    "--cursor",
                    "None",
                ],
            ):
                with self.subTest(arguments=arguments):
                    result = subprocess.run(
                        [sys.executable, str(SKILL / "modules/search/worker.py"), *arguments],
                        cwd=directory,
                        env=environment,
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 2)
                    response = json.loads(result.stdout)
                    self.assertEqual(response["status"], "error")
                    self.assertEqual(response["error"]["code"], "invalid_arguments")
                    self.assertFalse(response["error"]["retryable"])
                    self.assertIsNone(response["next_cursor"])
                    self.assertIsNone(response["next_command"])
                    self.assertEqual(response["records"], [])
                    self.assertNotIn("test-stage-token", result.stdout + result.stderr)
                    self.assertFalse(home.exists())

    def test_skill_and_plugin_versions_match(self) -> None:
        expected = (SKILL / "VERSION").read_text(encoding="utf-8").strip()
        descriptor = json.loads((SKILL / ".scholarseed-plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(descriptor["version"], expected)
        manifest = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        version = next(line for line in manifest.splitlines() if line.startswith("version:"))
        self.assertEqual(version.split(":", 1)[1].strip().strip('"'), expected)

    def test_guidance_preserves_terminal_and_failure_boundaries(self) -> None:
        guidance = (SKILL / "modules/search/BALANCE_AGENT.md").read_text(encoding="utf-8")
        for requirement in (
            "one returned `next_command` at a time",
            "Do not write shell pagination loops",
            "Python prints JSON null as `None`",
            "Stop on a failed command or invalid JSON",
            "confirm its exit before declaring the search finished",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, guidance)

    def test_string_sentinel_keeps_running_after_json_null(self) -> None:
        self.assertEqual(str(json.loads("null")), "None")
        program = (
            "import json\ncursor = '16'\nwhile cursor != 'null':\n cursor = str(json.loads('null'))"
        )
        with tempfile.TemporaryDirectory(prefix="pagination-sentinel-") as directory:
            with self.assertRaises(subprocess.TimeoutExpired):
                subprocess.run(
                    [sys.executable, "-c", program], cwd=directory, timeout=1, check=True
                )


if __name__ == "__main__":
    unittest.main()
