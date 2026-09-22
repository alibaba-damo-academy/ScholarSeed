"""content 域单一入口的机器可检守护 (proposal 47 §6.5)。

`ContentPort.resolve()` 返回 `str`, 所以「上层不得自行拼路径」在类型上无法
强制。三道 guard 用 AST 把它变成可检的:

1. **写操作 guard**: 消费域源码不出现 `open(` / `write_text(` / `mkdir(` /
   `shutil.*` —— 文件写入只能经 Port;
2. **路径拼接 guard**: 消费域不用 `Path` 拼接或 `expanduser()`;
   `Path(absolute).is_dir()` 这类只读判定放行 (资料库 api 现状即如此);
3. **事实源唯一性 guard**: 全仓不存在从目录名反解语义的代码 (对 `dir_root`
   做 `split("-")`、切片取日期或前 8 位等) —— 身份只来自 `project_id`,
   位置只来自 `dir_root`, 时间只来自 `created_at`。

用 AST 而不是子串匹配: 注释与 docstring 里出现 `mkdir(` 不是违规, 而
`shutil.copytree` 这种真实调用必须抓到。
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
from pathlib import Path

SERVE_ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = SERVE_ROOT / "service"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DESKTOP_SOURCE_ROOT = REPOSITORY_ROOT / "apps" / "desktop" / "src"

#: 只能经 Port 访问文件的消费域 (content 自己与 platform 契约不在其列)。
CONSUMER_DOMAINS = ("resources", "literature", "workbench", "assistant")

#: 持久化 owner 可以直接操作自己拥有的数据库或 CAS 对象布局；消费域的其余
#: 模块仍只能通过 ContentPort 读写项目文件。
STORAGE_OWNERS = (Path("resources/persistence"), Path("literature/persistence"))

#: 禁止的裸函数调用。
FORBIDDEN_FUNCTIONS = frozenset({"open"})

#: 禁止的方法名 (写操作 + 路径拼接/展开)。
#: 不含 `resolve`: `ContentPort.resolve()` 正是上层**应该**调的那一个。
#: 不含 `replace`: `dataclasses.replace` 与 `str.replace` 同名, 会误报。
FORBIDDEN_METHODS = frozenset(
    {
        "write_text",
        "write_bytes",
        "read_text_file",
        "mkdir",
        "rmdir",
        "unlink",
        "touch",
        "expanduser",
        "joinpath",
        "rglob",
        "iterdir",
    }
)

#: 禁止 import 的模块 (整包都是文件操作)。
FORBIDDEN_MODULES = frozenset({"shutil", "os.path"})

#: `write_text` 既是 `Path` 的方法, 也是 `ContentPort` 的方法 —— 靠**接收者**区分:
#: 经 Port 写是本提案要求的形态, 直接对 Path 写才是违规。
PORT_RECEIVERS = re.compile(r"^(self\._?)?(content|port|_content|_port)$")

#: `Path(x)` 允许的只读判定。
READONLY_PATH_ATTRS = frozenset({"is_dir", "is_file", "exists"})

#: 从目录名反解语义的形态。命中即说明目录名被当成了事实源。
DIRNAME_PARSE_PATTERNS = (
    re.compile(r"dir_root[^\n]{0,40}?\.(split|rsplit|partition)\("),
    re.compile(r"dir_root\s*\["),
    re.compile(r"directory_name\([^)]*\)\s*(\[|\.(split|rsplit|partition)\()"),
    re.compile(r"\.name\s*\.\s*split\(\s*[\"']-[\"']"),
)

#: 已被 content trash-token 链替代的整套过渡 API/IPC，生产源码必须保持零引用。
LEGACY_DELETE_MARKERS = (
    "/api/resource/trash",
    "scholarseed:trash-path",
    "trashPath",
    "resolve_for_trash",
)

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def domain_files() -> tuple[Path, ...]:
    files: list[Path] = []
    for domain in CONSUMER_DOMAINS:
        files.extend(
            path
            for path in sorted((SERVICE_ROOT / domain).rglob("*.py"))
            if not any(owner in path.relative_to(SERVICE_ROOT).parents for owner in STORAGE_OWNERS)
        )
    return tuple(files)


def code_without_comments(path: Path) -> str:
    """去掉注释与 docstring 的源码, 供正则型 guard 使用。"""

    source = path.read_text(encoding="utf-8")
    kept: list[str] = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type in {tokenize.COMMENT, tokenize.STRING}:
            continue
        kept.append(token.string)
    return " ".join(kept)


def write_violations(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_FUNCTIONS:
                found.append(f"{path.name}:{node.lineno} {node.func.id}()")
            if isinstance(node.func, ast.Attribute) and node.func.attr in FORBIDDEN_METHODS:
                receiver = ast.unparse(node.func.value)
                if not PORT_RECEIVERS.match(receiver):
                    found.append(f"{path.name}:{node.lineno} {receiver}.{node.func.attr}()")
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in FORBIDDEN_MODULES:
                    found.append(f"{path.name}:{node.lineno} import {alias.name}")
        if isinstance(node, ast.ImportFrom) and (node.module or "") in FORBIDDEN_MODULES:
            found.append(f"{path.name}:{node.lineno} from {node.module}")
    return found


def path_violations(path: Path) -> list[str]:
    """`Path` 只允许用于只读判定, 不允许拼接。"""

    tree = ast.parse(path.read_text(encoding="utf-8"))
    readonly: set[int] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and node.attr in READONLY_PATH_ATTRS
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "Path"
        ):
            readonly.add(id(node.value))
    found: list[str] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "Path"
        ):
            if id(node) not in readonly:
                found.append(f"{path.name}:{node.lineno} Path(...) 非只读判定")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            for side in (node.left, node.right):
                if (
                    isinstance(side, ast.Call)
                    and isinstance(side.func, ast.Name)
                    and side.func.id == "Path"
                ):
                    found.append(f"{path.name}:{node.lineno} Path 参与路径拼接")
    return found


def main() -> int:
    files = domain_files()
    check("消费域源码可枚举", len(files) > 0, str(SERVICE_ROOT))

    writes = [item for path in files for item in write_violations(path)]
    check("写操作 guard: 消费域不直接写文件", not writes, str(writes))

    joins = [item for path in files for item in path_violations(path)]
    check("路径拼接 guard: 消费域不自行拼路径", not joins, str(joins))

    parsed: list[str] = []
    for path in sorted(SERVICE_ROOT.rglob("*.py")):
        stripped = code_without_comments(path)
        for pattern in DIRNAME_PARSE_PATTERNS:
            if pattern.search(stripped):
                parsed.append(f"{path.relative_to(SERVICE_ROOT)} ~ {pattern.pattern}")
    check("事实源唯一性 guard: 无人从目录名反解语义", not parsed, str(parsed))

    legacy_delete_references: list[str] = []
    for root in (SERVICE_ROOT, DESKTOP_SOURCE_ROOT):
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx"}:
                continue
            source = path.read_text(encoding="utf-8")
            for marker in LEGACY_DELETE_MARKERS:
                if marker in source:
                    legacy_delete_references.append(
                        f"{path.relative_to(REPOSITORY_ROOT)} ~ {marker}"
                    )
    check(
        "旧删除通道 guard: production 中没有 resource trash 或 trashPath",
        not legacy_delete_references,
        str(legacy_delete_references),
    )

    # guard 自身必须真的会红: 拿一段违规源码验一次, 否则一个写错的正则会让
    # 三道 guard 永远绿着放行。
    probe = SERVE_ROOT / "tests" / "_boundary_probe.py"
    probe.write_text(
        "from pathlib import Path\n\n\n"
        "def bad(root: str, content: object) -> None:\n"
        "    target = Path(root).expanduser() / 'x'\n"
        "    target.mkdir(parents=True)\n"
        "    target.write_text('y', encoding='utf-8')\n"
        "    content.write_text('p', 'x', 'y')\n",
        encoding="utf-8",
    )
    try:
        violations = write_violations(probe)
        check("写操作 guard 对违规样本会红", len(violations) >= 2, str(violations))
        check(
            "写操作 guard 放行经 Port 的写入",
            not any("content.write_text" in item for item in violations),
            str(violations),
        )
        check("路径拼接 guard 对违规样本会红", len(path_violations(probe)) >= 1)
    finally:
        probe.unlink()

    print(f"\ncontract_content_boundary: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
