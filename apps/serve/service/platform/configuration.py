"""Host-qualified atomic publication for provider-owned configuration files."""

from __future__ import annotations

import logging
import os
import secrets
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
from pathlib import Path
from time import monotonic

from scholarseed_runtime.contract.resource import ResourceLease
from scholarseed_runtime.contract.storage import RuntimeConfigurationPartition
from service.platform.storage import (
    DirectoryHandle,
    canonical_root,
    open_private_directory,
    stable_read_matches,
)

CONFIGURATION_MAX_BYTES = 1024 * 1024
CONFIGURATION_LOCK_SUFFIX = ".lock"
CONFIGURATION_STAGE_PREFIX = ".configuration-"
CONFIGURATION_STAGE_TOKEN_BYTES = 16
CONFIGURATION_PARTITION_PREFIX = "runtime-"
CONFIGURATION_DIGEST_PREFIX = "sha256:"
CONFIGURATION_ACCESS_DENIED = "configuration_access_denied"
CONFIGURATION_CONFLICT = "configuration_conflict"
CONFIGURATION_INVALID = "configuration_invalid"


LOGGER = logging.getLogger(__name__)


class ConfigurationStage(str, Enum):
    QUALIFY = "qualify"
    LEASE = "lease"
    DIRECTORY = "directory"
    LOCK = "lock"
    READ = "read"
    TRANSFORM = "transform"
    CREATE = "create"
    WRITE = "write"
    COMPARE = "compare"
    REPLACE = "replace"
    VERIFY = "verify"
    CLEANUP = "cleanup"


class ConfigurationConflict(ValueError):
    pass


@dataclass(frozen=True)
class _Snapshot:
    payload: bytes | None = field(repr=False)
    identity: tuple[int, int, int, int] | None


class ConfigurationStorage:
    """An exact file grant, not permission to edit arbitrary provider roots."""

    def __init__(
        self,
        paths: tuple[Path, ...],
        resource_lease: Callable[[], ResourceLease],
    ) -> None:
        self._paths = frozenset(self._canonical(path) for path in paths)
        self._resource_lease = resource_lease

    @staticmethod
    def _canonical(path: Path) -> Path:
        if not path.is_absolute() or path.name in {"", ".", ".."}:
            raise ValueError(CONFIGURATION_ACCESS_DENIED)
        return Path(os.path.abspath(path))

    def partition(self, path: Path) -> RuntimeConfigurationPartition:
        selected = self._canonical(path)
        if selected not in self._paths:
            raise PermissionError(CONFIGURATION_ACCESS_DENIED)
        with closing(self._resource_lease()):
            with closing(open_private_directory(canonical_root(selected.parent), ())) as parent:
                name = CONFIGURATION_PARTITION_PREFIX + secrets.token_hex(
                    CONFIGURATION_STAGE_TOKEN_BYTES
                )
                parent.mkdir(name)
                with closing(open_private_directory(parent.path, (name,))) as child:
                    target = child.path / selected.name
        return RuntimeConfigurationPartition(
            target, ConfigurationStorage((target,), self._resource_lease)
        )

    @staticmethod
    def _read(directory: DirectoryHandle, name: str) -> _Snapshot:
        try:
            descriptor = directory.open_private(name, os.O_RDONLY)
        except FileNotFoundError:
            return _Snapshot(None, None)
        with os.fdopen(descriptor, "rb") as handle:
            before = os.fstat(handle.fileno())
            if before.st_size > CONFIGURATION_MAX_BYTES:
                raise ValueError(CONFIGURATION_INVALID)
            payload = handle.read(CONFIGURATION_MAX_BYTES + 1)
            after = os.fstat(handle.fileno())
            current = directory.stat(name)
            if not stable_read_matches(before, after, current, len(payload)):
                raise ConfigurationConflict(CONFIGURATION_CONFLICT)
        return _Snapshot(
            payload,
            (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns),
        )

    def update(self, path: Path, transform: Callable[[bytes | None], bytes]) -> str:
        started = monotonic()
        stage = ConfigurationStage.QUALIFY
        try:
            selected = self._canonical(path)
            if selected not in self._paths:
                raise PermissionError(CONFIGURATION_ACCESS_DENIED)
            stage = ConfigurationStage.LEASE
            with closing(self._resource_lease()):
                stage = ConfigurationStage.DIRECTORY
                with closing(
                    open_private_directory(canonical_root(selected.parent), ())
                ) as directory:
                    stage = ConfigurationStage.LOCK
                    with directory.arbitration(selected.name + CONFIGURATION_LOCK_SUFFIX):
                        stage = ConfigurationStage.READ
                        previous = self._read(directory, selected.name)
                        stage = ConfigurationStage.TRANSFORM
                        payload = transform(previous.payload)
                        if not isinstance(payload, bytes) or len(payload) > CONFIGURATION_MAX_BYTES:
                            raise ValueError(CONFIGURATION_INVALID)
                        temporary_name = CONFIGURATION_STAGE_PREFIX + secrets.token_hex(
                            CONFIGURATION_STAGE_TOKEN_BYTES
                        )
                        stage = ConfigurationStage.CREATE
                        descriptor = directory.open_private(
                            temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                        )
                        try:
                            stage = ConfigurationStage.WRITE
                            with os.fdopen(descriptor, "wb") as handle:
                                handle.write(payload)
                                handle.flush()
                                os.fsync(handle.fileno())
                            stage = ConfigurationStage.COMPARE
                            if self._read(directory, selected.name) != previous:
                                raise ConfigurationConflict(CONFIGURATION_CONFLICT)
                            stage = ConfigurationStage.REPLACE
                            directory.replace_private(temporary_name, selected.name)
                            stage = ConfigurationStage.VERIFY
                            published = self._read(directory, selected.name)
                            if published.payload != payload:
                                raise ConfigurationConflict(CONFIGURATION_CONFLICT)
                        finally:
                            try:
                                directory.remove_private(temporary_name)
                            except FileNotFoundError:
                                pass
                            except Exception:
                                stage = ConfigurationStage.CLEANUP
                                raise
            return CONFIGURATION_DIGEST_PREFIX + sha256(payload).hexdigest()
        except Exception as error:
            LOGGER.error(
                "runtime_configuration_failed pid=%s stage=%s elapsed_ms=%.1f exception_type=%s errno=%s winerror=%s",
                os.getpid(),
                stage.value,
                (monotonic() - started) * 1000,
                type(error).__name__,
                error.errno if isinstance(error, OSError) else None,
                getattr(error, "winerror", None) if isinstance(error, OSError) else None,
            )
            raise
