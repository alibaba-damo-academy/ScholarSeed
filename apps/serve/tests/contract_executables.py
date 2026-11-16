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
            ready = Path(folder) / "ready"
            release = Path(folder) / "release"
            finished = Path(folder) / "finished"
            wrapper_process = None
            started = None
            popen = subprocess.Popen
            descendant = (
                "import sys,time; from pathlib import Path; "
                "sys.stderr.write('descendant ready\\n'); sys.stderr.flush(); "
                f"Path({str(ready)!r}).touch(); "
                f"release = Path({str(release)!r}); "
                "deadline = time.monotonic() + 5; "
                "exec('while not release.exists() and time.monotonic() < deadline: time.sleep(0.01)'); "
                f"Path({str(finished)!r}).touch()"
            )
            wrapper = (
                "import subprocess,sys,time; "
                f"subprocess.Popen([sys.executable, '-c', {descendant!r}]); "
                "time.sleep(30)"
            )

            def ready_process(*args, **kwargs):
                nonlocal wrapper_process, started
                wrapper_process = popen(*args, **kwargs)
                # subprocess.run starts its timeout after Popen returns. Wait
                # for the real inherited stderr before measuring that timeout.
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    self.assertIsNone(wrapper_process.poll())
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "stderr fixture did not become ready")
                started = time.monotonic()
                return wrapper_process

            try:
                with (
                    patch.object(executables, "COMMAND_PROBE_TIMEOUT_SECONDS", 1),
                    patch.object(executables.subprocess, "Popen", side_effect=ready_process),
                ):
                    self.assertFalse(
                        executables.probe_command(Path(sys.executable), ("-c", wrapper))
                    )
                    self.assertIsNotNone(started)
                    self.assertLess(time.monotonic() - started, 2.5)
                    self.assertFalse(finished.exists())
            finally:
                release.touch()
                if wrapper_process is not None:
                    if wrapper_process.poll() is None:
                        wrapper_process.kill()
                    wrapper_process.wait()
                if ready.exists():
                    deadline = time.monotonic() + 5
                    while not finished.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(finished.exists(), "stderr fixture did not finish")

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
