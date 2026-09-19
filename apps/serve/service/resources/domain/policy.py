"""Pure, single-mode admission policy for complete-byte versions."""

from __future__ import annotations

from dataclasses import dataclass

from pathspec import GitIgnoreSpec

from service.platform.resources import VERSION_MAX_BYTES, ManagementState, VersionPolicyMode

INVALID_VERSION_MODE_ERROR = "invalid_version_mode"
POLICY_PREVIEW_REQUIRED_ERROR = "policy_preview_required"
POLICY_IMPACT_UNBOUND_ERROR = "policy_impact_unbound"
POLICY_MIGRATION_REQUIRED_ERROR = "policy_migration_required"


VersionMode = VersionPolicyMode


@dataclass(frozen=True)
class AdmissionPolicy:
    """Eligibility independently of preview and diff format capabilities."""

    mode: VersionMode
    include_patterns: tuple[str, ...]
    ignore_patterns: tuple[str, ...]
    max_size_bytes: int = VERSION_MAX_BYTES

    def classify(self, path: str, size: int, *, manual: bool = False) -> ManagementState:
        if size > self.max_size_bytes:
            return ManagementState.OVERSIZED
        if manual:
            return ManagementState.MANAGED
        if self.mode is VersionMode.WHITELIST:
            included = GitIgnoreSpec.from_lines(self.include_patterns).match_file(path)
            return ManagementState.MANAGED if included else ManagementState.UNSUPPORTED
        excluded = GitIgnoreSpec.from_lines(self.ignore_patterns).match_file(path)
        return ManagementState.IGNORED if excluded else ManagementState.MANAGED
