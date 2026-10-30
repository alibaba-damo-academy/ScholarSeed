"""Map explicitly selected ephemeral credentials before executing a stdio server."""

from __future__ import annotations

import ctypes
import json
import os
import re
import subprocess
import sys
import uuid
from ctypes import wintypes
from typing import Mapping

MCP_SECRET_ENVIRONMENT_PREFIX = "SCHOLARSEED_MCP_SECRET_"
MCP_LAUNCH_INVALID = "mcp_launch_invalid"
MCP_LAUNCH_FAILED = "scholarseed_mcp_launch_failed"
MCP_DIAGNOSTIC_VERSION = 1
MCP_LAUNCH_FAILURE_EXIT = 1
MCP_BINDINGS_ARGUMENT = 1
MCP_COMMAND_ARGUMENT = 2
MCP_MIN_ARGUMENT_COUNT = 3
JOB_EXTENDED_INFORMATION = 9
JOB_KILL_ON_CLOSE = 0x00002000


class JobLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_longlong),
        ("job_time", ctypes.c_longlong),
        ("flags", wintypes.DWORD),
        ("minimum_working_set", ctypes.c_size_t),
        ("maximum_working_set", ctypes.c_size_t),
        ("active_processes", wintypes.DWORD),
        ("affinity", ctypes.c_size_t),
        ("priority", wintypes.DWORD),
        ("scheduling", wintypes.DWORD),
    ]


class JobCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_ulonglong)
        for name in (
            "read_operations",
            "write_operations",
            "other_operations",
            "read_bytes",
            "write_bytes",
            "other_bytes",
        )
    ]


class JobInformation(ctypes.Structure):
    _fields_ = [
        ("limits", JobLimits),
        ("io", JobCounters),
        ("process_memory", ctypes.c_size_t),
        ("job_memory", ctypes.c_size_t),
        ("peak_process_memory", ctypes.c_size_t),
        ("peak_job_memory", ctypes.c_size_t),
    ]


MCP_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def server_environment(bindings: Mapping[str, str], inherited: Mapping[str, str]) -> dict[str, str]:
    names: set[str] = set()
    environment = {
        name: value
        for name, value in inherited.items()
        if not name.casefold().startswith(MCP_SECRET_ENVIRONMENT_PREFIX.casefold())
    }
    for target, source in bindings.items():
        if (
            not isinstance(target, str)
            or not isinstance(source, str)
            or not MCP_ENVIRONMENT_NAME.fullmatch(target)
            or not MCP_ENVIRONMENT_NAME.fullmatch(source)
            or not source.startswith(MCP_SECRET_ENVIRONMENT_PREFIX)
            or target.casefold().startswith(MCP_SECRET_ENVIRONMENT_PREFIX.casefold())
            or target.casefold() in names
        ):
            raise ValueError(MCP_LAUNCH_INVALID)
        names.add(target.casefold())
        selected = [
            value for name, value in inherited.items() if name.casefold() == source.casefold()
        ]
        if len(selected) != 1 or "\x00" in selected[0]:
            raise ValueError(MCP_LAUNCH_INVALID)
        environment = {
            name: value
            for name, value in environment.items()
            if name.casefold() != target.casefold()
        }
        environment[target] = selected[0]
    return environment


def windows_family() -> int:
    """Join a private, non-breakaway Job before any server code can execute.

    The handle is deliberately retained until this one-shot launcher exits.
    Closing it earlier would terminate the launcher itself. It is non-inheritable;
    kernel process teardown closes the last handle and terminates descendants,
    even when Codex's outer Job is unavailable or only this launcher is killed.
    """
    kernel = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetLastError.argtypes = []
    kernel.GetLastError.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise getattr(ctypes, "WinError")(kernel.GetLastError())
    information = JobInformation()
    information.limits.flags = JOB_KILL_ON_CLOSE
    if not kernel.SetInformationJobObject(
        job, JOB_EXTENDED_INFORMATION, ctypes.byref(information), ctypes.sizeof(information)
    ) or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        code = kernel.GetLastError()
        kernel.CloseHandle(job)
        raise getattr(ctypes, "WinError")(code)
    return int(job)


def main() -> int:
    stage = "bindings"
    try:
        if len(sys.argv) < MCP_MIN_ARGUMENT_COUNT:
            raise ValueError(MCP_LAUNCH_INVALID)
        bindings = json.loads(sys.argv[MCP_BINDINGS_ARGUMENT])
        if not isinstance(bindings, dict):
            raise ValueError(MCP_LAUNCH_INVALID)
        environment = server_environment(bindings, os.environ)
        arguments = sys.argv[MCP_COMMAND_ARGUMENT:]
        if os.name == "nt":
            stage = "containment"
            windows_family()
            stage = "exec"
            # Retain stdio/argv and the true exit code; the private Job is already
            # inherited by every child before its first instruction executes.
            return subprocess.call(
                arguments, env=environment, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr
            )
        stage = "exec"
        os.execvpe(arguments[0], arguments, environment)
    except (OSError, ValueError, TypeError) as error:
        # stdout is the MCP protocol. Never include argv, bindings or exception text.
        print(
            json.dumps(
                {
                    "event": MCP_LAUNCH_FAILED,
                    "schema_version": MCP_DIAGNOSTIC_VERSION,
                    "stage": stage,
                    "error_type": "os_error" if isinstance(error, OSError) else "invalid_bindings",
                    "errno": error.errno if isinstance(error, OSError) else None,
                    "winerror": (
                        getattr(error, "winerror", None) if isinstance(error, OSError) else None
                    ),
                    "correlation_id": uuid.uuid4().hex,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
            flush=True,
        )
        return MCP_LAUNCH_FAILURE_EXIT
    return MCP_LAUNCH_FAILURE_EXIT


if __name__ == "__main__":
    raise SystemExit(main())
