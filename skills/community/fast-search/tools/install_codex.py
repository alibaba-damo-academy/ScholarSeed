#!/usr/bin/env scholarseed-skill-python
"""Install the Veryfast workflow as a native Codex skill.

Examples:
    scholarseed-skill-python tools/install_codex.py --scope user --with-search-config
    scholarseed-skill-python tools/install_codex.py --scope repo --repo /path/to/project
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys


SKILL_NAME = "fast-search"
SOURCE_DIR = Path(__file__).resolve().parent.parent
SEARCH_CONFIG_SOURCE = SOURCE_DIR / "tools" / "search_config.default.json"


def _same_path(left, right):
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return False


def _install_file(source, target, dry_run=False):
    if target.exists() or target.is_symlink():
        try:
            if target.is_file() and target.read_bytes() == source.read_bytes():
                print(f"already installed: {target}")
                return
        except OSError:
            pass
        raise FileExistsError(f"refusing to overwrite existing path: {target}")
    print(f"install file: {target}")
    if not dry_run:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(source), str(target))


def _validate_search_config(target):
    """Accept an existing user config without overwriting machine-local values."""
    if not (target.exists() or target.is_symlink()):
        return
    try:
        if not target.is_file() or not isinstance(json.loads(target.read_text()), dict):
            raise ValueError("expected a JSON object")
    except (OSError, ValueError) as exc:
        raise FileExistsError(f"invalid existing search config {target}: {exc}") from exc


def _install_search_config(source, target, dry_run=False):
    if not (target.exists() or target.is_symlink()):
        _install_file(source, target, dry_run)
        return
    try:
        if target.is_file() and target.read_bytes() == source.read_bytes():
            print(f"already installed: {target}")
            return
        json.loads(target.read_text())
    except (OSError, ValueError) as exc:
        raise FileExistsError(f"invalid existing search config {target}: {exc}") from exc
    print(f"keep existing user config: {target}")


def _install_skill(target, mode, dry_run=False):
    if target.exists() or target.is_symlink():
        if target.is_symlink() and _same_path(target, SOURCE_DIR):
            print(f"already installed: {target} -> {SOURCE_DIR}")
            return
        raise FileExistsError(f"refusing to overwrite existing path: {target}")

    print(f"install skill ({mode}): {target}")
    if dry_run:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    if mode == "symlink":
        target.symlink_to(SOURCE_DIR, target_is_directory=True)
        return

    ignored = shutil.ignore_patterns(
        ".git", ".agents", ".codex", "__pycache__", "*.pyc",
        "fast-search-results", "runs", "work_*", "session",
        "search_config.json", "tests", "api.md",
    )
    shutil.copytree(str(SOURCE_DIR), str(target), ignore=ignored)


def _validate_skill(target):
    if not (target.exists() or target.is_symlink()):
        return
    if target.is_symlink() and _same_path(target, SOURCE_DIR):
        return
    raise FileExistsError(f"refusing to overwrite existing path: {target}")


def _paths(args):
    if args.user_root:
        user_root = Path(args.user_root).expanduser().resolve()
        config_home = user_root / ".config"
    else:
        user_root = Path.home()
        config_home = Path(os.environ.get("XDG_CONFIG_HOME", user_root / ".config")).expanduser()

    if args.scope == "user":
        skill_target = user_root / ".agents" / "skills" / SKILL_NAME
    else:
        repo = Path(args.repo or os.getcwd()).expanduser().resolve()
        skill_target = repo / ".agents" / "skills" / SKILL_NAME

    return (
        skill_target,
        config_home / SKILL_NAME / "search_config.json",
    )


def main():
    parser = argparse.ArgumentParser(description="Install fast-search for Codex")
    parser.add_argument("--scope", choices=("user", "repo"), default="user")
    parser.add_argument("--repo", help="Target repository for --scope repo (default: cwd)")
    parser.add_argument("--mode", choices=("symlink", "copy"), default="symlink")
    parser.add_argument(
        "--with-search-config", action="store_true",
        help="also install an editable machine-local PaperHub config",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--user-root", metavar="PATH", help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    if args.scope == "repo" and args.with_search_config:
        parser.error("--with-search-config is user-scoped; install it with --scope user")

    skill_target, search_config_target = _paths(args)
    try:
        _validate_skill(skill_target)
        if args.with_search_config:
            _validate_search_config(search_config_target)
        _install_skill(skill_target, args.mode, args.dry_run)
        if args.with_search_config:
            _install_search_config(SEARCH_CONFIG_SOURCE, search_config_target, args.dry_run)
    except (FileExistsError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print("\nNext:")
    print("  export SCHOLARSEED_API_KEY=<your PaperHub API key>")
    print("  codex --search -s workspace-write \\")
    print("    -c sandbox_workspace_write.network_access=true")
    print("  Then invoke: $fast-search <your literature-search request>")
    print("  For the low-latency product path, run tools/appserver_quick.py --serve-jsonl")
    if args.mode == "symlink":
        print(f"  Keep the source checkout: {SOURCE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
