"""The gate resolves each test owner in a real isolated child interpreter."""

from __future__ import annotations

import ctypes
import io
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, create_autospec, patch

from service import brand

from . import progress, run_all
from ._directories import LEASE_TEST_ROOT_ENV
from .run_all import NATIVE_COORDINATOR_EXCLUSIVE, REPOSITORY_ROOT, SERVE_ROOT, _child_environment
from .utils import Accounting, ExtendedLimits, ThreadEntry, WindowsJob

HANDSHAKE_TIMEOUT_SECONDS = 30
LISTENER_HOST = "127.0.0.1"
PROGRESS_WRITERS = 16
PROGRESS_EVENTS_PER_WRITER = 32


class RunnerImports(unittest.TestCase):
    def test_explicit_lease_root_controls_home_and_temporary_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(strict=True)
            with (
                patch.dict(os.environ, {LEASE_TEST_ROOT_ENV: str(root)}),
                _child_environment(product_root=False) as environment,
            ):
                home = Path(environment[brand.HOME_ENV])
                temporary = Path(environment["TMPDIR"])
                self.assertEqual(home.parent, root)
                self.assertEqual(temporary.parent, root)
                self.assertNotEqual(home, temporary)
                for variable in ("TMPDIR", "TEMP", "TMP"):
                    self.assertEqual(environment[variable], str(temporary))
            self.assertFalse(home.exists())
            self.assertFalse(temporary.exists())

    def test_real_application_source_qualification_uses_the_exclusive_coordinator_lane(
        self,
    ) -> None:
        self.assertIn("contract_startup_sources", NATIVE_COORDINATOR_EXCLUSIVE)

    def test_child_temporary_directories_are_physical_and_support_native_sockets(self) -> None:
        with _child_environment(product_root=False) as environment:
            result = subprocess.run(
                [
                    sys.executable,
                    "-P",
                    "-c",
                    "import json, socket, sys, tempfile\nfrom pathlib import Path\n"
                    "with tempfile.TemporaryDirectory(prefix='s-') as name:\n"
                    "    root = Path(name)\n"
                    "    if sys.platform != 'win32':\n"
                    "        with socket.socket(socket.AF_UNIX) as listener:\n"
                    "            listener.bind(str(root / 'listener.sock'))\n"
                    "    print(json.dumps([str(root), str(root.resolve(strict=True))]))",
                ],
                cwd=SERVE_ROOT,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            temporary, physical = map(Path, json.loads(result.stdout))
            self.assertEqual(temporary, physical)
            for variable in ("TMPDIR", "TEMP", "TMP"):
                self.assertEqual(environment[variable], str(temporary.parent))
        self.assertFalse(Path(environment[brand.HOME_ENV]).exists())
        self.assertFalse(Path(environment["TMPDIR"]).exists())

    def test_owner_and_repository_imports_without_cwd_or_inherited_help(self) -> None:
        for product_root in (False, True):
            other_root = SERVE_ROOT if product_root else REPOSITORY_ROOT
            expected = REPOSITORY_ROOT if product_root else SERVE_ROOT
            for inherited in ("", str(other_root)):
                with self.subTest(product_root=product_root, inherited=inherited):
                    with (
                        patch.dict(os.environ, {"PYTHONPATH": inherited}),
                        _child_environment(product_root=product_root) as environment,
                    ):
                        with tempfile.TemporaryDirectory() as cwd:
                            result = subprocess.run(
                                [
                                    sys.executable,
                                    "-P",
                                    "-c",
                                    "import json, tests; from importlib.util import find_spec; "
                                    "print(json.dumps([tests.__file__, "
                                    "find_spec('apps.serve.tests.pdf').origin]))",
                                ],
                                cwd=cwd,
                                env=environment,
                                capture_output=True,
                                text=True,
                                timeout=30,
                                check=False,
                            )
                        self.assertEqual(result.returncode, 0, result.stderr)
                        owner, fixture = map(Path, json.loads(result.stdout))
                        self.assertEqual(owner.resolve(), expected / "tests" / "__init__.py")
                        self.assertEqual(fixture.resolve(), SERVE_ROOT / "tests" / "pdf.py")
                    self.assertFalse(Path(environment[brand.HOME_ENV]).exists())
                    self.assertFalse(Path(environment["TMPDIR"]).exists())


class RunnerLifecycle(unittest.TestCase):
    def setUp(self):
        self.directories = []
        self.processes = []
        self.readers = []
        self.outputs = []
        self.jobs = []
        self.script = None
        self.interruption = None
        self.before_interruption = None
        self.make_directory = run_all.make_directory
        self.popen = subprocess.Popen
        self.job_type = run_all.WindowsJob
        self.addCleanup(self.recover)
        self.enterContext(patch.object(run_all, "make_directory", self.allocate))
        self.enterContext(patch.object(run_all.subprocess, "Popen", self.launch))
        self.enterContext(patch.object(run_all, "WindowsJob", self.own_job))

    def own_job(self):
        job = self.job_type()
        self.jobs.append(job)
        return job

    def allocate(self, *args, **kwargs):
        directory = self.make_directory(*args, **kwargs)
        self.directories.append(directory)
        return directory

    def launch(self, command, **kwargs):
        if command[0] != sys.executable:
            return self.popen(command, **kwargs)
        if self.script is not None:
            command = [sys.executable, "-c", self.script]
        process = self.popen(command, **kwargs)
        self.processes.append(process)
        communicate = process.communicate
        interruption = self.interruption

        def interrupted(*args, **kwargs):
            nonlocal interruption
            self.assertEqual(kwargs["timeout"], run_all.SUITE_TIMEOUT_SECONDS)
            if interruption is not None:
                error, interruption = interruption, None
                if self.before_interruption is not None:
                    self.before_interruption(process)
                raise error
            result = communicate(*args, **kwargs)
            self.outputs.append(result)
            return result

        process.communicate = interrupted
        return process

    def recover(self):
        for process in self.processes:
            if sys.platform == "win32":
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=run_all.SUITE_TIMEOUT_SECONDS)
            else:
                run_all._stop_suite(process)
        for job in self.jobs:
            job.close()
        for reader in self.readers:
            reader.join(timeout=HANDSHAKE_TIMEOUT_SECONDS)
            self.assertFalse(reader.is_alive(), "child handshake reader did not drain")
        for directory in self.directories:
            if directory.exists():
                shutil.rmtree(directory)

    def assert_released(self):
        for process in self.processes:
            self.assertIsNotNone(process.poll())
            for stream in (process.stdout, process.stderr):
                self.assertIsNotNone(stream)
                self.assertTrue(stream.closed)
        for directory in self.directories:
            self.assertFalse(directory.exists(), "owned directory leaked before runner exit")

    def test_real_success_and_failure_release_process_pipes_and_directories(self):
        for script, expected in ((None, 0), ("raise SystemExit(7)", 7)):
            with self.subTest(script=script):
                self.script = script
                result = run_all._run_suite("contract_filenames")
                self.assertEqual(result[1], expected)
                self.assert_released()

    def test_timeout_and_unexpected_communication_failures_drain_before_cleanup(self):
        self.script = "import threading; threading.Event().wait()"
        for interruption in (
            subprocess.TimeoutExpired("controlled child", run_all.SUITE_TIMEOUT_SECONDS),
            RuntimeError("injected communication failure"),
            KeyboardInterrupt("injected interruption"),
        ):
            with self.subTest(error=type(interruption).__name__):
                self.interruption = interruption
                if isinstance(interruption, subprocess.TimeoutExpired):
                    self.assertEqual(
                        run_all._run_suite("contract_filenames")[1], run_all.TIMEOUT_EXIT_CODE
                    )
                else:
                    with self.assertRaises(type(interruption)) as caught:
                        run_all._run_suite("contract_filenames")
                    self.assertIs(caught.exception, interruption)
                self.assert_released()

    def test_partial_allocation_and_spawn_failures_release_only_owned_directories(self):
        def second_allocation_fails(*args, **kwargs):
            if self.directories:
                raise OSError("injected allocation failure")
            return self.allocate(*args, **kwargs)

        with patch.object(run_all, "make_directory", second_allocation_fails):
            with self.assertRaisesRegex(OSError, "allocation failure"):
                run_all._run_suite("contract_filenames")
        self.assert_released()
        self.assertFalse(self.processes)
        with patch.object(run_all.subprocess, "Popen", side_effect=OSError("spawn failure")):
            with self.assertRaisesRegex(OSError, "spawn failure"):
                run_all._run_suite("contract_filenames")
        self.assert_released()

    def test_normal_exit_with_live_descendant_is_rejected_and_drained(self):
        child = (
            "import json,os,socket,threading; listener=socket.socket(); "
            f"listener.bind(({LISTENER_HOST!r},0)); listener.listen(); "
            "print(json.dumps({'pid':os.getpid(),'port':listener.getsockname()[1]}),flush=True); "
            "threading.Event().wait()"
        )
        self.script = (
            f"import subprocess,sys; child=subprocess.Popen([sys.executable,'-c',{child!r}],"
            "stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True); "
            "print(child.stdout.readline().strip(),flush=True)"
        )
        with self.assertRaisesRegex(RuntimeError, "descendants survived"):
            run_all._run_suite("contract_filenames")
        self.assert_released()
        ready = json.loads(self.outputs[0][0])
        with self.assertRaises(OSError):
            with socket.create_connection(
                (LISTENER_HOST, ready["port"]), timeout=HANDSHAKE_TIMEOUT_SECONDS
            ):
                self.fail("detached descendant listener survived rejection")

    def test_timeout_stops_a_real_descendant_listener_before_directory_cleanup(self):
        child = (
            "import json,os,socket,threading; listener=socket.socket(); "
            f"listener.bind(({LISTENER_HOST!r},0)); listener.listen(); "
            "print(json.dumps({'pid':os.getpid(),'port':listener.getsockname()[1]}),flush=True); "
            "threading.Event().wait()"
        )
        self.script = (
            f"import subprocess,sys,threading; subprocess.Popen([sys.executable,'-c',{child!r}]); "
            "threading.Event().wait()"
        )
        self.interruption = subprocess.TimeoutExpired(
            "controlled tree", run_all.SUITE_TIMEOUT_SECONDS
        )
        ready = {}

        def handshake(process):
            messages = queue.Queue()
            reader = threading.Thread(target=lambda: messages.put(process.stdout.readline()))
            self.readers.append(reader)
            reader.start()
            ready.update(json.loads(messages.get(timeout=HANDSHAKE_TIMEOUT_SECONDS)))
            reader.join(timeout=HANDSHAKE_TIMEOUT_SECONDS)
            self.assertFalse(reader.is_alive())
            self.assertGreater(ready["pid"], 0)
            with socket.create_connection(
                (LISTENER_HOST, ready["port"]), timeout=HANDSHAKE_TIMEOUT_SECONDS
            ):
                pass

        self.before_interruption = handshake
        original_cleanup = shutil.rmtree

        def cleanup(directory):
            self.assertIsNotNone(self.processes[-1].poll())
            with self.assertRaises(OSError):
                with socket.create_connection(
                    (LISTENER_HOST, ready["port"]), timeout=HANDSHAKE_TIMEOUT_SECONDS
                ):
                    self.fail("directory cleanup began before descendant listener stopped")
            original_cleanup(directory)

        with patch.object(run_all.shutil, "rmtree", cleanup):
            self.assertEqual(run_all._run_suite("contract_filenames")[1], run_all.TIMEOUT_EXIT_CODE)
        self.assert_released()
        with self.assertRaises(OSError):
            with socket.create_connection(
                (LISTENER_HOST, ready["port"]), timeout=HANDSHAKE_TIMEOUT_SECONDS
            ):
                self.fail("descendant listener survived suite drain")

    def test_execution_and_cleanup_failures_both_remain_visible(self):
        self.script = "import threading; threading.Event().wait()"
        self.interruption = RuntimeError("injected communication failure")
        original = shutil.rmtree
        failure = OSError("injected directory cleanup failure")

        def cleanup(directory):
            original(directory)
            if directory == run_all.filesystem_path(self.directories[0]):
                raise failure

        with patch.object(run_all.shutil, "rmtree", cleanup):
            with self.assertRaises(BaseExceptionGroup) as caught:
                run_all._run_suite("contract_filenames")
        self.assertIn(self.interruption, caught.exception.exceptions)
        self.assertIn(failure, caught.exception.exceptions)
        self.assert_released()

    def test_failed_drain_retains_state_and_both_causes(self):
        self.script = "import threading; threading.Event().wait()"
        self.interruption = RuntimeError("injected communication failure")
        failure = PermissionError("injected tree termination failure")
        with patch.object(run_all, "_stop_suite", side_effect=failure):
            with self.assertRaises(run_all.UndrainedSuite) as caught:
                run_all._run_suite("contract_filenames")
        causes = caught.exception.__cause__
        if not isinstance(causes, BaseExceptionGroup):
            self.fail("drain failure did not preserve both causes")
        self.assertIn(self.interruption, causes.exceptions)
        self.assertIn(failure, causes.exceptions)
        for directory in self.directories:
            self.assertTrue(directory.exists())
            self.assertIn(str(directory), str(caught.exception))

    def test_noop_cleanup_is_detected_before_test_runner_exit(self):
        with patch.object(run_all.shutil, "rmtree"):
            self.assertEqual(run_all._run_suite("contract_filenames")[1], 0)
        with self.assertRaisesRegex(AssertionError, "owned directory leaked"):
            self.assert_released()

    def test_windows_tree_stop_terminates_owned_job_then_waits(self):
        process = create_autospec(self.popen, instance=True)
        process.pid = 123
        process.communicate.return_value = ("stdout", "stderr")
        process.stdout = Mock()
        process.stderr = Mock()
        process.poll.return_value = None
        job = create_autospec(WindowsJob, instance=True)
        job.active.return_value = False
        with (
            patch.object(run_all.sys, "platform", "win32"),
            patch.object(run_all.os, "killpg", create=True) as kill,
        ):
            self.assertEqual(run_all._stop_suite(process, job), ("stdout", "stderr"))
        job.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        kill.assert_not_called()
        process.communicate.assert_called_once_with(timeout=run_all.SUITE_TIMEOUT_SECONDS)
        process.wait.assert_called_once_with(timeout=run_all.SUITE_TIMEOUT_SECONDS)
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()

    def test_pipe_close_failure_still_closes_other_pipe_and_waits(self):
        failure = OSError("injected pipe close failure")
        process = create_autospec(self.popen, instance=True)
        process.pid = 123
        process.communicate.return_value = ("stdout", "stderr")
        process.stdout = Mock()
        process.stdout.close.side_effect = failure
        process.stderr = Mock()
        with (
            patch.object(run_all.os, "killpg", create=True),
            patch.object(run_all.signal, "SIGKILL", 9, create=True),
            patch.object(run_all, "_scope_active", return_value=False),
        ):
            with patch.object(run_all.sys, "platform", "darwin"):
                with self.assertRaises(BaseExceptionGroup) as caught:
                    run_all._stop_suite(process)
        self.assertEqual(caught.exception.exceptions, (failure,))
        process.stderr.close.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=run_all.SUITE_TIMEOUT_SECONDS)

    def test_job_close_error_does_not_hide_undrained_state_or_delete_directories(self):
        primary = run_all.UndrainedSuite("injected undrained scope")
        failure = OSError("injected job close failure")
        job = create_autospec(WindowsJob, instance=True)
        job.close.side_effect = failure
        with self.assertRaises(BaseExceptionGroup) as caught:
            with _child_environment(product_root=False):
                with (
                    patch.object(run_all.sys, "platform", "win32"),
                    patch.object(run_all, "WindowsJob", return_value=job),
                    run_all._suite_job(),
                ):
                    raise primary
        self.assertEqual(caught.exception.exceptions, (primary, failure))
        for directory in self.directories:
            self.assertTrue(directory.exists())

    def test_windows_launch_is_suspended_until_job_assignment(self):
        process = create_autospec(self.popen, instance=True)
        process.pid = 123
        process.returncode = 0
        process.communicate.return_value = ("controlled output", "")
        job = create_autospec(WindowsJob, instance=True)
        job.active.return_value = False
        events = Mock()
        events.attach_mock(process, "process")
        events.attach_mock(job, "job")
        with _child_environment(product_root=False) as environment:
            with (
                patch.object(run_all.sys, "platform", "win32"),
                patch.object(run_all, "_child_environment", return_value=nullcontext(environment)),
                patch.object(run_all, "WindowsJob", return_value=job),
                patch.object(run_all.subprocess, "Popen", return_value=process) as spawn,
            ):
                self.assertEqual(run_all._run_suite("contract_filenames")[1], 0)
        self.assertEqual(spawn.call_args.kwargs["creationflags"], 0x00000004)
        self.assertFalse(spawn.call_args.kwargs["start_new_session"])
        calls = [call[0] for call in events.mock_calls]
        self.assertLess(calls.index("job.attach_and_resume"), calls.index("process.communicate"))
        job.attach_and_resume.assert_called_once_with(123)
        job.close.assert_called_once_with()
        self.assert_released()

    def test_posix_empty_zombie_and_unknown_scopes_are_not_confused(self):
        process = create_autospec(self.popen, instance=True)
        process.pid = 123
        with (
            patch.object(run_all.sys, "platform", "darwin"),
            patch.object(
                run_all.os, "killpg", side_effect=PermissionError("scope probe"), create=True
            ),
            patch.object(run_all.subprocess, "run") as snapshot,
        ):
            snapshot.return_value.stdout = "123 Z\n123 S\n999 R\n"
            self.assertTrue(run_all._scope_active(process, None))
            snapshot.return_value.stdout = "123 Z\n999 R\n"
            self.assertFalse(run_all._scope_active(process, None))
            snapshot.return_value.stdout = "999 R\n"
            self.assertFalse(run_all._scope_active(process, None))
            snapshot.return_value.stdout = "unparseable\n"
            with self.assertRaises(ValueError):
                run_all._scope_active(process, None)
            snapshot.side_effect = subprocess.CalledProcessError(1, "controlled ps")
            with self.assertRaises(subprocess.CalledProcessError):
                run_all._scope_active(process, None)

    def test_scope_wait_keeps_the_original_timeout_and_fails_if_not_drained(self):
        process = create_autospec(self.popen, instance=True)
        with (
            patch.object(run_all, "_scope_active", return_value=True),
            patch.object(run_all.time, "monotonic", side_effect=[0, 600]),
        ):
            with self.assertRaisesRegex(TimeoutError, "scope did not drain"):
                run_all._wait_scope(process, None)
        self.assertEqual(run_all.SUITE_TIMEOUT_SECONDS, 600)


class RunnerObservations(unittest.TestCase):
    def test_concurrent_progress_writers_preserve_every_complete_record(self):
        with tempfile.TemporaryDirectory(prefix="progress-writers-") as directory:
            barrier = threading.Barrier(PROGRESS_WRITERS)

            def write(worker):
                barrier.wait(timeout=HANDSHAKE_TIMEOUT_SECONDS)
                for index in range(PROGRESS_EVENTS_PER_WRITER):
                    progress.emit("case", f"{worker}:{index}:" + "x" * (worker + index), "starting")

            with patch.dict(os.environ, {progress.PROGRESS_DIRECTORY: directory}):
                with ThreadPoolExecutor(max_workers=PROGRESS_WRITERS) as pool:
                    list(pool.map(write, range(PROGRESS_WRITERS)))
            lines = (
                (Path(directory) / f"{os.getpid()}.jsonl").read_text(encoding="utf-8").splitlines()
            )
            events = [json.loads(line) for line in lines]
            expected = {
                f"{worker}:{index}:" + "x" * (worker + index)
                for worker in range(PROGRESS_WRITERS)
                for index in range(PROGRESS_EVENTS_PER_WRITER)
            }
            self.assertEqual(len(events), len(expected))
            self.assertEqual({event["id"] for event in events}, expected)

    def probe(self, source, *, arguments=()):
        with (
            tempfile.TemporaryDirectory(prefix="observations-probe-") as directory,
            _child_environment(product_root=False) as environment,
        ):
            root = Path(directory)
            (root / "probe.py").write_text(source, encoding="utf-8")
            target = root / "report.json"
            environment["PYTHONPATH"] = str(root) + os.pathsep + environment["PYTHONPATH"]
            result = subprocess.run(
                [
                    sys.executable,
                    "-P",
                    str(Path(run_all.__file__).with_name("observations.py")),
                    "--module",
                    "probe",
                    "--report",
                    str(target),
                    *arguments,
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=HANDSHAKE_TIMEOUT_SECONDS,
            )
            return result, json.loads(target.read_text(encoding="utf-8"))

    def test_report_mode_prints_early_and_late_failure_tracebacks(self):
        with tempfile.TemporaryDirectory(prefix="runner-diagnostics-") as directory:
            root = Path(directory)
            package = root / "diagnostic_probe"
            package.mkdir()
            (package / "__init__.py").write_text("", encoding="utf-8")
            (package / "entry.py").write_text(
                "import unittest\n"
                "class Probe(unittest.TestCase):\n"
                " def test_first(self): raise RuntimeError('first diagnostic failure')\n"
                " def test_last(self): self.fail('last diagnostic failure ' + 'x' * 5000)\n"
                "if __name__ == '__main__': unittest.main()\n",
                encoding="utf-8",
            )
            target = root / "result.json"
            environment = dict(os.environ)
            environment["PYTHONPATH"] = os.pathsep.join(
                (str(root), str(SERVE_ROOT), str(REPOSITORY_ROOT))
            )
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import sys; from tests import run_all; "
                    "run_all.SUITES=['entry']; run_all.SLOW=[]; "
                    "run_all.SERVE_SUITE_PREFIX='diagnostic_probe.'; sys.exit(run_all.main())",
                    "--jobs",
                    "1",
                    "--case-report-dir",
                    str(root / "cases"),
                    "--report",
                    str(target),
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=HANDSHAKE_TIMEOUT_SECONDS,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["verdict"], "fail")
            self.assertIn("Traceback (most recent call last)", result.stderr)
            self.assertIn("RuntimeError: first diagnostic failure", result.stderr)
            self.assertIn("AssertionError: last diagnostic failure", result.stderr)

    def test_successful_child_with_missing_report_still_prints_failure_reason(self):
        with tempfile.TemporaryDirectory(prefix="runner-missing-report-") as directory:
            root = Path(directory)
            stderr = io.StringIO()
            with (
                patch.object(run_all, "SUITES", ["missing_probe"]),
                patch.object(run_all, "SLOW", []),
                patch.object(run_all, "_run_suite", return_value=("missing_probe", 0, "OK", "", 1)),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_all",
                        "--case-report-dir",
                        str(root),
                        "--report",
                        str(root / "result.json"),
                    ],
                ),
                redirect_stdout(io.StringIO()),
                redirect_stderr(stderr),
            ):
                self.assertEqual(run_all.main(), 1)
            self.assertIn("suite=missing_probe exit=0", stderr.getvalue())
            self.assertIn("missing_probe.json", stderr.getvalue())
            self.assertIn("[Errno 2]", stderr.getvalue())

    def isolated_source(self, body, *, methods=("test_probe",), setup="pass"):
        return (
            "import unittest\nfrom tests.utils import isolated_case\n"
            "class Probe(unittest.TestCase):\n"
            " def setUp(self):\n"
            + "".join("  " + line + "\n" for line in setup.splitlines())
            + " def exercise(self):\n"
            + "".join("  " + line + "\n" for line in body.splitlines())
            + "".join(" def " + method + "(self): self.exercise()\n" for method in methods)
            + "def load_tests(loader, tests, pattern):\n"
            " return unittest.TestSuite(isolated_case(case, 'probe') "
            "for case in loader.loadTestsFromTestCase(Probe))\n"
            "if __name__=='__main__':\n unittest.main()\n"
        )

    def test_isolated_pool_overlaps_children_without_sharing_state(self):
        source = self.isolated_source(
            "import os, time\n"
            "from pathlib import Path\n"
            "barrier=Path(__file__).parent / 'barrier'\n"
            "barrier.mkdir(exist_ok=True)\n"
            "(barrier/self._testMethodName).write_text(str(os.getpid()))\n"
            "deadline=time.monotonic()+10\n"
            "while len(list(barrier.iterdir())) != 2 and time.monotonic()<deadline: time.sleep(.01)\n"
            "self.assertEqual(len(list(barrier.iterdir())),2)\n"
            "self.case_isolation={'actualHome':os.environ['SCHOLARSEED_HOME'], 'actualDB':str(Path(os.environ['SCHOLARSEED_HOME'])/'db')}\n",
            methods=("test_first", "test_second"),
        )
        with patch.dict(os.environ, {"CI_ISOLATED_CASE_JOBS": "2"}):
            result, report = self.probe(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        children = [case["childObservation"] for case in report["cases"]]
        self.assertEqual(len({child["report"]["isolation"]["pid"] for child in children}), 2)
        self.assertEqual(len({child["report"]["isolation"]["root"] for child in children}), 2)
        for child in children:
            self.assertTrue(child["report"]["isolation"]["rootRemovedBeforeExit"])
            self.assertGreater(child["executionMs"], 0)
        self.assertEqual(report["cleanupErrors"], [])

    def test_isolated_pool_refills_before_ordered_result_delivery(self):
        source = self.isolated_source(
            "import time\n"
            "from pathlib import Path\n"
            "signal=Path(__file__).parent/'third-started'\n"
            "if self._testMethodName == 'test_first':\n"
            " deadline=time.monotonic()+10\n"
            " while not signal.exists() and time.monotonic()<deadline: time.sleep(.01)\n"
            " self.assertTrue(signal.exists(),'idle worker did not start third child')\n"
            "elif self._testMethodName == 'test_third': signal.touch()",
            methods=("test_first", "test_second", "test_third"),
        )
        with patch.dict(os.environ, {"CI_ISOLATED_CASE_JOBS": "2"}):
            result, report = self.probe(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            [case["id"] for case in report["cases"]],
            ["Probe.test_first", "Probe.test_second", "Probe.test_third"],
        )
        self.assertTrue(all(case["status"] == "passed" for case in report["cases"]))

    def test_isolated_pool_respects_serial_barriers(self):
        source = self.isolated_source(
            "from pathlib import Path\n"
            "root=Path(__file__).parent\n"
            "if self._testMethodName == 'test_first':\n"
            " self.assertFalse((root/'serial').exists())\n"
            " (root/'first').touch()\n"
            "else:\n"
            " self.assertTrue((root/'serial').exists())\n"
            " (root/'second').touch()",
            methods=("test_first", "test_second"),
        )
        source = source.replace(
            "def load_tests(loader, tests, pattern):",
            "class Serial(unittest.TestCase):\n"
            " def test_barrier(self):\n"
            "  from pathlib import Path\n"
            "  root=Path(__file__).parent\n"
            "  self.assertTrue((root/'first').exists())\n"
            "  self.assertFalse((root/'second').exists())\n"
            "  (root/'serial').touch()\n"
            "def load_tests(loader, tests, pattern):",
        ).replace(
            "return unittest.TestSuite(isolated_case(case, 'probe') "
            "for case in loader.loadTestsFromTestCase(Probe))",
            "return unittest.TestSuite([isolated_case(Probe('test_first'),'probe'), "
            "Serial('test_barrier'), isolated_case(Probe('test_second'),'probe')])",
        )
        with patch.dict(os.environ, {"CI_ISOLATED_CASE_JOBS": "2"}):
            result, report = self.probe(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            [case["id"] for case in report["cases"]],
            ["Probe.test_first", "Serial.test_barrier", "Probe.test_second"],
        )
        self.assertEqual(report["cleanupErrors"], [])

    def test_isolated_pool_preserves_failure_and_drains_failfast_children(self):
        for failfast in (False, True):
            source = self.isolated_source(
                "if self._testMethodName == 'test_first': self.fail('injected parallel failure')",
                methods=("test_first", "test_second"),
            )
            if failfast:
                source = source.replace("unittest.main()", "unittest.main(failfast=True)")
            with patch.dict(os.environ, {"CI_ISOLATED_CASE_JOBS": "2"}):
                result, report = self.probe(source)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(report["cases"][0]["status"], "failed")
            self.assertEqual(report["cleanupErrors"], [])
            self.assertEqual(len(report["cases"]), 1 if failfast else 2)
            for case in report["cases"]:
                self.assertTrue(
                    case["childObservation"]["report"]["isolation"]["rootRemovedBeforeExit"]
                )

    def test_nested_runner_does_not_replace_top_level_observations(self):
        result, report = self.probe(
            "import unittest\n"
            "class Outer(unittest.TestCase):\n"
            " def test_outer(self):\n"
            "  class Inner(unittest.TestCase):\n"
            "   def test_inner(self): self.fail('expected nested failure')\n"
            "  nested=unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Inner))\n"
            "  self.assertFalse(nested.wasSuccessful())\n"
            "unittest.main()\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["planned"], ["Outer.test_outer"])
        self.assertEqual(
            [{key: case[key] for key in ("id", "status", "retries")} for case in report["cases"]],
            [{"id": "Outer.test_outer", "status": "passed", "retries": 0}],
        )
        self.assertEqual(report["errors"], [])
        timings = report["cases"][0]["timings"]
        self.assertGreater(timings["testMs"], 0)
        self.assertGreaterEqual(timings["unattributedMs"], 0)
        self.assertGreaterEqual(report["timings"]["unattributedMs"], 0)
        result, report = self.probe(
            "import unittest\nclass Probe(unittest.IsolatedAsyncioTestCase):\n"
            " async def asyncSetUp(self): self.steps=['setup']; self.addAsyncCleanup(self.release)\n"
            " async def test_probe(self): self.steps.append('test')\n"
            " async def asyncTearDown(self): self.steps.append('teardown')\n"
            " async def release(self): self.assertEqual(self.steps,['setup','test','teardown'])\n"
            "unittest.main()\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        timings = report["cases"][0]["timings"]
        for phase in ("setupMs", "testMs", "teardownMs", "cleanupMs"):
            self.assertGreater(timings[phase], 0)
        self.assertGreaterEqual(timings["unattributedMs"], 0)
        result, report = self.probe(
            self.isolated_source(
                "import os, sqlite3\n"
                "from contextlib import closing\n"
                "from pathlib import Path\n"
                "from service.literature.persistence.store import LiteratureRepository, connect\n"
                "repository=LiteratureRepository()\n"
                "home=Path(os.environ['SCHOLARSEED_HOME']).resolve()\n"
                "self.assertTrue(repository.database.resolve().is_relative_to(home))\n"
                "self.case_isolation={'actualHome':str(home),'actualDB':str(repository.database)}\n"
                "with closing(connect()) as connection, connection:\n"
                " connection.execute('CREATE TABLE isolation_probe (id TEXT PRIMARY KEY, value TEXT)')\n"
                " self.assertEqual(connection.execute('SELECT * FROM isolation_probe').fetchall(),[])\n"
                " connection.execute('INSERT INTO isolation_probe VALUES (?,?)',('same-paper','literal'))\n"
                "with self.assertRaisesRegex(sqlite3.ProgrammingError, 'closed database'):\n"
                " connection.execute('SELECT 1')\n"
                "print('connection-closed-before-exit',flush=True)",
                methods=("test_first", "test_second"),
            )
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["planned"], ["Probe.test_first", "Probe.test_second"])
        children = [case["childObservation"] for case in report["cases"]]
        homes, databases, processes = set(), set(), set()
        for case, child in zip(report["cases"], children):
            self.assertEqual(child["exitStatus"], 0, child)
            self.assertEqual(child["report"]["planned"], [case["id"]])
            self.assertEqual(len(child["report"]["cases"]), 1)
            actual = child["report"]["cases"][0]
            homes.add(actual["isolation"]["actualHome"])
            databases.add(actual["isolation"]["actualDB"])
            processes.add(child["report"]["isolation"]["pid"])
            self.assertTrue(child["report"]["isolation"]["rootRemovedBeforeExit"])
            self.assertFalse(Path(child["report"]["isolation"]["root"]).exists())
            self.assertIn("connection-closed-before-exit", child["stdout"])
            self.assertEqual(json.loads(child["reportText"]), child["report"])
        for identities in (homes, databases, processes):
            self.assertEqual(len(identities), 2)

    def test_skips_and_cleanup_errors_cannot_pass(self):
        for body, status in (
            ("self.skipTest('unexpected skip')", "skipped"),
            ("self.addCleanup(lambda: 1/0); self.fail('body failure')", "error"),
        ):
            with self.subTest(status=status):
                result, report = self.probe(
                    "import unittest\nclass Probe(unittest.TestCase):\n"
                    " def test_probe(self): " + body + "\nunittest.main()\n"
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(report["cases"][0]["status"], status)
                self.assertEqual(report["exitStatus"], 1)
                if status == "error":
                    self.assertIn("body failure", result.stderr)
                    self.assertIn("ZeroDivisionError", result.stderr)
                    case = report["cases"][0]
                    self.assertEqual(case["failureCategory"], "cleanup_failure")
                    self.assertEqual(case["phase"], "cleanup")
                    self.assertGreater(case["timings"]["cleanupMs"], 0)
                    self.assertEqual(
                        [failure["failureCategory"] for failure in case["failures"]],
                        ["assertion_failure", "cleanup_failure"],
                    )
        result, report = self.probe(
            "import unittest\nclass Probe(unittest.TestCase):\n"
            " def test_probe(self): pass\n"
            " def tearDown(self): raise OSError('teardown failure')\n"
            "unittest.main()\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report["cases"][0]["failureCategory"], "cleanup_failure")
        self.assertEqual(report["cases"][0]["phase"], "cleanup")
        self.assertGreater(report["cases"][0]["timings"]["teardownMs"], 0)
        for body in (
            "self.skipTest('unexpected isolated skip')",
            "self.addCleanup(lambda: 1/0)\nself.fail('isolated body failure')",
        ):
            with self.subTest(isolated_body=body):
                result, report = self.probe(self.isolated_source(body))
                self.assertNotEqual(result.returncode, 0)
                case = report["cases"][0]
                child = case["childObservation"]
                self.assertNotEqual(child["exitStatus"], 0)
                self.assertTrue(child["report"]["isolation"]["rootRemovedBeforeExit"])
                if "addCleanup" in body:
                    for evidence in (case, child["report"]["cases"][0]):
                        self.assertEqual(
                            [failure["failureCategory"] for failure in evidence["failures"]],
                            ["assertion_failure", "cleanup_failure"],
                        )
                    self.assertIn("isolated body failure", child["stderr"])
                    self.assertIn("ZeroDivisionError", child["stderr"])
                else:
                    self.assertEqual(child["report"]["cases"][0]["status"], "skipped")
        result, report = self.probe(
            self.isolated_source(
                "import sqlite3,tempfile\n"
                "from pathlib import Path\n"
                "from tests.contract_literature_delivery import DeliveryContract\n"
                "case=DeliveryContract('test_concurrent_batch_append_preserves_all_papers')\n"
                "case.case_isolation={}\n"
                "with tempfile.TemporaryDirectory() as directory:\n"
                " connection=sqlite3.connect(Path(directory)/'leak.sqlite3')\n"
                " case.connections=[connection]\n"
                " with self.assertRaisesRegex(AssertionError,'survived case cleanup'):\n"
                "  case.verify_connections()\n"
                " self.assertFalse(case.case_isolation['connectionsClosedBeforeCleanup'])\n"
                " with self.assertRaisesRegex(sqlite3.ProgrammingError,'closed database'):\n"
                "  connection.execute('SELECT 1')\n"
                " case.verify_connections()\n"
                " self.assertTrue(case.case_isolation['connectionsClosedBeforeCleanup'])\n"
                "class WrongThread:\n"
                " @property\n"
                " def in_transaction(self):\n"
                "  raise sqlite3.ProgrammingError('SQLite objects created in a thread can only be used in that same thread')\n"
                " def close(self): pass\n"
                "case.connections=[WrongThread()]\n"
                "with self.assertRaises(BaseExceptionGroup) as failure: case.verify_connections()\n"
                "self.assertTrue(any(isinstance(error,sqlite3.ProgrammingError) "
                "for error in failure.exception.exceptions))\n"
                "self.assertFalse(case.case_isolation['connectionsClosedBeforeCleanup'])"
            )
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["cases"][0]["status"], "passed")
        result, report = self.probe(
            "import unittest\n"
            "if __name__!='__main__':\n"
            " def cleanup():\n"
            "  print('module-cleanup-attempted',flush=True)\n"
            "  raise OSError('isolated module cleanup failure')\n"
            " unittest.addModuleCleanup(cleanup)\n"
            " raise RuntimeError('isolated import body failure')\n" + self.isolated_source("pass")
        )
        self.assertNotEqual(result.returncode, 0)
        case = report["cases"][0]
        self.assertEqual(
            [failure["failureCategory"] for failure in case["failures"]],
            ["runner_error", "cleanup_failure"],
        )
        child = case["childObservation"]
        self.assertIn("isolated import body failure", " ".join(child["report"]["errors"]))
        self.assertIn("isolated module cleanup failure", " ".join(child["report"]["cleanupErrors"]))
        self.assertIn("module-cleanup-attempted", child["stdout"])
        self.assertTrue(child["report"]["isolation"]["rootRemovedBeforeExit"])
        for boundary in ("module", "class"):
            for body in ("pass", "self.fail('normal runner body failure')"):
                source = self.isolated_source(body)
                if boundary == "module":
                    source = source.replace(
                        "if __name__=='__main__':",
                        "def tearDownModule(): raise OSError('normal module teardown failure')\n"
                        "if __name__=='__main__':",
                    )
                else:
                    source = source.replace(
                        " def setUp(self):",
                        " @classmethod\n"
                        " def tearDownClass(cls): raise OSError('normal class teardown failure')\n"
                        " def setUp(self):",
                    )
                with self.subTest(teardown=boundary, body=body):
                    result, report = self.probe(source)
                    self.assertNotEqual(result.returncode, 0)
                    case = report["cases"][0]
                    expected = (["assertion_failure"] if body != "pass" else []) + [
                        "cleanup_failure"
                    ]
                    self.assertEqual(
                        [failure["failureCategory"] for failure in case["failures"]], expected
                    )
                    child = case["childObservation"]
                    self.assertTrue(child["report"]["cleanupErrors"])
                    self.assertTrue(
                        all(
                            error in child["report"]["errors"]
                            for error in child["report"]["cleanupErrors"]
                        )
                    )
                    self.assertIn("normal " + boundary + " teardown failure", child["stderr"])
                    if body != "pass":
                        self.assertIn("normal runner body failure", child["stderr"])
                    self.assertTrue(child["report"]["isolation"]["rootRemovedBeforeExit"])

    def test_missing_duplicate_and_custom_collection_are_rejected(self):
        source = (
            "import unittest\nclass Probe(unittest.TestCase):\n"
            " def setUp(self): raise AssertionError('collection ran setup')\n"
            " def test_original(self): raise AssertionError('collection ran body')\n"
            " def test_added(self): raise AssertionError('collection ran new body')\n"
            "unittest.main()\n"
        )
        result, collected = self.probe(source, arguments=("--collect-only",))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(collected["kind"], "collection")
        self.assertEqual(collected["planned"], ["Probe.test_added", "Probe.test_original"])
        self.assertNotIn("cases", collected)
        for broken in ("raise RuntimeError('import failed')\n", "pass\n"):
            result, collected = self.probe(broken, arguments=("--collect-only",))
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(collected["errors"])
        for source in (
            "pass\n",
            "import unittest\nclass Probe(unittest.TestCase):\n"
            " def test_probe(self): pass\n"
            "unittest.TextTestRunner().run(unittest.TestSuite([Probe('test_probe'),Probe('test_probe')]))\n",
            "import unittest\nclass Custom(unittest.TestSuite): pass\n"
            "unittest.TextTestRunner().run(Custom())\n",
        ):
            with self.subTest(source=source):
                result, report = self.probe(source)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(report["errors"])

        for selector in ("Probe", "Probe.test_missing"):
            with self.subTest(exact_selector=selector):
                result, report = self.probe(
                    self.isolated_source("pass"), arguments=("--case", selector)
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(report["errors"])

        for payload in (None, '{"schemaVersion":'):
            source = (
                "import subprocess\nfrom pathlib import Path\nfrom unittest.mock import patch\n"
                "def fake_run(command, **keywords):\n"
                " target=Path(command[command.index('--report')+1])\n"
                + (
                    " target.write_text(" + repr(payload) + ",encoding='utf-8')\n"
                    if payload
                    else ""
                )
                + " return subprocess.CompletedProcess(command,0,'raw-out','raw-error')\n"
                + self.isolated_source("pass").replace(
                    "unittest.main()\n",
                    "with patch('tests.utils.subprocess.run',side_effect=fake_run): unittest.main()\n",
                )
            )
            with self.subTest(child_report=payload):
                result, report = self.probe(source)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotEqual(report["cases"][0]["status"], "passed")
                child = report["cases"][0]["childObservation"]
                self.assertEqual(child["exitStatus"], 0)
                self.assertEqual(child["stdout"], "raw-out")
                self.assertEqual(child["stderr"], "raw-error")

        valid = {
            "schemaVersion": 1,
            "suite": "probe",
            "planned": ["Probe.test_probe"],
            "cases": [{"id": "Probe.test_probe", "status": "passed", "retries": 0}],
            "errors": [],
            "exitStatus": 0,
            "isolation": {"rootRemovedBeforeExit": True},
        }
        mutations = (
            {**valid, "schemaVersion": 2},
            {**valid, "suite": "different_owner"},
            {**valid, "cases": [{**valid["cases"][0], "retries": 1}]},
        )
        for invalid in (valid, *mutations):
            source = (
                "import subprocess\nfrom pathlib import Path\nfrom unittest.mock import patch\n"
                "def fake_run(command, **keywords):\n"
                " target=Path(command[command.index('--report')+1])\n"
                " target.write_text(" + repr(json.dumps(invalid)) + ",encoding='utf-8')\n"
                " return subprocess.CompletedProcess(command,0,'raw-out','raw-error')\n"
                + self.isolated_source("pass").replace(
                    "unittest.main()\n",
                    "with patch('tests.utils.subprocess.run',side_effect=fake_run): unittest.main()\n",
                )
            )
            with self.subTest(invalid_child_report=invalid):
                result, report = self.probe(source)
                if invalid is valid:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(report["cases"][0]["status"], "passed")
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotEqual(report["cases"][0]["status"], "passed")
                child = report["cases"][0]["childObservation"]
                self.assertEqual(child["exitStatus"], 0)
                self.assertEqual(child["report"], invalid)

    def test_partial_and_repeated_top_level_runs_are_rejected(self):
        for source in (
            "import unittest\nclass Probe(unittest.TestCase):\n"
            " def test_first(self): self.fail('stop')\n"
            " def test_second(self): pass\n"
            "unittest.TextTestRunner(failfast=True).run(unittest.defaultTestLoader.loadTestsFromTestCase(Probe))\n",
            "import unittest\nclass Probe(unittest.TestCase):\n"
            " def test_probe(self): pass\n"
            "for i in range(2): unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Probe))\n",
        ):
            with self.subTest(source=source):
                result, report = self.probe(source)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(report["errors"])

        with tempfile.TemporaryDirectory(prefix="case-placement-") as directory:
            parent = Path(directory)
            sentinel = parent / "sentinel"
            sentinel.write_text("do not delete", encoding="utf-8")
            arguments = ("--case", "Probe.test_probe", "--isolation-root", str(parent))
            for source, expected in (
                (
                    "import unittest\n"
                    "unittest.addModuleCleanup(lambda: print('module-cleaned-before-exit',flush=True))\n"
                    "raise RuntimeError('isolated import failure')\n",
                    "module-cleaned-before-exit",
                ),
                (
                    self.isolated_source(
                        "self.fail('body must not execute')",
                        setup="import sqlite3\n"
                        "from pathlib import Path\n"
                        "import os\n"
                        "home=Path(os.environ['SCHOLARSEED_HOME'])\n"
                        "home.mkdir(parents=True)\n"
                        "connection=sqlite3.connect(home/'partial.sqlite3')\n"
                        "def release():\n"
                        " connection.close()\n"
                        " with self.assertRaisesRegex(sqlite3.ProgrammingError,'closed database'):\n"
                        "  connection.execute('SELECT 1')\n"
                        " print('partial-setup-closed-before-exit',flush=True)\n"
                        "self.addCleanup(release)\n"
                        "raise RuntimeError('partial setup failure')",
                    ),
                    "partial-setup-closed-before-exit",
                ),
            ):
                with self.subTest(isolated_failure=expected):
                    result, report = self.probe(source, arguments=arguments)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(expected, result.stdout)
                    self.assertTrue(report["isolation"]["rootRemovedBeforeExit"])
                    self.assertFalse(Path(report["isolation"]["root"]).exists())
                    self.assertEqual(sentinel.read_text(encoding="utf-8"), "do not delete")
                    self.assertEqual(list(parent.iterdir()), [sentinel])

    def test_opt_in_embeds_actual_cases_and_default_command_stays_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="observations-contract-") as directory:
            root = Path(directory)
            timings = {}
            queued_at = run_all.time.perf_counter_ns()
            result = run_all._run_suite("contract_filenames", root, timings, queued_at)
            self.assertEqual(result[1], 0, result[3])
            report = run_all.write_report(
                root / "summary.json",
                ["contract_filenames"],
                {"contract_filenames": (result[1], result[4])},
                case_report_dir=root,
                timings_by_suite={"contract_filenames": timings},
            )
            rows = report["results"]
            assert isinstance(rows, list)
            observed = rows[0]["observations"]
            self.assertEqual(len(observed["planned"]), 5)
            self.assertEqual(len(observed["cases"]), 5)
            self.assertEqual(observed["exitStatus"], 0)
            self.assertEqual(report["verdict"], "pass")
            self.assertEqual(rows[0]["timings"], timings)
            for phase in (
                "queueWaitMs",
                "preparationMs",
                "processCreationMs",
                "childExecutionAndWaitMs",
                "scopeCheckMs",
                "directoryCleanupMs",
                "totalMs",
            ):
                self.assertGreaterEqual(timings[phase], 0)
            self.assertGreater(timings["childExecutionAndWaitMs"], 0)
            (root / "contract_filenames.json").unlink()
            missing = run_all.write_report(
                root / "missing.json",
                ["contract_filenames"],
                {"contract_filenames": (0, 1)},
                case_report_dir=root,
            )
            self.assertEqual(missing["verdict"], "fail")
            default = run_all.write_report(
                root / "default.json", ["contract_filenames"], {"contract_filenames": (0, 1)}
            )
            default_rows = default["results"]
            assert isinstance(default_rows, list)
            self.assertNotIn("observations", default_rows[0])
            self.assertNotIn("timings", default_rows[0])
        with patch.object(run_all, "_run_suite", side_effect=AssertionError("list executed tests")):
            output = io.StringIO()
            with patch.object(sys, "argv", ["run_all", "--list"]), redirect_stdout(output):
                self.assertEqual(run_all.main(), 0)
            self.assertEqual(json.loads(output.getvalue())["suites"], run_all.SUITES + run_all.SLOW)
        result, report = self.probe(
            "import importlib,json,unittest\n"
            "from tests.run_all import REPOSITORY_ROOT\n"
            "class Probe(unittest.TestCase):\n"
            " def test_collect(self):\n"
            "  module=importlib.import_module('tests.contract_literature_delivery')\n"
            "  module.DeliveryContract.test_collection_extension=lambda self: None\n"
            "  loader=unittest.defaultTestLoader\n"
            "  originals=list(loader.loadTestsFromTestCase(module.DeliveryContract))\n"
            "  methods={case._testMethodName:getattr(module.DeliveryContract,case._testMethodName) "
            "for case in originals}\n"
            "  wrapped=list(module.load_tests(loader,unittest.TestSuite(),None))\n"
            "  manifest=json.loads((REPOSITORY_ROOT/'scripts/ci/smoke.json').read_text())\n"
            "  expected=next(entry['requiredCases'] for entry in manifest['entries'] "
            "if entry['runner'].get('suite')=='contract_literature_delivery')\n"
            "  identities=lambda cases:['.'.join(case.id().split('.')[-2:]) for case in cases]\n"
            "  self.assertTrue(originals)\n"
            "  expected_cases=originals+list(loader.loadTestsFromTestCase(module.DeliveryIsolationContracts))\n"
            "  self.assertEqual(identities(wrapped),identities(expected_cases))\n"
            "  self.assertTrue(set(expected).issubset(identities(wrapped)))\n"
            "  self.assertEqual(len(set(identities(wrapped))),len(wrapped))\n"
            "  for name,method in methods.items():\n"
            "   self.assertIs(getattr(module.DeliveryContract,name),method)\n"
            "unittest.main()\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["planned"], ["Probe.test_collect"])


class WindowsOwnership(unittest.TestCase):
    def kernel(self):
        library = Mock()
        library.CreateJobObjectW.return_value = 101
        library.SetInformationJobObject.return_value = 1
        library.OpenProcess.return_value = 202
        library.AssignProcessToJobObject.return_value = 1
        library.CreateToolhelp32Snapshot.return_value = 303
        library.OpenThread.return_value = 404
        library.ResumeThread.return_value = 1
        library.CloseHandle.return_value = 1
        library.GetLastError.return_value = 18
        library.Thread32Next.return_value = 0
        library.TerminateJobObject.return_value = 1

        def first(snapshot, pointer):
            entry = ctypes.cast(pointer, ctypes.POINTER(ThreadEntry)).contents
            entry.process_id = 123
            entry.thread_id = 456
            return 1

        def accounting(handle, kind, pointer, size, returned):
            ctypes.cast(pointer, ctypes.POINTER(Accounting)).contents.active = 0
            return 1

        library.Thread32First.side_effect = first
        library.QueryInformationJobObject.side_effect = accounting
        return library

    def test_job_binds_before_resuming_and_excludes_breakaway_flags(self):
        library = self.kernel()
        job = WindowsJob(library)
        self.addCleanup(job.close)
        limits = ctypes.cast(
            library.SetInformationJobObject.call_args.args[2], ctypes.POINTER(ExtendedLimits)
        ).contents
        self.assertEqual(limits.basic.flags, 0x2000)
        self.assertEqual(ctypes.sizeof(Accounting), 48)
        self.assertEqual(ctypes.sizeof(ThreadEntry), 28)
        job.attach_and_resume(123)
        calls = [call[0] for call in library.mock_calls]
        self.assertLess(calls.index("AssignProcessToJobObject"), calls.index("ResumeThread"))
        library.OpenProcess.assert_called_once_with(0x0101, False, 123)
        library.OpenThread.assert_called_once_with(0x0002, False, 456)
        self.assertEqual(
            [call.args[0] for call in library.CloseHandle.call_args_list], [202, 404, 303]
        )
        self.assertFalse(job.active())
        library.QueryInformationJobObject.side_effect = (
            lambda handle, kind, pointer, size, returned: (
                setattr(ctypes.cast(pointer, ctypes.POINTER(Accounting)).contents, "active", 3) or 1
            )
        )
        self.assertTrue(job.active())
        job.terminate()
        library.TerminateJobObject.assert_called_once_with(101, 1)
        job.close()
        self.assertIsNone(job.handle)
        self.assertEqual(library.CloseHandle.call_args.args, (101,))

    def test_assignment_and_snapshot_failures_never_resume_unowned_code(self):
        for operation, value in (
            ("OpenProcess", 0),
            ("AssignProcessToJobObject", 0),
            ("CreateToolhelp32Snapshot", ctypes.c_void_p(-1).value),
            ("OpenThread", 0),
        ):
            with self.subTest(operation=operation):
                library = self.kernel()
                getattr(library, operation).return_value = value
                job = WindowsJob(library)
                try:
                    with self.assertRaises(OSError):
                        job.attach_and_resume(123)
                    library.ResumeThread.assert_not_called()
                finally:
                    job.close()

    def test_ambiguous_threads_and_wrong_suspend_counts_are_rejected(self):
        library = self.kernel()
        job = WindowsJob(library)
        self.addCleanup(job.close)

        def second(snapshot, pointer):
            entry = ctypes.cast(pointer, ctypes.POINTER(ThreadEntry)).contents
            entry.thread_id = 789
            return 1

        def next_thread(snapshot, pointer):
            library.Thread32Next.side_effect = None
            library.Thread32Next.return_value = 0
            return second(snapshot, pointer)

        library.Thread32Next.side_effect = next_thread
        with self.assertRaisesRegex(RuntimeError, "exactly one initial thread"):
            job.attach_and_resume(123)
        library.ResumeThread.assert_not_called()
        for count in (0, 2, 0xFFFFFFFF):
            with self.subTest(previous_suspend_count=count):
                library.ResumeThread.return_value = count
                with self.assertRaisesRegex(RuntimeError, "suspended exactly once"):
                    job.attach_and_resume(123)

    def test_query_termination_and_close_failures_cannot_report_empty_or_closed(self):
        library = self.kernel()
        job = WindowsJob(library)
        self.addCleanup(job.close)
        library.QueryInformationJobObject.side_effect = None
        library.QueryInformationJobObject.return_value = 0
        with self.assertRaises(OSError):
            job.active()
        library.TerminateJobObject.return_value = 0
        with self.assertRaises(OSError):
            job.terminate()
        library.CloseHandle.side_effect = [0, 1]
        with self.assertRaises(OSError):
            job.close()
        self.assertEqual(job.handle, 101)
        job.close()
        self.assertIsNone(job.handle)

    def test_limit_setup_failure_releases_the_created_job(self):
        library = self.kernel()
        library.SetInformationJobObject.return_value = 0
        with self.assertRaises(OSError):
            WindowsJob(library)
        library.CloseHandle.assert_called_once_with(101)


if __name__ == "__main__":
    unittest.main()
