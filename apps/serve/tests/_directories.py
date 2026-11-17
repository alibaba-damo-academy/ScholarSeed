"""Physical test directories created by the product's native storage boundary."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from service.platform.storage import (
    WINDOWS_PATH_PREFIX,
    DarwinDirectoryNative,
    LinuxDirectoryNative,
    WindowsDirectoryNative,
    filesystem_path,
)

LEASE_TEST_ROOT_ENV = "SCHOLARSEED_LEASE_TEST_ROOT"
# 每次套件运行一次性下发，用于绑定 entry 收据的归属；不用进程号，因为 Windows
# 上 uv 生成的 venv python.exe 是启动器 stub，子进程真实 pid 与 Popen.pid 不同。
ENTRY_TOKEN_ENV = "SCHOLARSEED_ENTRY_OBSERVATION_TOKEN"


def make_directory(prefix: str = "ss-test-", *, parent: Path | None = None) -> Path:
    """Create a new qualified directory; the caller owns its lifetime."""
    root = parent or Path(os.environ.get(LEASE_TEST_ROOT_ENV, tempfile.gettempdir()))
    path = root.resolve(strict=True) / (prefix + uuid4().hex)
    implementations = {
        "darwin": DarwinDirectoryNative,
        "win32": WindowsDirectoryNative,
        "linux": LinuxDirectoryNative,
    }
    native = implementations[sys.platform]()
    pin = native.pin(str(path), True)
    native.release(pin)
    return path


@contextmanager
def directory(prefix: str = "ss-test-", *, parent: Path | None = None) -> Iterator[Path]:
    """Remove only this fixture after its owning test has drained all users."""
    path = make_directory(prefix, parent=parent)
    try:
        yield path
    finally:
        shutil.rmtree(filesystem_path(path))
