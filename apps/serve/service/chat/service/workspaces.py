"""Principal-aware workspace authorization for ScholarSeed product sessions."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol


class SessionWorkspacePolicy(Protocol):
    """Product-owned authorization for one resolved session workspace."""

    def __call__(
        self,
        *,
        principal_id: str,
        active_workspace: Path,
        requested_workspace: Path,
    ) -> bool: ...


class DefaultWorkspacePolicy(Protocol):
    """Base rule supplied by the session owner for the active workspace tree."""

    def __call__(self, active_workspace: Path, session_workspace: Path | None) -> bool: ...


class SessionProjectResolver(Protocol):
    """Product-owned mapping from a runtime workdir to a registered project root."""

    def __call__(self, requested_workspace: Path) -> Path | None: ...


class SessionWorkspaceService:
    """Authorize canonical workdirs through the one ScholarSeed product policy."""

    def __init__(self, default_policy: DefaultWorkspacePolicy) -> None:
        self._default_policy = default_policy
        self._policy: SessionWorkspacePolicy | None = None
        self._project_resolver: SessionProjectResolver | None = None

    def register(
        self,
        *,
        policy: SessionWorkspacePolicy,
        project_resolver: SessionProjectResolver | None = None,
    ) -> None:
        """Install the single product policy during application composition."""

        if self._policy is not None and self._policy is not policy:
            raise RuntimeError("session workspace policy already registered")
        self._policy = policy
        if project_resolver is None:
            return
        if self._project_resolver is not None and self._project_resolver is not project_resolver:
            raise RuntimeError("session project resolver already registered")
        self._project_resolver = project_resolver

    def allows(
        self,
        *,
        principal_id: str,
        active_workspace: Path,
        requested_workspace: Path | None,
    ) -> bool:
        if requested_workspace is None:
            return False
        active = active_workspace.expanduser().resolve()
        requested = requested_workspace.expanduser().resolve()
        if self._default_policy(active, requested):
            return True
        if self._policy is None or not principal_id.strip():
            return False
        return bool(
            self._policy(
                principal_id=principal_id,
                active_workspace=active,
                requested_workspace=requested,
            )
        )

    def project_for(self, requested_workspace: Path | None) -> Path | None:
        """Return only a product-registered project root for one runtime workspace."""

        if requested_workspace is None or self._project_resolver is None:
            return None
        project = self._project_resolver(requested_workspace.expanduser().resolve())
        return project.expanduser().resolve() if project is not None else None

    def is_project(self, requested_workspace: Path | None) -> bool:
        """Require an explicit assignment target to be the project root itself."""

        if requested_workspace is None:
            return False
        requested = requested_workspace.expanduser().resolve()
        project = self.project_for(requested)
        return project is not None and project == requested


__all__ = [
    "DefaultWorkspacePolicy",
    "SessionProjectResolver",
    "SessionWorkspacePolicy",
    "SessionWorkspaceService",
]
