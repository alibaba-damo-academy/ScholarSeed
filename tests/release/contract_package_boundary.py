"""ScholarSeed owns business code and consumes dependency packages without legacy namespaces."""

from __future__ import annotations

import ast
import pathlib
import re
import subprocess
import sys
import tomllib

PASS, FAIL = 0, 0
FORBIDDEN_IMPORT_ROOTS = ("damoagent", "agent", "tracekit", "launcher", "workagent")
# legacy research runtime (bc6992e2) 删除后父仓不再拥有顶层 work 树，故不再扫它。
PRODUCTION_ROOTS = (
    "apps/serve/service",
    "packages/runtime/scholarseed_runtime",
    "packages/adapters/codex/scholarseed_codex",
)

# account 边界: 独立 composition root，不得引入产品内部包

# account 的第三方依赖白名单 (proposal 39): import 根 -> pyproject 里的发行包名。
# 两边名字并不总是一致 (jwt <- PyJWT), 所以这张表必须显式写死。
# 白名单本身从 pyproject 的 account extra 读, 不在这里重复声明。
ACCOUNT_IMPORT_TO_DIST = {
    "alembic": "alembic",
    "alibabacloud_dysmsapi20170525": "alibabacloud_dysmsapi20170525",
    "alibabacloud_tea_openapi": "alibabacloud_tea_openapi",
    "cryptography": "cryptography",
    "fastapi": "fastapi",
    "httpx": "httpx",
    "jwt": "pyjwt",
    "psycopg": "psycopg",
    "pydantic": "pydantic",
    "sqlalchemy": "sqlalchemy",
    "uvicorn": "uvicorn",
}

# extra 里的依赖声明可能带 extras 与版本约束 (psycopg[binary] / sqlalchemy>=2.0)
_DIST_NAME = re.compile(r"^([A-Za-z0-9._-]+)")

# 只在运行期被按名加载、不会出现在 import 里的依赖。白名单反向检查要放过它们,
# 但每一项都要写清理由 —— 否则这个口子会变成「反正报错就添进来」的垃圾桶。
ACCOUNT_RUNTIME_ONLY_DISTS = {
    # SQLAlchemy 按 postgresql+psycopg:// 这个 URL 里的驱动名加载它, account 自己不 import
    "psycopg",
}


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def _forbidden(module: str) -> bool:
    return any(module == root or module.startswith(f"{root}.") for root in FORBIDDEN_IMPORT_ROOTS)


def _import_roots(paths: list[pathlib.Path]) -> set[str]:
    """收集这批文件里的顶层 import 根包名。"""
    roots: set[str] = set()
    for path in paths:
        for node in ast.walk(ast.parse(path.read_text("utf-8"))):
            modules: list[str] = []
            if isinstance(node, ast.Import):
                modules.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                modules.append(node.module or "")
            for module in modules:
                head = module.split(".")[0]
                if head:
                    roots.add(head)
    return roots


def _scan(root: pathlib.Path) -> list[str]:
    violations: list[str] = []
    paths = [
        *(path for package in PRODUCTION_ROOTS for path in (root / package).rglob("*.py")),
    ]
    for path in sorted(paths):
        tree = ast.parse(path.read_text("utf-8"))
        for node in ast.walk(tree):
            modules: list[str] = []
            if isinstance(node, ast.Import):
                modules.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                modules.append(node.module or "")
            for module in modules:
                if _forbidden(module):
                    violations.append(f"{path.relative_to(root)}:{node.lineno} {module}")
    return violations


def main() -> int:
    root = pathlib.Path(__file__).resolve().parents[2]
    # 开源布局: 产品发行包 (含 console_scripts) 在 apps/serve; 根 pyproject 是
    # uv workspace 编排器, 不产出 wheel 也不声明 scripts。
    project = tomllib.loads((root / "apps" / "serve" / "pyproject.toml").read_text("utf-8"))
    scripts = project["project"]["scripts"]

    print("── ScholarSeed repository boundary ──")
    check("legacy top-level agent package is absent", not (root / "agent").exists())
    check("legacy top-level tracekit package is absent", not (root / "tracekit").exists())
    check("legacy product launcher package is absent", not (root / "launcher").exists())
    check("legacy workagent package is absent", not (root / "workagent").exists())
    tracked_result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, capture_output=True, text=True, check=False
    )
    check("repository source inventory is readable", tracked_result.returncode == 0)
    tracked = tracked_result.stdout.split("\0")
    tracked_work = [path for path in tracked if path == "work" or path.startswith("work/")]
    check("legacy top-level work sources are absent", not tracked_work, str(tracked_work[:5]))
    check("ScholarSeed owns no Lattice service tree", not (root / "service/lattice").exists())
    check("ScholarSeed owns no Lattice UI tree", not (root / "ui/lattice").exists())
    # 开源边界 (方案 §8): 账号服务留在私有仓库。
    check("account service is not open-sourced", not (root / "account").exists())
    # 企业控制面源码与部署清单由 DeepR_D_Enterprise 独立仓库维护；开源仓既不打包，
    # 也不保留副本，避免凭据和内部部署拓扑再次进入公开历史。
    for enterprise in ("llm_gateway", "deploy"):
        tracked_enterprise = [path for path in tracked if path.startswith(f"{enterprise}/")]
        check(
            f"{enterprise} stays in the enterprise repository",
            not tracked_enterprise,
            str(tracked_enterprise[:5]),
        )
    # 开源仓库不再有内部 GitLab submodule: 两个依赖包以保留历史的方式并入
    # packages/, 各自仍是独立可构建的发行包 (自带 pyproject.toml)。
    check(
        "Runtime is an in-tree independent package; old DamoAgent directory is absent",
        (root / "packages/runtime/pyproject.toml").is_file()
        and not (root / "packages/damoagent").exists(),
    )
    check(
        "DamoATrace is an in-tree independent package",
        (root / "packages/damoatrace/pyproject.toml").is_file(),
    )
    check("no internal GitLab submodules remain", not (root / ".gitmodules").exists())
    check(
        "DamoASub stays in the enterprise control plane",
        not (root / "damoasub").exists() and not (root / "packages/damoasub").exists(),
    )
    check(
        "Codex runtime adapter is an independent package",
        (root / "packages/adapters/codex/pyproject.toml").is_file(),
    )
    violations = _scan(root)
    check("production has no legacy Python imports", not violations, str(violations[:12]))

    # 注: 原 account 边界防护段已随 account/ 一起移出开源仓库 (企业控制面)。
    # 相关约束 (独立 composition root / extras 声明 / Dockerfile 依赖 / 凭据名长度上限)
    # 由私有仓库的同名门禁继续保证。

    check(
        "bare scholarseed launches the Electron product",
        scripts.get("scholarseed") == "service.cli.desktop:main",
    )
    check("DamoAgent command is not owned by ScholarSeed", "damoagent" not in scripts)

    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
