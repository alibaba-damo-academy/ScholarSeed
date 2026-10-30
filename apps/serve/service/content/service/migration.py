"""LEGACY → MANAGED 的迁移 (content 域, 开发 1 拥有)。

proposal 47 §7 阶段四: 这是整个提案里**唯一**动用户真实文件的步骤, 所以流程是
定死的 —— dry-run 清单 → 用户确认 → 逐项移动 → 完整性校验 → 单项失败只回滚该
项并保留原目录 → 写审计。

为什么逐项而不是整体事务: 文件系统给不了事务。一个 20GB 的资料库中途失败时,
「整体回滚」意味着再搬 20GB 回去 (期间再失败就两头都不完整)。逐项移动 + 逐项
校验 + 逐项回滚的最坏情况是「一部分已迁移、一部分留在原处」, 而这个状态是可
描述、可继续、可人工核对的。

用户可以逐项「暂不迁移」: 老项目按 LEGACY 继续工作是**受支持**的形态, 不是待
清理的债 —— 逼用户迁移才会真的丢数据。
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from service.content.domain import naming
from service.content.domain.model import (
    LITERATURE_ROOT_RELATIVE,
    MANAGED_LITERATURE_ROOT_RELATIVE,
    MANAGED_RESOURCES_ROOT_RELATIVE,
    PROJECT_STATE_DIRNAME,
    ContentError,
    visible,
)
from service.content.persistence.catalog import AUDIT_MIGRATE, ContentCatalog
from service.platform.content import ProjectLayout, ProjectRef

#: 迁移计划里单个项目的条目上限。超过就说明这不是一个「项目目录」而是一整块盘,
#: 与其静默搬几万个文件, 不如让用户先自己收拾。
MAX_PLANNED_ENTRIES = 5000


@dataclass(frozen=True)
class MigrationEntry:
    """计划里的一条: 一个顶层条目搬到哪个内置库下。"""

    #: 相对项目根的源位置 (顶层条目名)。
    source: str
    #: 相对项目根的目标位置 (`resources/x` 或 `literature/x`)。
    target: str
    #: 字节数 (目录为递归求和)。给用户一个「要搬多少」的量级。
    size: int
    #: 目标已存在。搬过去会同名避让, 因此必须先告诉用户。
    conflict: bool = False


@dataclass(frozen=True)
class MigrationPlan:
    """一个项目的迁移计划 (dry-run 产物, 不动任何文件)。"""

    project_id: str
    display_name: str
    root: str
    entries: tuple[MigrationEntry, ...]
    #: 计划不可执行时的原因码 (已是 MANAGED、目录不可用等)。空串表示可执行。
    blocked: str = ""

    @property
    def total_size(self) -> int:
        return sum(entry.size for entry in self.entries)


@dataclass(frozen=True)
class MigrationMove:
    """One verified source-to-target transition relative to the project root."""

    source: str
    target: str


@dataclass(frozen=True)
class MigrationOutcome:
    """一次迁移的结果。失败项逐条回报, 不汇总成一句「部分失败」。"""

    project_id: str
    moved: tuple[str, ...]
    moves: tuple[MigrationMove, ...]
    failed: tuple[tuple[str, str], ...]
    layout: ProjectLayout


def _entry_size(path: Path) -> int:
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for current in path.rglob("*"):
        if not current.is_file():
            continue
        try:
            total += current.stat().st_size
        except OSError:
            continue
    return total


class MigrationService:
    """LEGACY 项目转 MANAGED 布局。`projects.layout` 只由本类改写。"""

    def __init__(self, catalog: ContentCatalog) -> None:
        self._catalog = catalog

    def plan(self, project: ProjectRef) -> MigrationPlan:
        """dry-run: 列出会搬什么、多大、有没有冲突。不动文件。"""

        root = Path(project.root)
        if not project.available or not root.is_dir():
            return MigrationPlan(
                project.id, project.name, str(root), (), blocked="root_unavailable"
            )
        if project.layout is ProjectLayout.MANAGED:
            return MigrationPlan(project.id, project.name, str(root), (), blocked="already_managed")

        resources_root = root / MANAGED_RESOURCES_ROOT_RELATIVE
        literature_root = root / MANAGED_LITERATURE_ROOT_RELATIVE
        entries: list[MigrationEntry] = []
        for item in sorted(root.iterdir(), key=lambda path: path.name.lower()):
            if item.name in {
                MANAGED_RESOURCES_ROOT_RELATIVE,
                MANAGED_LITERATURE_ROOT_RELATIVE,
                PROJECT_STATE_DIRNAME,
            }:
                continue
            if not visible(item.name):
                # 隐藏文件与产品状态目录留在原处: 它们不是用户的资料。
                continue
            # LEGACY 的 `文献` 目录整体成为 `literature`; 其余顶层条目进 `resources`。
            if item.name == LITERATURE_ROOT_RELATIVE and item.is_dir():
                target_root, target_name = literature_root, ""
            else:
                target_root, target_name = resources_root, item.name
            target = target_root if not target_name else target_root / target_name
            entries.append(
                MigrationEntry(
                    source=item.name,
                    target=target.relative_to(root).as_posix(),
                    size=_entry_size(item),
                    conflict=target.exists(),
                )
            )
            if len(entries) > MAX_PLANNED_ENTRIES:
                return MigrationPlan(
                    project.id, project.name, str(root), (), blocked="too_many_entries"
                )
        return MigrationPlan(project.id, project.name, str(root), tuple(entries))

    def migrate(
        self,
        project: ProjectRef,
        skip: tuple[str, ...] = (),
    ) -> MigrationOutcome:
        """执行迁移。`skip` 里的条目保持原位 (用户选了「暂不迁移」)。

        只有**全部**计划条目都成功搬完时才把 layout 改成 MANAGED: 部分迁移的
        项目仍按 LEGACY 解析, 于是留在根下的资料照样看得见 —— 否则用户会看到
        一个「半空」的资料库, 而文件其实还在磁盘上。
        """

        plan = self.plan(project)
        if plan.blocked:
            raise ContentError(plan.blocked)
        root = Path(project.root)
        skipped = {naming.normalize_display_name(name) for name in skip}
        moved: list[str] = []
        moves: list[MigrationMove] = []
        failed: list[tuple[str, str]] = []

        for entry in plan.entries:
            if entry.source in skipped:
                continue
            source = root / entry.source
            target = root / entry.target
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    # 同名不覆盖: 用户的两份资料都要留着, 由 UI 呈现避让结果。
                    target = _avoid(target)
                shutil.move(str(source), str(target))
            except OSError as exc:
                failed.append((entry.source, type(exc).__name__))
                continue
            if not _verify(source, target, entry.size):
                # 校验不过就把这一项搬回去, 并保留原目录结构。
                _rollback(source, target)
                failed.append((entry.source, "verification_failed"))
                continue
            moved.append(entry.source)
            moves.append(
                MigrationMove(
                    source=entry.source,
                    target=target.relative_to(root).as_posix(),
                )
            )

        # 只有「计划里每一项都搬完了」才转 MANAGED。用户选了暂不迁移的条目同样
        # 算没搬完 —— 它们还铺在项目根下, 按 MANAGED 解析就会从资料树里消失。
        remaining = [entry.source for entry in plan.entries if entry.source not in set(moved)]
        layout = ProjectLayout.MANAGED if not remaining else project.layout
        if layout is ProjectLayout.MANAGED:
            for relative in (MANAGED_RESOURCES_ROOT_RELATIVE, MANAGED_LITERATURE_ROOT_RELATIVE):
                (root / relative).mkdir(parents=True, exist_ok=True)
            self._catalog.set_layout(project.id, ProjectLayout.MANAGED.value)
        self._catalog.record(
            AUDIT_MIGRATE,
            f"moved={len(moved)} failed={len(failed)} skipped={len(skipped)} layout={layout.value}",
            project.id,
        )
        return MigrationOutcome(
            project_id=project.id,
            moved=tuple(moved),
            moves=tuple(moves),
            failed=tuple(failed),
            layout=layout,
        )


def _avoid(target: Path) -> Path:
    """目标已存在时取一个不冲突的名字 (与资产层同一套 ` (2)` 规则)。"""

    stem, suffix = target.stem, target.suffix
    for index in range(2, 1000):
        probe = target.with_name(f"{stem} ({index}){suffix}")
        if not probe.exists():
            return probe
    raise ContentError("too_many_duplicates")


def _verify(source: Path, target: Path, expected_size: int) -> bool:
    """搬完就地校验: 源已消失、目标存在、体积一致。"""

    if source.exists() or not target.exists():
        return False
    return _entry_size(target) == expected_size


def _rollback(source: Path, target: Path) -> None:
    """把这一项搬回原位。回滚本身失败时不掩盖 —— 留在目标位置也比丢了好。"""

    try:
        if target.exists() and not source.exists():
            shutil.move(str(target), str(source))
    except OSError:
        # 回滚本身失败不掩盖也不重试: 留在目标位置也比丢了好, 结果由 failed 项如实回报。
        pass


__all__ = [
    "MAX_PLANNED_ENTRIES",
    "MigrationEntry",
    "MigrationMove",
    "MigrationOutcome",
    "MigrationPlan",
    "MigrationService",
]
