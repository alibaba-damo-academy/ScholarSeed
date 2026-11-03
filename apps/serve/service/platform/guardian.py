"""Windows original-Job directory broker client.

Environment values locate the listener; actual server PID, process creation and
live ancestry are checked before sending a request. Grants are never cached.
The caller must retain its exclusive directory qualification while consuming
an authorize response. This module cannot retire a durable family record.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import sys
import time
from collections.abc import Mapping, Sequence
from ctypes import wintypes
from dataclasses import dataclass
from typing import overload

_PIPE = "SCHOLARSEED_DOMAINS_PIPE"
_PID = "SCHOLARSEED_DOMAINS_OWNER_PID"
_CREATED = "SCHOLARSEED_DOMAINS_OWNER_CREATED"
_FRAME = 1 << 20
_DIGEST = re.compile(r"[a-f0-9]{64}")
_PIPE_NAME = re.compile(r"\\\\\.\\pipe\\scholarseed-updater-[a-f0-9]{64}")


class GuardianError(RuntimeError):
    code = "ERR_DOMAIN_GUARDIAN"


class GuardianBusyError(GuardianError):
    code = "ERR_LEASE_BUSY"


class GuardianQualificationError(GuardianError):
    """The authenticated owner safely rejected one requested project capability."""

    def __init__(self, path: str, cause: str) -> None:
        super().__init__("project directory qualification failed")
        self.path = path
        self.code = {
            "permission": "ERR_LEASE_PERMISSION",
            "missing": "ERR_LEASE_MISSING",
            "busy": "ERR_LEASE_BUSY",
        }[cause]


def decode_qualification_failure(
    decoded: Mapping[str, object], payload: Mapping[str, object]
) -> GuardianQualificationError | None:
    if decoded.get("error") != "project_unavailable":
        return None
    roots = payload.get("roots")
    index, cause = decoded.get("root_index"), decoded.get("cause")
    if (
        set(decoded) != {"version", "error", "root_index", "cause"}
        or type(decoded.get("version")) is not int
        or decoded.get("version") != 1
        or payload.get("operation") != "extend"
        or not isinstance(roots, list)
        or type(index) is not int
        or not 0 <= index < len(roots)
        or cause not in ("permission", "missing", "busy")
    ):
        raise GuardianError("invalid project qualification response")
    root = roots[index]
    if (
        not isinstance(root, dict)
        or root.get("role") != "project"
        or root.get("create") is not False
        or not isinstance(root.get("path"), str)
        or not root["path"]
        or "\0" in root["path"]
    ):
        raise GuardianError("project qualification response changed request scope")
    return GuardianQualificationError(root["path"], cause)


@dataclass(frozen=True)
class WorkbenchState:
    generation: int
    release: str
    attempt: str
    phase: str
    recovery_at: int = 0


def decode_workbench(value: object) -> WorkbenchState:
    if not isinstance(value, dict) or set(value) != {
        "generation",
        "release",
        "attempt",
        "phase",
        "recovery_at",
    }:
        raise GuardianError("invalid workbench state")
    generation, release, attempt, phase = (
        value[name] for name in ("generation", "release", "attempt", "phase")
    )
    recovery_at = value["recovery_at"]
    if (
        type(generation) is not int
        or not 0 < generation < 2**64
        or not isinstance(release, str)
        or not _DIGEST.fullmatch(release)
        or not isinstance(attempt, str)
        or (attempt != "" and not _DIGEST.fullmatch(attempt))
        or phase not in ("warming", "ready")
        or (phase == "warming" and not attempt)
        or type(recovery_at) is not int
        or not 0 <= recovery_at <= 9007199254740991
        or (bool(attempt) != bool(recovery_at))
    ):
        raise GuardianError("invalid workbench identity or phase")
    return WorkbenchState(generation, release, attempt, phase, recovery_at)


class _Overlapped(ctypes.Structure):
    _fields_ = [
        ("internal", ctypes.c_size_t),
        ("internal_high", ctypes.c_size_t),
        ("offset", ctypes.c_uint32),
        ("offset_high", ctypes.c_uint32),
        ("event", ctypes.c_void_p),
    ]


class _ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("size", ctypes.c_uint32),
        ("usage", ctypes.c_uint32),
        ("pid", ctypes.c_uint32),
        ("heap", ctypes.c_size_t),
        ("module", ctypes.c_uint32),
        ("threads", ctypes.c_uint32),
        ("parent", ctypes.c_uint32),
        ("priority", ctypes.c_int32),
        ("flags", ctypes.c_uint32),
        ("executable", ctypes.c_wchar * 260),
    ]


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise GuardianError("duplicate broker field")
        result[key] = value
    return result


class Guardian:
    pipe: str
    pid: int
    created: str
    process: int
    kernel: ctypes.CDLL

    def __init__(self, pipe: str, pid: str, created: str) -> None:
        if (
            sys.platform != "win32"
            or not _PIPE_NAME.fullmatch(pipe)
            or not re.fullmatch(r"[1-9][0-9]{0,9}", pid)
            or int(pid) > 0xFFFFFFFF
            or not re.fullmatch(r"windows-[a-f0-9]{16}", created)
        ):
            raise GuardianError("invalid directory broker endpoint")
        self.pipe, self.pid, self.created = pipe, int(pid), created
        self.process = os.getpid()
        self.kernel = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True)
        p, u, b = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int
        declarations = {
            "CreateFileW": ([ctypes.c_wchar_p, u, u, p, u, u, p], p),
            "WaitNamedPipeW": ([ctypes.c_wchar_p, u], b),
            "GetNamedPipeServerProcessId": ([p, ctypes.POINTER(u)], b),
            "CloseHandle": ([p], b),
            "OpenProcess": ([u, b, u], p),
            "GetProcessTimes": ([p, p, p, p, p], b),
            "WaitForSingleObject": ([p, u], u),
            "CreateToolhelp32Snapshot": ([u, u], p),
            "Process32FirstW": ([p, ctypes.POINTER(_ProcessEntry)], b),
            "Process32NextW": ([p, ctypes.POINTER(_ProcessEntry)], b),
            "CreateEventW": ([p, b, b, ctypes.c_wchar_p], p),
            "ReadFile": ([p, p, u, p, ctypes.POINTER(_Overlapped)], b),
            "WriteFile": ([p, p, u, p, ctypes.POINTER(_Overlapped)], b),
            "CancelIoEx": ([p, ctypes.POINTER(_Overlapped)], b),
            "GetOverlappedResult": ([p, ctypes.POINTER(_Overlapped), ctypes.POINTER(u), b], b),
        }
        for name, (arguments, result) in declarations.items():
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = arguments, result

    def _close(self, handle: int) -> None:
        if not self.kernel.CloseHandle(handle):
            raise GuardianError("directory broker handle release failed")

    def _creation(self, handle: int) -> int:
        if self.kernel.WaitForSingleObject(handle, 0) != 258:
            raise GuardianError("directory broker ancestry is no longer live")
        values = [wintypes.FILETIME() for _ in range(4)]
        if not self.kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
            raise GuardianError("directory broker process identity unavailable")
        return values[0].dwLowDateTime | values[0].dwHighDateTime << 32

    def _authenticate(self, pipe: int) -> None:
        actual = ctypes.c_uint32()
        if (
            not self.kernel.GetNamedPipeServerProcessId(pipe, ctypes.byref(actual))
            or actual.value != self.pid
        ):
            raise GuardianError("directory broker server identity mismatch")
        snapshot = self.kernel.CreateToolhelp32Snapshot(2, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            raise GuardianError("directory broker ancestry unavailable")
        parents: dict[int, int] = {}
        try:
            entry = _ProcessEntry()
            entry.size = ctypes.sizeof(entry)
            ok = self.kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            while ok:
                parents[entry.pid] = entry.parent
                ok = self.kernel.Process32NextW(snapshot, ctypes.byref(entry))
            if getattr(ctypes, "get_last_error")() != 18:
                raise GuardianError("incomplete directory broker ancestry")
        finally:
            self._close(snapshot)
        handles: list[int] = []
        try:
            pid, previous = self.process, None
            seen: set[int] = set()
            for _ in range(256):
                if pid in seen or pid == 0:
                    break
                seen.add(pid)
                handle = self.kernel.OpenProcess(0x1000 | 0x100000, False, pid)
                if not handle:
                    raise GuardianError("directory broker ancestor unavailable")
                handles.append(handle)
                created = self._creation(handle)
                # Holding each ancestor plus monotonic creation times rejects
                # recycled parent PIDs in the process snapshot.
                if previous is not None and created > previous:
                    raise GuardianError("directory broker ancestor was replaced")
                if pid == self.pid:
                    if f"windows-{created:016x}" != self.created or len(handles) < 2:
                        raise GuardianError("directory broker owner changed")
                    for live in handles:
                        self._creation(live)
                    return
                previous, pid = created, parents.get(pid, 0)
            raise GuardianError("directory broker is not a live ancestor")
        finally:
            for handle in reversed(handles):
                self._close(handle)

    @overload
    def _transfer(self, handle: int, value: bytes, deadline: float) -> int: ...

    @overload
    def _transfer(self, handle: int, value: int, deadline: float) -> bytes: ...

    def _transfer(self, handle: int, value: bytes | int, deadline: float) -> bytes | int:
        writing = isinstance(value, bytes)
        if isinstance(value, bytes):
            size = len(value)
            buffer = ctypes.create_string_buffer(value, size)
        else:
            size = value
            buffer = ctypes.create_string_buffer(size)
        event = self.kernel.CreateEventW(None, True, False, None)
        if not event:
            raise GuardianError("directory broker IO event unavailable")
        operation = _Overlapped(event=event)
        transferred = ctypes.c_uint32()
        pending = False
        try:
            if time.monotonic() >= deadline:
                raise GuardianError("directory broker request timed out")
            call = self.kernel.WriteFile if writing else self.kernel.ReadFile
            pending = True
            ok = call(handle, buffer, size, None, ctypes.byref(operation))
            if not ok and getattr(ctypes, "get_last_error")() != 997:
                pending = False
                raise GuardianError("directory broker IO failed")
            remaining = max(0, int((deadline - time.monotonic()) * 1000))
            if self.kernel.WaitForSingleObject(event, remaining) != 0:
                raise GuardianError("directory broker request timed out")
            ok = self.kernel.GetOverlappedResult(
                handle, ctypes.byref(operation), ctypes.byref(transferred), False
            )
            pending = False
            if not ok or transferred.value == 0:
                raise GuardianError("directory broker connection closed")
            return transferred.value if writing else buffer.raw[: transferred.value]
        finally:
            if pending:
                # Cancellation is only a request. Keep the OVERLAPPED and its
                # buffer alive until native completion, even after timeout.
                self.kernel.CancelIoEx(handle, ctypes.byref(operation))
                self.kernel.GetOverlappedResult(
                    handle, ctypes.byref(operation), ctypes.byref(transferred), True
                )
            self._close(event)

    def request(self, operation: str, values: Sequence[Mapping[str, object]]) -> dict[str, str]:
        if operation not in {"authorize", "extend"} or not values:
            raise GuardianError("invalid directory broker operation")
        field = "bindings" if operation == "authorize" else "roots"
        decoded = self._exchange({"version": 1, "operation": operation, field: list(values)})
        if set(decoded) - {"version", "records"}:
            raise GuardianError("directory broker denied request")
        records = decoded.get("records", {})
        if (
            not isinstance(records, dict)
            or (operation == "authorize" and not records)
            or len(records) > 4096
        ):
            raise GuardianError("invalid directory broker membership response")
        if any(
            not _DIGEST.fullmatch(name)
            or not isinstance(value, str)
            or not _DIGEST.fullmatch(value)
            for name, value in records.items()
        ):
            raise GuardianError("invalid directory broker membership record")
        return records

    def workbench(self) -> WorkbenchState:
        decoded = self._exchange({"version": 1, "operation": "workbench"})
        if set(decoded) != {"version", "workbench"}:
            raise GuardianError("invalid workbench response")
        return decode_workbench(decoded["workbench"])

    def _exchange(self, payload: Mapping[str, object]) -> dict[str, object]:
        if os.getpid() != self.process:
            raise GuardianError("directory broker client ownership changed")
        raw = (
            json.dumps(payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode(
                "ascii"
            )
            + b"\n"
        )
        if len(raw) > _FRAME:
            raise GuardianError("directory broker request too large")
        deadline = time.monotonic() + 30
        while True:
            # Local overlapped pipe; identification-only SQOS prevents the peer
            # from impersonating this client at a stronger level.
            handle = self.kernel.CreateFileW(self.pipe, 0xC0000000, 0, None, 3, 0x40110000, None)
            if handle != ctypes.c_void_p(-1).value:
                break
            if getattr(ctypes, "get_last_error")() != 231 or time.monotonic() >= deadline:
                raise GuardianError("directory broker unavailable")
            self.kernel.WaitNamedPipeW(self.pipe, 100)
        try:
            self._authenticate(handle)
            sent = 0
            while sent < len(raw):
                sent += self._transfer(handle, raw[sent:], deadline)
            response = bytearray()
            while not response.endswith(b"\n"):
                response.extend(
                    self._transfer(handle, min(4096, _FRAME + 1 - len(response)), deadline)
                )
                if len(response) > _FRAME:
                    raise GuardianError("directory broker response too large")
            try:
                decoded = json.loads(response.decode("utf-8"), object_pairs_hook=_object)
            except (UnicodeError, ValueError) as error:
                raise GuardianError("invalid directory broker response encoding") from error
            if (
                not isinstance(decoded, dict)
                or type(decoded.get("version")) is not int
                or decoded["version"] != 1
            ):
                raise GuardianError("invalid directory broker response")
            self._transfer(handle, b"\x06", deadline)
            project_failure = decode_qualification_failure(decoded, payload)
            if project_failure is not None:
                raise project_failure
            if set(decoded) == {"version", "error"} and decoded["error"] == "domain_busy":
                raise GuardianBusyError("directory broker is busy")
            if decoded.get("error"):
                raise GuardianError("directory broker denied request")
            return decoded
        finally:
            self._close(handle)


def from_environment() -> Guardian | None:
    values = tuple(os.environ.get(key) for key in (_PIPE, _PID, _CREATED))
    if not any(value is not None for value in values):
        return None
    pipe, pid, created = values
    if pipe is None or pid is None or created is None:
        raise GuardianError("incomplete directory broker endpoint")
    return Guardian(pipe, pid, created)
