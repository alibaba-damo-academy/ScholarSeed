"""Real-interpreter contracts for cwd-owned task Python environments."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scholarseed_runtime.contract import LaunchSecretScope
from service.chat.runtime.secrets import _launch_secret_contract
from service.platform.executables import BRIDGE_DIR_ENV, command_directories
from service.platform.python import prepare_commands, prepare_environment, task_environment
from service.platform.storage import filesystem_path, open_directory

PROBE = (
    "import json,sys,site; print(json.dumps([sys.prefix,sys.base_prefix,site.ENABLE_USER_SITE]))"
)


def command(environment: dict[str, str], *arguments: str) -> list[str] | str:
    invocation = [environment["SCHOLARSEED_TASK_PYTHON"], *arguments]
    if os.name == "nt":
        return f'{subprocess.list2cmdline([os.environ["COMSPEC"]])} /d /s /c "{subprocess.list2cmdline(invocation)}"'
    return invocation


class TaskPythonContracts(unittest.TestCase):
    def test_deep_unicode_directory_executes_real_task_python(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory).joinpath(*(["long-path-" * 5] * 5), "中文 directory")
            cwd.mkdir(parents=True)
            prepare_commands(cwd)
            try:
                prepare_environment(cwd)
            except subprocess.CalledProcessError as error:
                self.fail((error.stderr or error.stdout).decode("utf-8", errors="replace"))
            environment = task_environment(cwd)
            result = subprocess.run(
                command(environment, "-c", PROBE),
                env=environment,
                cwd=directory,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            prefix, _base, user_site = json.loads(result.stdout)
            self.assertEqual(filesystem_path(prefix), filesystem_path(environment["VIRTUAL_ENV"]))
            self.assertFalse(user_site)

    def test_task_launcher_discovery_does_not_trust_inherited_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"PATH": directory, BRIDGE_DIR_ENV: ""}):
                self.assertNotIn(Path(directory), command_directories(inherit_path=False))

    def test_pip_commands_fail_closed_while_another_installer_holds_the_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            prepare_commands(cwd)
            prepare_environment(cwd)
            environment = task_environment(cwd)
            parent = Path(environment["VIRTUAL_ENV"]).parent
            with closing(open_directory(parent, ())) as handle:
                with handle.arbitration("install.lock"):
                    result = subprocess.run(
                        command(environment, "-m", "pip", "--version"),
                        env=environment,
                        cwd=cwd,
                        capture_output=True,
                        text=True,
                        check=False,
                        timeout=30,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Task Python unavailable", result.stderr)

    def test_first_command_lazily_creates_bound_environment_after_shell_cd(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd = root / "中文 directory"
            elsewhere = root / "elsewhere"
            cwd.mkdir()
            elsewhere.mkdir()
            prepare_commands(cwd)
            environment = task_environment(cwd)
            self.assertFalse(Path(environment["VIRTUAL_ENV"]).exists())
            result = subprocess.run(
                command(environment, "-c", PROBE),
                env=environment,
                cwd=elsewhere,
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
            prefix, base, user_site = json.loads(result.stdout)
            self.assertEqual(filesystem_path(prefix), filesystem_path(environment["VIRTUAL_ENV"]))
            self.assertNotEqual(prefix, base)
            self.assertFalse(user_site)
            self.assertFalse((elsewhere / ".scholarseed").exists())

    def test_backend_prepares_only_aliases_not_a_privileged_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            with patch("service.platform.python.venv.EnvBuilder.create") as create:
                prepare_commands(cwd)
                create.assert_not_called()
            self.assertFalse(Path(task_environment(cwd)["VIRTUAL_ENV"]).exists())

    def test_product_executable_directories_are_removed_from_task_path(self) -> None:
        product_bin = str(Path(sys.executable).parent)
        environment = task_environment(
            Path.cwd(), {"PATH": os.pathsep.join((product_bin, os.defpath))}
        )
        self.assertNotIn(product_bin, environment["PATH"].split(os.pathsep)[1:])

    def test_offline_install_changes_only_one_cwd_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            prepare_environment(first)
            prepare_environment(second)
            prepare_commands(first)
            prepare_commands(second)
            wheel = root / "cwd_isolation_probe-0.0.1-py3-none-any.whl"
            metadata = "cwd_isolation_probe-0.0.1.dist-info"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("cwd_isolation_probe.py", "VALUE = True\n")
                archive.writestr(
                    f"{metadata}/METADATA",
                    "Metadata-Version: 2.1\nName: cwd-isolation-probe\nVersion: 0.0.1\n",
                )
                archive.writestr(
                    f"{metadata}/WHEEL",
                    "Wheel-Version: 1.0\nGenerator: contract\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
                )
                archive.writestr(f"{metadata}/RECORD", "")
            first_environment = task_environment(first)
            subprocess.run(
                command(
                    first_environment, "-m", "pip", "install", "--no-index", "--no-deps", str(wheel)
                ),
                env=first_environment,
                cwd=first,
                check=True,
                capture_output=True,
                timeout=30,
            )
            probe = "import importlib.util,sys; sys.exit(importlib.util.find_spec('cwd_isolation_probe') is None)"
            for cwd, expected in ((first, 0), (second, 1)):
                environment = task_environment(cwd)
                result = subprocess.run(
                    command(environment, "-c", probe),
                    env=environment,
                    cwd=cwd,
                    check=False,
                    timeout=30,
                )
                self.assertEqual(result.returncode, expected)
            result = subprocess.run([sys.executable, "-I", "-c", probe], check=False, timeout=30)
            self.assertEqual(result.returncode, 1)

    def test_session_environment_is_tool_scoped_and_inspections_remain_read_only(self) -> None:
        cwd = Path.cwd()
        inspected, _port = _launch_secret_contract({"PRODUCT_KEY": "secret"})
        self.assertFalse(any(row.scope is LaunchSecretScope.TOOL for row in inspected.bindings))
        launched, port = _launch_secret_contract({"PRODUCT_KEY": "secret"}, cwd=cwd)
        process_names = {
            row.name for row in launched.bindings if row.scope is LaunchSecretScope.PROCESS
        }
        tool_names = {row.name for row in launched.bindings if row.scope is LaunchSecretScope.TOOL}
        self.assertEqual(process_names, {"PRODUCT_KEY"})
        self.assertIn("SCHOLARSEED_TASK_PYTHON", tool_names)
        self.assertIn("VIRTUAL_ENV", tool_names)
        self.assertIsNotNone(port)

    def test_real_environment_is_bound_to_cwd_not_product_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            original = cwd / ".venv"
            original.mkdir()
            sentinel = original / "user.txt"
            sentinel.write_text("preserved", encoding="utf-8")
            prepare_environment(cwd)
            prepare_commands(cwd)
            environment = task_environment(cwd)
            result = subprocess.run(
                command(environment, "-c", PROBE),
                env=environment,
                cwd=cwd,
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
            prefix, base, user_site = json.loads(result.stdout)
            self.assertEqual(filesystem_path(prefix), filesystem_path(environment["VIRTUAL_ENV"]))
            self.assertNotEqual(prefix, sys.prefix)
            self.assertNotEqual(prefix, base)
            self.assertFalse(user_site)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserved")
            executable = Path(environment["SCHOLARSEED_TASK_PYTHON"])
            identity = executable.stat()
            prepare_environment(cwd)
            self.assertEqual(executable.stat(), identity)

    def test_environments_follow_cwd_and_preserve_parent_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first"
            second = Path(directory) / "中文 directory"
            inherited = {
                "PATH": os.defpath,
                "PYTHONPATH": "/product/pylibs",
                "PYTHONHOME": "/product/python",
                "PIP_TARGET": "/product/python/packages",
                "PIP_PREFIX": "/product/python",
                "PIP_USER": "1",
                "VIRTUAL_ENV": "/product/python",
                "HTTP_PROXY": "http://proxy.invalid",
            }
            original = dict(inherited)
            first_environment = task_environment(first, inherited)
            second_environment = task_environment(second, inherited)
            self.assertNotEqual(first_environment["VIRTUAL_ENV"], second_environment["VIRTUAL_ENV"])
            self.assertEqual(inherited, original)
            self.assertEqual(first_environment["PIP_REQUIRE_VIRTUALENV"], "1")
            self.assertEqual(first_environment["PYTHONNOUSERSITE"], "1")
            self.assertEqual(first_environment["HTTP_PROXY"], inherited["HTTP_PROXY"])
            self.assertFalse(first_environment.get("PYTHONPATH"))
            self.assertFalse(first_environment.get("PYTHONHOME"))
            self.assertFalse(first_environment.get("PIP_TARGET"))
            self.assertFalse(first_environment.get("PIP_PREFIX"))
            self.assertEqual(first_environment["PIP_USER"], "0")

    def test_windows_aliases_and_nonportable_names_do_not_duplicate_overrides(self) -> None:
        environment = task_environment(
            Path.cwd(),
            {
                "Path": os.defpath,
                "pip_user": "1",
                "PythonPath": "product",
                "ProgramFiles(x86)": "tools",
            },
        )
        self.assertNotIn("Path", environment)
        self.assertNotIn("pip_user", environment)
        self.assertNotIn("PythonPath", environment)
        self.assertNotIn("ProgramFiles(x86)", environment)
        self.assertEqual(environment["PIP_USER"], "0")

    def test_rejects_modified_config_without_rebuilding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            prepare_environment(cwd)
            configuration = Path(task_environment(cwd)["VIRTUAL_ENV"]) / "pyvenv.cfg"
            original = configuration.read_text(encoding="utf-8")
            configuration.write_text(
                original.replace(
                    "include-system-site-packages = false", "include-system-site-packages = true"
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "invalid"):
                prepare_environment(cwd)
            self.assertIn(
                "include-system-site-packages = true", configuration.read_text(encoding="utf-8")
            )

    def test_unknown_partial_environment_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            root = Path(task_environment(cwd)["VIRTUAL_ENV"])
            root.mkdir(parents=True)
            sentinel = root / "user.txt"
            sentinel.write_text("preserved", encoding="utf-8")
            with self.assertRaisesRegex((OSError, ValueError), "python|environment"):
                prepare_environment(cwd)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserved")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink unavailable")
    def test_rejects_symlinked_environment_root_without_writing_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory) / "workspace"
            outside = Path(directory) / "outside"
            cwd.mkdir()
            outside.mkdir()
            root = Path(task_environment(cwd)["VIRTUAL_ENV"])
            root.parent.mkdir(parents=True)
            try:
                root.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(str(error))
            with self.assertRaises((OSError, ValueError)):
                prepare_environment(cwd)
            self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
