"""Deterministic contracts for the product-owned Skill Python entry point."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.cli import serve, skill_python
from service.platform import executables
from service.platform.bridge import BRIDGE_SESSION_ENV


class SkillPythonContracts(unittest.TestCase):
    def test_cli_reexecutes_the_active_interpreter_with_exact_arguments(self) -> None:
        arguments = ["script.py", "--query", "含空格中文引号", '{"query":"quoted value"}']
        with patch.object(skill_python.os, "execv") as execute:
            self.assertEqual(skill_python.main(arguments), 0)
        execute.assert_called_once_with(
            skill_python.sys.executable,
            [skill_python.sys.executable, *arguments],
        )

    def test_cli_rejects_an_empty_invocation(self) -> None:
        with patch.object(skill_python.os, "execv") as execute:
            self.assertEqual(skill_python.main([]), 2)
        execute.assert_not_called()

    def test_managed_skill_checks_live_admission_before_exec(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            script = root / "run.py"
            script.write_text("print('run')", encoding="utf-8")
            with (
                patch.dict(os.environ, {BRIDGE_SESSION_ENV: "session"}, clear=True),
                patch.object(skill_python, "execute", return_value={"ok": True}) as admit,
                patch.object(skill_python.os, "execv") as execute,
            ):
                self.assertEqual(skill_python.main([str(script)]), 0)
                admit.assert_called_once()
                self.assertIn(str(script.resolve()), admit.call_args.args[2])
                execute.assert_called_once()

    def test_revoked_or_unreachable_admission_never_executes_skill(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            script = root / "run.py"
            script.write_text("print('run')", encoding="utf-8")
            for error in (ValueError("login_required"), OSError("bridge unavailable")):
                with (
                    self.subTest(error=str(error)),
                    patch.dict(os.environ, {BRIDGE_SESSION_ENV: "session"}, clear=True),
                    patch.object(skill_python, "execute", side_effect=error),
                    patch.object(skill_python.os, "execv") as execute,
                ):
                    self.assertEqual(skill_python.main([str(script)]), 1)
                    execute.assert_not_called()

    def test_standalone_serve_prepends_the_active_scripts_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory)
            launcher = scripts / executables.SKILL_PYTHON_COMMAND
            launcher.write_text("launcher", encoding="utf-8")
            environment = {"PATH": os.pathsep.join(("/host/bin", str(scripts), "/usr/bin"))}
            with (
                patch.dict(os.environ, environment, clear=True),
                patch.object(serve, "resolve_command", return_value=launcher),
                patch.object(serve, "scripts_directory", return_value=scripts),
            ):
                serve._ensure_skill_python_path()
                self.assertEqual(
                    os.environ["PATH"].split(os.pathsep),
                    [str(scripts), "/host/bin", "/usr/bin"],
                )

    def test_windows_resolution_accepts_cmd_launchers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory)
            launcher = scripts / f"{executables.SKILL_PYTHON_COMMAND}.cmd"
            launcher.write_text("@echo off\r\n", encoding="utf-8")
            with (
                patch.object(executables.os, "name", "nt"),
                patch.object(executables, "scripts_directory", return_value=scripts),
            ):
                self.assertEqual(
                    executables.resolve_command(executables.SKILL_PYTHON_COMMAND),
                    launcher,
                )


if __name__ == "__main__":
    unittest.main()
