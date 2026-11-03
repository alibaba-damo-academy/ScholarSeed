"""Product metadata and dependency checks for Codex-native skills."""

from __future__ import annotations

import json
import logging
import re
import shutil
from dataclasses import dataclass, field, replace
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from scholarseed_runtime.contract.inventory import (
    SkillAvailability,
    SkillDependency,
    SkillInventory,
    SkillView,
)
from service.capabilities.domain import SKILL_MANIFEST_NAME
from service.capabilities.service.attribution import read_attribution
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.delivery import InstallationCandidates
from service.capabilities.service.descriptor import HOST_COMPONENT_PLUGIN, PLUGIN_DESCRIPTOR
from service.capabilities.service.install import (
    ORIGIN_FILE_NAME,
    SkillPackageError,
    parse_skill_frontmatter,
)
from service.capabilities.service.installed import installed_inventory
from service.capabilities.service.plugins import PLUGIN_ORIGIN_KIND, identity_snapshot
from service.paths import SERVICE_SKILL_STATE_FILE
from service.platform.storage import filesystem_path

SKILL_PRODUCT_METADATA_FILE = ".scholarseed.json"
SKILL_INVOCATION_METADATA_KEY = "invocation"
SKILL_INVOCATION_PERMISSION_KEY = "permission"
SKILL_INVOCATION_PROFILES_KEY = "profiles"
SKILL_INVOCATION_PERMISSION_DEFAULT = "default"
SKILL_INVOCATION_PERMISSION_FULL_ACCESS = "full-access"
SKILL_INVOCATION_POLICY_FIELDS = frozenset({SKILL_INVOCATION_PERMISSION_KEY})
SKILL_INVOCATION_PROFILE_FIELDS = frozenset({SKILL_INVOCATION_PROFILES_KEY})
SKILL_INVOCATION_PROFILE_PATTERN = re.compile(r"^[a-z][a-z0-9-]*$")
SKILL_SOURCE_BUILTIN = "builtin"
SKILL_SOURCE_USER = "user"
SKILL_SOURCE_PROJECT = "project"
SKILL_GROUP_SCHOLARSEED = "scholarseed"
SKILL_GROUP_USER = "user"
SKILL_CATEGORY_SCHOLARSEED = "系统预置"
SKILL_CATEGORY_USER = "用户安装"
SKILL_DEPENDENCY_READY = "ready"
SKILL_DEPENDENCY_MISSING = "missing"
SKILL_DEPENDENCY_ERROR = "error"
SKILL_LOCAL_VERSION_PREFIX = "local"
SKILL_STATE_DISABLED = "disabled"
SKILL_STATE_DELETED = "deleted"
SKILL_STATE_INSTALLATIONS = "installationSources"
SKILL_INSTALLATION_UPLOAD = "upload"
SKILL_INSTALLATION_MARKETPLACE = "marketplace"
SKILL_INSTALLATION_CREATED = "created"
SKILL_INSTALLATION_GITHUB = "github"
SKILL_INSTALLATION_UNKNOWN = "unknown"
SKILL_INSTALLATION_SOURCES = frozenset(
    {
        SKILL_INSTALLATION_UPLOAD,
        SKILL_INSTALLATION_MARKETPLACE,
        SKILL_INSTALLATION_CREATED,
        SKILL_INSTALLATION_GITHUB,
    }
)
SKILL_STATE_RUNTIME_RECOVERY = "runtimeRecovery"
SKILL_STATE_RUNTIME_RECOVERY_VERSION = "version"
SKILL_STATE_RUNTIME_RECOVERY_WORKSPACES = "workspaces"
SKILL_RECOVERY_VERSION = 1
SKILL_ICON_FALLBACK = "skills"
SKILL_ICON_PATTERN = re.compile(r"^[a-z][a-z0-9-]*$")
SKILL_DESCRIPTION_LOCALE_PATTERN = re.compile(
    r"^description[_-]([a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*)$"
)
SKILL_PRESENTATION_FILE = Path(__file__).resolve().parents[1] / "catalog.json"
SKILL_PRESENTATION_SCHEMA = 3
SKILL_PRESENTATION_REQUIRED_KEY = "required"
SKILL_PRESENTATION_LOGIN_KEY = "requires_login"
SKILL_PRESENTATION_DISPLAY_NAMES_KEY = "display_names"
SKILL_DISPLAY_LOCALES = frozenset({"zh", "en"})
SKILL_LOGIN_REQUIRED_REASON = "login_required"
SKILL_SURFACE_CONVERSATION = "conversation"
SKILL_SURFACE_SETTINGS = "settings"
SKILL_PRESENTATION_NAMES_KEY = "skills"
SKILL_PRESENTATION_SOURCES_KEY = "sources"
SKILL_PRESENTATION_SURFACE_FIELDS = frozenset(
    {SKILL_PRESENTATION_NAMES_KEY, SKILL_PRESENTATION_SOURCES_KEY}
)
SKILL_PRESENTATION_ALLOWED_SOURCES = frozenset({SKILL_SOURCE_BUILTIN, SKILL_SOURCE_USER})
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SkillProductState:
    disabled_skills: frozenset[str] = frozenset()
    deleted_skills: frozenset[str] = frozenset()
    runtime_recovery_version: int = 0
    recovered_workspaces: frozenset[str] = frozenset()
    installation_sources: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SkillEnablementPlan:
    """Runtime writes plus the product state safe to commit after they succeed."""

    configurations: tuple[tuple[Path, bool], ...]
    state: SkillProductState


@dataclass(frozen=True)
class SkillSurfacePresentation:
    """Per-surface allowlist: named skills plus a source-based passthrough.

    A skill is visible on the surface when either its ``name`` is in
    ``skills`` or its runtime source (``builtin``/``user``) is in ``sources``.
    """

    skills: frozenset[str]
    sources: frozenset[str]


@dataclass(frozen=True)
class SkillPresentation:
    surfaces: Mapping[str, SkillSurfacePresentation]
    required: frozenset[str]
    requires_login: frozenset[str] = frozenset()
    display_names: Mapping[str, Mapping[str, str]] = field(default_factory=dict)


def load_skill_presentation(path: Path = SKILL_PRESENTATION_FILE) -> SkillPresentation:
    """Load product-owned surface visibility and builtin display titles."""

    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != SKILL_PRESENTATION_SCHEMA:
        raise ValueError("unsupported skill presentation schema")
    raw_surfaces = value.get("surfaces")
    raw_required = value.get(SKILL_PRESENTATION_REQUIRED_KEY)
    raw_login = value.get(SKILL_PRESENTATION_LOGIN_KEY, [])
    if (
        not isinstance(raw_surfaces, Mapping)
        or not isinstance(raw_required, list)
        or not all(isinstance(name, str) and name for name in raw_required)
        or len(raw_required) != len(set(raw_required))
        or not isinstance(raw_login, list)
        or not all(isinstance(name, str) and name for name in raw_login)
        or len(raw_login) != len(set(raw_login))
        or set(value)
        - {
            "schema",
            "surfaces",
            SKILL_PRESENTATION_REQUIRED_KEY,
            SKILL_PRESENTATION_LOGIN_KEY,
            SKILL_PRESENTATION_DISPLAY_NAMES_KEY,
        }
    ):
        raise ValueError("invalid skill presentation policy")
    surfaces: dict[str, SkillSurfacePresentation] = {}
    for surface, policy in raw_surfaces.items():
        if (
            not isinstance(surface, str)
            or not surface
            or not isinstance(policy, Mapping)
            or set(policy) != SKILL_PRESENTATION_SURFACE_FIELDS
        ):
            raise ValueError("invalid skill presentation surface")
        names = policy.get(SKILL_PRESENTATION_NAMES_KEY)
        sources = policy.get(SKILL_PRESENTATION_SOURCES_KEY)
        if (
            not isinstance(names, list)
            or not all(isinstance(name, str) and name for name in names)
            or len(names) != len(set(names))
            or not isinstance(sources, list)
            or not all(
                isinstance(source, str) and source in SKILL_PRESENTATION_ALLOWED_SOURCES
                for source in sources
            )
            or len(sources) != len(set(sources))
        ):
            raise ValueError("invalid skill presentation surface")
        surfaces[surface] = SkillSurfacePresentation(
            skills=frozenset(names),
            sources=frozenset(sources),
        )
    display_names = value.get(SKILL_PRESENTATION_DISPLAY_NAMES_KEY, {})
    if not isinstance(display_names, Mapping) or any(
        not isinstance(name, str)
        or not name
        or not isinstance(titles, Mapping)
        or set(titles) != SKILL_DISPLAY_LOCALES
        or any(not isinstance(title, str) or not title.strip() for title in titles.values())
        for name, titles in display_names.items()
    ):
        raise ValueError("invalid skill display names")
    return SkillPresentation(
        surfaces=surfaces,
        required=frozenset(raw_required),
        requires_login=frozenset(raw_login),
        display_names=display_names,
    )


def load_skill_state(path: Path = SERVICE_SKILL_STATE_FILE) -> SkillProductState:
    """Load product enablement without inventing runtime inventory entries."""

    value: Mapping[str, Any] = {}
    if path.is_file():
        try:
            decoded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(decoded, Mapping):
                value = decoded
        except (OSError, TypeError, ValueError):
            value = {}
    recovery = value.get(SKILL_STATE_RUNTIME_RECOVERY)
    if not isinstance(recovery, Mapping):
        recovery = {}
    recovery_version = recovery.get(SKILL_STATE_RUNTIME_RECOVERY_VERSION)
    if not isinstance(recovery_version, int):
        recovery_version = 0
    recovered_workspaces = recovery.get(SKILL_STATE_RUNTIME_RECOVERY_WORKSPACES)
    if recovery_version != SKILL_RECOVERY_VERSION or not isinstance(recovered_workspaces, list):
        recovered_workspaces = []
    installations = value.get(SKILL_STATE_INSTALLATIONS)
    if not isinstance(installations, Mapping):
        installations = {}
    return SkillProductState(
        disabled_skills=frozenset(str(row) for row in value.get(SKILL_STATE_DISABLED) or ()),
        deleted_skills=frozenset(str(row) for row in value.get(SKILL_STATE_DELETED) or ()),
        runtime_recovery_version=recovery_version,
        recovered_workspaces=frozenset(str(row) for row in recovered_workspaces),
        installation_sources={
            name: source
            for name, source in installations.items()
            if isinstance(name, str)
            and isinstance(source, str)
            and source in SKILL_INSTALLATION_SOURCES
        },
    )


def save_skill_state(
    state: SkillProductState,
    path: Path = SERVICE_SKILL_STATE_FILE,
) -> None:
    """Atomically persist product enablement state."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    payload = skill_state_record(state)
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def skill_state_record(state: SkillProductState) -> dict[str, Any]:
    return {
        SKILL_STATE_DISABLED: sorted(state.disabled_skills),
        SKILL_STATE_DELETED: sorted(state.deleted_skills),
        SKILL_STATE_INSTALLATIONS: dict(state.installation_sources),
        SKILL_STATE_RUNTIME_RECOVERY: {
            SKILL_STATE_RUNTIME_RECOVERY_VERSION: state.runtime_recovery_version,
            SKILL_STATE_RUNTIME_RECOVERY_WORKSPACES: sorted(state.recovered_workspaces),
        },
    }


def restore_skill_state(record: dict[str, Any]) -> None:
    disabled = record.get(SKILL_STATE_DISABLED)
    deleted = record.get(SKILL_STATE_DELETED)
    recovery = record.get(SKILL_STATE_RUNTIME_RECOVERY)
    if not isinstance(recovery, dict) or any(
        not isinstance(items, list) or any(not isinstance(item, str) for item in items)
        for items in (disabled, deleted)
    ):
        raise ValueError("plugin_recovery_state_invalid")
    version = recovery.get(SKILL_STATE_RUNTIME_RECOVERY_VERSION)
    workspaces = recovery.get(SKILL_STATE_RUNTIME_RECOVERY_WORKSPACES)
    if (
        type(version) is not int
        or not isinstance(workspaces, list)
        or any(not isinstance(item, str) for item in workspaces)
    ):
        raise ValueError("plugin_recovery_state_invalid")
    save_skill_state(
        SkillProductState(frozenset(disabled), frozenset(deleted), version, frozenset(workspaces))
    )


def replace_skill_state(
    state: SkillProductState,
    *,
    disabled_skills: frozenset[str] | None = None,
    deleted_skills: frozenset[str] | None = None,
    runtime_recovery_version: int | None = None,
    recovered_workspaces: frozenset[str] | None = None,
    installation_sources: Mapping[str, str] | None = None,
) -> SkillProductState:
    return SkillProductState(
        disabled_skills=(state.disabled_skills if disabled_skills is None else disabled_skills),
        deleted_skills=state.deleted_skills if deleted_skills is None else deleted_skills,
        installation_sources=(
            state.installation_sources if installation_sources is None else installation_sources
        ),
        runtime_recovery_version=(
            state.runtime_recovery_version
            if runtime_recovery_version is None
            else runtime_recovery_version
        ),
        recovered_workspaces=(
            state.recovered_workspaces if recovered_workspaces is None else recovered_workspaces
        ),
    )


def workspace_recovery_key(cwd: Path) -> str:
    """Return a privacy-preserving identity for one canonical runtime workspace."""

    canonical = str(cwd.expanduser().resolve())
    return sha256(canonical.encode("utf-8")).hexdigest()


class SkillCatalog:
    """Project owned packages for browsing and native inventories for execution."""

    def __init__(
        self,
        *,
        bundled_root: Path,
        user_root: Path,
        presentation: SkillPresentation | None = None,
        components: ComponentRegistry | None = None,
    ) -> None:
        self._bundled_root = bundled_root.expanduser().resolve()
        self._user_root = user_root.expanduser().resolve()
        self._presentation = presentation or load_skill_presentation()
        self._authenticated: Callable[[str], bool] = lambda _user_id: False
        self.components = components
        self.candidates: InstallationCandidates | None = None
        if components is not None:
            components.authorize = self.component_authorized
        # 目录指纹按内容签名复用: 全量重算要逐文件读字节, 而它每次列表请求都会跑一遍。
        self._fingerprints: dict[Path, tuple[tuple[tuple[str, int, int], ...], str]] = {}

    def bind_authentication(self, authenticated: Callable[[str], bool]) -> None:
        self._authenticated = authenticated

    def installed_inventory(self, cwd: Path) -> SkillInventory:
        return installed_inventory(self._bundled_root, self._user_root, cwd)

    def installation_report(self, workspace: Path, path: str, sha256: str) -> dict[str, Any]:
        if self.candidates is None:
            raise ValueError("plugin_installation_unavailable")
        report = self.candidates.delivery(workspace, path, sha256)
        name = (report.get("descriptor") or {}).get("id", "")
        if name and (self._bundled_root / name).exists():
            if report.get("candidate"):
                self.candidates.discard(report["candidate"])
            raise ValueError("immutable_skill")
        return {**report, "update": bool(name and (self._user_root / name).exists())}

    def installation_receipt(self, report: Mapping[str, Any]) -> dict[str, Any] | None:
        if self.candidates is None:
            raise ValueError("plugin_installation_unavailable")
        return self.candidates.receipt(report["candidate"], report["sha256"])

    def component_authorized(self, name: str, user_id: str) -> bool:
        return (
            name == HOST_COMPONENT_PLUGIN
            or name not in self._presentation.requires_login
            or self._authenticated(user_id)
        )

    def component_snapshots(
        self,
        inventory: SkillInventory,
        state: SkillProductState,
        *,
        unavailable: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        snapshots = []
        retained = {
            item["descriptor"]["id"]: item
            for item in (self.components.enabled_snapshots() if self.components is not None else [])
        }
        for skill in self.product_skills(inventory):
            if (
                skill.name in state.disabled_skills
                or skill.name in state.deleted_skills
                or not self._plugin_declared(skill)
            ):
                continue
            try:
                snapshot = identity_snapshot(
                    {
                        "path": str(self.manifest(skill.path)),
                        "source": self.source(skill.path),
                        "active": True,
                    }
                )
                if self.components is not None:
                    snapshot = self.components.dependencies(snapshot)
            except (ValueError, OSError, KeyError, TypeError) as error:
                logger.warning(
                    "plugin_component_unavailable plugin=%r failure_type=%s",
                    skill.name,
                    type(error).__name__,
                )
                if unavailable is not None:
                    unavailable.add(skill.name)
                if skill.name in retained:
                    snapshots.append(retained[skill.name])
                continue
            snapshots.append(snapshot)
        return snapshots

    def requires_login(self, skill: SkillView) -> bool:
        return skill.name in self._presentation.requires_login

    def availability_revision(self, user_id: str) -> tuple[object, ...]:
        state = load_skill_state()
        return (
            self._authenticated(user_id),
            tuple(sorted(state.disabled_skills)),
            tuple(sorted(state.deleted_skills)),
            tuple(sorted(state.installation_sources.items())),
        )

    def session_enablement(
        self, inventory: SkillInventory, state: SkillProductState, *, user_id: str
    ) -> tuple[tuple[Path, bool], ...]:
        authenticated = self._authenticated(user_id)
        selected = {
            self.manifest(skill.path).resolve(): skill for skill in self.product_skills(inventory)
        }
        return tuple(
            sorted(
                (
                    (
                        self.manifest(skill.path).expanduser().resolve(),
                        self.manifest(skill.path).resolve() in selected
                        and not self._plugin_error(skill)
                        and (self.required(skill.name) or skill.name not in state.disabled_skills)
                        and (
                            self.source(skill.path) != SKILL_SOURCE_USER
                            or skill.name not in state.deleted_skills
                        )
                        and (not self.requires_login(skill) or authenticated),
                    )
                    for reported in inventory.skills
                    for skill in (self._owned_skill(reported),)
                    if self.source(skill.path) in {SKILL_SOURCE_BUILTIN, SKILL_SOURCE_USER}
                ),
                key=lambda row: str(row[0]),
            )
        )

    def payloads(
        self,
        inventory: SkillInventory,
        state: SkillProductState,
        *,
        available_mcp_tools: Iterable[str] = (),
        surface: str | None = None,
        user_id: str = "",
        locale: str | None = None,
    ) -> list[dict[str, Any]]:
        mcp_tools = frozenset(str(value) for value in available_mcp_tools)
        errors = {
            str(error.path.expanduser().resolve()): error.message for error in inventory.errors
        }
        rows: list[dict[str, Any]] = []
        for skill in self.surface_skills(inventory, surface):
            source = self.source(skill.path)
            if source == SKILL_SOURCE_USER and skill.name in state.deleted_skills:
                continue
            rows.append(
                self._payload(
                    skill,
                    state,
                    mcp_tools=mcp_tools,
                    inventory_errors=errors,
                    runtime_revision=inventory.revision,
                    authenticated=self._authenticated(user_id),
                    locale=locale,
                )
            )
        return sorted(rows, key=lambda row: (str(row["category"]), str(row["name"])))

    def supports_surface(self, surface: str) -> bool:
        return surface in self._presentation.surfaces

    def surface_skills(
        self,
        inventory: SkillInventory,
        surface: str | None,
    ) -> tuple[SkillView, ...]:
        skills = self.product_skills(inventory)
        if surface is None:
            return skills
        policy = self._presentation.surfaces.get(surface)
        if policy is None:
            return ()
        return tuple(
            skill
            for skill in skills
            if skill.name in policy.skills or self.source(skill.path) in policy.sources
        )

    def desired_enablement(
        self,
        inventory: SkillInventory,
        state: SkillProductState,
    ) -> tuple[tuple[Path, bool], ...]:
        """Project product state only onto paths owned by this product."""

        rows: list[tuple[Path, bool]] = []
        selected = {self.manifest(skill.path).resolve() for skill in self.product_skills(inventory)}
        for reported in inventory.skills:
            skill = self._owned_skill(reported)
            source = self.source(skill.path)
            manifest = self._manifest(skill.path).expanduser().resolve()
            if source == SKILL_SOURCE_PROJECT:
                continue
            if source == SKILL_SOURCE_USER and skill.name in state.deleted_skills:
                continue
            enabled = (
                manifest in selected
                and not self._plugin_error(skill)
                and (self.required(skill.name) or skill.name not in state.disabled_skills)
            )
            rows.append((manifest, enabled))
        return tuple(rows)

    def enablement_plan(
        self,
        inventory: SkillInventory,
        state: SkillProductState,
    ) -> SkillEnablementPlan:
        """Plan owned reconciliation and one versioned repair of legacy external disables."""

        configurations = dict(self.desired_enablement(inventory, state))
        recovery_key = workspace_recovery_key(inventory.cwd)
        recovery_complete = (
            state.runtime_recovery_version == SKILL_RECOVERY_VERSION
            and recovery_key in state.recovered_workspaces
        )
        if recovery_complete:
            return SkillEnablementPlan(tuple(configurations.items()), state)
        for skill in inventory.skills:
            if self.source(skill.path) != SKILL_SOURCE_PROJECT or skill.enabled:
                continue
            configurations[self._manifest(skill.path).expanduser().resolve()] = True
        recovered = (
            state.recovered_workspaces
            if state.runtime_recovery_version == SKILL_RECOVERY_VERSION
            else frozenset()
        )
        recovered_state = replace_skill_state(
            state,
            runtime_recovery_version=SKILL_RECOVERY_VERSION,
            recovered_workspaces=recovered | {recovery_key},
        )
        return SkillEnablementPlan(tuple(configurations.items()), recovered_state)

    def product_skills(self, inventory: SkillInventory) -> tuple[SkillView, ...]:
        """Select installed plugin identities without silently falling back on corruption."""

        selected: dict[str, SkillView] = {}
        for reported in inventory.skills:
            skill = self._owned_skill(reported)
            identity = skill.name.strip().casefold()
            source = self.source(skill.path)
            if not identity or source not in {SKILL_SOURCE_BUILTIN, SKILL_SOURCE_USER}:
                continue
            current = selected.get(identity)
            candidate_plugin = source == SKILL_SOURCE_USER and self._plugin_declared(skill)
            current_plugin = (
                current is not None
                and self.source(current.path) == SKILL_SOURCE_USER
                and self._plugin_declared(current)
            )
            if (
                current is None
                or (candidate_plugin and not current_plugin)
                or (
                    not current_plugin
                    and source == SKILL_SOURCE_BUILTIN
                    and self.source(current.path) == SKILL_SOURCE_USER
                )
            ):
                selected[identity] = skill
        return tuple(selected.values())

    def _plugin_declared(self, skill: SkillView) -> bool:
        directory = self.manifest(skill.path).parent
        return (
            (directory / PLUGIN_DESCRIPTOR).exists()
            or self._json_file(directory / ORIGIN_FILE_NAME).get("kind") == PLUGIN_ORIGIN_KIND
            or (self.components is not None and self.components.has_claim(skill.name))
        )

    def _plugin_error(self, skill: SkillView) -> str:
        manifest = self.manifest(skill.path)
        if not self._plugin_declared(skill):
            return ""
        try:
            identity_snapshot(
                {"path": str(manifest), "source": self.source(skill.path), "active": True}
            )
        except (ValueError, OSError, KeyError, TypeError) as error:
            return f"plugin_invalid: {error}"
        return ""

    def _owned_skill(self, skill: SkillView) -> SkillView:
        if self.source(skill.path) == SKILL_SOURCE_PROJECT:
            return skill
        name = self._manifest(skill.path).parent.name
        return skill if skill.name == name else replace(skill, name=name)

    def find(
        self,
        inventory: SkillInventory,
        state: SkillProductState,
        name: str,
    ) -> SkillView | None:
        for skill in self.product_skills(inventory):
            if skill.name != name:
                continue
            source = self.source(skill.path)
            if source == SKILL_SOURCE_USER and skill.name in state.deleted_skills:
                continue
            return skill
        return None

    def source(self, path: Path) -> str:
        manifest = self._manifest(path)
        if self._is_under(manifest, self._bundled_root):
            return SKILL_SOURCE_BUILTIN
        if self._is_under(manifest, self._user_root):
            return SKILL_SOURCE_USER
        return SKILL_SOURCE_PROJECT

    def removable(self, path: Path) -> bool:
        return self.source(path) != SKILL_SOURCE_BUILTIN

    def required(self, name: str) -> bool:
        return name in self._presentation.required

    def toggleable(self, skill: SkillView) -> bool:
        """Return whether the product permits changing this skill's enablement."""

        return not self.required(skill.name) and self.source(skill.path) in {
            SKILL_SOURCE_BUILTIN,
            SKILL_SOURCE_USER,
        }

    def manifest(self, path: Path) -> Path:
        return self._manifest(path)

    def _payload(
        self,
        skill: SkillView,
        state: SkillProductState,
        *,
        mcp_tools: frozenset[str],
        inventory_errors: Mapping[str, str],
        runtime_revision: str,
        authenticated: bool,
        locale: str | None = None,
    ) -> dict[str, Any]:
        manifest = self._manifest(skill.path)
        directory = manifest.parent
        source = self.source(manifest)
        metadata = self._json_file(directory / SKILL_PRODUCT_METADATA_FILE)
        hub_record = self._json_file(directory / ORIGIN_FILE_NAME)
        attribution = read_attribution(directory, skill.name)
        fingerprint = self._fingerprint(directory)
        dependencies = [
            self._dependency_payload(
                dependency,
                mcp_tools=mcp_tools,
            )
            for dependency in skill.dependencies
        ]
        dependency_state = self._aggregate_dependency_state(dependencies)
        plugin_error = self._plugin_error(skill)
        runtime_error = plugin_error or inventory_errors.get(
            str(manifest.expanduser().resolve()), ""
        )
        product_enabled = self.required(skill.name) or skill.name not in state.disabled_skills
        runtime_enabled = (
            not plugin_error and skill.enabled and skill.availability == SkillAvailability.AVAILABLE
        )
        requires_login = self.requires_login(skill)
        login_available = not requires_login or authenticated
        active = (
            product_enabled
            and runtime_enabled
            and login_available
            and dependency_state == SKILL_DEPENDENCY_READY
        )
        unavailable_reason = self._unavailable_reason(
            product_enabled=product_enabled,
            runtime_enabled=runtime_enabled,
            runtime_error=runtime_error,
            dependencies=dependencies,
        )
        if product_enabled and not login_available:
            unavailable_reason = SKILL_LOGIN_REQUIRED_REASON
        version = str(metadata.get("version") or hub_record.get("version") or "").strip()
        if not plugin_error and self._plugin_declared(skill):
            version = str(self._json_file(directory / PLUGIN_DESCRIPTOR).get("version") or "")
        if not version and fingerprint:
            version = f"{SKILL_LOCAL_VERSION_PREFIX}-{fingerprint[:12]}"
        category = str(metadata.get("category") or "").strip()
        if not category:
            category = (
                SKILL_CATEGORY_SCHOLARSEED
                if source == SKILL_SOURCE_BUILTIN
                else SKILL_CATEGORY_USER
            )
        description = str(hub_record.get("description") or skill.description)
        descriptions = self._localized_descriptions(manifest)
        display_name = hub_record.get("display_name") or skill.display_name
        if source == SKILL_SOURCE_BUILTIN and locale:
            language = locale.strip().replace("_", "-").lower().split("-")[0]
            display_name = (
                self._presentation.display_names.get(skill.name, {}).get(language) or display_name
            )
        icon = str(metadata.get("icon") or SKILL_ICON_FALLBACK).strip().lower()
        if not SKILL_ICON_PATTERN.fullmatch(icon):
            icon = SKILL_ICON_FALLBACK
        invocation = metadata.get(SKILL_INVOCATION_METADATA_KEY)
        trusted_invocation = (
            dict(invocation)
            if source == SKILL_SOURCE_BUILTIN and isinstance(invocation, Mapping)
            else None
        )
        return {
            "id": f"{source}:{skill.name}",
            "name": skill.name,
            "version": version,
            "fingerprint": fingerprint,
            "description": description,
            "descriptions": descriptions or None,
            "path": str(manifest.expanduser().resolve()),
            "origin": {
                "scope": skill.scope,
                "root": str(directory.expanduser().resolve()),
                "namespace": str(hub_record.get("namespace") or source),
            },
            "source": source,
            "group": (
                SKILL_GROUP_SCHOLARSEED if source == SKILL_SOURCE_BUILTIN else SKILL_GROUP_USER
            ),
            "category": category,
            "blurb": str(metadata.get("blurb") or skill.short_description or description),
            "icon": icon,
            "hub": hub_record or None,
            "installationSource": state.installation_sources.get(
                skill.name, SKILL_INSTALLATION_UNKNOWN
            ),
            **attribution,
            "updated_at": self._mtime(manifest),
            "active": active,
            "enabled": product_enabled,
            "requires_login": requires_login,
            "builtin": source == SKILL_SOURCE_BUILTIN,
            "imported": source == SKILL_SOURCE_USER,
            "removable": self.removable(manifest),
            "toggleable": self.toggleable(skill),
            "dependency_status": dependency_state,
            "unavailable_reason": unavailable_reason,
            "dependencies": dependencies,
            "runtime_enabled": runtime_enabled,
            "runtime_availability": skill.availability.value,
            "runtime_revision": runtime_revision,
            "display_name": display_name,
            SKILL_INVOCATION_METADATA_KEY: trusted_invocation,
        }

    def _dependency_payload(
        self,
        dependency: SkillDependency,
        *,
        mcp_tools: frozenset[str],
    ) -> dict[str, str]:
        kind = dependency.kind.strip().lower()
        value = dependency.value.strip()
        status = SKILL_DEPENDENCY_MISSING
        message = "依赖未安装或未启用"
        if kind == "mcp":
            if value in mcp_tools or any(row.startswith(f"{value}/") for row in mcp_tools):
                status = SKILL_DEPENDENCY_READY
                message = "MCP 能力已连接"
        elif kind in {"binary", "command", "executable"}:
            command = dependency.command.strip() or value
            if command and shutil.which(command):
                status = SKILL_DEPENDENCY_READY
                message = "本地命令可用"
        return {
            "name": value,
            "kind": dependency.kind,
            "status": status,
            "message": dependency.description or message,
        }

    @staticmethod
    def _aggregate_dependency_state(dependencies: list[dict[str, str]]) -> str:
        if any(row["status"] == SKILL_DEPENDENCY_ERROR for row in dependencies):
            return SKILL_DEPENDENCY_ERROR
        if any(row["status"] == SKILL_DEPENDENCY_MISSING for row in dependencies):
            return SKILL_DEPENDENCY_MISSING
        return SKILL_DEPENDENCY_READY

    @staticmethod
    def _unavailable_reason(
        *,
        product_enabled: bool,
        runtime_enabled: bool,
        runtime_error: str,
        dependencies: list[dict[str, str]],
    ) -> str:
        if not product_enabled:
            return "该技能已在书深中停用"
        if runtime_error:
            return runtime_error
        if not runtime_enabled:
            return "Codex 已禁用或无法加载该技能"
        missing = [row["name"] for row in dependencies if row["status"] != SKILL_DEPENDENCY_READY]
        if missing:
            return f"缺少或停用了依赖：{', '.join(missing)}"
        return ""

    @staticmethod
    def _manifest(path: Path) -> Path:
        expanded = path.expanduser()
        return expanded / SKILL_MANIFEST_NAME if filesystem_path(expanded).is_dir() else expanded

    @staticmethod
    def _is_under(path: Path, root: Path) -> bool:
        try:
            # Python imports may retain \\?\ while native inventory returns DOS paths.
            # Keep extended paths for IO and compare both sides in the same namespace.
            filesystem_path(path.expanduser()).resolve().relative_to(
                filesystem_path(root.expanduser()).resolve()
            )
            return True
        except ValueError:
            return False

    @staticmethod
    def _json_file(path: Path) -> dict[str, Any]:
        path = filesystem_path(path)
        if not path.is_file():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError):
            return {}
        return dict(value) if isinstance(value, Mapping) else {}

    @staticmethod
    def _localized_descriptions(manifest: Path) -> dict[str, str]:
        """Collect `description_<lang>` entries from the manifest frontmatter.

        Frontend-only: the default `description` still drives agent-facing
        matching; these copies are shown in the UI when the current language
        matches.
        """

        manifest = filesystem_path(manifest)
        if not manifest.is_file():
            return {}
        try:
            frontmatter, _body = parse_skill_frontmatter(manifest.read_text(encoding="utf-8"))
        except (OSError, SkillPackageError):
            return {}
        descriptions: dict[str, str] = {}
        for key, value in frontmatter.items():
            match = SKILL_DESCRIPTION_LOCALE_PATTERN.fullmatch(str(key))
            if match is None:
                continue
            description = str(value or "").strip()
            if not description:
                continue
            locale = match.group(1).replace("_", "-").lower()
            descriptions[locale] = description
        return descriptions

    def _fingerprint(self, directory: Path) -> str:
        """Hash the skill directory, reusing the previous digest while nothing changed."""

        resolved = filesystem_path(directory.expanduser()).resolve()
        signature = self._signature(resolved)
        if signature is None:
            self._fingerprints.pop(resolved, None)
            return ""
        cached = self._fingerprints.get(resolved)
        if cached is not None and cached[0] == signature:
            return cached[1]
        digest = self._digest(resolved)
        self._fingerprints[resolved] = (signature, digest)
        return digest

    @staticmethod
    def _signature(directory: Path) -> tuple[tuple[str, int, int], ...] | None:
        """Name, mtime and size of every regular file; ``None`` when unreadable."""

        rows: list[tuple[str, int, int]] = []
        try:
            for path in directory.rglob("*"):
                if path.is_symlink() or not path.is_file():
                    continue
                stat = path.stat()
                rows.append((str(path.relative_to(directory)), stat.st_mtime_ns, stat.st_size))
        except OSError:
            return None
        return tuple(sorted(rows))

    @staticmethod
    def _digest(directory: Path) -> str:
        digest = sha256()
        files: list[Path] = []
        try:
            files = sorted(
                path for path in directory.rglob("*") if path.is_file() and not path.is_symlink()
            )
            for path in files:
                digest.update(str(path.relative_to(directory)).encode("utf-8"))
                digest.update(b"\0")
                digest.update(path.read_bytes())
                digest.update(b"\0")
        except OSError:
            return ""
        return digest.hexdigest() if files else ""

    @staticmethod
    def _mtime(path: Path) -> float | None:
        try:
            return filesystem_path(path).stat().st_mtime
        except OSError:
            return None


__all__ = [
    "SKILL_DEPENDENCY_ERROR",
    "SKILL_DEPENDENCY_MISSING",
    "SKILL_DEPENDENCY_READY",
    "SKILL_INSTALLATION_CREATED",
    "SKILL_INSTALLATION_GITHUB",
    "SKILL_INSTALLATION_MARKETPLACE",
    "SKILL_INSTALLATION_UNKNOWN",
    "SKILL_INSTALLATION_UPLOAD",
    "SKILL_PRODUCT_METADATA_FILE",
    "SKILL_INVOCATION_METADATA_KEY",
    "SKILL_INVOCATION_PERMISSION_DEFAULT",
    "SKILL_INVOCATION_PERMISSION_FULL_ACCESS",
    "SKILL_INVOCATION_PERMISSION_KEY",
    "SKILL_INVOCATION_POLICY_FIELDS",
    "SKILL_INVOCATION_PROFILE_FIELDS",
    "SKILL_INVOCATION_PROFILE_PATTERN",
    "SKILL_INVOCATION_PROFILES_KEY",
    "SKILL_SOURCE_BUILTIN",
    "SKILL_SOURCE_PROJECT",
    "SKILL_SOURCE_USER",
    "SkillCatalog",
    "SkillPresentation",
    "SkillProductState",
    "SkillSurfacePresentation",
    "load_skill_state",
    "replace_skill_state",
    "save_skill_state",
]
