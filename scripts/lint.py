"""Run Pylint over the selected sources in a single parallel invocation.

历史上这里把文件分成 24 个一批串行跑 (担心内存/稳定性)。实测单次跑全部 344 文件
峰值仅 ~516MB, 且 pylint `-j` 会把文件分给多个 worker 子进程 (每 worker 内存有界),
故去掉分批、改为单次 `-j` 并行。`-j` 只影响跨文件的 duplicate-code / cyclic-import
两项检查, 而它俩在 pyproject 已 disable; 实测分批/单次/`-j` 三种模式的消息集逐条一致。

另带一道与 pylint 无关的前缀门禁 (proposal-38): 全仓禁止新增作废的 `VEDA_*` 环境变量名。
放在这里而不是 contract 套件里: 它要扫的不只是 Python, 还有 TS / shell / Makefile / 文档。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path

PYTHON_SUFFIX = ".py"
EXCLUDED_PATH_PARTS = frozenset({".venv", "__pycache__", "build", "dist", "node_modules", "tmp"})


#: 作废的旧环境变量前缀 (proposal-38)。带标识符边界, 所以 `LEGACY_VEDA_HOME_DIRNAME`
#: (backend.ts 有意保留的旧目录名常量) 不会被误判。
OBSOLETE_ENV_PATTERN = re.compile(r"(?<![A-Z0-9_])VEDA_[A-Z0-9_]+")
#: 按名字放行: 这个旧名本身就是打包脚本用来报错拒绝的守卫字面量。
OBSOLETE_ENV_ALLOWED_NAMES = frozenset({"VEDA_DESKTOP_DEFAULT_CONFIG"})
#: 按文件放行: 运行时根契约门禁自己就要拿旧名做正反用例。
OBSOLETE_ENV_ALLOWED_FILES = frozenset({"apps/serve/tests/contract_runtime_root.py"})
#: 不扫: 独立发布的依赖包 (各自有自己的门禁)、生成物、以及 wiki 历史叙述
#: (当时快照不追改)。开源布局下依赖包已从 submodule 变为 packages/ 下的 in-tree
#: 目录, 前缀随之改变 —— 否则会把它们的历史提案文档也扫进来。
OBSOLETE_ENV_SKIP_PREFIXES = (
    "packages/damoatrace/",
    "packages/adapters/",
    ".understand-anything/",
    "wiki/",
)


def _tracked_files() -> list[str]:
    result = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return []
    return result.stdout.split("\n")


def _obsolete_prefix_gate() -> int:
    """全仓扫作废 `VEDA_*` 残留; 有则逐条打印并返回非零。

    这道门的意义在于: 旧名早已无人读取, 写出来**不报错也不生效**。靠 review 抓不住,
    只能靠静态扫描阻止回流。
    """

    offenders: list[tuple[str, str]] = []
    for relative in _tracked_files():
        if not relative or relative.startswith(OBSOLETE_ENV_SKIP_PREFIXES):
            continue
        if relative in OBSOLETE_ENV_ALLOWED_FILES:
            continue
        path = Path(relative)
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for name in sorted(set(OBSOLETE_ENV_PATTERN.findall(text))):
            if name not in OBSOLETE_ENV_ALLOWED_NAMES:
                offenders.append((relative, name))
    if not offenders:
        return 0
    print(
        "env-prefix: 发现作废的 VEDA_* 名字 (proposal-38: 产品自有变量用 SCHOLARSEED_, "
        "读取方在 Agent 层的用 DAMOAGENT_)",
        file=sys.stderr,
    )
    for relative, name in offenders:
        suggestion = "SCHOLARSEED_" + name[len("VEDA_") :]
        print(f"  {relative}: {name} -> {suggestion}", file=sys.stderr)
    return 1


def _is_source_file(path: Path) -> bool:
    return path.is_file() and path.suffix == PYTHON_SUFFIX


def _is_excluded(path: Path) -> bool:
    relative = path.resolve().relative_to(Path.cwd())
    return bool(EXCLUDED_PATH_PARTS.intersection(relative.parts))


def _sources(paths: Sequence[str]) -> list[Path]:
    files: list[Path] = []
    for raw_path in paths:
        path = Path(raw_path)
        candidates: Iterable[Path] = path.rglob(f"*{PYTHON_SUFFIX}") if path.is_dir() else (path,)
        files.extend(candidate for candidate in candidates if _is_source_file(candidate))
    return sorted({path for path in files if not _is_excluded(path)})


def main(argv: Sequence[str]) -> int:
    files = _sources(argv)
    if not files:
        print("pylint: no Python source files selected", file=sys.stderr)
        return 2

    jobs = min(8, os.cpu_count() or 4)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pylint",
            "--score=n",
            "--reports=n",
            f"-j{jobs}",
            *map(str, files),
        ],
        check=False,
    )
    # 两道门都跑完再汇总退码: 别因为 pylint 先红就看不到前缀残留。
    prefix_failed = _obsolete_prefix_gate()
    return int(result.returncode != 0 or prefix_failed != 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
