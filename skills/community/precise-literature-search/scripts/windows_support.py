"""Windows 10+ process ownership and private files, using only Win32/stdlib.

A pool worker owns a named, non-breakaway Job Object for its entire lifetime.
The adapter can exit while paused; subsequent adapters reopen and verify the job.
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
import json
import os
from pathlib import Path
import subprocess
import signal
import socket
import sys
import time
import uuid

if os.name != "nt":
    raise ImportError("windows_support is only available on Windows")

K = C.WinDLL("kernel32", use_last_error=True)
A = C.WinDLL("advapi32", use_last_error=True)


def api(dll, name, result, *arguments):
    function = getattr(dll, name)
    function.restype, function.argtypes = result, list(arguments)
    return function


close = api(K, "CloseHandle", W.BOOL, W.HANDLE)
current = api(K, "GetCurrentProcess", W.HANDLE)
open_process = api(K, "OpenProcess", W.HANDLE, W.DWORD, W.BOOL, W.DWORD)
get_times = api(K, "GetProcessTimes", W.BOOL, W.HANDLE, *([C.POINTER(W.FILETIME)] * 4))
create_job = api(K, "CreateJobObjectW", W.HANDLE, C.c_void_p, W.LPCWSTR)
open_job = api(K, "OpenJobObjectW", W.HANDLE, W.DWORD, W.BOOL, W.LPCWSTR)
set_job = api(K, "SetInformationJobObject", W.BOOL, W.HANDLE, C.c_int, C.c_void_p, W.DWORD)
query_job = api(K, "QueryInformationJobObject", W.BOOL, W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.c_void_p)
assign_job = api(K, "AssignProcessToJobObject", W.BOOL, W.HANDLE, W.HANDLE)
in_job = api(K, "IsProcessInJob", W.BOOL, W.HANDLE, W.HANDLE, C.POINTER(W.BOOL))
terminate_job = api(K, "TerminateJobObject", W.BOOL, W.HANDLE, W.UINT)


class BasicLimits(C.Structure):
    _fields_ = [("process_time", C.c_int64), ("job_time", C.c_int64),
                ("flags", W.DWORD), ("minimum", C.c_size_t), ("maximum", C.c_size_t),
                ("active", W.DWORD), ("affinity", C.c_size_t),
                ("priority", W.DWORD), ("scheduling", W.DWORD)]


class ExtendedLimits(C.Structure):
    _fields_ = [("basic", BasicLimits), ("io", C.c_uint64 * 6),
                ("process_memory", C.c_size_t), ("job_memory", C.c_size_t),
                ("peak_process", C.c_size_t), ("peak_job", C.c_size_t)]


class Accounting(C.Structure):
    _fields_ = [("times", C.c_int64 * 4), ("faults", W.DWORD),
                ("total", W.DWORD), ("active", W.DWORD), ("terminated", W.DWORD)]


def checked(value):
    if not value:
        raise C.WinError(C.get_last_error())
    return value


def identity_handle(handle):
    times = [W.FILETIME() for _ in range(4)]
    checked(get_times(handle, *(C.byref(value) for value in times)))
    return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)


def process_identity(pid):
    handle = open_process(0x1000, False, int(pid))
    if not handle:
        if C.get_last_error() == 87:  # PID no longer exists.
            return None
        raise C.WinError(C.get_last_error())
    try:
        return identity_handle(handle)
    finally:
        close(handle)


def job_handle(name):
    handle = open_job(0x0004 | 0x0008, False, name)  # QUERY | TERMINATE
    if not handle and C.get_last_error() != 2:
        raise C.WinError(C.get_last_error())
    return handle


def active_count(handle):
    info = Accounting()
    checked(query_job(handle, 1, C.byref(info), C.sizeof(info), None))
    return info.active


def record_active(record):
    if not record or not record.get("job"):
        return False
    handle = job_handle(record["job"])
    if not handle:
        return False
    try:
        return bool(active_count(handle))
    finally:
        close(handle)


def verify_record(record, handle):
    process = open_process(0x1000, False, int(record["pid"]))
    checked(process)
    try:
        belongs = W.BOOL()
        checked(in_job(process, handle, C.byref(belongs)))
        if not belongs.value or identity_handle(process) != record["started"]:
            raise ValueError("Process ownership cannot be verified; browser slot remains reserved")
    finally:
        close(process)


def stop_record(record, timeout=5):
    if not record:
        return
    if not record.get("job"):
        raise ValueError("Missing Windows job ownership; close old processes manually")
    handle = job_handle(record["job"])
    if not handle:
        return
    try:
        if not active_count(handle):
            return
        verify_record(record, handle)
        checked(terminate_job(handle, 1))
        deadline = time.monotonic() + timeout
        while active_count(handle):
            if time.monotonic() >= deadline:
                raise ValueError("Windows process job did not exit; slot remains reserved")
            time.sleep(0.05)
    finally:
        close(handle)


def own_job(name, *, allow_breakaway=False):
    handle = checked(create_job(None, name))
    try:
        if C.get_last_error() == 183:
            raise ValueError("Windows job name already exists")
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000 | (0x800 if allow_breakaway else 0)  # KILL_ON_JOB_CLOSE
        checked(set_job(handle, 9, C.byref(limits), C.sizeof(limits)))
        checked(assign_job(handle, current()))
        return handle
    except BaseException:
        close(handle)
        raise


def start_worker(script, mode, *, kwargs=None, breakaway=False):
    """A loopback gate preserves the caller's stdin for interactive downloads."""
    name = "Local\\precise-literature-search-" + uuid.uuid4().hex
    token = uuid.uuid4().hex
    options = dict(kwargs or {})
    # Match CPython multiprocessing: bypass the Windows venv redirector so
    # Popen.pid identifies the interpreter which owns the Job, while retaining
    # the venv's sys.executable, prefix and site-packages.
    executable = sys.executable
    base_executable = getattr(sys, "_base_executable", executable)
    if os.path.normcase(executable) != os.path.normcase(base_executable):
        environment = dict(options.get("env") if options.get("env") is not None else os.environ)
        environment["__PYVENV_LAUNCHER__"] = executable
        options["env"] = environment
        executable = base_executable
    options["creationflags"] = 0x200 | (0x01000000 if breakaway else 0)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        command = [executable, str(script), mode, name,
                   str(listener.getsockname()[1]), token]
        process = subprocess.Popen(command, **options)
        connection = None
        try:
            connection, _ = listener.accept()
            connection.settimeout(15)
            with connection.makefile("rb") as ready:
                if ready.readline(128) != (token + "\n").encode("ascii"):
                    raise ValueError("Windows worker gate authentication failed")
            record = {"pid": process.pid, "started": process_identity(process.pid), "job": name}
            handle = checked(job_handle(name))
            try:
                verify_record(record, handle)
            finally:
                close(handle)
            process._pls_gate = connection
            process._pls_record = record
            return process, record
        except BaseException:
            if connection:
                connection.close()
            process.terminate()
            process.wait(timeout=5)
            raise


def worker_request(name, port, token, *, allow_breakaway=False):
    job = own_job(name, allow_breakaway=allow_breakaway)
    with socket.create_connection(("127.0.0.1", int(port)), timeout=15) as connection:
        connection.sendall((token + "\n").encode("ascii"))
        with connection.makefile("rb") as incoming:
            line = incoming.readline(1024 * 1024)
    if not line:
        return job, None  # Parent exited before granting any command.
    if not line.endswith(b"\n"):
        raise ValueError("Windows worker request is too large")
    return job, json.loads(line)


def grant(process, request):
    connection = process._pls_gate
    try:
        connection.sendall((json.dumps(request, ensure_ascii=True) + "\n").encode("ascii"))
    finally:
        connection.close()


def current_user_sid():
    """Return the numeric SID from this process's user token (never an SDDL alias)."""
    open_token = api(A, "OpenProcessToken", W.BOOL, W.HANDLE, W.DWORD, C.POINTER(W.HANDLE))
    token_info = api(A, "GetTokenInformation", W.BOOL, W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD))
    sid_string = api(A, "ConvertSidToStringSidW", W.BOOL, C.c_void_p, C.POINTER(W.LPWSTR))
    local_free = api(K, "LocalFree", C.c_void_p, C.c_void_p)
    token, size, sid = W.HANDLE(), W.DWORD(), W.LPWSTR()
    checked(open_token(current(), 8, C.byref(token)))
    try:
        token_info(token, 1, None, 0, C.byref(size))
        buffer = C.create_string_buffer(size.value)
        checked(token_info(token, 1, buffer, size, C.byref(size)))
        checked(sid_string(C.cast(buffer, C.POINTER(C.c_void_p))[0], C.byref(sid)))
        user_sid = sid.value
    finally:
        if sid:
            local_free(sid)
        close(token)
    return user_sid


def secure_directory(path):
    """Protect owned data with inheritable full access for this user/SYSTEM/admins."""
    user_sid = current_user_sid()
    local_free = api(K, "LocalFree", C.c_void_p, C.c_void_p)
    sddl = f"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user_sid})"
    convert = api(A, "ConvertStringSecurityDescriptorToSecurityDescriptorW", W.BOOL,
                  W.LPCWSTR, W.DWORD, C.POINTER(C.c_void_p), C.c_void_p)
    get_dacl = api(A, "GetSecurityDescriptorDacl", W.BOOL, C.c_void_p,
                   C.POINTER(W.BOOL), C.POINTER(C.c_void_p), C.POINTER(W.BOOL))
    set_security = api(A, "SetNamedSecurityInfoW", W.DWORD, W.LPWSTR, C.c_int,
                      W.DWORD, C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p)
    descriptor, dacl, present, defaulted = C.c_void_p(), C.c_void_p(), W.BOOL(), W.BOOL()
    checked(convert(sddl, 1, C.byref(descriptor), None))
    try:
        checked(get_dacl(descriptor, C.byref(present), C.byref(dacl), C.byref(defaulted)))
        error = set_security(str(path), 1, 0x80000004, None, None, dacl, None)
        if error:
            raise C.WinError(error)
    finally:
        local_free(descriptor)


def open_regular(path):
    import msvcrt
    create_file = api(K, "CreateFileW", W.HANDLE, W.LPCWSTR, W.DWORD, W.DWORD,
                      C.c_void_p, W.DWORD, W.DWORD, W.HANDLE)
    file_info = api(K, "GetFileInformationByHandleEx", W.BOOL, W.HANDLE, C.c_int, C.c_void_p, W.DWORD)
    handle = create_file(str(path), 0x80000000, 1, None, 3, 0x00200000, None)
    if handle == W.HANDLE(-1).value:
        raise C.WinError(C.get_last_error())
    try:
        attributes = (W.DWORD * 2)()
        checked(file_info(handle, 9, attributes, C.sizeof(attributes)))
        if attributes[0] & (0x400 | 0x10):
            raise ValueError("Profile contains a reparse point or non-regular file")
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None  # descriptor now owns the Win32 handle
        return descriptor
    finally:
        if handle:
            close(handle)


def command_arguments(command):
    shell = C.WinDLL("shell32", use_last_error=True)
    parse = api(shell, "CommandLineToArgvW", C.POINTER(W.LPWSTR), W.LPCWSTR, C.POINTER(C.c_int))
    local_free = api(K, "LocalFree", C.c_void_p, C.c_void_p)
    count = C.c_int()
    arguments = checked(parse(command, C.byref(count)))
    try:
        return [arguments[i] for i in range(count.value)]
    finally:
        local_free(arguments)


def process_commands():
    # Fixed PowerShell program; no profile paths are interpolated into executable code.
    script = ('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); '
              'Get-CimInstance Win32_Process -ErrorAction Stop | '
              'Select-Object Name,CommandLine | ConvertTo-Json -Compress')
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, encoding="utf-8", timeout=15, check=True)
    entries = json.loads(result.stdout.lstrip("\ufeff"))
    return entries if isinstance(entries, list) else [entries]


def command_worker(name, port, token):
    from platform_support import executable_command, utf8_environment
    # Keep this handle until process exit: explicit CloseHandle kills us too.
    job, data = worker_request(name, port, token, allow_breakaway=True)
    if data is None:
        return 0
    signal.signal(signal.SIGBREAK, lambda *_: None)
    signal.signal(signal.SIGINT, lambda *_: None)
    child = subprocess.Popen(executable_command(data["command"]), cwd=data.get("cwd"),
                             env=utf8_environment(data.get("env")))
    return child.wait()


if __name__ == "__main__":
    raise SystemExit(command_worker(*sys.argv[2:5]))
