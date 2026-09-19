#!/usr/bin/env python3
"""构建 ScholarSeed Desktop 的跨平台入口脚本。"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


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

    if parsed.install:
        extra_args.append("--install")
    return subprocess.run(
        [node, "scripts/build.cjs", *extra_args],
        cwd=desktop_dir,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
