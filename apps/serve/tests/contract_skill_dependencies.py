"""Contract gate for bundled skill dependencies in the ScholarSeed product Python."""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

from service.capabilities.service.package import PACKAGE_MANIFEST

PASS = 0
FAIL = 0
REPO_ROOT = Path(__file__).resolve().parents[3]
# 开源布局: 产品发行包(含技能依赖声明)在 apps/serve; 根 pyproject 只是 workspace 编排器。
PYPROJECT = REPO_ROOT / "apps" / "serve" / "pyproject.toml"
MAKEFILE = REPO_ROOT / "Makefile"
BUNDLE_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "bundle.cjs"
BUILD_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "build.cjs"
DEPENDENCIES = (
    REPO_ROOT / "apps" / "serve" / "service" / "capabilities" / "service" / "dependencies.py"
)
BACKEND_SOURCE = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "backend.ts"
# 依赖政策有两份声明: registry.json 是构建期政策(scripts/dependencies.py 校验它进 desktop
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
        "pikepdf",
        "playwright",
        "pydantic",
        "pymupdf",
        "pyyaml",
        "rich",
        "tenacity",
        "typer",
    }
)


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
    for slug in sorted(set(policy) & set(manifests)):
        declared = policy[slug]
        supplied = manifests[slug].get("dependencies", {})
        check(
            f"registry 与 {slug} 清单的依赖声明一致",
            declared == supplied,
            f"registry={declared} manifest={supplied}",
        )


def _builds_install_into_product_python() -> None:
    makefile = MAKEFILE.read_text(encoding="utf-8")
    build = BUILD_SCRIPT.read_text(encoding="utf-8")
    dependencies = DEPENDENCIES.read_text(encoding="utf-8")
    # 开源版没有 Hub 冻结步骤: make install 直接调 prebundle --build 从仓库源码离线编译。
    check(
        "开发安装使用统一的离线编译入口",
        "-m service.cli.prebundle --build" in makefile and "service.cli.skills" not in makefile,
    )
    check(
        "DMG 使用实际产品 Python 的统一依赖入口", "'service.cli.prebundle', '--provision'" in build
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
    adapter = PAID_DOWNLOAD_ADAPTER.read_text(encoding="utf-8")
    check("Electron 显式注入产品 Python", "[SCHOLARSEED_PYTHON_ENV]: python" in backend)
    order = _merged_path_arguments(backend)
    inherited = order.index("inheritedExecutablePath") if "inheritedExecutablePath" in order else -1
    check("PATH 合并保留继承的宿主 PATH", inherited > 0, str(order))
    for name in (
        "hookBin",
        "pythonExecutableDirectory",
        "codexExecutableDirectory",
        "texliveExecutableDirectory",
    ):
        position = order.index(name) if name in order else -1
        check(f"{name} 在继承的宿主 PATH 之前", 0 <= position < inherited, f"order={order}")
    check(
        "paid-download 使用活动解释器模块入口",
        '[sys.executable, "-m", "paper_dl"]' in adapter,
    )
    product_policy = adapter.find("if os.getenv(PRODUCT_PYTHON_ENV):")
    product_entry = adapter.find('[sys.executable, "-m", "paper_dl"]', product_policy)
    standalone_fallback = adapter.find("local_executable = installed_venv_executable()")
    check(
        "paid-download 在书深产品路径不切换 skill 独立环境",
        product_policy >= 0
        and product_entry > product_policy
        and standalone_fallback > product_entry,
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
        "'--toolchain-root', context.texlive.binDirectory" in build,
    )
    check("打包期编译技能真实前导作为 oracle", "smoke_publication.py" in build)


def main() -> int:
    _product_dependencies_are_declared()
    _registry_and_package_manifests_agree()
    _builds_install_into_product_python()
    _runtime_uses_one_interpreter()
    _bundled_toolchain_is_staged_and_proved()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
