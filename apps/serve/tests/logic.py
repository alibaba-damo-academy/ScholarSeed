"""Audit the filename pilot's import and logic cases, not a security sandbox."""

from __future__ import annotations

import os
import sys
from contextvars import ContextVar

FORBIDDEN_EVENTS = frozenset(
    {
        "sqlite3.connect",
        "sqlite3.connect/handle",
        "socket.__new__",
        "socket.connect",
        "socket.bind",
        "subprocess.Popen",
        "os.system",
        "os.posix_spawn",
        "os.fork",
        "os.mkdir",
        "os.remove",
        "os.rmdir",
        "os.rename",
        "os.chmod",
        "os.chdir",
    }
)
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
ACTIVE_GUARD: ContextVar[SideEffectGuard | None] = ContextVar("filename_logic_guard", default=None)


class SideEffectViolation(AssertionError):
    pass


def audit(event: str, arguments: tuple) -> None:
    guard = ACTIVE_GUARD.get()
    if guard is None:
        return
    forbidden = event in FORBIDDEN_EVENTS
    if event == "open":
        mode, flags = arguments[1:3]
        forbidden = (isinstance(mode, str) and any(character in mode for character in "wax+")) or (
            isinstance(flags, int) and bool(flags & WRITE_FLAGS)
        )
    if forbidden:
        guard.violations.append(event)
        raise SideEffectViolation("forbidden filename logic side effect: " + event)


class SideEffectGuard:
    def __init__(self) -> None:
        self.violations: list[str] = []
        self.token = None
        self.previous_bytecode = sys.dont_write_bytecode

    def __enter__(self) -> SideEffectGuard:
        self.previous_bytecode = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        self.token = ACTIVE_GUARD.set(self)
        return self

    def __exit__(self, error_type, error, traceback) -> None:
        if self.token is None:
            return
        ACTIVE_GUARD.reset(self.token)
        self.token = None
        sys.dont_write_bytecode = self.previous_bytecode
        if self.violations and error is None:
            raise SideEffectViolation(
                "caught forbidden side effects: " + ", ".join(self.violations)
            )


sys.addaudithook(audit)
