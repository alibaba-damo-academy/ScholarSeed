"""ScholarSeed Electron application launcher.

- 定位 apps/desktop/ (env `SCHOLARSEED_APP_DIR` 可覆盖)
- 找 node/npm (electron 运行时需要 node; 缺则提示装)
- node_modules 缺失 → npm install
- 启动**前**在终端打印一份**启动报告** (SCHOLARSEED_HOME / 配置的 model+provider+base_url /
  trace 系统状态 + UI 地址 / 后端=仓库 .venv editable=最新代码 / 前端=live HMR / 日志路径),
  让你在终端就看到起了什么、配置对不对、trace 在哪 —— 然后启动日志实时流在 banner 下方。
- 默认 exec `npm run dev` (electron-vite dev): 前端 vite HMR + main/preload 即时编译 + 后端从
  仓库 .venv 跑 `python -m service.cli.serve` (后台子进程) → **始终用最新代码**, 不碰打包产物。
- `--shoot` / `--say "msg"` / `--mode-check` / `--drive <dir>`: 无头验证模式 (electron-vite build → electron . flags),
  capturePage 落 PNG 到 tmp/test_snapshot/desktop/, 供开发者/Claude 看真实渲染。
- `--attach <url>` 或 env `SCHOLARSEED_SERVE_URL`: electron 挂到一个**已在后台跑的 serve** (后台挂载式),
  不自起后端 —— 你可以先 `scholarseed serve` 在后台跑最新代码, 再用本 launcher 挂上去看。

Env:
  SCHOLARSEED_APP_DIR       覆盖 apps/desktop 目录
  SCHOLARSEED_BIN           scholarseed python bin (传给 electron main 备用)
  SCHOLARSEED_HOME       整体换 root (config/logs/trace 都跟着走)
  DAMOAGENT_TRACE[_SERVER] trace 系统开关 (见 damoatrace.recording.config)
  SCHOLARSEED_SERVE_URL     挂到已在跑的后台 serve
"""

# Composition-root exception (see `apply_runtime_defaults()` below): the product home must
# land before damoagent is imported, so the remaining imports stay after that call.
# pylint: disable=wrong-import-position

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

# 书深运行时根默认值必须在 import damoagent 之前落地: Agent 层的路径常量在 import 时
# 即按 .scholarseed 求值。这是 composition root 的既定例外, 故此处 import 顺序被显式豁免。
from service.brand import apply_runtime_defaults  # noqa: E402

apply_runtime_defaults()

import damoatrace.server.launcher as trace_server_launcher  # noqa: E402
from damoatrace.recording.config import resolve_trace  # noqa: E402
from service.capabilities.service.prebundle import SkillPackError  # noqa: E402
from service.capabilities.service.source import (  # noqa: E402
    COMMUNITY_SKILLS_DIR,
    compile_source_skills,
    verify_source_pack,
)
from service.paths import (  # noqa: E402
    CONFIG_PATH,
    SCHOLARSEED_HOME,
    SERVICE_BUNDLED_SKILLS_DIR,
    SYSTEM_LOG,
)
from service.platform.executables import executable_suffix, scripts_directory  # noqa: E402
from service.settings.config import load_config_values  # noqa: E402

_TRACE_UI_WAIT_SECONDS = 1.5
_ENV_APP_DIR = "SCHOLARSEED_APP_DIR"
_ENV_SCHOLARSEED_BIN = "SCHOLARSEED_BIN"
_ENV_SCHOLARSEED_PYTHON = "SCHOLARSEED_PYTHON"
_ENV_SERVE_URL = "SCHOLARSEED_SERVE_URL"
_DESKTOP_DIRNAME = "desktop"
_SCHOLARSEED_SCRIPT = "scholarseed"
_TOOLCHAIN_RELATIVE = ("scripts", "pre", "toolchain.cjs")
_ELECTRON_PACKAGE_RELATIVE = ("node_modules", "electron")
_ELECTRON_PATH_FILE = "path.txt"
_ELECTRON_DIST_DIRECTORY = "dist"
_SKILL_SYNC_FAILURE = "[scholarseed] repository skill pack synchronization failed"
_SKILL_SYNC_SUCCESS = "[scholarseed] repository skill pack synchronized"


def _find_desktop_dir() -> Optional[Path]:
    """定位 Electron 工程目录 (apps/desktop)。

    开源布局下本模块住在 apps/serve/service/cli/, Electron 工程是 apps/ 下的兵弟
    目录 apps/desktop/。打包后渲染产物与主进程已在 App 内, 不走本 launcher ——
    因此只需在开发树里找到工程根, 找不到就显式报错而不静默回落。
    """

    env_override = os.environ.get(_ENV_APP_DIR)
    candidates: List[Path] = []
    if env_override:
        candidates.append(Path(env_override))
    # service/cli/desktop.py -> service/cli -> service -> apps/serve -> apps
    candidates.append(Path(__file__).resolve().parents[3] / _DESKTOP_DIRNAME)
    for p in candidates:
        if (p / "package.json").exists():
            return p
    return None


def _find_node() -> Optional[str]:
    """electron 用 node/npm 运行时 (非 bun)。"""
    return shutil.which("node")


def _electron_bin(desktop: Path) -> Optional[str]:
    package = desktop.joinpath(*_ELECTRON_PACKAGE_RELATIVE)
    manifest = package / _ELECTRON_PATH_FILE
    if not manifest.is_file():
        return None
    cand = package / _ELECTRON_DIST_DIRECTORY / manifest.read_text(encoding="utf-8").strip()
    return str(cand) if cand.exists() else None


def _ensure_deps(desktop: Path, node: str) -> bool:
    toolchain = desktop.parents[1].joinpath(*_TOOLCHAIN_RELATIVE)
    return subprocess.call([node, str(toolchain), "ensure"], cwd=desktop) == 0


def synchronize_source_skills(
    *,
    source: Path = COMMUNITY_SKILLS_DIR,
    target: Path = SERVICE_BUNDLED_SKILLS_DIR,
) -> bool:
    """Keep the ignored development pack aligned with its repository source."""

    try:
        current, _problems = verify_source_pack(target, source)
        if current:
            return True
        compile_source_skills(target, source)
        current, problems = verify_source_pack(target, source)
    except (OSError, SkillPackError, ValueError) as error:
        print(f"{_SKILL_SYNC_FAILURE}: {error}", file=sys.stderr)
        return False
    if not current:
        print(f"{_SKILL_SYNC_FAILURE}: {'; '.join(problems)}", file=sys.stderr)
        return False
    print(_SKILL_SYNC_SUCCESS, file=sys.stderr)
    return True


def _resolve_scholarseed_bin() -> str:
    env = os.environ.get(_ENV_SCHOLARSEED_BIN)
    if env and Path(env).exists():
        return env
    here = scripts_directory() / f"{_SCHOLARSEED_SCRIPT}{executable_suffix()}"
    if here.exists():
        return str(here)
    return shutil.which("scholarseed") or "scholarseed"


def _effective_config() -> dict:
    """生效配置 (产品默认 + 用户已声明的值 + 加载态收敛), 不是盘上的模板回显。

    banner 是排查面。显示裸盘值会让人看到 ``model=— provider=— base_url=—``, 而产品实际
    跑的是收敛后的内置网关与 qwen3.8-max —— 排查线索与真实生效面不一致只会把排查带偏。
    """

    try:
        return load_config_values()
    except (OSError, ValueError):
        return {}


def _print_banner(*, attach_url: Optional[str], trace_ui: Optional[str], mode: str) -> None:
    cfg = _effective_config()
    plan = resolve_trace(None, False)
    backend = f"attach {attach_url}" if attach_url else "repo .venv (editable → latest code)"
    lines = [
        "────────────── scholarseed ──────────────",
        f" home     {SCHOLARSEED_HOME}",
        f" config   {'ok' if CONFIG_PATH.exists() else 'MISSING (run npm run config)'}"
        f"  model={cfg.get('model_name') or '—'}"
        f"  provider={cfg.get('provider') or '—'}",
        f" base_url {cfg.get('base_url') or '—'}",
        f" trace    {plan.sink}"
        + (f"  UI {trace_ui}" if trace_ui else ("  UI off" if not plan.spawn_server else "")),
        f" backend  {backend}",
        f" renderer live (electron-vite {mode})" if mode == "dev" else f" renderer built ({mode})",
        f" log      {SYSTEM_LOG}",
        "──────────────────────────────────────",
    ]
    for ln in lines:
        print(ln, file=sys.stderr)
    sys.stderr.flush()


def _build_env(attach_url: Optional[str]) -> dict:
    env = os.environ.copy()
    env.setdefault(_ENV_SCHOLARSEED_BIN, _resolve_scholarseed_bin())
    env.setdefault(_ENV_SCHOLARSEED_PYTHON, sys.executable)
    env["PATH"] = str(scripts_directory()) + os.pathsep + env.get("PATH", "")
    if attach_url:
        env[_ENV_SERVE_URL] = attach_url
    return env


def _run_harness(desktop: Path, node: str, env: dict, electron_flags: List[str]) -> int:
    """无头验证: build → electron . <flags>，等待真实 renderer/serve 链路结束。"""
    print("[scholarseed] electron-vite build …", file=sys.stderr)
    toolchain = desktop.parents[1].joinpath(*_TOOLCHAIN_RELATIVE)
    if subprocess.call([node, str(toolchain), "npm", "run", "build"], cwd=desktop, env=env) != 0:
        print("[scholarseed] build failed", file=sys.stderr)
        return 2
    electron = _electron_bin(desktop)
    if not electron:
        print("[scholarseed] electron binary missing under node_modules/.bin", file=sys.stderr)
        return 2
    print(f"[scholarseed] electron . {' '.join(electron_flags)}", file=sys.stderr)
    return subprocess.call([electron, ".", *electron_flags], cwd=desktop, env=env)


def _help() -> None:
    print(
        "scholarseed — Electron application launcher\n\n"
        "Usage:\n"
        "  scholarseed                 起 app (electron-vite dev, 最新代码, 后台后端)\n"
        '  scholarseed --say "hi"      无头跑一轮真实对话并截图 (tmp/test_snapshot/desktop)\n'
        "  scholarseed --shoot         无头截全部场景图\n"
        "  scholarseed --mode-check    无头跑权限模式的真实产品流\n"
        "  scholarseed --drive DIR     无头执行多轮真实产品驱动 (DIR/cmd.jsonl)\n"
        "  scholarseed --workbench-check  无头跑 0.2 工作台产品流程验收 (点真实 DOM + 核验落盘)\n"
        "  scholarseed --attach URL    挂到已在后台跑的 scholarseed-serve (不自起后端)\n"
        "  scholarseed --help-desktop  本帮助\n\n"
        "Env: SCHOLARSEED_APP_DIR SCHOLARSEED_BIN SCHOLARSEED_HOME DAMOAGENT_TRACE[_SERVER] SCHOLARSEED_SERVE_URL\n",
    )


def main() -> int:
    argv = sys.argv[1:]
    attach_url = os.environ.get(_ENV_SERVE_URL) or None
    shoot = False
    mode_check = False
    workbench_check = False
    say_msg: Optional[str] = None
    drive_dir: Optional[str] = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--help-desktop", "-hd"):
            _help()
            return 0
        if a == "--shoot":
            shoot = True
        elif a == "--mode-check":
            mode_check = True
        elif a == "--workbench-check":
            workbench_check = True
        elif a == "--say":
            say_msg = argv[i + 1] if i + 1 < len(argv) else ""
            i += 1
        elif a == "--drive":
            if i + 1 >= len(argv):
                print(
                    "[scholarseed] --drive needs a directory containing cmd.jsonl", file=sys.stderr
                )
                return 2
            drive_dir = argv[i + 1]
            i += 1
        elif a == "--attach":
            attach_url = argv[i + 1] if i + 1 < len(argv) else attach_url
            i += 1
        i += 1

    desktop = _find_desktop_dir()
    if desktop is None:
        print(
            "[scholarseed] apps/desktop not found (set SCHOLARSEED_APP_DIR).",
            file=sys.stderr,
        )
        return 2
    if not attach_url and not synchronize_source_skills():
        return 2
    node = _find_node()
    if not node:
        print(
            "[scholarseed] node/npm not found. Electron needs Node.js.\n"
            "Install Node (e.g. via nvm) then retry.",
            file=sys.stderr,
        )
        return 2
    if not _ensure_deps(desktop, node):
        print("[scholarseed] locked dependency preparation failed", file=sys.stderr)
        return 2

    # trace 系统: 按 DAMOAGENT_TRACE plan 决定是否顺带起 trace UI server (让桌面用户也能开浏览页)。
    plan = resolve_trace(None, False)
    trace_ui: Optional[str] = None
    if plan.spawn_server and not attach_url:
        try:
            info = trace_server_launcher.ensure_running(wait_ready=_TRACE_UI_WAIT_SECONDS)
            if info is not None:
                trace_ui = info.url
        except Exception as e:  # noqa: BLE001 — trace server 起不来不该挡住 app
            print(f"[scholarseed] trace server skip: {e}", file=sys.stderr)

    env = _build_env(attach_url)

    if shoot or say_msg is not None or mode_check or drive_dir is not None or workbench_check:
        _print_banner(attach_url=attach_url, trace_ui=trace_ui, mode="build")
        flags = (
            ["--drive", drive_dir]
            if drive_dir is not None
            else (
                ["--workbench-check"]
                if workbench_check
                else (
                    ["--mode-check"]
                    if mode_check
                    else ["--say", say_msg] if say_msg is not None else ["--shoot"]
                )
            )
        )
        return _run_harness(desktop, node, env, flags)

    # 默认: electron-vite dev = 最新代码 (前端 HMR + 后端仓库 .venv), 后端为后台子进程。
    _print_banner(attach_url=attach_url, trace_ui=trace_ui, mode="dev")
    os.chdir(desktop)  # npm run dev 需在 apps/desktop 下找 package.json
    try:
        toolchain = desktop.parents[1].joinpath(*_TOOLCHAIN_RELATIVE)
        os.execve(node, [node, str(toolchain), "npm", "run", "dev"], env)
    except OSError as e:
        print(f"[scholarseed] failed to exec npm run dev: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
