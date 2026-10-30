"""Chat product settings business service."""

from __future__ import annotations

import errno
import json
import os
import stat
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from types import ModuleType
from typing import Any, Mapping

from service.chat.constants import (
    DEFAULT_AUTO_REVIEW_ENABLED,
    DEFAULT_GLOBAL_PERMISSION_MODE,
    DEFAULT_VERSION_IGNORE_PATTERNS,
    DEFAULT_WORKFLOW_ENABLED,
    GLOBAL_AUTO_REVIEW_DEFAULT_KEY,
    GLOBAL_PERMISSION_MODE_KEY,
    GLOBAL_PERMISSION_MODES,
    GLOBAL_WORKFLOW_DEFAULT_KEY,
    LEGACY_RUNTIME_EXECUTABLE_KEY,
    MAX_VERSION_FILE_SIZE_KB_KEY,
    MAX_VERSIONS_PER_FILE_KEY,
    RUNTIME_MODEL_KEY,
    VERSION_IGNORE_PATTERNS_KEY,
    VERSION_INCLUDE_PATTERNS_KEY,
    VERSION_MODE_KEY,
    VERSION_POLICY_BACKUP_KEY,
    VERSION_POLICY_MIGRATION_KEY,
    WORKSPACE_ROOT_KEY,
)
from service.paths import SERVE_SETTINGS_FILE
from service.platform.resources import (
    DEFAULT_MAX_VERSION_FILE_SIZE_KB,
    DEFAULT_MAX_VERSIONS_PER_FILE,
    MAX_MAX_VERSION_FILE_SIZE_KB,
    MAX_MAX_VERSIONS_PER_FILE,
    MIN_MAX_VERSION_FILE_SIZE_KB,
    MIN_MAX_VERSIONS_PER_FILE,
    VERSION_FILE_SIZE_KILOBYTE,
    VERSION_MAX_BYTES,
    VersionPolicyMode,
)
from service.resources.domain.policy import (
    INVALID_VERSION_MODE_ERROR,
    VersionMode,
    VersionPolicyInputs,
)

msvcrt: ModuleType
fcntl: ModuleType
if os.name == "nt":
    import msvcrt
else:
    import fcntl

SETTINGS_LOCK_SUFFIX = ".lock"
SETTINGS_TEMP_SUFFIX = ".tmp"
SETTINGS_LOCK_TIMEOUT_SECONDS = 10.0
SETTINGS_LOCK_RETRY_SECONDS = 0.05
SETTINGS_FILE_MODE = 0o600
SETTINGS_INVALID_FORMAT_ERROR = "settings_invalid_format"
WORKSPACE_ROOT_INVALID_ERROR = "workspace_root_invalid"


@contextmanager
def _transaction() -> Iterator[None]:
    """Serialize settings RMW across instances/processes, not update admission.

    The sidecar is permanent: replacing or unlinking it would split lock identity.
    A descriptor belongs only to this operation and is not inherited by children.
    """
    SERVE_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    lock = SERVE_SETTINGS_FILE.with_name(SERVE_SETTINGS_FILE.name + SETTINGS_LOCK_SUFFIX)
    descriptor = os.open(
        lock,
        os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        SETTINGS_FILE_MODE,
    )
    try:
        identity = os.fstat(descriptor)
        if (
            not stat.S_ISREG(identity.st_mode)
            or identity.st_nlink != 1
            or not os.path.samestat(identity, lock.stat(follow_symlinks=False))
        ):
            raise OSError("unsafe settings lock")
        deadline = time.monotonic() + SETTINGS_LOCK_TIMEOUT_SECONDS
        while True:
            try:
                if os.name == "nt":
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError("settings transaction is busy") from error
                time.sleep(SETTINGS_LOCK_RETRY_SECONDS)
        yield
    finally:
        os.close(descriptor)


class SettingsService:
    """Own validated reads and writes of product-level chat preferences."""

    def __init__(self, environ: Mapping[str, str] | None = None) -> None:
        self._environ = os.environ if environ is None else environ

    @staticmethod
    def normalize_permission_mode(value: object) -> str:
        mode = str(value or "").strip()
        return mode if mode in GLOBAL_PERMISSION_MODES else DEFAULT_GLOBAL_PERMISSION_MODE

    def permission_mode(self) -> str:
        data = self._read()
        return self.normalize_permission_mode(data.get(GLOBAL_PERMISSION_MODE_KEY))

    def workflow_default(self) -> bool:
        value = self._read().get(GLOBAL_WORKFLOW_DEFAULT_KEY)
        return value if isinstance(value, bool) else DEFAULT_WORKFLOW_ENABLED

    def set_permission_mode(self, mode: object) -> str:
        value = str(mode or "").strip()
        if value not in GLOBAL_PERMISSION_MODES:
            raise ValueError(f"unsupported permission mode: {value!r}")
        with _transaction():
            data = self._read()
            data[GLOBAL_PERMISSION_MODE_KEY] = value
            self._write(data)
        return value

    def set_workflow_default(self, enabled: object) -> bool:
        if not isinstance(enabled, bool):
            raise ValueError(f"default_workflow_enabled must be boolean: {enabled!r}")
        with _transaction():
            data = self._read()
            data[GLOBAL_WORKFLOW_DEFAULT_KEY] = enabled
            self._write(data)
        return enabled

    def auto_review_default(self) -> bool:
        value = self._read().get(GLOBAL_AUTO_REVIEW_DEFAULT_KEY)
        return value if isinstance(value, bool) else DEFAULT_AUTO_REVIEW_ENABLED

    def max_versions_per_file(self) -> int:
        """Return the validated global file-version retention limit."""

        value = self._read().get(MAX_VERSIONS_PER_FILE_KEY)
        if (
            isinstance(value, int)
            and MIN_MAX_VERSIONS_PER_FILE <= value <= MAX_MAX_VERSIONS_PER_FILE
        ):
            return value
        return DEFAULT_MAX_VERSIONS_PER_FILE

    def max_version_file_size_kb(self) -> int:
        """Return the validated automatic version-capture size ceiling in KiB."""

        return self.max_version_file_size_kb_values(self._read())

    @staticmethod
    def max_version_file_size_kb_values(values: Mapping[str, Any]) -> int:
        value = values.get(MAX_VERSION_FILE_SIZE_KB_KEY)
        if (
            isinstance(value, int)
            and not isinstance(value, bool)
            and MIN_MAX_VERSION_FILE_SIZE_KB <= value <= MAX_MAX_VERSION_FILE_SIZE_KB
        ):
            return value
        return DEFAULT_MAX_VERSION_FILE_SIZE_KB

    def version_ignore_patterns(self) -> tuple[str, ...]:
        """Return normalized global gitignore-style rules."""

        return self.version_ignore_patterns_values(self._read())

    @staticmethod
    def version_ignore_patterns_values(values: Mapping[str, Any]) -> tuple[str, ...]:
        value = values.get(VERSION_IGNORE_PATTERNS_KEY)
        if not isinstance(value, list):
            return DEFAULT_VERSION_IGNORE_PATTERNS
        return tuple(line for item in value if (line := str(item).strip()))

    def version_include_patterns(self) -> tuple[str, ...] | None:
        """Distinguish absent defaults from explicitly empty user rules."""

        return self.version_include_patterns_values(self._read())

    @staticmethod
    def version_include_patterns_values(values: Mapping[str, Any]) -> tuple[str, ...] | None:
        value = values.get(VERSION_INCLUDE_PATTERNS_KEY)
        if not isinstance(value, list):
            return None
        return tuple(line for item in value if (line := str(item).strip()))

    def version_mode(self) -> VersionPolicyMode:
        """Return the selected automatic admission mode."""
        return self.version_mode_values(self._read())

    @staticmethod
    def version_mode_values(values: Mapping[str, Any]) -> VersionPolicyMode:
        value = values.get(VERSION_MODE_KEY, VersionMode.WHITELIST.value)
        if value not in tuple(VersionMode):
            raise ValueError(INVALID_VERSION_MODE_ERROR)
        return VersionPolicyMode(value)

    @classmethod
    def initialized_values(
        cls, values: Mapping[str, Any], *, existing_projects: bool
    ) -> dict[str, Any]:
        """Plan preference initialization without IO or changing caller data."""
        data = dict(values)
        data.pop(LEGACY_RUNTIME_EXECUTABLE_KEY, None)
        if VERSION_MODE_KEY not in data and not cls._version_migration_required(data):
            if existing_projects:
                data[VERSION_POLICY_MIGRATION_KEY] = True
            else:
                data[VERSION_MODE_KEY] = VersionMode.WHITELIST.value
        return data

    def initialize(self, *, existing_projects: bool) -> None:
        """Explicitly migrate preferences before the composition root starts scans.

        Existing projects may have used implicit old defaults without any
        version preference keys. Their old policy needs explicit confirmation.
        A new installation records its default now so newly created projects
        never become legacy projects just because they later acquire history.
        """
        observed = self._read()
        if self.initialized_values(observed, existing_projects=existing_projects) == observed:
            return
        with _transaction():
            current = self._read()
            prepared = self.initialized_values(current, existing_projects=existing_projects)
            if prepared != current:
                self._write(prepared)

    @classmethod
    def preview_initialization(cls, raw: bytes | None, *, existing_projects: bool) -> bytes | None:
        """Project only the bytes that initialize would publish, without IO."""
        current = cls.decode(raw)
        prepared = cls.initialized_values(current, existing_projects=existing_projects)
        return cls.encode(prepared) if prepared != current else raw

    @classmethod
    def version_policy_values(cls, values: Mapping[str, Any]) -> VersionPolicyInputs:
        """Apply the normal settings readers to one private startup snapshot."""
        return VersionPolicyInputs(
            VersionMode(cls.version_mode_values(values)),
            cls.version_include_patterns_values(values),
            cls.version_ignore_patterns_values(values),
            min(
                cls.max_version_file_size_kb_values(values) * VERSION_FILE_SIZE_KILOBYTE,
                VERSION_MAX_BYTES,
            ),
            cls._version_migration_required(values),
        )

    def version_migration_required(self) -> bool:
        """Old explicit dual-list settings require user impact confirmation."""
        return self._version_migration_required(self._read())

    @staticmethod
    def _version_migration_required(data: Mapping[str, Any]) -> bool:
        return VERSION_MODE_KEY not in data and (
            data.get(VERSION_POLICY_MIGRATION_KEY) is True
            or any(
                key in data
                for key in (
                    MAX_VERSIONS_PER_FILE_KEY,
                    MAX_VERSION_FILE_SIZE_KB_KEY,
                    VERSION_INCLUDE_PATTERNS_KEY,
                    VERSION_IGNORE_PATTERNS_KEY,
                )
            )
        )

    def set_file_version_settings(
        self,
        max_versions_per_file: int,
        include_patterns: tuple[str, ...],
        ignore_patterns: tuple[str, ...],
        mode: str | VersionPolicyMode = VersionMode.WHITELIST,
        *,
        max_file_size_kb: int = DEFAULT_MAX_VERSION_FILE_SIZE_KB,
    ) -> None:
        """Persist retention, allow and deny settings with one atomic replace."""

        if not (
            isinstance(max_versions_per_file, int)
            and not isinstance(max_versions_per_file, bool)
            and MIN_MAX_VERSIONS_PER_FILE <= max_versions_per_file <= MAX_MAX_VERSIONS_PER_FILE
        ):
            raise ValueError("invalid_max_versions")
        if not (
            isinstance(max_file_size_kb, int)
            and not isinstance(max_file_size_kb, bool)
            and MIN_MAX_VERSION_FILE_SIZE_KB <= max_file_size_kb <= MAX_MAX_VERSION_FILE_SIZE_KB
        ):
            raise ValueError("invalid_max_file_size")
        includes = [line for item in include_patterns if (line := str(item).strip())]
        ignores = [line for item in ignore_patterns if (line := str(item).strip())]
        if mode not in tuple(VersionMode):
            raise ValueError(INVALID_VERSION_MODE_ERROR)
        mode_value = VersionPolicyMode(mode)
        with _transaction():
            data = self._read()
            if self._version_migration_required(data):
                data[VERSION_POLICY_BACKUP_KEY] = {
                    key: data[key]
                    for key in (
                        MAX_VERSIONS_PER_FILE_KEY,
                        MAX_VERSION_FILE_SIZE_KB_KEY,
                        VERSION_INCLUDE_PATTERNS_KEY,
                        VERSION_IGNORE_PATTERNS_KEY,
                    )
                    if key in data
                }
            data.pop(VERSION_POLICY_MIGRATION_KEY, None)
            data[VERSION_MODE_KEY] = mode_value.value
            data[MAX_VERSIONS_PER_FILE_KEY] = max_versions_per_file
            data[MAX_VERSION_FILE_SIZE_KB_KEY] = max_file_size_kb
            data[VERSION_INCLUDE_PATTERNS_KEY] = includes
            data[VERSION_IGNORE_PATTERNS_KEY] = ignores
            self._write(data)

    def set_auto_review_default(self, enabled: object) -> bool:
        if not isinstance(enabled, bool):
            raise ValueError(f"default_auto_review_enabled must be boolean: {enabled!r}")
        with _transaction():
            data = self._read()
            data[GLOBAL_AUTO_REVIEW_DEFAULT_KEY] = enabled
            self._write(data)
        return enabled

    def runtime_executable(self) -> str:
        """Legacy product seam; executable selection belongs to the runtime provider."""

        return ""

    def runtime_model(self) -> str:
        """Return the native runtime model selected for future sessions."""

        return str(self._read().get(RUNTIME_MODEL_KEY) or "").strip()

    def set_runtime_model(self, model: object) -> str:
        """Persist an App Server model id after inventory validation."""

        value = str(model or "").strip()
        with _transaction():
            data = self._read()
            data[RUNTIME_MODEL_KEY] = value
            self._write(data)
        return value

    def workspace_root(self) -> str:
        """Return the configured project workspace root, when the user set one."""
        return self.workspace_from(self._read())

    @staticmethod
    def workspace_from(data: Mapping[str, Any]) -> str:
        value = data.get(WORKSPACE_ROOT_KEY, "")
        if not isinstance(value, str):
            raise ValueError(WORKSPACE_ROOT_INVALID_ERROR)
        return value.strip()

    def set_workspace_root(self, root: object) -> str:
        """Persist the project workspace root.

        Only new projects follow a changed root: already registered projects keep
        their own recorded directory, so switching roots never orphans them.
        """

        value = str(root or "").strip()
        with _transaction():
            data = self._read()
            if value:
                data[WORKSPACE_ROOT_KEY] = value
            else:
                data.pop(WORKSPACE_ROOT_KEY, None)
            self._write(data)
        return value

    @staticmethod
    def _read() -> dict[str, Any]:
        try:
            raw = SERVE_SETTINGS_FILE.read_bytes()
        except FileNotFoundError:
            raw = None
        return SettingsService.decode(raw)

    @staticmethod
    def decode(raw: bytes | None) -> dict[str, Any]:
        """Decode either normal file IO or an already qualified native read."""
        if raw is None:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError(SETTINGS_INVALID_FORMAT_ERROR) from error
        if not isinstance(data, dict):
            raise ValueError(SETTINGS_INVALID_FORMAT_ERROR)
        return data

    @staticmethod
    def encode(data: dict[str, Any]) -> bytes:
        """Shared publication bytes for ordinary writes and startup projection."""
        return (json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        )

    @staticmethod
    def _write(data: dict[str, Any]) -> None:
        SERVE_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(
            prefix=SERVE_SETTINGS_FILE.name + ".",
            suffix=SETTINGS_TEMP_SUFFIX,
            dir=SERVE_SETTINGS_FILE.parent,
        )
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(SettingsService.encode(data))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, SERVE_SETTINGS_FILE)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass
