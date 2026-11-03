"""Dependency-free diagnostics for CLI startup before logging is configured."""

from __future__ import annotations

import os
import sys
import time


def startup_checkpoint(phase: str) -> None:
    try:
        print(
            f"startup_checkpoint phase={phase} pid={os.getpid()} "
            f"monotonic_seconds={time.monotonic():.6f} unix_seconds={time.time():.6f}",
            file=sys.stderr,
            flush=True,
        )
    except (OSError, ValueError):
        pass
