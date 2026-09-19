"""Principal-aware native session workspace policy contract."""

from __future__ import annotations

import tempfile
from pathlib import Path

from service.chat.service.sessions import workspace_allows
from service.chat.service.workspaces import SessionWorkspaceService

PASS = 0
FAIL = 0
OWNER = "owner-a"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def scenario(root: Path) -> None:
    active = (root / "backend").resolve()
    descendant = active / "child"
    project = (root / "user-selected-project").resolve()
    other = (root / "foreign-project").resolve()
    for path in (active, descendant, project, other):
        path.mkdir(parents=True, exist_ok=True)

    registry = SessionWorkspaceService(workspace_allows)
    observed: list[tuple[str, Path, Path]] = []

    def policy(*, principal_id: str, active_workspace: Path, requested_workspace: Path) -> bool:
        observed.append((principal_id, active_workspace, requested_workspace))
        return principal_id == OWNER and requested_workspace == project

    def resolve(requested: Path) -> Path | None:
        return project if requested == project else None

    registry.register(policy=policy, project_resolver=resolve)  # type: ignore[arg-type]
    check(
        "active workspace and descendants retain the default authorization",
        registry.allows(
            principal_id="any",
            active_workspace=active,
            requested_workspace=active,
        )
        and registry.allows(
            principal_id="any",
            active_workspace=active,
            requested_workspace=descendant,
        ),
    )
    check(
        "product policy authorizes only the principal-owned project root",
        registry.allows(
            principal_id=OWNER,
            active_workspace=active,
            requested_workspace=project,
        )
        and not registry.allows(
            principal_id="owner-b",
            active_workspace=active,
            requested_workspace=project,
        )
        and not registry.allows(
            principal_id=OWNER,
            active_workspace=active,
            requested_workspace=other,
        ),
        str(observed),
    )
    check(
        "project assignment requires the exact registered root",
        registry.is_project(project)
        and not registry.is_project(project / "nested")
        and not registry.is_project(other),
    )
    check(
        "project resolver never fabricates a root",
        registry.project_for(project) == project and registry.project_for(other) is None,
    )
    try:
        registry.register(
            policy=lambda **_kwargs: True,
            project_resolver=lambda requested: requested,
        )
    except RuntimeError:
        duplicate_rejected = True
    else:
        duplicate_rejected = False
    check("workspace policy composition is single-owner", duplicate_rejected)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="session-workspaces-") as tmp:
        scenario(Path(tmp).resolve())
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
