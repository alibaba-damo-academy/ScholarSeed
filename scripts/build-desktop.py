#!/usr/bin/env python3
"""构建 ScholarSeed Desktop 的跨平台入口脚本。"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_VENV = ".venv"
BACKEND_STAGE = "backend"
DEFAULT_STAGE = "installer"
DESKTOP_GROUP = "desktop"
UV_ENV = "UV"


def _build_stage(arguments: list[str]) -> str:
    for index, argument in enumerate(arguments):
        if argument == "--stage" and index + 1 < len(arguments):
            return arguments[index + 1]
        if argument.startswith("--stage="):
            return argument.split("=", 1)[1]
    return DEFAULT_STAGE


def _prepare_python_environment(repo_root: Path, node: str) -> bool:
    uv = os.environ.get(UV_ENV) or shutil.which("uv")
    if uv is None:
        print("[build] ERROR uv is required", file=sys.stderr)
        return False

    env = os.environ.copy()
    venv = env.get("VENV") or DEFAULT_VENV
    runtime = env.get("PYTHON")
    if runtime is None or runtime == "":
        prepare = subprocess.run(
            [node, str(repo_root / "scripts" / "python.cjs"), "prepare"],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            text=True,
        )
        if prepare.returncode != 0:
            return False
        runtime = prepare.stdout.strip()

    sync_env = env.copy()
    sync_env["UV_PROJECT_ENVIRONMENT"] = venv
    subprocess.run(
        [
            uv,
            "sync",
            "--locked",
            "--all-packages",
            "--extra",
            "serve",
            "--extra",
            "dev",
            "--group",
            DESKTOP_GROUP,
            "--no-python-downloads",
            "--python",
            runtime,
        ],
        cwd=repo_root,
        env=sync_env,
        check=True,
    )

    if env.get("PYTHON"):
        return True
    subprocess.run(
        [node, str(repo_root / "scripts" / "python.cjs"), "check", venv],
        cwd=repo_root,
        check=True,
    )
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="ScholarSeed Desktop 构建入口脚本。先按 package-lock.json 安装锁定依赖，"
        "再调用 apps/desktop/scripts/build.cjs 执行实际打包。",
        epilog="示例:\n"
        "  python scripts/build-desktop.py\n"
        "  python scripts/build-desktop.py --type dev --platform darwin --arch arm64\n"
        "  python scripts/build-desktop.py --install\n"
        "\n"
        "所有未被本脚本识别的参数都会原样透传给 build.cjs；"
        "完整参数说明见 scripts/BUILD.md。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--install",
        action="store_true",
        help="构建完成后自动安装到本机（macOS 复制到 /Applications，Windows 静默安装）",
    )
    parsed, extra_args = parser.parse_known_args()

    repo_root = Path(__file__).resolve().parent.parent
    desktop_dir = repo_root / "apps" / "desktop"

    node = shutil.which("node")
    if node is None:
        print("[build] ERROR node is required", file=sys.stderr)
        return 1
    subprocess.run(
        [node, str(repo_root / "scripts" / "toolchain.cjs"), "ensure"],
        cwd=desktop_dir,
        check=True,
    )
    if _build_stage(extra_args) != BACKEND_STAGE:
        if not _prepare_python_environment(repo_root, node):
            return 1

    if parsed.install:
        extra_args.append("--install")
    return subprocess.run(
        [node, "scripts/build.cjs", *extra_args],
        cwd=desktop_dir,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
