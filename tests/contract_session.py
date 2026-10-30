"""Contracts for directly invoking the developer session metadata reader."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / ".agents/skills/evidence-session/scripts"


class SessionReaderTests(unittest.TestCase):
    def test_scripts_do_not_shadow_standard_library_inspect(self):
        result = subprocess.run(
            [sys.executable, "-B", "-c", "import inspect; assert callable(inspect.signature)"],
            cwd=SCRIPTS,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_direct_metadata_command_preserves_nested_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "trace.jsonl"
            source.write_text(
                json.dumps(
                    {
                        "session_id": "synthetic-session",
                        "span_id": "synthetic-span",
                        "status": "ok",
                        "attributes": {"status": "error"},
                        "body": "must-not-be-projected",
                    }
                )
                + "\n"
            )
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPTS / "metadata.py"), str(source)],
                cwd=directory,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("must-not-be-projected", result.stdout)
            self.assertIn('"status": "error"', result.stdout)
            self.assertIn('"session_id": "synthetic-session"', result.stdout)


if __name__ == "__main__":
    unittest.main()
