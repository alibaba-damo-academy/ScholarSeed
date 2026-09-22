"""Chat product settings business service."""

from __future__ import annotations

import json
import os
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
    SETTINGS_TMP_SUFFIX,
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
    VersionPolicyMode,
)
from service.resources.domain.policy import INVALID_VERSION_MODE_ERROR, VersionMode


class SettingsService:
    """Own validated reads and writes of product-level chat preferences."""

    def __init__(self, environ: Mapping[str, str] | None = None) -> None:
        self._environ = os.environ if environ is None else environ
        self._discard_legacy_runtime_executable()

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
        data = self._read()
        data[GLOBAL_PERMISSION_MODE_KEY] = value
        self._write(data)
        return value

    def set_workflow_default(self, enabled: object) -> bool:
        if not isinstance(enabled, bool):
            raise ValueError(f"default_workflow_enabled must be boolean: {enabled!r}")
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

        value = self._read().get(MAX_VERSION_FILE_SIZE_KB_KEY)
        if (
            isinstance(value, int)
            and not isinstance(value, bool)
            and MIN_MAX_VERSION_FILE_SIZE_KB <= value <= MAX_MAX_VERSION_FILE_SIZE_KB
        ):
            return value
        return DEFAULT_MAX_VERSION_FILE_SIZE_KB

    def version_ignore_patterns(self) -> tuple[str, ...]:
        """Return normalized global gitignore-style rules."""

        value = self._read().get(VERSION_IGNORE_PATTERNS_KEY)
        if not isinstance(value, list):
            return DEFAULT_VERSION_IGNORE_PATTERNS
        return tuple(line for item in value if (line := str(item).strip()))

    def version_include_patterns(self) -> tuple[str, ...] | None:
        """Distinguish absent defaults from explicitly empty user rules."""

        value = self._read().get(VERSION_INCLUDE_PATTERNS_KEY)
        if not isinstance(value, list):
            return None
        return tuple(line for item in value if (line := str(item).strip()))

    def version_mode(self) -> VersionPolicyMode:
        """Return the selected automatic admission mode."""
        value = self._read().get(VERSION_MODE_KEY, VersionMode.WHITELIST.value)
        if value not in tuple(VersionMode):
            raise ValueError(INVALID_VERSION_MODE_ERROR)
        return VersionPolicyMode(value)

    def initialize_version_policy(self, *, existing_projects: bool) -> None:
        """Freeze schema before first scan using registered project identities.

        Existing projects may have used implicit old defaults without any
        version preference keys. Their old policy needs explicit confirmation.
        A new installation records its default now so newly created projects
        never become legacy projects just because they later acquire history.
        """
        data = self._read()
        if VERSION_MODE_KEY in data or self.version_migration_required():
            return
        if existing_projects:
            data[VERSION_POLICY_MIGRATION_KEY] = True
        else:
            data[VERSION_MODE_KEY] = VersionMode.WHITELIST.value
        self._write(data)

    def version_migration_required(self) -> bool:
        """Old explicit dual-list settings require user impact confirmation."""
        data = self._read()
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
        data = self._read()
        if self.version_migration_required():
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
        data = self._read()
        data[RUNTIME_MODEL_KEY] = value
        self._write(data)
        return value

    def workspace_root(self) -> str:
        """Return the configured project workspace root, when the user set one."""

        return str(self._read().get(WORKSPACE_ROOT_KEY) or "").strip()

    def set_workspace_root(self, root: object) -> str:
        """Persist the project workspace root.

        Only new projects follow a changed root: already registered projects keep
        their own recorded directory, so switching roots never orphans them.
        """

        value = str(root or "").strip()
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
            data = json.loads(SERVE_SETTINGS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return dict(data) if isinstance(data, dict) else {}

    @staticmethod
    def _write(data: dict[str, Any]) -> None:
        SERVE_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = SERVE_SETTINGS_FILE.with_name(SERVE_SETTINGS_FILE.name + SETTINGS_TMP_SUFFIX)
        temporary.write_text(
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, SERVE_SETTINGS_FILE)

    def _discard_legacy_runtime_executable(self) -> None:
        data = self._read()
        if LEGACY_RUNTIME_EXECUTABLE_KEY not in data:
            return
        data.pop(LEGACY_RUNTIME_EXECUTABLE_KEY, None)
        self._write(data)
