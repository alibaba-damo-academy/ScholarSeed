"""Project authorization for ScholarSeed chat sessions."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

PROJECT_FILE_COUNT_LIMIT = 5_000
PROJECT_HIDDEN_NAMES = frozenset({".git", ".scholarseed", ".veda"})


def summarize_project(entry: dict[str, Any]) -> dict[str, Any]:
    """Project-card read model from one registered root, without recursive traversal."""

    summary = dict(entry)
    path = Path(str(entry.get("path") or "")).expanduser()
    latest = float(entry.get("added_at") or 0)
    count = 0
    capped = False
    try:
        with os.scandir(path) as children:
            for child in children:
                if child.name.startswith(".") or child.name in PROJECT_HIDDEN_NAMES:
                    continue
                if count >= PROJECT_FILE_COUNT_LIMIT:
                    capped = True
                    break
                count += 1
                try:
                    latest = max(latest, child.stat(follow_symlinks=False).st_mtime)
                except OSError:
                    continue
    except OSError:
        summary.update({"available": False, "file_count": None, "file_count_capped": False})
        if latest:
            summary["updated_at"] = latest
        return summary
    summary.update(
        {
            "available": True,
            "file_count": count,
            "file_count_capped": capped,
        }
    )
    if latest:
        summary["updated_at"] = latest
    return summary


class ProjectWorkspacePolicy:
    """Authorize the default root and the project roots registered in content.

    proposal 47 §6.8: 「已登记的项目」只有一个事实源 —— content 域的项目表, 由组合根
    注入一个判定函数。本域的 `projects.json` 已退回**只读种子**这一个角色 (首启种进
    content), 不再参与授权: 两处都能授权时, 用户在产品里移除的项目会因为 JSON 里还留着
    条目而仍然能开会话 —— 那种分歧不报错, 只会让「我明明移除了」失效。
    """

    def __init__(self, default_workspace: Path) -> None:
        self._default_workspace = default_workspace.expanduser().resolve()
        self._recognizer: Callable[[Path], bool] = lambda _path: False

    def bind_recognizer(self, recognizer: Callable[[Path], bool]) -> None:
        """注入「这个路径是不是一个已登记项目」的判定 (组合根调用一次)。"""

        self._recognizer = recognizer

    def _registered(self, requested: Path) -> bool:
        return self._recognizer(requested)

    def __call__(
        self,
        *,
        principal_id: str,
        active_workspace: Path,
        requested_workspace: Path,
    ) -> bool:
        del active_workspace
        if not principal_id.strip():
            return False
        requested = requested_workspace.expanduser().resolve()
        if requested == self._default_workspace:
            return True
        return self._registered(requested)

    def project_for(self, requested_workspace: Path) -> Path | None:
        requested = requested_workspace.expanduser().resolve()
        return requested if self._registered(requested) else None


__all__ = ["ProjectWorkspacePolicy", "summarize_project"]
