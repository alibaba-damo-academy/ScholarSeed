"""Native process ownership for the test runner, not product execution."""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from enum import IntEnum
from pathlib import Path

from .observations import CLEANUP_FAILURE, RUNNER_ERROR, SCHEMA_VERSION, SUCCESS
from .prefetch import IsolatedExecution

JOB_TERMINATION_EXIT_CODE = 1
CASE_STATE_PREFIX = "case-state-"
CASE_ARTIFACT_PREFIX = "case-evidence-"


def isolated_case(original: unittest.TestCase, module: str) -> unittest.TestCase:
    """Keep a collected identity while executing its original public unittest selector."""

    class IsolatedCase(unittest.TestCase, IsolatedExecution):
        def id(self):
            return original.id()

        def shortDescription(self):
            return original.shortDescription()

        def __str__(self):
            return str(original)

        def check_cleanup(self):
            self.state.rmdir()
            if self.child_observation is None:
                return
            evidence = self.child_observation
            report = evidence.get("report", {})
            failures = [
                failure
                for case in report.get("cases", [])
                for failure in case.get("failures", [])
                if failure["failureCategory"] == CLEANUP_FAILURE
            ]
            self.assertFalse(failures, evidence)
            self.assertFalse(report.get("cleanupErrors", []), evidence)
            self.assertFalse(self.state.exists(), evidence)
            self.assertTrue(report.get("isolation", {}).get("rootRemovedBeforeExit"), evidence)

        def runTest(self):
            if hasattr(self, "prepare_execution"):
                self.prepare_execution()
                try:
                    self.execution.result()
                finally:
                    self.finished()
            else:
                self.execute()

        def execute(self):
            started = time.perf_counter_ns()
            repository = Path(__file__).resolve().parents[3]
            artifact_parent = getattr(
                self, "observation_artifacts", repository / "tmp" / "test_snapshot" / "cases"
            )
            artifact_parent.mkdir(parents=True, exist_ok=True)
            artifact = Path(tempfile.mkdtemp(prefix=CASE_ARTIFACT_PREFIX, dir=artifact_parent))
            self.state = Path(tempfile.mkdtemp(prefix=CASE_STATE_PREFIX, dir=artifact)).resolve()
            self.child_observation = None
            self.addCleanup(self.check_cleanup)
            environment = dict(os.environ)
            selector = ".".join(original.id().split(".")[-2:])
            target = artifact / "observations.json"
            result = subprocess.run(
                [
                    sys.executable,
                    "-P",
                    str(Path(__file__).with_name("observations.py")),
                    "--module",
                    module,
                    "--case",
                    selector,
                    "--isolation-root",
                    str(self.state),
                    "--report",
                    str(target),
                ],
                cwd=Path(__file__).resolve().parents[1],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.child_observation = {
                "executionMs": (time.perf_counter_ns() - started) / 1_000_000,
                "artifactDirectory": str(artifact),
                "exitStatus": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            for name, content in (("stdout.txt", result.stdout), ("stderr.txt", result.stderr)):
                (artifact / name).write_text(content, encoding="utf-8")
            (artifact / "exit.json").write_text(
                json.dumps({"exitStatus": result.returncode}) + "\n", encoding="utf-8"
            )
            self.child_observation["reportText"] = target.read_text(encoding="utf-8")
            report = json.loads(self.child_observation["reportText"])
            self.child_observation["report"] = report
            self.assertEqual(report["schemaVersion"], SCHEMA_VERSION, self.child_observation)
            self.assertEqual(report["suite"], module.rsplit(".", 1)[-1], self.child_observation)
            runner_errors = [
                error for error in report["errors"] if error not in report.get("cleanupErrors", [])
            ]
            if runner_errors:
                raise RuntimeError(self.child_observation)
            self.assertEqual(report["planned"], [selector], self.child_observation)
            self.assertEqual([case["id"] for case in report["cases"]], [selector])
            case = report["cases"][0]
            self.assertEqual(case["retries"], 0, self.child_observation)
            failures = case.get("failures", [])
            body_failures = [
                failure for failure in failures if failure["failureCategory"] != CLEANUP_FAILURE
            ]
            if any(failure["failureCategory"] == RUNNER_ERROR for failure in body_failures):
                raise RuntimeError(self.child_observation)
            self.assertFalse(body_failures, self.child_observation)
            if not failures:
                self.assertEqual(case["status"], SUCCESS, self.child_observation)
                if not report.get("cleanupErrors"):
                    self.assertEqual(result.returncode, 0, self.child_observation)
                    self.assertEqual(report["exitStatus"], 0, self.child_observation)

    IsolatedCase.__module__ = original.__class__.__module__
    return IsolatedCase()


class WindowsFlag(IntEnum):
    CREATE_SUSPENDED = 0x00000004
    JOB_KILL_ON_CLOSE = 0x00002000
    JOB_EXTENDED_LIMITS = 9
    JOB_ACCOUNTING = 1
    PROCESS_SET_QUOTA_AND_TERMINATE = 0x0101
    THREAD_SUSPEND_RESUME = 0x0002
    SNAPSHOT_THREADS = 0x00000004
    NO_MORE_FILES = 18
    SUSPENDED_ONCE = 1


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_int64),
        ("job_time", ctypes.c_int64),
        ("flags", ctypes.c_uint32),
        ("minimum", ctypes.c_size_t),
        ("maximum", ctypes.c_size_t),
        ("active", ctypes.c_uint32),
        ("affinity", ctypes.c_size_t),
        ("priority", ctypes.c_uint32),
        ("scheduling", ctypes.c_uint32),
    ]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", BasicLimits),
        ("io", ctypes.c_uint64 * 6),
        ("process_memory", ctypes.c_size_t),
        ("job_memory", ctypes.c_size_t),
        ("peak_process", ctypes.c_size_t),
        ("peak_job", ctypes.c_size_t),
    ]


class Accounting(ctypes.Structure):
    _fields_ = [
        ("times", ctypes.c_int64 * 4),
        ("faults", ctypes.c_uint32),
        ("total", ctypes.c_uint32),
        ("active", ctypes.c_uint32),
        ("terminated", ctypes.c_uint32),
    ]


class ThreadEntry(ctypes.Structure):
    _fields_ = [
        ("size", ctypes.c_uint32),
        ("usage", ctypes.c_uint32),
        ("thread_id", ctypes.c_uint32),
        ("process_id", ctypes.c_uint32),
        ("base_priority", ctypes.c_int32),
        ("delta_priority", ctypes.c_int32),
        ("flags", ctypes.c_uint32),
    ]


class WindowsJob:
    """Assign a suspended suite before it can start any descendants."""

    def __init__(self, library=None):
        if library is not None:
            self.api = library
        elif sys.platform == "win32":
            self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        else:
            raise OSError("Windows Job Objects require a Windows host")
        self.handle = None
        signatures = {
            "CreateJobObjectW": (ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_wchar_p]),
            "SetInformationJobObject": (
                ctypes.c_int32,
                [ctypes.c_void_p, ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32],
            ),
            "OpenProcess": (ctypes.c_void_p, [ctypes.c_uint32, ctypes.c_int32, ctypes.c_uint32]),
            "AssignProcessToJobObject": (ctypes.c_int32, [ctypes.c_void_p, ctypes.c_void_p]),
            "QueryInformationJobObject": (
                ctypes.c_int32,
                [
                    ctypes.c_void_p,
                    ctypes.c_int32,
                    ctypes.c_void_p,
                    ctypes.c_uint32,
                    ctypes.c_void_p,
                ],
            ),
            "TerminateJobObject": (ctypes.c_int32, [ctypes.c_void_p, ctypes.c_uint32]),
            "CreateToolhelp32Snapshot": (ctypes.c_void_p, [ctypes.c_uint32, ctypes.c_uint32]),
            "Thread32First": (ctypes.c_int32, [ctypes.c_void_p, ctypes.POINTER(ThreadEntry)]),
            "Thread32Next": (ctypes.c_int32, [ctypes.c_void_p, ctypes.POINTER(ThreadEntry)]),
            "OpenThread": (ctypes.c_void_p, [ctypes.c_uint32, ctypes.c_int32, ctypes.c_uint32]),
            "ResumeThread": (ctypes.c_uint32, [ctypes.c_void_p]),
            "CloseHandle": (ctypes.c_int32, [ctypes.c_void_p]),
            "GetLastError": (ctypes.c_uint32, []),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(self.api, name)
            function.restype = result
            function.argtypes = arguments
        self.handle = self.checked(self.api.CreateJobObjectW(None, None), "CreateJobObjectW")
        try:
            limits = ExtendedLimits()
            limits.basic.flags = WindowsFlag.JOB_KILL_ON_CLOSE
            self.checked(
                self.api.SetInformationJobObject(
                    self.handle,
                    WindowsFlag.JOB_EXTENDED_LIMITS,
                    ctypes.byref(limits),
                    ctypes.sizeof(limits),
                ),
                "SetInformationJobObject",
            )
        except BaseException:
            self.close()
            raise

    def checked(self, value, operation):
        if not value:
            raise OSError(self.api.GetLastError(), f"{operation} failed")
        return value

    def attach_and_resume(self, pid: int) -> None:
        process = self.checked(
            self.api.OpenProcess(WindowsFlag.PROCESS_SET_QUOTA_AND_TERMINATE, False, pid),
            "OpenProcess",
        )
        try:
            self.checked(
                self.api.AssignProcessToJobObject(self.handle, process), "AssignProcessToJobObject"
            )
        finally:
            self.checked(self.api.CloseHandle(process), "CloseHandle(process)")
        snapshot = self.api.CreateToolhelp32Snapshot(WindowsFlag.SNAPSHOT_THREADS, 0)
        if snapshot in (None, ctypes.c_void_p(-1).value):
            raise OSError(self.api.GetLastError(), "CreateToolhelp32Snapshot failed")
        try:
            entry = ThreadEntry()
            entry.size = ctypes.sizeof(entry)
            threads = []
            available = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while available:
                if entry.process_id == pid:
                    threads.append(entry.thread_id)
                available = self.api.Thread32Next(snapshot, ctypes.byref(entry))
            if self.api.GetLastError() != WindowsFlag.NO_MORE_FILES:
                raise OSError(self.api.GetLastError(), "thread enumeration failed")
            if len(threads) != 1:
                raise RuntimeError("suspended suite does not have exactly one initial thread")
            thread = self.checked(
                self.api.OpenThread(WindowsFlag.THREAD_SUSPEND_RESUME, False, threads[0]),
                "OpenThread",
            )
            try:
                if self.api.ResumeThread(thread) != WindowsFlag.SUSPENDED_ONCE:
                    raise RuntimeError("suite initial thread was not suspended exactly once")
            finally:
                self.checked(self.api.CloseHandle(thread), "CloseHandle(thread)")
        finally:
            self.checked(self.api.CloseHandle(snapshot), "CloseHandle(snapshot)")

    def active(self) -> bool:
        accounting = Accounting()
        self.checked(
            self.api.QueryInformationJobObject(
                self.handle,
                WindowsFlag.JOB_ACCOUNTING,
                ctypes.byref(accounting),
                ctypes.sizeof(accounting),
                None,
            ),
            "QueryInformationJobObject",
        )
        return bool(accounting.active)

    def terminate(self) -> None:
        self.checked(
            self.api.TerminateJobObject(self.handle, JOB_TERMINATION_EXIT_CODE),
            "TerminateJobObject",
        )

    def close(self) -> None:
        if self.handle is not None:
            self.checked(self.api.CloseHandle(self.handle), "CloseHandle(job)")
            self.handle = None
