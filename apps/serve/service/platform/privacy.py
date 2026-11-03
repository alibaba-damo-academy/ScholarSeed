"""Private permissions for product-owned credential and configuration files."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from service.platform.storage import protect_windows_path

LOGGER = logging.getLogger(__name__)
WINDOWS_PLATFORM = "nt"


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


__all__ = ["protect_path"]
