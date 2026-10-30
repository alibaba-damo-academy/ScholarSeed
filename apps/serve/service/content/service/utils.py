"""Descriptor-relative filesystem helpers shared by Content operations."""

from __future__ import annotations

import errno
import os
import stat
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from service.content.domain.model import ContentError
from service.platform.storage import (
    NOFOLLOW,
    NONBLOCK,
    DirectoryHandle,
)
from service.platform.storage import open_directory as open_storage_directory
from service.platform.storage import (
    stable_read_matches,
)

DIRECTORY_PATH_INVALID = "content_directory_path_invalid"
CONTENT_SOURCE_CHANGED = "content_source_changed"
NAME_TOO_LONG = "name_too_long"
WINDOWS_FILENAME_EXCED_RANGE = 206
WINDOWS_PATH_NOT_FOUND = 3
WINDOWS_MAX_PATH = 260
WRITE_DENIED_ERRORS = frozenset({errno.EACCES, errno.EPERM, errno.EROFS})


def writable(parent: DirectoryHandle, name: str) -> bool:
    """Probe native write access without creating, truncating or changing permissions."""

    try:
        descriptor = parent.open(name, os.O_WRONLY | NOFOLLOW | NONBLOCK)
    except OSError as error:
        if error.errno in WRITE_DENIED_ERRORS:
            return False
        raise
    try:
        return stat.S_ISREG(os.fstat(descriptor).st_mode)
    finally:
        os.close(descriptor)


def name_length_error(error: OSError, path: Path | None = None) -> ContentError | None:
    """Classify only the operating-system name/path length failure.

    Returns ``None`` for every other ``OSError`` so callers keep their own
    fallback semantics. Length is the one failure that is actionable for the
    user (shorten the name) and the one we must never impose a fixed character
    limit on, since the byte boundary depends on the filesystem and encoding.
    Windows reports some full-path overflows as ``ERROR_PATH_NOT_FOUND``;
    classify that code only when the failed target is at least ``MAX_PATH``.
    """
    windows_error = getattr(error, "winerror", None)
    path_exceeds_windows_limit = (
        path is not None
        and (
            windows_error == WINDOWS_PATH_NOT_FOUND
            or (windows_error is None and error.errno == WINDOWS_PATH_NOT_FOUND)
        )
        and len(str(path)) >= WINDOWS_MAX_PATH
    )
    if (
        error.errno == errno.ENAMETOOLONG
        or windows_error == WINDOWS_FILENAME_EXCED_RANGE
        or path_exceeds_windows_limit
    ):
        return ContentError(NAME_TOO_LONG)
    return None


def filesystem_error(error: OSError, fallback: str, path: Path | None = None) -> ContentError:
    """Preserve actionable length failures without imposing a filesystem limit."""
    return name_length_error(error, path) or ContentError(fallback)


def read_regular(
    parent: DirectoryHandle,
    name: str,
    limit: int,
    *,
    verify: Callable[[int], None] | None = None,
) -> bytes:
    """Read one bounded stable regular file from an already authorized directory."""
    descriptor = parent.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ContentError("not_a_file")
        if before.st_size > limit:
            raise ContentError("file_too_large")
        if verify is not None:
            verify(stream.fileno())
        payload = stream.read(limit + 1)
        if len(payload) > limit:
            raise ContentError("file_too_large")
        after = os.fstat(stream.fileno())
        current = parent.stat(name)
        if not stable_read_matches(before, after, current, len(payload)):
            raise ContentError(CONTENT_SOURCE_CHANGED)
    return payload


def open_directory(root: Path, parts: tuple[str, ...], *, create: bool = False) -> DirectoryHandle:
    """Open every ancestor no-follow; ownership of the returned fd passes to caller.

    Even the configured root's ancestors are opened individually: O_NOFOLLOW on
    an absolute pathname alone protects only its final component.
    """
    if not root.is_absolute():
        raise ContentError(DIRECTORY_PATH_INVALID)
    try:
        return open_storage_directory(root, parts, create=create)
    except ValueError as error:
        raise ContentError(DIRECTORY_PATH_INVALID) from error


@contextmanager
def directory(
    root: Path, parts: tuple[str, ...], *, create: bool = False
) -> Iterator[DirectoryHandle]:
    descriptor = open_directory(root, parts, create=create)
    try:
        yield descriptor
    finally:
        descriptor.close()
