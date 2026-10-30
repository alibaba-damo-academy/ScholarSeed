"""Contract gate for bundled skill dependencies in the ScholarSeed product Python."""

from __future__ import annotations

import ast
import json
import re
import sys
import tomllib
from pathlib import Path

from service.capabilities.service.package import PACKAGE_MANIFEST
from service.capabilities.service.source import source_lock

PASS = 0
FAIL = 0
REPO_ROOT = Path(__file__).resolve().parents[3]
# 开源布局: 产品发行包(含技能依赖声明)在 apps/serve; 根 pyproject 只是 workspace 编排器。
PYPROJECT = REPO_ROOT / "apps" / "serve" / "pyproject.toml"
WORKSPACE_SCRIPT = REPO_ROOT / "scripts" / "shared" / "workspace.cjs"
BUNDLE_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "cd" / "bundle.cjs"
SKILL_PYTHON_RUNTIME = REPO_ROOT / "apps" / "desktop" / "runtime" / "python.cjs"
BUILD_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "cd" / "build.cjs"
DEPENDENCIES = (
    REPO_ROOT / "apps" / "serve" / "service" / "capabilities" / "service" / "dependencies.py"
)
BACKEND_SOURCE = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "backend.ts"
# 依赖政策有两份声明: registry.json 是构建期政策(scripts/shared/dependencies.py 校验它进 desktop
# 闭包), 技能清单是 provision/verify 真正读取的那份(dependencies.py:_inputs)。两者必须逐字
# 一致, 否则"评审过的政策"与"实际被供给的依赖"会静默分叉。
SKILL_REGISTRY = REPO_ROOT / "skills" / "registry.json"
COMMUNITY_SKILLS = REPO_ROOT / "skills" / "community"
# 随包原生工具链的资产清单: 它是"哪些命令由产品供给"的唯一来源, 技能声明必须是它的子集。
TEXLIVE_MANIFEST = REPO_ROOT / "scripts" / "vendor" / "texlive" / "manifest.json"
# 开源布局: 技能源码事实源在 skills/community/ (随仓开源),
# apps/serve/service/capabilities/skills/ 是 prebundle 离线编译的生成物。
PAID_DOWNLOAD_ADAPTER = (
    REPO_ROOT
    / "skills"
    / "community"
    / "precise-literature-search"
    / "modules"
    / "paid-download"
    / "adapter.py"
)

REQUIRED_PRODUCT_DEPENDENCIES = frozenset(
    {
        "beautifulsoup4",
        "httpx",
        "lxml",
        "patchright",
        "playwright",
        "pydantic",
        "pypdfium2",
        "pdfplumber",
        "pypdf",
        "pyyaml",
        "rich",
        "tenacity",
        "typer",
    }
)
FORBIDDEN_PRODUCT_DEPENDENCIES = frozenset({"fpdf2", "pikepdf", "questionary", "tqdm"})
SKILL_COMMAND_SUFFIXES = frozenset({"", ".json", ".md", ".py", ".sh"})
NAKED_PYTHON_COMMAND = re.compile(
    r"(?m)^(?:#!\s*/usr/bin/env\s+|[ \t]*(?:\$[ \t]+)?)(?:python|python3)(?:[ \t]|$)"
    r'|^[ \t]*["\'](?:python|python3)["\'][ \t]*,?[ \t]*$',
)
PYTHON_PROCESS_METHODS = frozenset({"call", "check_call", "check_output", "Popen", "run"})


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def _distribution_name(specification: str) -> str:
    for separator in ("[", "<", ">", "=", "!", "~", " "):
        specification = specification.split(separator, maxsplit=1)[0]
    return specification.strip().lower().replace("_", "-")


def _product_dependencies_are_declared() -> None:
    project = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    declared = {
        _distribution_name(specification) for specification in project["project"]["dependencies"]
    }
    missing = REQUIRED_PRODUCT_DEPENDENCIES - declared
    check("预装技能传递依赖属于根产品依赖", not missing, str(sorted(missing)))
    forbidden = FORBIDDEN_PRODUCT_DEPENDENCIES & declared
    check("产品不声明未使用的许可证风险依赖", not forbidden, str(sorted(forbidden)))


def _registry_and_package_manifests_agree() -> None:
    policy = json.loads(SKILL_REGISTRY.read_text(encoding="utf-8"))["dependencies"]
    directories = sorted(item.name for item in COMMUNITY_SKILLS.iterdir() if item.is_dir())
    manifests = {}
    for slug in directories:
        manifest = COMMUNITY_SKILLS / slug / PACKAGE_MANIFEST
        if manifest.is_file():
            manifests[slug] = json.loads(manifest.read_text(encoding="utf-8"))
    without_manifest = sorted(slug for slug in directories if slug not in manifests)
    check("每个内置技能都带依赖清单", not without_manifest, str(without_manifest))
    check(
        "registry 没有指向不存在的技能目录",
        not sorted(set(policy) - set(manifests)),
        str(sorted(set(policy) - set(manifests))),
    )
    check(
        "每个技能目录都在 registry 登记政策",
        not sorted(set(manifests) - set(policy)),
        str(sorted(set(manifests) - set(policy))),
    )
    versions = {row["slug"]: row["version"] for row in source_lock(COMMUNITY_SKILLS)["skills"]}
    for slug in sorted(set(policy) & set(manifests)):
        check(
            f"{slug} 源码与打包清单版本一致",
            manifests[slug].get("version") == versions[slug],
            f"source={versions[slug]} manifest={manifests[slug].get('version')}",
        )
        declared = policy[slug]
        supplied = manifests[slug].get("dependencies", {})
        check(
            f"registry 与 {slug} 清单的依赖声明一致",
            declared == supplied,
            f"registry={declared} manifest={supplied}",
        )


def _builds_install_into_product_python() -> None:
    workspace = WORKSPACE_SCRIPT.read_text(encoding="utf-8")
    build = BUILD_SCRIPT.read_text(encoding="utf-8")
    dependencies = DEPENDENCIES.read_text(encoding="utf-8")
    # 开源版没有 Hub 冻结步骤: npm workspace install 直接调 prebundle --build 从仓库源码离线编译。
    check(
        "开发安装使用统一的离线编译入口",
        "'-m', 'service.cli.prebundle', '--build'" in workspace
        and "service.cli.skills" not in workspace,
    )
    check(
        "DMG 使用实际产品 Python 的统一依赖入口",
        re.search(r"'service\.cli\.prebundle',\s*'--provision'", build) is not None,
    )
    check(
        "wheel 不进行第二次依赖解析且同版重装",
        "--no-deps" in dependencies and "--force-reinstall" in dependencies,
    )
    check("统一执行依赖一致性检查", '["-m", "pip", "check"]' in dependencies)
    check("统一执行声明的真实模块入口探针", '["-m", module, "--help"]' in dependencies)


def _merged_path_arguments(source: str) -> list[str]:
    """Argument identifiers of the mergeExecutablePaths() call, in order.

    Matching a whitespace-exact literal broke once already when `hookBin` became
    the first argument, so the invariant is expressed as argument ORDER: every
    product-owned directory has to precede the inherited host PATH.
    """
    marker = "mergeExecutablePaths("
    start = source.index(marker) + len(marker)
    depth = 1
    cursor = start
    while depth:
        if source[cursor] == "(":
            depth += 1
        elif source[cursor] == ")":
            depth -= 1
        cursor += 1
    return [part.strip() for part in source[start : cursor - 1].split(",") if part.strip()]


def _runtime_uses_one_interpreter() -> None:
    backend = BACKEND_SOURCE.read_text(encoding="utf-8")
    bundle = BUNDLE_SCRIPT.read_text(encoding="utf-8")
    launcher = SKILL_PYTHON_RUNTIME.read_text(encoding="utf-8")
    adapter = PAID_DOWNLOAD_ADAPTER.read_text(encoding="utf-8")
    check("Electron 显式注入产品 Python", "[SCHOLARSEED_PYTHON_ENV]: python" in backend)
    order = _merged_path_arguments(backend)
    inherited = order.index("inheritedExecutablePath") if "inheritedExecutablePath" in order else -1
    check("PATH 合并保留继承的宿主 PATH", inherited > 0, str(order))
    for name in (
        "skillBin",
        "hookBin",
        "...pythonDirectories",
        "codexExecutableDirectory",
        "texliveExecutableDirectory",
    ):
        position = order.index(name) if name in order else -1
        check(f"{name} 在继承的宿主 PATH 之前", 0 <= position < inherited, f"order={order}")
    check(
        "开发 Desktop 生成 Skill Python launcher",
        "writeSkillPythonLauncher(skillBin, python)" in backend,
    )
    check(
        "安装包生成目标平台 Skill Python launcher",
        "writeSkillPythonLauncher(bin, python, target.platform)" in bundle,
    )
    check(
        "Skill Python launcher 只按相对路径定位解释器",
        "path.relative(launcherDirectory" in launcher
        and "fs.realpathSync" in launcher
        and "SCHOLARSEED_PYTHON" not in launcher,
    )
    check(
        "Windows Skill Python launcher 原样转发参数",
        "%*" in launcher,
    )
    check(
        "paid-download 使用活动解释器模块入口",
        any(
            isinstance(node, ast.List)
            and ast.dump(node, include_attributes=False)
            == ast.dump(
                ast.parse('[sys.executable, "-m", "paper_dl"]', mode="eval").body,
                include_attributes=False,
            )
            for node in ast.walk(ast.parse(adapter))
        ),
    )


def _skills_use_product_python_command() -> None:
    naked_commands: list[str] = []
    hardcoded_children: list[str] = []
    for path in sorted(COMMUNITY_SKILLS.rglob("*")):
        if not path.is_file() or path.suffix not in SKILL_COMMAND_SUFFIXES:
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if NAKED_PYTHON_COMMAND.search(source):
            naked_commands.append(str(path.relative_to(COMMUNITY_SKILLS)))
        if path.suffix != ".py":
            continue
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if (
                not isinstance(node, ast.Call)
                or not isinstance(node.func, ast.Attribute)
                or node.func.attr not in PYTHON_PROCESS_METHODS
                or not node.args
                or not isinstance(node.args[0], (ast.List, ast.Tuple))
                or not node.args[0].elts
            ):
                continue
            executable = node.args[0].elts[0]
            if isinstance(executable, ast.Constant) and executable.value in {"python", "python3"}:
                hardcoded_children.append(f"{path.relative_to(COMMUNITY_SKILLS)}:{node.lineno}")
    check("Skill 命令不再使用裸 python/python3", not naked_commands, str(naked_commands))
    check(
        "Skill Python 子进程不写死解释器",
        not hardcoded_children,
        str(hardcoded_children),
    )


def _bundled_toolchain_is_staged_and_proved() -> None:
    bundle = BUNDLE_SCRIPT.read_text(encoding="utf-8")
    build = BUILD_SCRIPT.read_text(encoding="utf-8")
    supplied = set(json.loads(TEXLIVE_MANIFEST.read_text(encoding="utf-8"))["executables"])
    policy = json.loads(SKILL_REGISTRY.read_text(encoding="utf-8"))["dependencies"]
    declared = {
        slug: set(dependencies.get("bundled_executables", []))
        for slug, dependencies in policy.items()
        if dependencies.get("bundled_executables")
    }
    check("确有技能声明随包工具链", bool(declared), str(sorted(policy)))
    for slug, names in sorted(declared.items()):
        check(
            f"{slug} 声明的随包工具链由 vendor 资产供给",
            names <= supplied,
            str(sorted(names - supplied)),
        )
    check("打包在校验归档摘要后解压随包工具链", "stageVerifiedTexlive(" in bundle)
    check(
        "provision 收到随包工具链根目录",
        re.search(r"'--toolchain-root',\s*context\.texlive\.binDirectory", build) is not None,
    )
    check("打包期编译技能真实前导作为 oracle", "smoke_publication.py" in build)


def main() -> int:
    _product_dependencies_are_declared()
    _registry_and_package_manifests_agree()
    _builds_install_into_product_python()
    _runtime_uses_one_interpreter()
    _skills_use_product_python_command()
    _bundled_toolchain_is_staged_and_proved()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
