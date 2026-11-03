"""Windows machine-wide startup coordination, independent of runtime Home.

The native mutex belongs to a dedicated thread, never an asyncio loop thread:
Windows mutexes are thread-reentrant, while coroutines on a loop are not owners.
No filesystem path or persistent stale lock is involved. Access denial fails closed.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import ctypes
import logging
import os
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from ctypes import wintypes
from typing import AsyncIterator

from scholarseed_codex.permissions import STARTUP_MUTEX_DESCRIPTOR, record_denial
from scholarseed_codex.protocol.state import CODEX_RPC_TIMEOUT_SECONDS, AppServerError
from scholarseed_codex.sandbox import SANDBOX_EXECUTION_TIMEOUT_MS, SANDBOX_SETUP_TIMEOUT_SECONDS
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.resource import RESOURCE_LIFECYCLE_LOGGER
from scholarseed_runtime.contract.sandbox import SANDBOX_SETUP_ERROR

STARTUP_MUTEX = "Global\\ScholarSeed.Codex.Startup.v1"
# Admit at least one complete cold-start RPC sequence ahead of this caller.
# This is a bounded queue budget, not an unlimited guarantee for arbitrary queues.
STARTUP_WAIT_SECONDS = (
    SANDBOX_SETUP_TIMEOUT_SECONDS
    + SANDBOX_EXECUTION_TIMEOUT_MS / 1000
    + 3 * CODEX_RPC_TIMEOUT_SECONDS
)
WAIT_SLICE_MS = 50
WAIT_OBJECT = 0
WAIT_ABANDONED = 0x80
WAIT_TIMEOUT = 0x102
MUTEX_ACCESS = 0x00120001  # SYNCHRONIZE | READ_CONTROL | MUTEX_MODIFY_STATE
# The kernel expands GA to MUTEX_ALL_ACCESS when creating an object. Use the
# concrete mask so the descriptor readback also matches on first creation.
MUTEX_DESCRIPTOR = STARTUP_MUTEX_DESCRIPTOR
SECURITY_DESCRIPTOR_REVISION = 1
KERNEL_OBJECT = 6
DACL_INFORMATION = 4
ACL_MAXIMUM_BYTES = 65535


class _SecurityAttributes(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.DWORD),
        ("descriptor", ctypes.c_void_p),
        ("inherit", wintypes.BOOL),
    ]


def _create_mutex(kernel) -> int:
    security = getattr(ctypes, "WinDLL")("advapi32", use_last_error=True)
    pointer = ctypes.c_void_p
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(pointer),
        pointer,
    ]
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    security.GetSecurityDescriptorDacl.argtypes = [
        pointer,
        ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(pointer),
        ctypes.POINTER(wintypes.BOOL),
    ]
    security.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    security.GetSecurityInfo.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
        pointer,
        pointer,
        ctypes.POINTER(pointer),
        pointer,
        ctypes.POINTER(pointer),
    ]
    security.GetSecurityInfo.restype = wintypes.DWORD
    security.IsValidAcl.argtypes = [pointer]
    security.IsValidAcl.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    kernel.CreateMutexExW.argtypes = [
        ctypes.POINTER(_SecurityAttributes),
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    kernel.CreateMutexExW.restype = wintypes.HANDLE
    expected, observed, acl = pointer(), pointer(), pointer()
    handle = None
    try:
        if not security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            MUTEX_DESCRIPTOR, SECURITY_DESCRIPTOR_REVISION, ctypes.byref(expected), None
        ):
            raise _error(
                "Windows startup mutex descriptor could not be created",
                getattr(ctypes, "get_last_error", lambda: 0)(),
            )
        attributes = _SecurityAttributes(ctypes.sizeof(_SecurityAttributes), expected, False)
        handle = kernel.CreateMutexExW(ctypes.byref(attributes), STARTUP_MUTEX, 0, MUTEX_ACCESS)
        if not handle:
            raise _error(
                "Windows startup mutex could not be opened with minimum access",
                getattr(ctypes, "get_last_error", lambda: 0)(),
            )
        status = security.GetSecurityInfo(
            handle,
            KERNEL_OBJECT,
            DACL_INFORMATION,
            None,
            None,
            ctypes.byref(acl),
            None,
            ctypes.byref(observed),
        )
        if status:
            raise _error("Windows startup mutex permissions could not be inspected", status)
        expected_acl = pointer()
        present, defaulted = wintypes.BOOL(), wintypes.BOOL()
        if (
            not security.GetSecurityDescriptorDacl(
                expected, ctypes.byref(present), ctypes.byref(expected_acl), ctypes.byref(defaulted)
            )
            or not present
        ):
            raise _error("Windows startup mutex descriptor is invalid")
        if not acl or not security.IsValidAcl(acl):
            raise _error("Windows startup mutex has an unsupported ACL")
        size = ctypes.cast(acl, ctypes.POINTER(ctypes.c_ushort))[1]
        expected_size = ctypes.cast(expected_acl, ctypes.POINTER(ctypes.c_ushort))[1]
        if (
            not 0 < size <= ACL_MAXIMUM_BYTES
            or size != expected_size
            or ctypes.string_at(acl, size) != ctypes.string_at(expected_acl, expected_size)
        ):
            raise _error(
                "Windows startup mutex uses an incompatible descriptor; close old clients and retry"
            )
        result, handle = handle, None
        return result
    finally:
        if handle:
            kernel.CloseHandle(handle)
        if observed:
            kernel.LocalFree(observed)
        if expected:
            kernel.LocalFree(expected)


LOGGER = logging.getLogger(f"{RESOURCE_LIFECYCLE_LOGGER}.sandbox")


def _error(message: str, system_code: int = 0) -> AppServerError:
    error = AppServerError(
        message,
        safe_error=SANDBOX_SETUP_ERROR,
        retryability=RuntimeRetryability.USER_RETRYABLE,
    )
    if system_code:
        setattr(error, "winerror", system_code)
    record_denial(error, "startup_mutex", "lock", "coordination_failed", logger=LOGGER)
    return error


def _hold(
    acquired: concurrent.futures.Future[None], release: threading.Event, timeout: float
) -> None:
    handle = None
    owned = False
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        kernel.ReleaseMutex.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = _create_mutex(kernel)
        if not handle:
            raise _error(
                "Windows runtime startup coordination could not be opened",
                getattr(ctypes, "get_last_error", lambda: 0)(),
            )
        deadline = time.monotonic() + timeout
        while not release.is_set():
            result = kernel.WaitForSingleObject(handle, WAIT_SLICE_MS)
            if result in (WAIT_OBJECT, WAIT_ABANDONED):
                owned = True
                if result == WAIT_ABANDONED:
                    # This lock is cooperative app startup ordering, not native
                    # setup authority. Recheck readiness; the official elevated
                    # helper owns Global\\CodexSandboxSetup through mutations.
                    LOGGER.warning("windows_startup_coordination event=previous_owner_exited")
                acquired.set_result(None)
                release.wait()
                return
            if result != WAIT_TIMEOUT:
                raise _error(
                    "Windows runtime startup coordination failed",
                    getattr(ctypes, "get_last_error", lambda: 0)(),
                )
            if time.monotonic() >= deadline:
                raise _error("Windows runtime startup coordination timed out")
        acquired.cancel()
    except BaseException as error:
        if not acquired.done():
            acquired.set_exception(error)
    finally:
        if handle:
            if owned:
                kernel.ReleaseMutex(handle)
            kernel.CloseHandle(handle)


@asynccontextmanager
async def startup_mutex() -> AsyncIterator[None]:
    if sys.platform != "win32":
        yield
        return
    started = time.monotonic()
    attempt = uuid.uuid4().hex
    owner = os.getpid()
    acquired: concurrent.futures.Future[None] = concurrent.futures.Future()
    release = threading.Event()
    worker = threading.Thread(
        target=_hold, args=(acquired, release, STARTUP_WAIT_SECONDS), daemon=True
    )
    worker.start()
    waiting = asyncio.wrap_future(acquired)
    LOGGER.info(
        "windows_startup_coordination event=waiting attempt=%s owner_pid=%s", attempt, owner
    )
    try:
        await asyncio.shield(waiting)
        LOGGER.info(
            "windows_startup_coordination event=acquired attempt=%s owner_pid=%s wait_ms=%s",
            attempt,
            owner,
            round((time.monotonic() - started) * 1000),
        )
        yield
    finally:
        release.set()
        joined = asyncio.create_task(asyncio.to_thread(worker.join))
        cancelled = False
        while not joined.done():
            try:
                await asyncio.shield(joined)
            except asyncio.CancelledError:
                cancelled = True
        # Retrieve a concurrent failure even if the caller cancelled while waiting.
        if waiting.done() and not waiting.cancelled():
            failure = waiting.exception()
            if failure is not None:
                LOGGER.warning(
                    "windows_startup_coordination event=failed attempt=%s owner_pid=%s",
                    attempt,
                    owner,
                    exc_info=(type(failure), failure, failure.__traceback__),
                )
        LOGGER.info(
            "windows_startup_coordination event=released attempt=%s owner_pid=%s", attempt, owner
        )
        if cancelled:
            raise asyncio.CancelledError
