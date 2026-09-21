"""Contract gate for the frozen, offline product skill compiler (fixtures are not acceptance)."""

from __future__ import annotations

import json
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.service.manifest import cache_path
from service.capabilities.service.package import PackageError, json_bytes
from service.capabilities.service.prebundle import (
    SkillPackError,
    compile_bundled_skills,
    validate_bundled_skills,
    verify_bundled_skill_sources,
    verify_locked_pack,
)
from service.capabilities.service.skills import (
    SKILL_CATEGORY_SCHOLARSEED,
    SKILL_CATEGORY_USER,
    SKILL_GROUP_SCHOLARSEED,
    SKILL_GROUP_USER,
    SKILL_INVOCATION_METADATA_KEY,
    SKILL_INVOCATION_PERMISSION_FULL_ACCESS,
    SKILL_INVOCATION_PERMISSION_KEY,
    SKILL_PRODUCT_METADATA_FILE,
    SKILL_RECOVERY_VERSION,
    SkillCatalog,
    SkillPresentation,
    SkillProductState,
    SkillSurfacePresentation,
    load_skill_state,
    save_skill_state,
    workspace_recovery_key,
)

from .contract_skill_distribution import locked_fixture

PASS = 0
FAIL = 0
REPO_ROOT = Path(__file__).resolve().parents[3]
PREBUNDLE_MODULE = "service.cli.prebundle"
EXPECTED_SKILLS = frozenset({"example"})
COMMUNITY_SKILLS_ROOT = REPO_ROOT / "skills" / "community"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def _inputs(root: Path) -> tuple[Path, Path]:
    lock, data = locked_fixture()
    lock["target"] = {
        "platform": sys.platform,
        "machine": platform.machine(),
        "python": platform.python_version(),
    }
    lock_path = root / "skills.lock.json"
    lock_path.write_bytes(json_bytes(lock))
    cache = root / "cache"
    cache.mkdir()
    cache_path(cache, lock["skills"][0]).write_bytes(data)
    return lock_path, cache


def _locked_source_compiles_exactly() -> None:
    with tempfile.TemporaryDirectory(prefix="skill-pack-contract-") as temporary:
        root = Path(temporary)
        lock, cache = _inputs(root)
        target = root / "skills"
        (cache / "unrelated.zip").write_bytes(b"not an input")
        result = compile_bundled_skills(lock, cache, target)
        check("only locked ZIPs are compiled", result.packages == ("fixture/example@1.0.0",))
        check("exact locked skill collection", frozenset(result.skills) == EXPECTED_SKILLS)
        check("standard skill pack", validate_bundled_skills(target, expected=EXPECTED_SKILLS).ok)
        check(
            "executable mode restored",
            (target / "example/scripts/run").stat().st_mode & 0o777 == 0o755,
        )
        metadata = json.loads((target / "example/.scholarseed.json").read_bytes())
        check(
            "real version and fixed product group",
            metadata["version"] == "1.0.0" and metadata["category"] == SKILL_CATEGORY_SCHOLARSEED,
        )
        shutil.copytree(target / "example", target / "stale")
        compile_bundled_skills(lock, cache, target)
        check(
            "clean rebuild removes stale skill",
            set(p.name for p in target.iterdir()) == EXPECTED_SKILLS,
        )
        original = (target / "example/SKILL.md").read_bytes()
        record = json.loads(lock.read_bytes())["skills"][0]
        cache_path(cache, record).write_bytes(b"broken")
        try:
            compile_bundled_skills(lock, cache, target)
        except PackageError:
            check(
                "bad cache preserves old pack",
                (target / "example/SKILL.md").read_bytes() == original,
            )
        else:
            check("bad cache must fail", False)
        check("missing pack rejected", not validate_bundled_skills(root / "missing").ok)
        (target / "unknown").mkdir()
        check("unknown empty top-level directory rejected", not validate_bundled_skills(target).ok)
        try:
            compile_bundled_skills(lock, cache, root)
        except SkillPackError:
            check("input inside target is rejected", True)
        else:
            check("input inside target is rejected", False)


def _official_skills_remain_agent_visible() -> None:
    """产品 surface 可以隐藏官方技能，但 Codex Agent 目录不能隐藏它们。"""

    hidden: list[str] = []
    for skill_dir in sorted(COMMUNITY_SKILLS_ROOT.iterdir()):
        metadata_path = skill_dir / "agents" / "openai.yaml"
        if not metadata_path.is_file():
            continue
        metadata = yaml.safe_load(metadata_path.read_text(encoding="utf-8")) or {}
        policy = metadata.get("policy") or {}
        if policy.get("allow_implicit_invocation") is False:
            hidden.append(skill_dir.name)
    check(
        "所有书深官方技能均进入 Agent 可见目录",
        hidden == [],
        str(hidden),
    )


def _write_manifest(root: Path, name: str) -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    manifest = directory / "SKILL.md"
    manifest.write_text(
        f"---\nname: {name}\ndescription: {name} contract fixture\n---\n",
        encoding="utf-8",
    )
    return manifest


def _view(name: str, manifest: Path) -> SkillView:
    return SkillView(
        name=name,
        path=manifest,
        description=f"{name} runtime description",
        availability=SkillAvailability.AVAILABLE,
        enabled=True,
        scope="system",
    )


def _catalog_exposes_only_product_roots() -> None:
    with tempfile.TemporaryDirectory(prefix="skill-catalog-contract-") as temporary:
        root = Path(temporary)
        bundled_root = root / "bundled"
        user_root = root / "user"
        project_root = root / "project"
        bundled = _write_manifest(bundled_root, "bundled-skill")
        user = _write_manifest(user_root, "user-skill")
        external = _write_manifest(project_root, "test-residual-skill")
        shadow = _write_manifest(project_root, "bundled-skill")
        invocation_policy = {
            SKILL_INVOCATION_METADATA_KEY: {
                SKILL_INVOCATION_PERMISSION_KEY: SKILL_INVOCATION_PERMISSION_FULL_ACCESS
            }
        }
        (bundled.parent / SKILL_PRODUCT_METADATA_FILE).write_bytes(json_bytes(invocation_policy))
        (user.parent / SKILL_PRODUCT_METADATA_FILE).write_bytes(json_bytes(invocation_policy))
        inventory = SkillInventory(
            cwd=REPO_ROOT,
            revision="runtime-revision",
            skills=(
                _view("bundled-skill", bundled),
                _view("user-skill", user),
                _view("test-residual-skill", external),
                _view("bundled-skill", shadow),
            ),
        )
        catalog = SkillCatalog(
            bundled_root=bundled_root,
            user_root=user_root,
            presentation=SkillPresentation(
                surfaces={
                    "conversation": SkillSurfacePresentation(
                        skills=frozenset({"bundled-skill"}),
                        sources=frozenset(),
                    ),
                    "settings": SkillSurfacePresentation(
                        skills=frozenset({"bundled-skill"}),
                        sources=frozenset({"user"}),
                    ),
                },
                required=frozenset(),
            ),
        )
        state = SkillProductState(
            disabled_skills=frozenset({"bundled-skill", "user-skill"}),
            deleted_skills=frozenset({"bundled-skill"}),
        )
        rows = catalog.payloads(inventory, state)
        by_name = {str(row["name"]): row for row in rows}
        check("产品目录只暴露书深与用户根", set(by_name) == {"bundled-skill", "user-skill"})
        conversation = catalog.payloads(inventory, state, surface="conversation")
        check(
            "对话场景只暴露产品登记技能",
            [row["name"] for row in conversation] == ["bundled-skill"],
            str(conversation),
        )
        settings_rows = catalog.payloads(inventory, state, surface="settings")
        check(
            "设置策略包含登记技能与用户安装且不引入外部技能",
            settings_rows == rows,
        )
        check("禁用状态不被可见性覆盖", all(not row["active"] for row in settings_rows))
        check(
            "未知场景仍不展示技能",
            catalog.payloads(inventory, state, surface="unknown") == [],
        )
        deleted_rows = catalog.payloads(
            inventory,
            SkillProductState(deleted_skills=frozenset({"user-skill"})),
            surface="settings",
        )
        check(
            "已删除用户技能不被重新展示", [row["name"] for row in deleted_rows] == ["bundled-skill"]
        )
        bundled.write_text(
            "---\n"
            "name: bundled-skill\n"
            "description: bundled-skill contract fixture\n"
            "description_zh: 预装技能完整说明\n"
            "---\n",
            encoding="utf-8",
        )
        localized_rows = catalog.payloads(inventory, state)
        localized_by_name = {str(row["name"]): row for row in localized_rows}
        check(
            "产品目录从主 SKILL.md frontmatter 投射中文描述",
            localized_by_name["bundled-skill"]["descriptions"] == {"zh": "预装技能完整说明"},
        )
        desired = dict(catalog.desired_enablement(inventory, state))
        check(
            "产品技能按产品状态投影且外部技能不进入稳定态配置",
            desired
            == {
                Path(str(by_name["bundled-skill"]["path"])): False,
                Path(str(by_name["user-skill"]["path"])): False,
            },
            str(catalog.desired_enablement(inventory, state)),
        )
        recovery_plan = catalog.enablement_plan(inventory, state)
        check(
            "首次恢复只启用当前被禁用的外部技能",
            dict(recovery_plan.configurations)
            == {
                bundled.resolve(): False,
                user.resolve(): False,
            },
            str(recovery_plan.configurations),
        )
        disabled_external_inventory = SkillInventory(
            cwd=REPO_ROOT,
            revision="disabled-external",
            skills=(
                _view("bundled-skill", bundled),
                _view("user-skill", user),
                SkillView(
                    name="test-residual-skill",
                    path=external,
                    description="external",
                    availability=SkillAvailability.AVAILABLE,
                    enabled=False,
                    scope="system",
                ),
            ),
        )
        recovery_plan = catalog.enablement_plan(disabled_external_inventory, state)
        check(
            "历史禁用外部技能只在未迁移 workspace 恢复为启用",
            dict(recovery_plan.configurations)[external.resolve()] is True,
        )
        recovery_key = workspace_recovery_key(REPO_ROOT)
        check(
            "恢复计划携带版本化 workspace 回执",
            recovery_plan.state.runtime_recovery_version == SKILL_RECOVERY_VERSION
            and recovery_key in recovery_plan.state.recovered_workspaces,
        )
        repeated = catalog.enablement_plan(disabled_external_inventory, recovery_plan.state)
        check(
            "同一 workspace 完成恢复后不再配置外部技能",
            external.resolve() not in dict(repeated.configurations),
        )
        other_inventory = SkillInventory(
            cwd=root / "another-workspace",
            revision="other-workspace",
            skills=disabled_external_inventory.skills,
        )
        check(
            "不同 workspace 独立执行一次恢复",
            external.resolve()
            in dict(catalog.enablement_plan(other_inventory, recovery_plan.state).configurations),
        )
        state_path = root / "skills.json"
        save_skill_state(recovery_plan.state, state_path)
        check(
            "恢复回执可持久化并完整读回",
            load_skill_state(state_path) == recovery_plan.state,
        )
        check(
            "书深技能使用固定分组",
            by_name["bundled-skill"]["group"] == SKILL_GROUP_SCHOLARSEED
            and by_name["bundled-skill"]["category"] == SKILL_CATEGORY_SCHOLARSEED,
            str(by_name["bundled-skill"]),
        )
        check(
            "用户技能使用固定分组",
            by_name["user-skill"]["group"] == SKILL_GROUP_USER
            and by_name["user-skill"]["category"] == SKILL_CATEGORY_USER,
            str(by_name["user-skill"]),
        )
        check("书深技能不可删除", by_name["bundled-skill"]["removable"] is False)
        check(
            "书深技能保留在目录并遵循停用状态",
            by_name["bundled-skill"]["enabled"] is False
            and by_name["bundled-skill"]["active"] is False,
            str(by_name["bundled-skill"]),
        )
        check("书深技能允许启停", by_name["bundled-skill"]["toggleable"] is True)
        reenabled_state = SkillProductState(deleted_skills=state.deleted_skills)
        reenabled = {str(row["name"]): row for row in catalog.payloads(inventory, reenabled_state)}
        check(
            "书深技能重新启用且忽略历史删除状态",
            reenabled["bundled-skill"]["enabled"] is True
            and reenabled["bundled-skill"]["active"] is True
            and dict(catalog.desired_enablement(inventory, reenabled_state))[bundled.resolve()]
            is True,
        )
        check("用户技能允许删除", by_name["user-skill"]["removable"] is True)
        check(
            "只有书深 bundled 技能暴露受信 Invocation policy",
            by_name["bundled-skill"][SKILL_INVOCATION_METADATA_KEY]
            == invocation_policy[SKILL_INVOCATION_METADATA_KEY]
            and by_name["user-skill"][SKILL_INVOCATION_METADATA_KEY] is None,
        )
        check(
            "用户技能仍可停用与重新启用",
            by_name["user-skill"]["enabled"] is False
            and by_name["user-skill"]["active"] is False
            and by_name["user-skill"]["toggleable"] is True,
            str(by_name["user-skill"]),
        )
        required_catalog = SkillCatalog(
            bundled_root=bundled_root,
            user_root=user_root,
            presentation=SkillPresentation(
                surfaces={},
                required=frozenset({"bundled-skill"}),
            ),
        )
        required = {str(row["name"]): row for row in required_catalog.payloads(inventory, state)}
        check(
            "产品必需技能忽略停用偏好并保持不可切换",
            required["bundled-skill"]["enabled"] is True
            and required["bundled-skill"]["active"] is True
            and required["bundled-skill"]["toggleable"] is False
            and dict(required_catalog.desired_enablement(inventory, state))[bundled.resolve()]
            is True,
            str(required["bundled-skill"]),
        )


def _fingerprint_cache_tracks_content() -> None:
    with tempfile.TemporaryDirectory(prefix="skill-fingerprint-contract-") as temporary:
        root = Path(temporary)
        bundled_root = root / "bundled"
        bundled_root.mkdir()
        user_root = root / "user"
        manifest = _write_manifest(user_root, "cached-skill")
        body = manifest.parent / "body.txt"
        body.write_text("aaaa", encoding="utf-8")
        catalog = SkillCatalog(bundled_root=bundled_root, user_root=user_root)
        inventory = SkillInventory(
            cwd=REPO_ROOT,
            revision="runtime-revision",
            skills=(_view("cached-skill", manifest),),
        )

        def fingerprint() -> str:
            return str(catalog.payloads(inventory, SkillProductState())[0]["fingerprint"])

        first = fingerprint()
        check("目录未变时复用同一指纹", bool(first) and fingerprint() == first, first)
        # 同尺寸改写只剩 mtime 可依据, 这是签名缓存最容易漏判的情形。
        body.write_text("bbbb", encoding="utf-8")
        rewritten = fingerprint()
        check("同尺寸改写也会让指纹失效", rewritten != first, f"{first} -> {rewritten}")
        extra = manifest.parent / "extra.txt"
        extra.write_text("x", encoding="utf-8")
        added = fingerprint()
        check("新增文件会让指纹失效", added != rewritten, f"{rewritten} -> {added}")
        extra.unlink()
        removed = fingerprint()
        check(
            "删除文件会让指纹失效并回到改写后的取值",
            removed != added and removed == rewritten,
            f"{added} -> {removed}",
        )


def _write_source_skill(directory: Path) -> None:
    """写一个最小但合法的技能源码目录 (frontmatter + 可执行脚本)。"""

    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(
        "---\n"
        "name: example\n"
        "description: fixture skill\n"
        "metadata:\n"
        "  version: 1.0.0\n"
        "  short-description: fixture skill\n"
        "  invocation:\n"
        "    permission: full-access\n"
        "---\n\n# Example\n",
        encoding="utf-8",
    )
    interface = directory / "agents"
    interface.mkdir()
    (interface / "openai.yaml").write_text(
        "interface:\n  short_description: fixture skill\n", encoding="utf-8"
    )
    scripts = directory / "scripts"
    scripts.mkdir()
    run = scripts / "run"
    run.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    run.chmod(0o755)


def _cli_gate_runs() -> None:
    """CLI 门禁: 从仓库式技能源码目录离线编译, 无 lock / 无 ZIP 缓存。

    负向用例保持同等强度: 删掉一个已装文件后, 逐文件源校验必须失败并指出路径,
    且只读校验不得把缺失文件补回去。
    """

    with tempfile.TemporaryDirectory(prefix="skill-cli-contract-") as temporary:
        source = Path(temporary) / "community"
        _write_source_skill(source / "example")
        target = Path(temporary) / "skills"
        build_command = [
            sys.executable,
            "-m",
            PREBUNDLE_MODULE,
            "--build",
            "--source",
            str(source),
            "--target",
            str(target),
        ]
        result = subprocess.run(
            build_command, cwd=REPO_ROOT, check=False, capture_output=True, text=True
        )
        check("构建期 Skill CLI 返回成功", result.returncode == 0, result.stdout + result.stderr)
        discovered = validate_bundled_skills(target, expected=EXPECTED_SKILLS)
        check("CLI 产物精确匹配书深 pack", discovered.ok, str(discovered.errors))
        verify_command = [
            sys.executable,
            "-m",
            PREBUNDLE_MODULE,
            "--verify-source",
            "--source",
            str(source),
            "--target",
            str(target),
        ]
        verified = subprocess.run(
            verify_command, cwd=REPO_ROOT, capture_output=True, text=True, check=False
        )
        check("CLI 逐文件源校验返回成功", verified.returncode == 0, verified.stdout)
        product_metadata = json.loads(
            (target / "example" / SKILL_PRODUCT_METADATA_FILE).read_bytes()
        )
        check(
            "源码编译器生成受信 Invocation policy",
            product_metadata[SKILL_INVOCATION_METADATA_KEY]
            == {SKILL_INVOCATION_PERMISSION_KEY: SKILL_INVOCATION_PERMISSION_FULL_ACCESS},
        )
        (target / "example" / SKILL_PRODUCT_METADATA_FILE).write_text("{}\n", encoding="utf-8")
        stale_metadata = subprocess.run(
            verify_command, cwd=REPO_ROOT, capture_output=True, text=True, check=False
        )
        check(
            "CLI 拒绝被篡改的产品 Invocation policy",
            stale_metadata.returncode != 0
            and f"example/{SKILL_PRODUCT_METADATA_FILE}" in stale_metadata.stdout,
            stale_metadata.stdout,
        )
        rebuilt = subprocess.run(
            build_command, cwd=REPO_ROOT, check=False, capture_output=True, text=True
        )
        check("重建恢复可信产品元数据", rebuilt.returncode == 0, rebuilt.stdout)
        config_path = target / "example" / "scripts" / "run"
        config_path.unlink()
        rejected = subprocess.run(
            verify_command, cwd=REPO_ROOT, capture_output=True, text=True, check=False
        )
        check(
            "CLI 缺少模型配置时失败并指出路径",
            rejected.returncode != 0 and "example/scripts/run" in rejected.stdout,
            rejected.stdout,
        )
        check("CLI 只读校验不会补写缺失配置", not config_path.exists())


def _source_verification_checks_payloads() -> None:
    with tempfile.TemporaryDirectory(prefix="skill-payload-contract-") as temporary:
        target = Path(temporary) / "skills"
        lock, zip_cache = _inputs(Path(temporary))
        compile_bundled_skills(lock, zip_cache, target)
        original = verify_bundled_skill_sources(lock, zip_cache, target)
        check("源归档与完整产物逐文件一致", original.ok, str(original.errors))
        config_path = target / "example" / "scripts" / "run"
        original_config = config_path.read_bytes()
        config_path.write_text("{}\n", encoding="utf-8")
        stale = verify_bundled_skill_sources(lock, zip_cache, target)
        check(
            "归档元数据未变也能拦截旧模型配置",
            not stale.ok and "changed bundled file: example/scripts/run" in str(stale.errors),
            str(stale.errors),
        )
        check("逐文件校验不会修改旧配置", config_path.read_text() == "{}\n")
        config_path.write_bytes(original_config)
        unexpected = config_path.with_name("obsolete.json")
        unexpected.write_text("{}\n", encoding="utf-8")
        leaked = verify_bundled_skill_sources(lock, zip_cache, target)
        check("逐文件校验拦截多余资产", not leaked.ok, str(leaked.errors))
        unexpected.unlink()
        config_path.chmod(0o644)
        changed_mode = verify_bundled_skill_sources(lock, zip_cache, target)
        check("missing executable permission rejected", not changed_mode.ok)
        config_path.chmod(0o755)
        cache = target / "example" / "__pycache__"
        cache.mkdir()
        (cache / "generated.cpython-312.pyc").write_bytes(b"interpreter cache")
        cached = verify_bundled_skill_sources(lock, zip_cache, target)
        check("打包精确门禁拒绝锁外字节码缓存", not cached.ok, str(cached.errors))
        check("安装版精确门禁同样拒绝锁外字节码", not verify_locked_pack(lock, target).ok)
        (cache / "link").symlink_to(lock)
        try:
            verify_bundled_skill_sources(lock, zip_cache, target)
        except SkillPackError:
            check("bytecode directory symlink cannot bypass validation", True)
        else:
            check("bytecode directory symlink cannot bypass validation", False)


def main() -> int:
    _locked_source_compiles_exactly()
    _official_skills_remain_agent_visible()
    _catalog_exposes_only_product_roots()
    _fingerprint_cache_tracks_content()
    _cli_gate_runs()
    _source_verification_checks_payloads()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
