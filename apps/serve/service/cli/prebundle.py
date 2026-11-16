"""离线编译书深技能 pack，或独立校验源码、安装产物与依赖。"""

from __future__ import annotations

import argparse
import subprocess
import traceback
from pathlib import Path
from typing import Any, Sequence

# Runtime defaults must be applied before importing service paths at this composition root.
from service.brand import apply_runtime_defaults  # noqa: E402

apply_runtime_defaults()

# 下面的导入必须晚于 apply_runtime_defaults(), 原因同上。`noqa` 只管 flake8/ruff,
# pylint 要单独豁免, 否则这个组合根写法会被判成乱序导入。
# pylint: disable=wrong-import-position

from service.capabilities.service.dependencies import (  # noqa: E402
    provision_dependencies,
    verify_dependencies,
)
from service.capabilities.service.manifest import atomic_write  # noqa: E402
from service.capabilities.service.package import json_bytes  # noqa: E402
from service.capabilities.service.prebundle import (  # noqa: E402
    SkillPackError,
    validate_bundled_skills,
)
from service.capabilities.service.source import (  # noqa: E402
    COMMUNITY_SKILLS_DIR,
    compile_source_skills,
    verify_compiled_skill,
    verify_source_pack,
)
from service.chat.service.contracts import bundled_contracts  # noqa: E402
from service.paths import SERVICE_BUNDLED_SKILLS_DIR  # noqa: E402

LOG_PREFIX = "[skills]"
OPERATIONS_SKILL = "scholarseed-product-operations"
BRIDGE_REFERENCE = Path("references/scholarseed-bridge/contracts")


def _bridge_reference(source: Path, *, write: bool = False) -> None:
    skill = source / OPERATIONS_SKILL
    if not skill.is_dir() and not write:
        return
    if not (skill / "SKILL.md").is_file():
        raise SkillPackError(f"Missing operations skill: {skill}")
    reference = skill / BRIDGE_REFERENCE
    expected = bundled_contracts()
    existing = {entry.name for entry in reference.iterdir()} if reference.is_dir() else set()
    extra = sorted(existing - expected.keys())
    if extra:
        raise SkillPackError(f"Obsolete Bridge references in {reference}: {', '.join(extra)}")
    if write:
        reference.mkdir(parents=True, exist_ok=True)
    drifted = []
    for name, content in expected.items():
        target = reference / name
        if write:
            atomic_write(target, content)
        elif not target.is_file() or target.read_bytes() != content:
            drifted.append(name)
    if drifted:
        raise SkillPackError(
            f"Bridge reference drift: {', '.join(drifted)}; regenerate with --write-bridge-reference"
        )


def _parse(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m service.cli.prebundle",
        description="从仓库内 skills/community 源码离线编译或校验书深技能。",
    )
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument(
        "--build",
        action="store_true",
        help="从仓库内技能源码编译并原子替换目标技能 pack。",
    )
    operation.add_argument(
        "--verify-source",
        action="store_true",
        help="只读比较目标 pack 与仓库内源码的每个文件、大小及权限。",
    )
    operation.add_argument(
        "--diagnose-local-skill",
        type=Path,
        metavar="DIRECTORY",
        help="按随包构建清单只读列出一个本地预置技能的文件差异，不影响执行。",
    )
    operation.add_argument(
        "--provision", action="store_true", help="在当前产品 Python 安装技能声明的依赖。"
    )
    operation.add_argument(
        "--verify-installed", action="store_true", help="无需源码的安装产物及依赖验证。"
    )
    operation.add_argument(
        "--write-bridge-reference",
        action="store_true",
        help="从当前 Bridge 注册表刷新随包操作契约。",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=COMMUNITY_SKILLS_DIR,
        help="技能源码根（默认 skills/community），依赖政策取自同级 registry.json。",
    )
    parser.add_argument(
        "--lock",
        type=Path,
        help="构建时输出随包验收清单；依赖安装或离线安装态验证时读取该清单。",
    )
    parser.add_argument("--report", type=Path, help="依赖闭包与原生可选能力检查报告。")
    parser.add_argument(
        "--toolchain-root",
        type=Path,
        help="随包原生工具链的可执行目录；技能声明 bundled_executables 时必填。",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=SERVICE_BUNDLED_SKILLS_DIR,
        help="编译或验证的技能 pack 目录。",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse(argv)
    expected: frozenset[str] | None = None
    if args.diagnose_local_skill is not None:
        try:
            row = verify_compiled_skill(args.diagnose_local_skill.expanduser())
        except (OSError, ValueError) as exc:
            print(f"{LOG_PREFIX} {exc}")
            return 1
        print(f"{LOG_PREFIX} {row['slug']}: local files match the build inventory")
        return 0
    if args.write_bridge_reference:
        try:
            _bridge_reference(args.source, write=True)
        except (OSError, ValueError, SkillPackError) as exc:
            print(f"{LOG_PREFIX} FAILED: {exc}")
            return 1
        return 0
    if args.provision or args.verify_installed:
        try:
            if args.provision:
                result = provision_dependencies(args.lock, args.target, args.toolchain_root)
            else:
                # The installed-product gate deliberately has no source checkout.
                # Its embedded repository lock is the complete byte/mode authority.
                result = verify_dependencies(args.lock, args.target, args.toolchain_root)
            if args.report:
                atomic_write(args.report, json_bytes(result))
            print(
                f"{LOG_PREFIX} installed payload and product dependencies verified: "
                f"{len(result['skills'])} skills"
            )
            return 0
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            print(f"{LOG_PREFIX} FAILED: {exc}")
            traceback.print_exc()
            return 1
    if args.verify_source:
        try:
            ok, problems = verify_source_pack(args.target, args.source)
        except (OSError, SkillPackError, ValueError) as exc:
            print(f"{LOG_PREFIX} FAILED: {exc}")
            traceback.print_exc()
            return 1
        print(f"{LOG_PREFIX} source={args.source.expanduser().resolve()}")
        print(f"{LOG_PREFIX} root={args.target.expanduser().resolve()}")
        for problem in problems:
            print(f"{LOG_PREFIX}   FAILED {problem}")
        if ok:
            print(f"{LOG_PREFIX} all bundled bytes, sizes and modes match the repository source")
        return 0 if ok else 1
    if args.build:
        try:
            _bridge_reference(args.source)
            built = compile_source_skills(args.target, args.source, lock_path=args.lock)
            if args.lock:
                print(f"{LOG_PREFIX} lock={args.lock.expanduser().resolve()}")
        except (OSError, SkillPackError, ValueError) as exc:
            print(f"{LOG_PREFIX} FAILED: {exc}")
            traceback.print_exc()
            return 1
        expected = frozenset(built.skills)
        print(f"{LOG_PREFIX} source={args.source.expanduser().resolve()}")
        print(f"{LOG_PREFIX} built {built.summary()}")
        for package in built.packages:
            print(f"{LOG_PREFIX}   package {package}")
    try:
        outcome = validate_bundled_skills(args.target, expected=expected)
    except (OSError, SkillPackError, ValueError) as exc:
        print(f"{LOG_PREFIX} FAILED: {exc}")
        traceback.print_exc()
        return 1
    print(f"{LOG_PREFIX} root={args.target.expanduser().resolve()}")
    print(f"{LOG_PREFIX} {outcome.summary()}")
    for name in outcome.discovered:
        print(f"{LOG_PREFIX}   validated {name}")
    for name, errors in outcome.errors.items():
        for error in errors:
            print(f"{LOG_PREFIX}   FAILED {name}: {error}")
    return 0 if outcome.ok else 1


def prebundle_main(argv: Any = None) -> int:
    return main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
