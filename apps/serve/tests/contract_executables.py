"""Real process contracts for noninteractive launcher probes."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from service.platform import executables


class CommandProbeContracts(unittest.TestCase):
    def test_skill_python_cold_start_can_exceed_generic_command_deadline(self) -> None:
        with (
            patch.object(executables, "resolve_command", return_value=Path(sys.executable)),
            patch.object(
                executables, "SKILL_PYTHON_PROBE_ARGUMENTS", ("-c", "import time; time.sleep(6)")
            ),
        ):
            self.assertEqual(executables.skill_python_probe([str(Path.cwd())]), 0)

    def test_probe_does_not_read_parent_control_stdin(self) -> None:
        # Keep the host's stdin pipe open, as Desktop does for parent control.
        code = (
            "import sys; from pathlib import Path; "
            "from service.platform.executables import probe_command; "
            "sys.exit(0 if probe_command(Path(sys.executable), "
            "('-c', 'import sys; assert sys.stdin.buffer.read() == b\\\"\\\"')) else 1)"
        )
        with subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE) as host:
            try:
                self.assertEqual(host.wait(timeout=8), 0)
            finally:
                if host.poll() is None:
                    host.kill()

    def test_skill_python_deadline_exhaustion_still_fails(self) -> None:
        with (
            patch.object(executables, "resolve_command", return_value=Path(sys.executable)),
            patch.object(executables, "SKILL_PYTHON_PROBE_TIMEOUT_SECONDS", 0.1),
            patch.object(
                executables, "SKILL_PYTHON_PROBE_ARGUMENTS", ("-c", "import time; time.sleep(6)")
            ),
            self.assertLogs(executables.__name__, level="WARNING") as logs,
        ):
            self.assertEqual(executables.skill_python_probe([str(Path.cwd())]), 1)
        self.assertIn("TimeoutExpired", "\n".join(logs.output))

    def test_timeout_does_not_wait_for_descendant_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            finished = Path(folder) / "finished"
            descendant = (
                "import time; from pathlib import Path; time.sleep(3); "
                f"Path({str(finished)!r}).touch()"
            )
            wrapper = (
                "import subprocess,sys,time; "
                f"subprocess.Popen([sys.executable, '-c', {descendant!r}]); "
                "time.sleep(30)"
            )
            try:
                with patch.object(executables, "COMMAND_PROBE_TIMEOUT_SECONDS", 1):
                    started = time.monotonic()
                    self.assertFalse(
                        executables.probe_command(Path(sys.executable), ("-c", wrapper))
                    )
                    self.assertLess(time.monotonic() - started, 2.5)
            finally:
                # The fixture's descendant finishes naturally; do not leave it behind.
                deadline = time.monotonic() + 5
                while not finished.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(finished.exists())

    def test_exit_status_and_bounded_diagnostics(self) -> None:
        self.assertTrue(executables.probe_command(Path(sys.executable), ("--version",)))
        with self.assertLogs(executables.__name__, level="WARNING") as logs:
            self.assertFalse(
                executables.probe_command(
                    Path(sys.executable),
                    (
                        "-c",
                        "import sys; sys.stderr.write('discarded beginning' + 'x' * 10000 "
                        "+ 'RuntimeError: launcher failure'); sys.exit(7)",
                    ),
                )
            )
        self.assertIn("exited with code 7", logs.output[0])
        self.assertIn("stderr_truncated=True", logs.output[0])
        self.assertIn("RuntimeError: launcher failure", logs.output[0])
        self.assertNotIn("discarded beginning", logs.output[0])
        self.assertEqual(
            len(logs.output[0].split("stderr=", 1)[1]), executables.COMMAND_PROBE_ERROR_LIMIT
        )
        self.assertFalse(executables.probe_command(Path(os.devnull) / "missing"))


if __name__ == "__main__":
    unittest.main()
