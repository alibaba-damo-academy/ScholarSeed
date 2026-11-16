"""Private permissions for product-owned credential and configuration files."""

from __future__ import annotations

import logging
import os
import secrets
from contextlib import closing
from pathlib import Path

from service.platform.storage import open_parent, protect_windows_path

LOGGER = logging.getLogger(__name__)
WINDOWS_PLATFORM = "nt"
PRIVATE_STAGE_PREFIX = ".private-"
PRIVATE_STAGE_TOKEN_BYTES = 16


def publish_private(path: Path, payload: bytes, *, exclusive: bool = False) -> bool:
    """Create with private permissions, then publish through the pinned parent.

    Creating a writable file does not grant WRITE_OWNER on Windows. The native
    creation primitive supplies its security descriptor before any payload is
    written, instead of repairing inherited permissions through ReOpenFile.
    """
    parent, name = open_parent(path.absolute())
    with closing(parent):
        temporary = PRIVATE_STAGE_PREFIX + secrets.token_hex(PRIVATE_STAGE_TOKEN_BYTES)
        descriptor = parent.open_private(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        published = False
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
                try:
                    parent.replace_private(
                        temporary, name, exclusive=exclusive, source_descriptor=handle.fileno()
                    )
                except FileExistsError:
                    if not exclusive:
                        raise
                    return False
                published = True
                return True
        finally:
            if not published:
                try:
                    parent.remove_private(temporary)
                except FileNotFoundError:
                    pass


def protect_path(path: Path, mode: int, descriptor: int | None = None) -> None:
    if os.name == WINDOWS_PLATFORM:
        try:
            protect_windows_path(path, descriptor)
        except OSError as exc:
            LOGGER.exception(
                "private_acl_failed backend=win32 path=%r winerror=%s errno=%s error=%s",
                str(path),
                getattr(exc, "winerror", None),
                exc.errno,
                exc,
            )
            raise
    elif descriptor is not None:
        getattr(os, "fchmod")(descriptor, mode)
    else:
        path.chmod(mode)


__all__ = ["protect_path", "publish_private"]
