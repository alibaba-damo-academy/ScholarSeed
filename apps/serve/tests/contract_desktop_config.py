"""Contract coverage for the desktop packaged-config bootstrap."""

from __future__ import annotations

import json
import logging
import os
import stat
import subprocess
import tempfile
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path

from scholarseed_runtime.contract.resource import RESOURCE_LIFECYCLE_LOGGER
from service.cli.desktop import synchronize_source_skills
from service.cli.serve import (
    CONFIG_FILE_MODE,
    _configure_resource_logging,
    seed_user_config,
)

PASS = 0
FAIL = 0
REPO_ROOT = Path(__file__).resolve().parents[3]
BUNDLE_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "bundle.cjs"
PACKAGE_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "build.cjs"
BUILD_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "build.cjs"
VERIFY_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "verify.cjs"
SIGN_SCRIPT = REPO_ROOT / "apps" / "desktop" / "scripts" / "sign.cjs"
# baseline.cjs 是 Skillhub 交付基线提升器, 开源后应当不存在。
BASELINE_SCRIPT_PATH = REPO_ROOT / "apps" / "desktop" / "scripts" / "baseline.cjs"
TOOLCHAIN_SCRIPT = REPO_ROOT / "scripts" / "toolchain.cjs"
DESKTOP_PACKAGE = REPO_ROOT / "apps" / "desktop" / "package.json"
DESKTOP_PRODUCT = REPO_ROOT / "apps" / "desktop" / "resources" / "product.json"
DESKTOP_BACKEND = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "backend.ts"
DESKTOP_RUNTIME = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "runtime.ts"
DESKTOP_LAUNCHER = REPO_ROOT / "apps" / "serve" / "service" / "cli" / "desktop.py"
PRODUCT_NAME = "书深"
PRODUCT_BUNDLE_ID = "com.scholarseed.desktop"
SHA256_LENGTH = 64


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def test_resource_logging_preserves_hosting_and_third_party_configuration() -> None:
    root_logger = logging.getLogger()
    resource_logger = logging.getLogger(RESOURCE_LIFECYCLE_LOGGER)
    original_handlers = list(root_logger.handlers)
    original_root_level = root_logger.level
    original_resource_level = resource_logger.level
    original_resource_handlers = list(resource_logger.handlers)
    original_resource_propagate = resource_logger.propagate
    trace_logger = logging.getLogger("damoatrace")
    created_handlers = []
    try:
        root_logger.handlers = []
        root_logger.setLevel(logging.WARNING)
        resource_logger.handlers = []
        resource_logger.propagate = True
        resource_logger.setLevel(logging.NOTSET)
        trace_level = trace_logger.getEffectiveLevel()
        output = StringIO()
        with redirect_stderr(output):
            _configure_resource_logging("info")
            created_handlers = list(root_logger.handlers)
            _configure_resource_logging("info")
            resource_logger.info("resource lifecycle contract")
        check(
            "resource lifecycle reaches the existing stderr capture",
            "resource lifecycle contract" in output.getvalue(),
        )
        check(
            "resource logging does not duplicate handlers",
            len(root_logger.handlers) == 1 and root_logger.handlers == created_handlers,
        )
        check(
            "resource logging preserves root and Trace verbosity",
            root_logger.level == logging.WARNING
            and trace_logger.getEffectiveLevel() == trace_level,
        )
        resource_logger.setLevel(logging.ERROR)
        _configure_resource_logging("debug")
        check(
            "hosting logger level and handlers remain authoritative",
            resource_logger.level == logging.ERROR and root_logger.handlers == created_handlers,
        )
    finally:
        root_logger.handlers = original_handlers
        root_logger.setLevel(original_root_level)
        resource_logger.setLevel(original_resource_level)
        resource_logger.handlers = original_resource_handlers
        resource_logger.propagate = original_resource_propagate
        for handler in created_handlers:
            handler.close()


def test_seed_user_config() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / "package-config.json"
        target = root / "user" / "config.json"
        payload = {"provider": "openai", "api_key": "internal-secret", "model_name": "m"}
        source.write_text(json.dumps(payload), encoding="utf-8")
        check(
            "first launch copies packaged config",
            seed_user_config(source=source, target=target)
            and json.loads(target.read_text()) == {"provider": "openai", "model_name": "m"},
        )
        # 出厂种子内嵌的凭据不能落进用户配置: 那把 key 全体客户端共用, 不识别人、
        # 不能按用户吊销。模型调用的凭据是登录用户的 access JWT, 不经这份文件。
        check(
            "packaged credential is stripped before landing",
            "api_key" not in json.loads(target.read_text()),
            target.read_text(),
        )
        check(
            "seeded config has owner-only mode",
            stat.S_IMODE(target.stat().st_mode) == CONFIG_FILE_MODE,
        )
        target.write_text(json.dumps({"provider": "user-choice"}), encoding="utf-8")
        check(
            "existing user config is preserved",
            not seed_user_config(source=source, target=target)
            and json.loads(target.read_text()) == {"provider": "user-choice"},
        )


def test_reject_invalid_default_config() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / "invalid.json"
        target = root / "user" / "config.json"
        source.write_text("not-json", encoding="utf-8")
        try:
            seed_user_config(source=source, target=target)
        except RuntimeError as exc:
            check("invalid packaged config is rejected", "not valid JSON" in str(exc))
        else:
            check("invalid packaged config is rejected", False, "no exception")


def test_desktop_synchronizes_repository_skill_pack() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        source = root / "source"
        skill = source / "demo"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: demo\ndescription: Desktop source synchronization contract\n---\n",
            encoding="utf-8",
        )
        target = root / "target"
        stale = target / "stale"
        stale.mkdir(parents=True)
        (stale / "SKILL.md").write_text(
            "---\nname: stale\ndescription: Stale generated skill\n---\n",
            encoding="utf-8",
        )
        (stale / ".scholarseed.json").write_text("{}", encoding="utf-8")

        check(
            "desktop launch rebuilds a stale repository skill pack",
            synchronize_source_skills(source=source, target=target)
            and (target / "demo" / "SKILL.md").is_file()
            and not stale.exists(),
        )
        metadata = target / "demo" / ".scholarseed.json"
        before = metadata.stat().st_mtime_ns
        check(
            "desktop launch preserves an already current skill pack",
            synchronize_source_skills(source=source, target=target)
            and metadata.stat().st_mtime_ns == before,
        )


def test_packaged_codex_runtime_is_a_complete_pair() -> None:
    bundle = BUNDLE_SCRIPT.read_text(encoding="utf-8")
    package = PACKAGE_SCRIPT.read_text(encoding="utf-8")
    build = BUILD_SCRIPT.read_text(encoding="utf-8")
    verify = VERIFY_SCRIPT.read_text(encoding="utf-8")
    signer = SIGN_SCRIPT.read_text(encoding="utf-8")
    backend = DESKTOP_BACKEND.read_text(encoding="utf-8")
    runtime = DESKTOP_RUNTIME.read_text(encoding="utf-8")
    launcher = DESKTOP_LAUNCHER.read_text(encoding="utf-8")
    desktop = json.loads(DESKTOP_PACKAGE.read_text(encoding="utf-8"))
    product = json.loads(DESKTOP_PRODUCT.read_text(encoding="utf-8"))
    runtime_policy = product["runtimes"][product["default_runtime"]]
    credential_profiles = product["credential_profiles"]
    resources = desktop["build"]["extraResources"]

    check(
        "bundle requires an explicit custom Codex input",
        "context.binaries.codex.root" in bundle,
    )
    check(
        "local package discovers the reviewed upstream Codex binary",
        "const DESKTOP = path.resolve(__dirname, '..')" in package
        and "resolveVendoredCodex" in build
        and "DEFAULT_CODEX_DIR" not in package
        and "SCHOLARSEED_BUNDLE_CODEX_CODE_MODE_HOST" not in package,
    )
    check(
        "bundle preserves the complete official Codex runtime package",
        "fs.cpSync(context.binaries.codex.root" in bundle and "codex-runtime" in bundle,
    )
    check(
        "bundle validates the target architecture",
        "target.triple" in bundle and "target.ripgrepName" in bundle,
    )
    check(
        "electron-builder copies the generated backend resource tree",
        any(
            row.get("from") == "resources/backend" and row.get("to") == "backend"
            for row in resources
        ),
    )
    check(
        "desktop packaging uses one locked owner and target-scoped build directory",
        desktop["scripts"]["bundle:backend"] == "node scripts/build.cjs --stage backend --type dev"
        and "const mutex = acquireMutex()" in build
        and "buildRunDirectory(releaseRoot, args)" in build
        and "resourceRoot" in build,
    )
    check(
        "skill compilation is offline and the frozen lock is re-checked",
        # 开源版没有 Hub sync: 从源码编译, 冻结 lock, 构建末尾复核 lock 未漂移。
        "'service.cli.prebundle', '--build'" in build
        and "context.lockSha256 = await verify.sha256(context.lock)" in build,
    )
    check(
        "local DMG needs no delivered Skillhub baseline",
        # 技能源码随仓库, 因此不再有 --lock/--cache/--refresh-skills 交付基线复放。
        "DELIVERED_SKILLS_LOCK" not in package and "--refresh-skills" not in package,
    )
    check(
        "desktop build uses the shared locked npm dependency installer",
        "ensureNodeDependencies()" in build
        and "require('../../../scripts/toolchain.cjs')" in build
        and "runNpm(['ci', '--no-audit', '--no-fund'], repo)"
        in TOOLCHAIN_SCRIPT.read_text(encoding="utf-8"),
    )
    check(
        "backend configuration validation uses the product Python",
        "fs.copyFileSync(context.config.path, config)" in bundle,
    )
    check(
        "packaging no longer depends on Skillhub",
        not BASELINE_SCRIPT_PATH.exists()
        and "service.cli.skills" not in build
        and "scholarseed_skills" not in build
        and "--previous" not in build,
    )
    check(
        "packaging compiles skills from the in-repo source and re-verifies bytes",
        "'--build', '--source', context.skillSource" in build
        and "path.join(REPO, 'skills', 'community')" in build,
    )
    check(
        "development desktop launch synchronizes repository skills before runtime discovery",
        "if not attach_url and not synchronize_source_skills():" in launcher,
    )
    check(
        "local DMG uses a complete ad-hoc app signature",
        "mac.identity = null" in build
        and desktop["build"]["afterPack"] == "scripts/sign.cjs"
        and "identity: AD_HOC_IDENTITY" in signer
        and "identityValidation: false" in signer
        and signer.index("await verify(builderContext)") < signer.index("await signAsync")
        and "artifact failed structural codesign verification" in verify,
    )
    check(
        "reviewed upstream Codex is never rewritten by App signing",
        "/Contents/Resources/backend/bin/codex$" in desktop["build"]["mac"]["signIgnore"]
        and "/Contents/Resources/backend/codex-runtime(?:/|$)"
        in desktop["build"]["mac"]["signIgnore"]
        and "ignore: shouldIgnore" in signer
        and "return preserveReviewedRuntime(filename) || !isMachO(filename)" in signer
        and "await sha256(current.codex) !== frozen.binaries.codex.sha256" in verify,
    )
    check(
        "packaged code identity must match the product bundle id",
        "CFBundleIdentifier: frozen.appId" in verify,
    )
    check(
        "DMG artifact gate verifies upstream Codex and ripgrep",
        "current.codex" in verify
        and "current.rg" in verify
        and "packaged resources differ from frozen build inputs" in verify,
    )
    check(
        "reviewed Codex runtime policy is digest-bound and explicit",
        product["default_runtime"] == "codex"
        and runtime_policy["enabled"] is True
        and runtime_policy["profile"] == "official"
        and runtime_policy["distribution"] == "official-vendored"
        and "runtime.executable_sha256 = binaries.codex.executable_sha256" in build
        and "runtime.reported_version = binaries.codex.reported_version" in build
        and "code_mode_host_sha256" not in runtime_policy
        and "gateway_auth" not in runtime_policy
        and "allow_development_version" not in runtime_policy
        # 多 runtime manifest 下校验消息已泛化为逐 runtime / 逐二进制。
        and "default runtime lacks verified official release evidence" in build,
    )
    check(
        "local DMG credentials avoid macOS Keychain without disabling account auth",
        product["auth_mode"] == "account"
        and credential_profiles["local"]["key_provider"] == "mock_keychain"
        and credential_profiles["distribution"]["key_provider"] == "system_keychain"
        and "use-mock-keychain"
        in (REPO_ROOT / "apps" / "desktop" / "src" / "main" / "index.ts").read_text(
            encoding="utf-8"
        ),
    )
    check(
        "packaged bundled Codex adds no private Harness capabilities",
        "projectCodexRuntimeEnvironment" in backend
        and "app.isPackaged" in backend
        and "resolve(selectedExecutable) === resolve(bundledExecutable)" in runtime
        and "SCHOLARSEED_CODEX_GATEWAY_AUTH" not in runtime
        and "DAMOAGENT_CODEX_ALLOW_DEVELOPMENT_VERSION" not in runtime,
    )
    check(
        "packaged Python cannot mutate the signed App with bytecode caches",
        "const PYTHON_DONT_WRITE_BYTECODE_ENV = 'PYTHONDONTWRITEBYTECODE'" in backend
        and "...(app.isPackaged ? { [PYTHON_DONT_WRITE_BYTECODE_ENV]: '1' } : {})" in backend,
    )
    check(
        "desktop launch and artifact verification use product-owned paths",
        "SCHOLARSEED_HOME" in backend
        and "SCHOLARSEED_PROJECT_DIRNAME" in backend
        and "SCHOLARSEED_HOME" in verify
        and "SCHOLARSEED_PROJECT_DIRNAME" in verify
        and all(
            obsolete not in source
            for source in (backend, verify)
            for obsolete in (
                "DAMOAGENT_HOME",
                "DAMOAGENT_PROJECT_DIRNAME",
                "DAMOAGENT_OBS_CONSOLE",
            )
        ),
    )


def main() -> int:
    print("desktop packaged config contract")
    test_resource_logging_preserves_hosting_and_third_party_configuration()
    test_seed_user_config()
    test_reject_invalid_default_config()
    test_desktop_synchronizes_repository_skill_pack()
    test_packaged_codex_runtime_is_a_complete_pair()
    print(f"passed={PASS} failed={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
