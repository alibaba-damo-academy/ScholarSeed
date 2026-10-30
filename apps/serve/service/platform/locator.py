"""Directory discovery hints; only a qualified parent can prove absence."""

from __future__ import annotations

import errno
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from service.platform.storage import DirectoryRole

MISSING_DIRECTORY = "ERR_LEASE_MISSING"
REJECTED_DIRECTORY_PERMISSION = "ERR_LEASE_PERMISSION"
PROJECT_DIRECTORY_REJECTIONS = frozenset(
    {REJECTED_DIRECTORY_PERMISSION, "ERR_LEASE_DIRECTORY", "ERR_LEASE_UNSUPPORTED"}
)
WINDOWS_DIRECTORY_ACCESS_ERRORS = frozenset({5, 32, 33})
POSIX_DIRECTORY_ACCESS_ERRORS = frozenset({errno.EACCES, errno.EPERM, errno.EBUSY})


class LocatorNative(Protocol):
    def pin(
        self, path: str, create: bool, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> object: ...

    def release(self, pin: object, /) -> None: ...


@dataclass(frozen=True)
class DirectoryLocator:
    path: str
    anchor: str
    remaining: tuple[str, ...]
    anchor_rejected: bool = False
    failure_code: str = ""


def pin_directory(
    native: LocatorNative, path: str, create: bool, role: DirectoryRole = DirectoryRole.PRIVATE
) -> object:
    """Apply an explicit caller-selected role; private remains the default."""
    role = DirectoryRole(role)
    return (
        native.pin(path, create)
        if role is DirectoryRole.PRIVATE
        else native.pin(path, create, role)
    )


def directory_locator(
    native: LocatorNative, path: str, role: DirectoryRole = DirectoryRole.PRIVATE
) -> DirectoryLocator:
    """Probe without creation or business IO; retain rejected absence anchors.

    The returned ancestor is only a discovery hint. Its caller must obtain the
    full directory qualification and prove the first remaining entry absent.
    A permission-rejected ancestor after a missing path is not qualified and
    grants neither an absence proof nor permission to access or recover that project.
    """
    role = DirectoryRole(role)
    target = Path(path)
    if not target.is_absolute() or ".." in target.parts or "\0" in path:
        raise ValueError("directory locator requires an absolute canonical path")
    anchor = target
    while True:
        try:
            pin = pin_directory(native, str(anchor), False, role)
        except OSError as error:
            code = getattr(error, "code", "")
            if role is DirectoryRole.PROJECT and (
                code in PROJECT_DIRECTORY_REJECTIONS
                or (
                    code == "ERR_LEASE_NATIVE"
                    and error.errno
                    in (
                        WINDOWS_DIRECTORY_ACCESS_ERRORS
                        if os.name == "nt"
                        else POSIX_DIRECTORY_ACCESS_ERRORS
                    )
                )
            ):
                return DirectoryLocator(
                    str(target), str(anchor), target.relative_to(anchor).parts, True, code
                )
            if getattr(error, "code", None) == REJECTED_DIRECTORY_PERMISSION and anchor != target:
                return DirectoryLocator(
                    str(target), str(anchor), target.relative_to(anchor).parts, True
                )
            if getattr(error, "code", None) != MISSING_DIRECTORY or anchor.parent == anchor:
                raise
            anchor = anchor.parent
            continue
        # Cleanup failure is not evidence of successful discovery.
        native.release(pin)
        return DirectoryLocator(str(target), str(anchor), target.relative_to(anchor).parts)
