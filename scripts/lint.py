"""Run syntax, inferred-type and repository-policy checks without short-circuiting."""

from __future__ import annotations

import ast
import fnmatch
import io
import re
import subprocess
import sys
import tokenize
import tomllib
from collections.abc import Iterable, Sequence
from pathlib import Path

PYTHON_SUFFIX = ".py"
ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "pyproject.toml"
ARGUMENT_BUDGET = 16000
MUTABLE_DEFAULT = "SS001"
POINTLESS_STRING = "SS002"
TYPE_COMPARISON = "SS003"
SYNTAX_MESSAGES = {
    MUTABLE_DEFAULT: "mutable literal default argument",
    POINTLESS_STRING: "string statement has no effect",
    TYPE_COMPARISON: "use isinstance instead of comparing type()",
}
NOQA_PATTERN = re.compile(r"#\s*noqa(?::\s*([A-Z0-9, ]+))?", re.IGNORECASE)
SCOPE_NODES = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
TYPE_NAME = "type"
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


def _is_excluded(path: Path, patterns: Sequence[str]) -> bool:
    relative = path.resolve().relative_to(Path.cwd())
    candidates = [relative, *relative.parents]
    return bool(EXCLUDED_PATH_PARTS.intersection(relative.parts)) or any(
        fnmatch.fnmatchcase(candidate.as_posix(), pattern)
        for candidate in candidates
        for pattern in patterns
    )


def _sources(paths: Sequence[str]) -> list[Path]:
    config = tomllib.loads(CONFIG.read_text(encoding="utf-8"))
    patterns = config["tool"]["ruff"]["extend-exclude"]
    files: list[Path] = []
    for raw_path in paths:
        path = Path(raw_path)
        candidates: Iterable[Path] = path.rglob(f"*{PYTHON_SUFFIX}") if path.is_dir() else (path,)
        files.extend(candidate for candidate in candidates if _is_source_file(candidate))
    return sorted({path for path in files if not _is_excluded(path, patterns)})


def _batches(files: Sequence[Path]) -> Iterable[list[str]]:
    batch: list[str] = []
    size = 0
    for path in files:
        name = str(path)
        length = len(subprocess.list2cmdline([name]).encode("utf-16-le")) // 2 + 1
        if batch and size + length > ARGUMENT_BUDGET:
            yield batch
            batch = []
            size = 0
        batch.append(name)
        size += length
    if batch:
        yield batch


def _binds_type(node: ast.AST) -> bool:
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if child.name == TYPE_NAME:
                return True
            continue
        if (
            isinstance(child, ast.Name)
            and isinstance(child.ctx, ast.Store)
            and child.id == TYPE_NAME
        ):
            return True
        if isinstance(child, ast.arg) and child.arg == TYPE_NAME:
            return True
        if isinstance(child, ast.alias) and (child.asname or child.name) == TYPE_NAME:
            return True
        if _binds_type(child):
            return True
    return False


def _syntax_issues(path: Path) -> list[tuple[int, str]]:
    with tokenize.open(path) as stream:
        source = stream.read()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    shadowed = {
        node for node in ast.walk(tree) if isinstance(node, SCOPE_NODES) and _binds_type(node)
    }
    docstrings = {
        id(node.body[0])
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        and node.body
        and ast.get_docstring(node) is not None
    }
    for owner in ast.walk(tree):
        if isinstance(owner, (ast.Module, ast.ClassDef)):
            for previous, statement in zip(owner.body, owner.body[1:], strict=False):
                if isinstance(previous, (ast.Assign, ast.AnnAssign)):
                    docstrings.add(id(statement))
    ignored: dict[int, set[str] | None] = {}
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.COMMENT:
            continue
        marker = NOQA_PATTERN.match(token.string)
        if marker:
            ignored[token.start[0]] = (
                {code.strip().upper() for code in marker[1].split(",")} if marker[1] else None
            )
    issues: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for default in [*node.args.defaults, *node.args.kw_defaults]:
                if isinstance(default, (ast.List, ast.Dict, ast.Set)):
                    issues.append((default.lineno, MUTABLE_DEFAULT))
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and id(node) not in docstrings
        ):
            issues.append((node.lineno, POINTLESS_STRING))
        if isinstance(node, ast.Compare) and any(
            isinstance(operand, ast.Call)
            and isinstance(operand.func, ast.Name)
            and operand.func.id == TYPE_NAME
            and len(operand.args) == 1
            for operand in [node.left, *node.comparators]
        ):
            ancestor: ast.AST | None = node
            while ancestor is not None and ancestor not in shadowed:
                ancestor = parents.get(ancestor)
            if ancestor is None:
                issues.append((node.lineno, TYPE_COMPARISON))
    filtered = []
    for line, code in issues:
        exemptions = ignored.get(line, set())
        if exemptions is not None and code not in exemptions:
            filtered.append((line, code))
    return sorted(filtered)


def _syntax_gate(files: Sequence[Path]) -> int:
    failed = False
    for path in files:
        for line, code in _syntax_issues(path):
            print(f"{path}:{line}: {code}: {SYNTAX_MESSAGES[code]}", flush=True)
            failed = True
    return int(failed)


def main(argv: Sequence[str]) -> int:
    files = _sources(argv)
    if not files:
        print("lint: no Python source files selected", file=sys.stderr)
        return 2

    commands = (
        ("ruff", "check", "--no-fix", "--config", str(CONFIG)),
        ("pyright", "--project", str(CONFIG), "--pythonpath", sys.executable),
    )
    failed = False
    for command in commands:
        for batch in _batches(files):
            result = subprocess.run([sys.executable, "-m", *command, *batch], check=False)
            failed = result.returncode != 0 or failed
    syntax_failed = _syntax_gate(files)
    prefix_failed = _obsolete_prefix_gate()
    return int(failed or syntax_failed != 0 or prefix_failed != 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
