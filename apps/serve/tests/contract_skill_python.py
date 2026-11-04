"""Deterministic contracts for the product-owned Skill Python entry point."""

from __future__ import annotations

import asyncio
import io
import json
import os
import shlex
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import asynccontextmanager, redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI

from service.capabilities.service.skills import SKILL_PRODUCT_METADATA_FILE
from service.capabilities.service.source import compile_source_skills
from service.cli import serve, skill_python
from service.platform import executables
from service.platform.activity import Activities
from service.platform.storage import filesystem_path
from service.platform.toolchain import ToolchainReadiness
from service.platform.vocabulary import (
    BRIDGE_SESSION_ENV,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    INTERNAL_BASE_URL_ENV,
)

TEST_TIMEOUT_SECONDS = 10


def reviewed_script(directory: str, source: str = "print('run')") -> Path:
    with tempfile.TemporaryDirectory() as inputs:
        source_root = Path(inputs) / "source"
        skill = source_root / "fixture"
        skill.mkdir(parents=True)
        (Path(inputs) / "registry.json").write_bytes(b'{"dependencies":{"fixture":{}}}')
        (skill / "SKILL.md").write_text(
            "---\nname: fixture\ndescription: Reviewed fixture\nversion: 1.0.0\n---\n",
            encoding="utf-8",
        )
        (skill / "run.py").write_text(source, encoding="utf-8")
        compile_source_skills(Path(directory), source_root)
    return Path(directory) / "fixture" / "run.py"


class SkillPythonContracts(unittest.TestCase):
    def test_reviewed_script_and_descendant_keep_utf8_under_legacy_environment(self) -> None:
        text = "中文目录 空格 😀"
        with tempfile.TemporaryDirectory() as directory:
            document = Path(directory) / "中文正文.txt"
            document.write_text(text, encoding="utf-8")
            script = reviewed_script(
                directory,
                "import json,sys,subprocess\nfrom pathlib import Path\n"
                "text=Path(sys.argv[1]).read_text()\n"
                "print(json.dumps([text,sys.argv[2],sys.flags.utf8_mode],ensure_ascii=False),flush=True)\n"
                "subprocess.run([sys.executable,'-B','-c',"
                "'import sys;print(sys.flags.utf8_mode)'],check=True)\n"
                "raise SystemExit(7)\n",
            )
            bootstrap = (
                "import sys\nfrom pathlib import Path\n"
                "from service.cli import skill_python\n"
                "skill_python.SERVICE_BUNDLED_SKILLS_DIR=Path(sys.argv[1])\n"
                "raise SystemExit(skill_python.main(sys.argv[2:]))\n"
            )
            environment = {
                **os.environ,
                "PYTHONUTF8": "0",
                "PYTHONIOENCODING": "cp1252",
            }
            environment.pop(BRIDGE_SESSION_ENV, None)
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    bootstrap,
                    directory,
                    str(script),
                    str(document),
                    text,
                ],
                env=environment,
                capture_output=True,
                timeout=TEST_TIMEOUT_SECONDS,
                check=False,
            )
            self.assertEqual(result.returncode, 7, result.stderr.decode("utf-8", errors="replace"))
            lines = result.stdout.decode("utf-8").splitlines()
            self.assertEqual(json.loads(lines[0]), [text, text, 1])
            self.assertEqual(lines[1], "1")

    def test_authoring_contract_uses_product_launcher_without_arbitrary_modules(self) -> None:
        # Verify launcher dispatch against a current contract fixture. A bundled
        # author's snapshot can legitimately lag a host contract; freshness is
        # reported by prepare, not part of the Python module allowlist contract.
        command = [sys.executable, "-m", "service.cli.skill_python", "-m", "service.cli.plugins"]
        described = subprocess.run(
            [*command, "describe"],
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT_SECONDS,
            check=False,
        )
        self.assertEqual(described.returncode, 0, described.stderr)
        contract = json.loads(described.stdout)
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "contract.json"
            snapshot.write_text(json.dumps(contract), encoding="utf-8")
            response = subprocess.run(
                [*command, "prepare", str(snapshot)],
                capture_output=True,
                text=True,
                timeout=TEST_TIMEOUT_SECONDS,
                check=False,
            )
        self.assertEqual(response.returncode, 0, response.stderr)
        result = json.loads(response.stdout)
        self.assertTrue(result["matched"])
        self.assertFalse(result["authorized"])
        self.assertFalse(result["runtime_verified"])

    def test_frozen_diagnostic_does_not_admit_or_run_user_code(self):
        with (
            redirect_stdout(io.StringIO()) as output,
            patch.object(skill_python, "admit_script") as admit,
            patch.object(skill_python.subprocess, "run") as run,
            patch.object(skill_python.os, "execve") as execute,
        ):
            self.assertEqual(skill_python.main(["--diagnostic-v1"]), 0)
        self.assertEqual(json.loads(output.getvalue())["event"], "launcher_ready")
        admit.assert_not_called()
        run.assert_not_called()
        execute.assert_not_called()

    def test_early_probe_reports_invalid_arguments_without_running_a_launcher(self):
        for arguments, reason in (([], "argument count"), (["relative"], "absolute directory")):
            with self.subTest(arguments=arguments):
                with (
                    self.assertLogs(executables.__name__, level="WARNING") as captured,
                    patch.object(executables, "probe_command") as probe,
                ):
                    self.assertEqual(executables.skill_python_probe(arguments), 2)
                self.assertIn(reason, "\n".join(captured.output))
                probe.assert_not_called()

    def test_early_probe_reports_missing_launcher_and_search_directory(self):
        directory = Path(tempfile.gettempdir()).absolute()
        with (
            self.assertLogs(executables.__name__, level="WARNING") as captured,
            patch.object(executables, "resolve_command", return_value=None),
        ):
            self.assertEqual(executables.skill_python_probe([str(directory)]), 1)
        output = "\n".join(captured.output)
        self.assertIn("launcher not found", output)
        self.assertIn(executables.SKILL_PYTHON_COMMAND, output)
        self.assertIn(str(directory), output)

    def test_early_probe_reports_resolved_launcher_and_successful_execution(self):
        directory = Path(tempfile.gettempdir()).absolute()
        launcher = directory / "scholarseed-skill-python"
        with (
            self.assertLogs(executables.__name__, level="INFO") as captured,
            patch.object(executables, "resolve_command", return_value=launcher),
            patch.object(executables.subprocess, "run", return_value=SimpleNamespace(returncode=0)),
        ):
            self.assertEqual(executables.skill_python_probe([str(directory)]), 0)
        output = "\n".join(captured.output)
        self.assertIn(f"resolved launcher: {launcher}", output)
        self.assertIn(f"Command probe starting at {launcher}", output)
        self.assertIn("--version", output)
        self.assertIn("exited with code 0", output)

    def test_command_probe_preserves_bounded_stderr_tail_for_nonzero_exit_and_timeout(self):
        launcher = Path(tempfile.gettempdir()).absolute() / "scholarseed-skill-python"
        discarded = b"discarded traceback beginning"
        final_error = b"RuntimeError: final launcher failure"
        payload = discarded + b"x" * executables.COMMAND_PROBE_ERROR_LIMIT + final_error
        for timeout in (False, True):
            with self.subTest(timeout=timeout):

                def run(command, *, probe_times_out=timeout, **kwargs):
                    kwargs["stderr"].write(payload)
                    if probe_times_out:
                        raise subprocess.TimeoutExpired(
                            command, executables.COMMAND_PROBE_TIMEOUT_SECONDS
                        )
                    return SimpleNamespace(returncode=7)

                with (
                    self.assertLogs(executables.__name__, level="WARNING") as captured,
                    patch.object(executables.subprocess, "run", side_effect=run),
                ):
                    self.assertFalse(executables.probe_command(launcher))
                output = "\n".join(captured.output)
                self.assertIn(final_error.decode(), output)
                self.assertNotIn(discarded.decode(), output)
                self.assertIn("stderr_truncated=True", output)
                self.assertIn("TimeoutExpired" if timeout else "exited with code 7", output)
                self.assertLess(len(output), executables.COMMAND_PROBE_ERROR_LIMIT * 2)

    def test_command_probe_reports_launch_error_type_without_changing_failure(self):
        launcher = Path(tempfile.gettempdir()).absolute() / "scholarseed-skill-python"
        with (
            self.assertLogs(executables.__name__, level="WARNING") as captured,
            patch.object(
                executables.subprocess, "run", side_effect=FileNotFoundError("missing interpreter")
            ),
        ):
            self.assertFalse(executables.probe_command(launcher))
        output = "\n".join(captured.output)
        self.assertIn("FileNotFoundError", output)
        self.assertIn("missing interpreter", output)
        self.assertIn("stderr_truncated=False", output)

    def test_early_probe_uses_product_launcher_and_original_validation(self):
        directory = Path(tempfile.gettempdir()).absolute()
        launcher = directory / "scholarseed-skill-python"
        with (
            patch.object(executables, "resolve_command", return_value=launcher) as resolve,
            patch.object(executables, "probe_command", return_value=True) as probe,
        ):
            self.assertEqual(executables.skill_python_probe([str(directory)]), 0)
            resolve.assert_called_once_with(executables.SKILL_PYTHON_COMMAND, directory)
            probe.assert_called_once_with(
                launcher,
                executables.SKILL_PYTHON_PROBE_ARGUMENTS,
                timeout_seconds=executables.SKILL_PYTHON_PROBE_TIMEOUT_SECONDS,
            )
        for arguments in [[], ["relative"], [str(directory), "--help"]]:
            with patch.object(executables, "probe_command") as probe:
                self.assertEqual(executables.skill_python_probe(arguments), 2)
                probe.assert_not_called()
        with patch.object(executables, "resolve_command", return_value=None):
            self.assertEqual(executables.skill_python_probe([str(directory)]), 1)
        with (
            patch.object(executables, "resolve_command", return_value=launcher),
            patch.object(executables, "probe_command", return_value=False),
        ):
            self.assertEqual(executables.skill_python_probe([str(directory)]), 1)

    def test_early_receipt_gates_http_without_repeating_the_probe(self):
        async def scenario(ready):
            app = FastAPI()
            app.state.activities = Activities()
            app.state.runtime_service = SimpleNamespace(
                schedule_readiness=Mock(), stop_readiness=AsyncMock()
            )
            gate = ToolchainReadiness()
            gate.defer()
            serve._prepare_startup(app, gate)
            entered = asyncio.Event()

            async def enter():
                async with app.router.lifespan_context(app):
                    entered.set()

            with patch.object(serve, "_ensure_skill_python_path", new=AsyncMock()) as probe:
                task = asyncio.create_task(enter())
                await asyncio.sleep(0)
                self.assertFalse(entered.is_set())
                gate.complete(ready)
                if ready:
                    await task
                    self.assertTrue(entered.is_set())
                else:
                    with self.assertRaises(RuntimeError):
                        await task
                    self.assertFalse(entered.is_set())
                probe.assert_not_called()
                app.state.runtime_service.stop_readiness.assert_awaited_once()

        asyncio.run(scenario(True))
        asyncio.run(scenario(False))

    def test_product_interpreter_never_writes_bytecode_on_either_platform(self) -> None:
        for platform in ("darwin", "win32"):
            with (
                self.subTest(platform=platform),
                patch.object(skill_python.sys, "platform", platform),
                patch.object(skill_python.os, "execve") as replace,
                patch.object(
                    skill_python.subprocess, "run", return_value=SimpleNamespace(returncode=7)
                ) as run,
            ):
                self.assertEqual(skill_python.main(["--version"]), 7 if platform == "win32" else 0)
                command = [sys.executable, "-B", "-X", "utf8", "--version"]
                if platform == "win32":
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(run.call_args.args, (command,))
                    self.assertEqual(run.call_args.kwargs["executable"], sys.executable)
                    self.assertFalse(run.call_args.kwargs["check"])
                    environment = run.call_args.kwargs["env"]
                    replace.assert_not_called()
                else:
                    self.assertEqual(replace.call_count, 1)
                    self.assertEqual(replace.call_args.args[:2], (sys.executable, command))
                    environment = replace.call_args.args[2]
                    run.assert_not_called()
                self.assertEqual(environment["PYTHONUTF8"], "1")
                self.assertEqual(environment["PYTHONIOENCODING"], "utf-8")

    def test_rebuilt_inventory_authorizes_current_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reviewed_script(directory)
            script = reviewed_script(directory, "print('current reviewed source')")
            with (
                patch.object(skill_python, "SERVICE_BUNDLED_SKILLS_DIR", Path(directory)),
                patch.dict(os.environ, {}, clear=True),
            ):
                skill_python.admit_script([str(script)])

    def test_launcher_admission_matches_native_and_filesystem_path_spellings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = reviewed_script(directory)
            native_root = Path(str(Path(directory)).removeprefix("\\\\?\\"))
            native_script = Path(str(script).removeprefix("\\\\?\\"))
            for root, selected in (
                (native_root, filesystem_path(script)),
                (filesystem_path(Path(directory)), native_script),
            ):
                with self.subTest(root=root, selected=selected):
                    with (
                        patch.object(skill_python, "SERVICE_BUNDLED_SKILLS_DIR", root),
                        patch.dict(os.environ, {}, clear=True),
                    ):
                        skill_python.admit_script([str(selected)])

    def test_missing_build_receipt_never_falls_back_to_legacy_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = reviewed_script(directory)
            (script.parent / SKILL_PRODUCT_METADATA_FILE).unlink()
            with patch.object(skill_python, "SERVICE_BUNDLED_SKILLS_DIR", Path(directory)):
                with self.assertRaises(OSError):
                    skill_python.admit_script([str(script)])

    def test_unlisted_file_invalidates_compiled_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = reviewed_script(directory)
            (script.parent / "extra.py").write_text("print('extra')\n", encoding="utf-8")
            with patch.object(skill_python, "SERVICE_BUNDLED_SKILLS_DIR", Path(directory)):
                with self.assertRaisesRegex(ValueError, "integrity"):
                    skill_python.admit_script([str(script)])

    def test_native_session_uses_frozen_builtin_without_exporting_bridge_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = reviewed_script(directory)
            with (
                patch.object(skill_python, "SERVICE_BUNDLED_SKILLS_DIR", Path(directory)),
                patch.dict(os.environ, {}, clear=True),
                patch.object(skill_python, "request") as admit,
            ):
                skill_python.admit_script([str(script)])
                admit.assert_not_called()
                script.write_text("print('modified')", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "integrity"):
                    skill_python.admit_script([str(script)])

    def test_forged_bridge_cannot_admit_a_user_script(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = reviewed_script(directory)
            with (
                patch.object(
                    skill_python, "SERVICE_BUNDLED_SKILLS_DIR", Path(directory) / "elsewhere"
                ),
                patch.dict(os.environ, {BRIDGE_SESSION_ENV: "forged"}),
                patch.object(
                    skill_python, "request", return_value={"ok": True, "builtin": True}
                ) as admit,
            ):
                with self.assertRaises((ValueError, OSError)):
                    skill_python.admit_script([str(script)])
                admit.assert_not_called()

    def test_product_launcher_rejects_user_code_and_installation(self) -> None:
        for arguments in (
            ["-c", "print('user')"],
            ["-m", "pip", "install", "package"],
            ["-m", "service.cli.serve"],
            ["-m", "service.cli.plugins.injected", "prepare"],
        ):
            with (
                self.subTest(arguments=arguments),
                patch.object(skill_python.os, "execve") as execute,
                patch.object(skill_python.subprocess, "run") as run,
                redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(skill_python.main(arguments), 1)
                execute.assert_not_called()
                run.assert_not_called()

        response = subprocess.run(
            [
                sys.executable,
                "-m",
                "service.cli.skill_python",
                "-m",
                "service.cli.plugins",
                "install",
                "package",
            ],
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT_SECONDS,
            check=False,
        )
        self.assertEqual(response.returncode, 2, response.stderr)

    def test_runtime_discovery_failure_prevents_probe_and_composition(self) -> None:
        with (
            patch.object(
                serve.RuntimeDiscovery, "discover", side_effect=RuntimeError("discovery failed")
            ),
            patch.object(serve, "_ensure_skill_python_path") as probe,
            patch.object(serve, "create_app") as create,
        ):
            with self.assertRaisesRegex(RuntimeError, "discovery failed"):
                serve.serve_main(["--auth-mode", "off", "--ownership-axis", "machine"])
            probe.assert_not_called()
            create.assert_not_called()

    def test_serve_cancellation_is_not_converted_to_success(self) -> None:
        with (
            patch.dict(os.environ),
            patch.object(serve, "_ensure_skill_python_path"),
            patch.object(serve, "create_app"),
            patch.object(serve.ProductServer, "run", side_effect=asyncio.CancelledError),
            redirect_stderr(io.StringIO()),
        ):
            with self.assertRaises(asyncio.CancelledError):
                serve.serve_main(["--auth-mode", "off", "--ownership-axis", "machine"])

    def test_serve_argument_exits_do_not_probe_local_launchers(self) -> None:
        cases = (
            (["--help"], 0),
            (["--port", "invalid"], 2),
            (["--unknown-option"], 2),
            (["client", "--help"], 0),
            (["client"], 2),
            (["--await-skill-python"], 2),
            (["--await-skill-python", "--parent-control"], 2),
        )
        for arguments, status in cases:
            with (
                self.subTest(arguments=arguments),
                patch.object(serve, "_ensure_skill_python_path") as probe,
                patch.object(serve, "create_app") as create,
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                with self.assertRaises(SystemExit) as exited:
                    serve.serve_main(arguments)
                self.assertEqual(exited.exception.code, status)
                probe.assert_not_called()
                create.assert_not_called()

    def test_serve_invalid_auth_environment_does_not_probe(self) -> None:
        with (
            patch.dict(os.environ, {serve.AUTH_MODE_ENV: "invalid"}),
            patch.object(serve, "_ensure_skill_python_path") as probe,
            patch.object(serve, "create_app") as create,
            redirect_stderr(io.StringIO()),
        ):
            with self.assertRaises(SystemExit) as exited:
                serve.serve_main([])
            self.assertEqual(exited.exception.code, 2)
            probe.assert_not_called()
            create.assert_not_called()

    def test_http_client_does_not_prepare_local_server(self) -> None:
        stopped = RuntimeError("stop at the HTTP transport boundary")
        with (
            patch.object(serve, "_ensure_skill_python_path") as probe,
            patch.object(serve, "create_app") as create,
            patch.object(serve.httpx, "post", side_effect=stopped) as post,
        ):
            with self.assertRaises(RuntimeError) as error:
                serve.serve_main(["client", "--message", "hello"])
            self.assertIs(error.exception, stopped)
            post.assert_called_once()
            probe.assert_not_called()
            create.assert_not_called()

    def test_composition_failure_prevents_skill_probe(self) -> None:
        stopped = RuntimeError("stop before constructing the app fixture")
        calls = []

        def compose(*args: object, **kwargs: object) -> None:
            calls.append("compose")
            raise stopped

        with (
            patch.dict(os.environ),
            patch.object(
                serve, "_ensure_skill_python_path", side_effect=lambda: calls.append("probe")
            ),
            patch.object(serve, "create_app", side_effect=compose),
        ):
            with self.assertRaises(RuntimeError) as error:
                serve.serve_main(["--auth-mode", "off", "--ownership-axis", "machine"])
            self.assertIs(error.exception, stopped)
        self.assertEqual(calls, ["compose"])

    def test_serve_installs_startup_after_composition_without_running_probe(self) -> None:
        calls = []
        stopped = RuntimeError("stop at server run")
        with (
            patch.dict(os.environ),
            patch.object(serve.RuntimeDiscovery, "discover") as discovery,
            patch.object(serve, "create_app") as create,
            patch.object(serve, "_ensure_skill_python_path") as probe,
            patch.object(serve.ProductServer, "run") as run,
            redirect_stderr(io.StringIO()),
        ):
            app = create.return_value
            create.side_effect = lambda *args, **kwargs: calls.append("compose") or app
            probe.side_effect = lambda: calls.append("probe")

            def stop():
                calls.append("run")
                raise stopped

            run.side_effect = stop
            with self.assertRaises(RuntimeError) as failed:
                serve.serve_main(["--auth-mode", "off", "--ownership-axis", "machine"])
            self.assertIs(failed.exception, stopped)
            discovery.assert_called_once_with()
            self.assertIs(create.call_args.kwargs["runtime_discovery"], discovery.return_value)
            probe.assert_not_called()
            run.assert_called_once_with()
        self.assertEqual(calls, ["compose", "run"])

    def test_skill_probe_failure_prevents_lifespan_and_drains_readiness(self) -> None:
        app = FastAPI()
        app.state.activities = Activities()
        app.state.runtime_service = SimpleNamespace(
            schedule_readiness=Mock(), stop_readiness=AsyncMock()
        )
        entered = []

        @asynccontextmanager
        async def previous(application):
            entered.append(True)
            yield

        app.router.lifespan_context = previous
        serve._prepare_startup(app)

        async def scenario():
            with patch.object(
                serve, "_ensure_skill_python_path", side_effect=RuntimeError("failed")
            ):
                with self.assertRaisesRegex(RuntimeError, "failed"):
                    async with app.router.lifespan_context(app):
                        self.fail("must not open HTTP")
            app.state.runtime_service.stop_readiness.assert_awaited_once()
            self.assertEqual(entered, [])

        asyncio.run(scenario())

    def test_skill_validation_overlaps_readiness_and_commits_path_on_main_thread(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            launcher = Path(directory) / executables.SKILL_PYTHON_COMMAND
            original_path = os.environ["PATH"]
            entered = []
            worker_threads = []
            readiness_started = threading.Event()

            @asynccontextmanager
            async def previous(application):
                entered.append(os.environ["PATH"].split(os.pathsep)[0])
                yield

            async def scenario():
                async def readiness():
                    readiness_started.set()

                app = FastAPI()
                app.state.activities = Activities()
                tasks = []
                app.state.runtime_service = SimpleNamespace(
                    schedule_readiness=lambda: tasks.append(asyncio.create_task(readiness())),
                    stop_readiness=AsyncMock(),
                )
                app.router.lifespan_context = previous
                serve._prepare_startup(app)

                def find():
                    worker_threads.append(threading.get_ident())
                    self.assertTrue(readiness_started.wait(5))
                    self.assertEqual(os.environ["PATH"], original_path)
                    return launcher

                with patch.object(serve, "_find_skill_python_launcher", side_effect=find):
                    async with app.router.lifespan_context(app):
                        self.assertEqual(entered, [directory])
                await asyncio.gather(*tasks)
                self.assertNotEqual(worker_threads, [threading.get_ident()])

            with patch.dict(os.environ):
                asyncio.run(scenario())

    def test_cancelled_skill_probe_joins_actual_worker_before_path_commit(self) -> None:
        started = threading.Event()
        release = threading.Event()
        original_path = os.environ["PATH"]

        def find():
            started.set()
            self.assertTrue(release.wait(5))
            return Path("/unused/launcher")

        async def scenario():
            with patch.object(serve, "_find_skill_python_launcher", side_effect=find):
                task = asyncio.create_task(serve._ensure_skill_python_path(Activities()))
                await asyncio.to_thread(started.wait, 5)
                try:
                    for _ in range(2):
                        task.cancel()
                        await asyncio.sleep(0.01)
                        self.assertFalse(task.done())
                finally:
                    release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertEqual(os.environ["PATH"], original_path)

        asyncio.run(scenario())

    def test_cli_reexecutes_the_active_interpreter_with_exact_arguments(self) -> None:
        arguments = ["script.py", "--query", "含空格中文引号", '{"query":"quoted value"}']
        with (
            patch.object(skill_python, "admit_script"),
            patch.object(skill_python.sys, "platform", "darwin"),
            patch.object(skill_python.os, "execve") as execute,
        ):
            self.assertEqual(skill_python.main(arguments), 0)
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(
            execute.call_args.args[:2],
            (
                skill_python.sys.executable,
                [skill_python.sys.executable, "-B", "-X", "utf8", *arguments],
            ),
        )

    def test_cli_rejects_an_empty_invocation(self) -> None:
        with patch.object(skill_python.os, "execve") as execute:
            self.assertEqual(skill_python.main([]), 2)
        execute.assert_not_called()

    def test_managed_skill_checks_live_admission_before_exec(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = reviewed_script(directory)
            with (
                patch.object(skill_python, "SERVICE_BUNDLED_SKILLS_DIR", Path(directory)),
                patch.dict(os.environ, {BRIDGE_SESSION_ENV: "session"}, clear=True),
                patch.object(
                    skill_python, "request", return_value={"ok": True, "builtin": True}
                ) as admit,
                patch.object(skill_python.sys, "platform", "darwin"),
                patch.object(skill_python.os, "execve") as execute,
            ):
                self.assertEqual(skill_python.main([str(script)]), 0)
                admit.assert_called_once()
                self.assertEqual(
                    admit.call_args.args[1], {"path": str(filesystem_path(script).resolve())}
                )
                execute.assert_called_once()

    def test_real_interpreter_preserves_arguments_and_failure_status(self) -> None:
        arguments = ["中文 空格", "", 'quoted "value"', "path with spaces\\"]
        source = "import json,sys; print(json.dumps(sys.argv[1:])); sys.exit(7)"

        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "中文 script.py"
            (script.parent / "SKILL.md").write_text("fixture", encoding="utf-8")
            script.write_text(source, encoding="utf-8")
            for invocation in ([str(script)],):
                with self.subTest(invocation=invocation):
                    result = subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "service.cli.skill_python",
                            "--task",
                            *invocation,
                            *arguments,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=15,
                        check=False,
                        env={
                            **os.environ,
                            "SCHOLARSEED_TASK_CWD": directory,
                        },
                    )
                    self.assertEqual(result.returncode, 7, result.stderr)
                    self.assertEqual(result.stderr, "")
                    self.assertEqual(json.loads(result.stdout), arguments)

    def test_revoked_or_unreachable_admission_never_executes_skill(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = reviewed_script(directory)
            for error in (ValueError("login_required"), OSError("bridge unavailable")):
                with (
                    self.subTest(error=str(error)),
                    patch.object(skill_python, "SERVICE_BUNDLED_SKILLS_DIR", Path(directory)),
                    patch.dict(os.environ, {BRIDGE_SESSION_ENV: "session"}, clear=True),
                    patch.object(skill_python, "request", side_effect=error),
                    patch.object(skill_python.os, "execve") as execute,
                    patch.object(skill_python.subprocess, "run") as run,
                ):
                    self.assertEqual(skill_python.main([str(script)]), 1)
                    execute.assert_not_called()
                    run.assert_not_called()

    def test_launcher_import_keeps_rpc_registry_outside_frozen_builtin_validation(self) -> None:
        # 0.3 requires local frozen-inventory validation (including manifest parsing).
        # Keep that admission boundary while avoiding the general RPC registry.
        program = (
            "import sys; import service.cli.skill_python; "
            "assert not {'service.cli.bridge', 'service.platform.bridge', "
            "} & sys.modules.keys()"
        )
        result = subprocess.run(
            [sys.executable, "-B", "-c", program],
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT_SECONDS,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipIf(
        os.name == "nt", "POSIX shell launcher; Windows uses the packaged executable contract"
    )
    def test_real_launcher_probe_rejects_a_broken_interpreter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            launcher = Path(directory) / "skill-python"
            launcher.write_text(
                f'#!/bin/sh\nexec {shlex.quote(sys.executable)} -B -m service.cli.skill_python "$@"\n'
            )
            launcher.chmod(0o700)
            self.assertTrue(executables.probe_command(launcher, ("--version",)))
            launcher.write_text("#!/nonexistent/scholarseed-python\n")
            self.assertFalse(executables.probe_command(launcher, ("--version",)))

    def test_real_managed_launcher_never_executes_a_rejected_skill(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(403)
                self.end_headers()
                self.wfile.write(b'{"ok": false, "error": "skill_access_denied"}')

            def log_message(self, *_args):
                pass

        with (
            tempfile.TemporaryDirectory() as directory,
            ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server,
        ):
            root = Path(directory)
            marker = root / "executed"
            script = reviewed_script(
                directory, f"from pathlib import Path; Path({str(marker)!r}).touch()"
            )
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                result = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        "-c",
                        "from pathlib import Path; from service.cli import skill_python; "
                        f"skill_python.SERVICE_BUNDLED_SKILLS_DIR = Path({directory!r}); "
                        f"raise SystemExit(skill_python.main([{str(script)!r}]))",
                    ],
                    env={
                        **os.environ,
                        BRIDGE_SESSION_ENV: "test-session",
                        BRIDGE_TOKEN_ENV: "test-token",
                        BRIDGE_SOCKET_ENV: "",
                        INTERNAL_BASE_URL_ENV: f"http://127.0.0.1:{server.server_port}",
                    },
                    capture_output=True,
                    text=True,
                    timeout=TEST_TIMEOUT_SECONDS,
                )
            finally:
                server.shutdown()
                worker.join()
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("skill_access_denied", result.stderr)
            self.assertFalse(marker.exists())

    def test_standalone_serve_prepends_the_active_scripts_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory)
            launcher = scripts / executables.SKILL_PYTHON_COMMAND
            launcher.write_text("launcher", encoding="utf-8")
            environment = {"PATH": os.pathsep.join(("/host/bin", str(scripts), "/usr/bin"))}
            with (
                patch.dict(os.environ, environment, clear=True),
                patch.object(serve, "resolve_command", return_value=launcher),
                patch.object(serve, "command_directories", return_value=(scripts,)),
                patch.object(serve, "probe_command", return_value=True),
            ):
                asyncio.run(serve._ensure_skill_python_path(Activities()))
                self.assertEqual(
                    os.environ["PATH"].split(os.pathsep),
                    [str(scripts), "/host/bin", "/usr/bin"],
                )

    def test_resolution_delegates_suffixes_to_native_command_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory)
            for suffix in ("", ".exe", ".cmd", ".bat", ".com"):
                launcher = scripts / f"{executables.SKILL_PYTHON_COMMAND}{suffix}"
                with (
                    self.subTest(suffix=suffix),
                    patch.object(executables.shutil, "which", return_value=str(launcher)) as which,
                ):
                    self.assertEqual(
                        executables.resolve_command(executables.SKILL_PYTHON_COMMAND, scripts),
                        launcher,
                    )
                    which.assert_called_once_with(str(scripts / executables.SKILL_PYTHON_COMMAND))

    def test_product_directory_precedes_path_and_scripts_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            product, installed = root / "product bin", root / "Scripts"
            environment = {
                executables.BRIDGE_DIR_ENV: str(product),
                "PATH": os.pathsep.join((str(installed), str(product))),
            }
            with (
                patch.dict(os.environ, environment, clear=True),
                patch.object(executables, "scripts_directory", return_value=installed),
            ):
                self.assertEqual(executables.command_directories(), (product, installed))

    def test_working_product_skill_launcher_wins_over_installed_trampoline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            product, installed = root / "product bin", root / "Scripts"
            launcher = product / "scholarseed-skill-python.cmd"
            with (
                patch.dict(os.environ, {"PATH": str(installed)}, clear=True),
                patch.object(serve, "command_directories", return_value=(product, installed)),
                patch.object(serve, "resolve_command", return_value=launcher) as resolve,
                patch.object(serve, "probe_command", return_value=True) as probe,
            ):
                asyncio.run(serve._ensure_skill_python_path(Activities()))
                self.assertEqual(
                    os.environ["PATH"].split(os.pathsep), [str(product), str(installed)]
                )
                resolve.assert_called_once_with(executables.SKILL_PYTHON_COMMAND, product)
                probe.assert_called_once_with(
                    launcher,
                    executables.SKILL_PYTHON_PROBE_ARGUMENTS,
                    timeout_seconds=executables.SKILL_PYTHON_PROBE_TIMEOUT_SECONDS,
                )

    def test_failed_skill_probe_does_not_reorder_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory)
            original = os.pathsep.join((str(scripts / "product"), str(scripts)))
            with (
                patch.dict(os.environ, {"PATH": original}, clear=True),
                patch.object(serve, "command_directories", return_value=(scripts,)),
                patch.object(serve, "resolve_command", return_value=scripts / "launcher.exe"),
                patch.object(serve, "probe_command", return_value=False),
            ):
                asyncio.run(serve._ensure_skill_python_path(Activities()))
                self.assertEqual(os.environ["PATH"], original)


if __name__ == "__main__":
    unittest.main()
