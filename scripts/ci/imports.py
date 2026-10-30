#!/usr/bin/env python3
"""import 位置守卫 (E402 风格): 模块级 import 必须在文件头, 不得夹在代码后。

语义对齐 pycodestyle E402 (Python 生态通用定义), 是 `pnpm ops ci format` 的
一环。允许出现在 import 之前的「前导」(不触发违规):

  - 模块 docstring / 裸字符串
  - `from __future__ import ...`
  - dunder 赋值 (`__all__ = ...` / `__version__: str = ...`)
  - 条件/守卫块: 顶层 `if` / `try` / `with` (含 `import x except ImportError: x=None`
    这类可选依赖守卫; 守卫内的 import 是缩进的, 本就不算「模块级」)

其余顶层语句 (普通赋值 / 函数调用 / def / class / for / while ...) 一旦出现, 之后的
模块级 import 即违规。

例外标记: 行尾 `# noqa: E402` (或裸 `# noqa`) 表示「有意为之」—— 用于真正 load-bearing 的
import (循环依赖底部 re-export / 测试里 import 前设 DAMOAGENT_HOME 做隔离)。这是 pycodestyle/flake8/
ruff 通用的逐行可见标记, 不是集中白名单。**能上移的 import 应直接上移, 不要靠 noqa 搪塞。**

跑法: .venv/bin/python scripts/ci/imports.py [PATH ...]   (默认扫 5 个源目录)
确定性, 不烧 token。有未标记违规 → 非零退出。
"""

from __future__ import annotations

import ast
import pathlib
import sys

# 开源布局: 产品后端在 apps/serve/service, 跨包门禁在 tests/。
DEFAULT_ROOTS = ["apps/serve/service", "apps/serve/tests", "tests", "scripts"]
SKIP_PARTS = {".venv", "node_modules", "vendor", "__pycache__", "build", "dist"}
# 技能 pack 是 `prebundle --build` 的生成物 (源码事实源在 skills/community/), 不参与
# 源码格式化与 import 位置检查 —— 它的契约由 prebundle 逐字节复核保障。
SKIP_ROOTS = (pathlib.Path("apps/serve/service/capabilities/skills").resolve(),)


def _is_skipped(path: pathlib.Path) -> bool:
    resolved = path.resolve()
    return bool(SKIP_PARTS & set(path.parts)) or any(
        resolved == root or root in resolved.parents for root in SKIP_ROOTS
    )


def _is_docstring(node: ast.stmt) -> bool:
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    )


def _is_dunder_assign(node: ast.stmt) -> bool:
    targets: list[ast.expr] = []
    if isinstance(node, ast.Assign):
        targets = list(node.targets)
    elif isinstance(node, ast.AnnAssign):
        targets = [node.target]
    else:
        return False
    return bool(targets) and all(
        isinstance(t, ast.Name) and t.id.startswith("__") and t.id.endswith("__") for t in targets
    )


def _is_future(node: ast.stmt) -> bool:
    return isinstance(node, ast.ImportFrom) and node.module == "__future__"


def _has_noqa(line: str) -> bool:
    # 行尾注释里出现 `# noqa` (裸) 或 `# noqa: ...E402...`
    low = line.lower()
    idx = low.find("# noqa")
    if idx == -1:
        idx = low.find("#noqa")
    if idx == -1:
        return False
    tail = low[idx:]
    if ":" not in tail:
        return True  # 裸 noqa = 全部豁免
    return "e402" in tail


def check_file(path: pathlib.Path) -> list[tuple[int, str]]:
    src = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []  # 语法错误交给别的工具报
    lines = src.splitlines()
    seen_code = False
    violations: list[tuple[int, str]] = []
    for node in tree.body:
        if _is_docstring(node) or _is_future(node) or _is_dunder_assign(node):
            continue
        # 顶层条件/守卫块: pycodestyle 视 if/try/with 关键字为允许的前导 (可选依赖守卫等)
        if isinstance(node, (ast.If, ast.Try, ast.With, ast.AsyncWith)):
            continue
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if seen_code:
                ln = node.lineno
                line = lines[ln - 1] if 0 <= ln - 1 < len(lines) else ""
                if not _has_noqa(line):
                    violations.append((ln, ast.unparse(node).splitlines()[0][:70]))
            continue
        seen_code = True
    return violations


def iter_py(roots: list[str]) -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for root in roots:
        base = pathlib.Path(root)
        if base.is_file() and base.suffix == ".py":
            if not _is_skipped(base):
                out.append(base)
            continue
        for p in base.rglob("*.py"):
            if _is_skipped(p):
                continue
            out.append(p)
    return sorted(out)


def main(argv: list[str]) -> int:
    roots = argv or DEFAULT_ROOTS
    roots = [r for r in roots if pathlib.Path(r).exists()]
    total = 0
    files = 0
    for path in iter_py(roots):
        bad = check_file(path)
        if bad:
            files += 1
            total += len(bad)
            for ln, src in bad:
                print(f"{path}:{ln}: E402 module-level import not at top -> {src}")
    if total:
        print(
            f"\n✗ {total} import(s) not at file head in {files} file(s). "
            f"上移到文件头, 或确属 load-bearing 时加 `# noqa: E402` 并注明原因。",
            file=sys.stderr,
        )
        return 1
    print("✓ 所有模块级 import 都在文件头 (或已逐行 noqa 标注)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
