"""No-mock p09 acceptance runner using public product entrypoints only.

This runner is intentionally not part of the contract suite. It starts real ScholarSeed
surfaces only when requested and then inspects real artifacts under the selected
workspace. It never uses fake providers, mocked LLMProvider instances, direct
internal dispatch, or hand-written bridge JSONL.

Run examples:
  .venv/bin/python -m tests.acceptance_p09_real --surface cli
  .venv/bin/python -m tests.acceptance_p09_real --surface opentui
  .venv/bin/python -m tests.acceptance_p09_real --surface desktop
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TMP_RESEARCH = REPO / "tmp" / "research"
TMP_SNAPSHOT = REPO / "tmp" / "test_snapshot" / "p09"
DEFAULT_TIMEOUT_SECONDS = 420
DEFAULT_PROMPT = (
    "Remember this durable validation fact for p09: file p09_acceptance_marker.txt "
    "must keep the line P09_GRAPH_ACCEPTANCE_MARKER. Then answer with the marker."
)

SURFACE_ALL = "all"
SURFACE_CLI = "cli"
SURFACE_OPENTUI = "opentui"
SURFACE_DESKTOP = "desktop"
SURFACES = (SURFACE_CLI, SURFACE_OPENTUI, SURFACE_DESKTOP)

VERDICT_PASS = "PASS"
VERDICT_FAIL = "FAIL"
VERDICT_BLOCKED = "BLOCKED"

ENV_SCHOLARSEED_HOME = "SCHOLARSEED_HOME"
ENV_SCHOLARSEED_REAL_HOME = "SCHOLARSEED_REAL_HOME"
ENV_SCHOLARSEED_BIN = "SCHOLARSEED_BIN"
ENV_SCHOLARSEED_DEFAULT_WORKSPACE = "SCHOLARSEED_DEFAULT_WORKSPACE"
ENV_SCHOLARSEED_DESKTOP_DIR = "SCHOLARSEED_DESKTOP_DIR"
ENV_SCHOLARSEED_REPO = "SCHOLARSEED_REPO"
ENV_SCHOLARSEED_SHOOT_SCENES = "SCHOLARSEED_SHOOT_SCENES"

CONFIG_FILE = "config.json"
GRAPH_OPS = "graph_ops.jsonl"
GRAPH_INDEX = "index.sqlite3"
SNAPSHOTS_DIR = "snapshots"
MEMORY_DIR = "memory"
GRAPH_DIR = "graph"
PROJECT_DIR = ".scholarseed"
MARKER_FILE = "p09_acceptance_marker.txt"
MARKER_TEXT = "P09_GRAPH_ACCEPTANCE_MARKER"

API_KEY_ENV_KEYS = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
)
API_KEY_NAME_PARTS = ("api_key", "apikey", "access_token", "secret_key")
CLI_COMMAND = ("--work", "scholar", "-p")
CLI_MODE_ARGS = ("--mode", "acceptEdits")

VHS_STARTUP_SLEEP = "10s"
VHS_REPLY_SLEEP = "35s"
VHS_WIDTH = 1280
VHS_HEIGHT = 720
VHS_FONT_SIZE = 14
VHS_TYPING_SPEED = "35ms"
VHS_THEME = "Catppuccin Mocha"
DESKTOP_SHOOT_SCENES = "agent-session,evidence-graph,drawer-memory"


@dataclass
class SurfaceResult:
    name: str
    verdict: str
    reason: str
    command: list[str]
    artifacts: dict[str, str]


def _json_line(verdict: str, results: list[SurfaceResult]) -> str:
    payload = {
        "verdict": verdict,
        "results": [
            {
                "name": item.name,
                "verdict": item.verdict,
                "reason": item.reason,
                "command": item.command,
                "artifacts": item.artifacts,
            }
            for item in results
        ],
    }
    return json.dumps(payload, ensure_ascii=True, sort_keys=True)


def _find_executable(name: str) -> str | None:
    venv_candidate = REPO / ".venv" / "bin" / name
    if venv_candidate.exists():
        return str(venv_candidate)
    return shutil.which(name)


def _configured_home() -> Path | None:
    raw = os.environ.get(ENV_SCHOLARSEED_REAL_HOME) or os.environ.get(ENV_SCHOLARSEED_HOME)
    return Path(raw).expanduser() if raw else None


def _walk_values(value) -> list[str]:
    values: list[str] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            lowered = str(key).lower()
            if any(part in lowered for part in API_KEY_NAME_PARTS) and nested:
                values.append(str(nested))
            values.extend(_walk_values(nested))
    elif isinstance(value, list):
        for nested in value:
            values.extend(_walk_values(nested))
    return values


def _config_blocker() -> str | None:
    home = _configured_home()
    if home is None:
        return "Set SCHOLARSEED_REAL_HOME or SCHOLARSEED_HOME to a configured ScholarSeed home."
    config = home / CONFIG_FILE
    if not config.exists():
        return f"Config file is missing: {config}"
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except ValueError as exc:
        return f"Config file is not valid JSON: {exc}"
    has_config_key = any(v.strip() for v in _walk_values(data))
    has_env_key = any(os.environ.get(key) for key in API_KEY_ENV_KEYS)
    if not has_config_key and not has_env_key:
        return "No API key found in config JSON or supported API key environment variables."
    return None


def _base_env(workdir: Path) -> dict[str, str]:
    env = os.environ.copy()
    home = _configured_home()
    if home is not None:
        env[ENV_SCHOLARSEED_HOME] = str(home)
    env[ENV_SCHOLARSEED_DEFAULT_WORKSPACE] = str(workdir)
    env[ENV_SCHOLARSEED_REPO] = str(REPO)
    env.setdefault("PYTHONUNBUFFERED", "1")
    scholarseed = _find_executable("scholarseed")
    if scholarseed:
        env[ENV_SCHOLARSEED_BIN] = scholarseed
    return env


def _new_workdir(label: str) -> Path:
    TMP_RESEARCH.mkdir(parents=True, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix=f"p09-{label}-", dir=str(TMP_RESEARCH)))
    (path / MARKER_FILE).write_text(MARKER_TEXT + "\n", encoding="utf-8")
    return path


def _inspect_artifacts(workdir: Path) -> tuple[bool, dict[str, str], str]:
    memory_root = workdir / PROJECT_DIR / MEMORY_DIR
    graphs = sorted(memory_root.rglob(GRAPH_DIR)) if memory_root.exists() else []
    graph_ops = [graph / GRAPH_OPS for graph in graphs if (graph / GRAPH_OPS).exists()]
    indexes = [graph / GRAPH_INDEX for graph in graphs if (graph / GRAPH_INDEX).exists()]
    snapshots = [graph / SNAPSHOTS_DIR for graph in graphs if (graph / SNAPSHOTS_DIR).exists()]
    nonempty_ops = [path for path in graph_ops if path.stat().st_size > 0]
    artifacts = {
        "workdir": str(workdir),
        "memory_root": str(memory_root),
        "graph_ops": ";".join(str(path) for path in graph_ops),
        "index_sqlite3": ";".join(str(path) for path in indexes),
        "snapshots": ";".join(str(path) for path in snapshots),
    }
    if not graphs:
        return False, artifacts, "No p09 graph directory under workdir/.scholarseed/memory."
    if not nonempty_ops:
        return False, artifacts, "No nonempty graph_ops.jsonl after real product run."
    if not indexes:
        return False, artifacts, "No index.sqlite3 after real product run."
    return True, artifacts, "p09 graph artifacts present."


def _blocked(name: str, reason: str) -> SurfaceResult:
    return SurfaceResult(
        name=name, verdict=VERDICT_BLOCKED, reason=reason, command=[], artifacts={}
    )


def _run_command(
    name: str, command: list[str], env: dict[str, str], cwd: Path, timeout: int
) -> SurfaceResult:
    started = time.time()
    proc = subprocess.run(
        command,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    elapsed = time.time() - started
    ok, artifacts, reason = _inspect_artifacts(cwd)
    artifacts["stdout_tail"] = (proc.stdout or "")[-1000:]
    artifacts["stderr_tail"] = (proc.stderr or "")[-1000:]
    artifacts["elapsed_seconds"] = f"{elapsed:.1f}"
    if proc.returncode != 0:
        return SurfaceResult(
            name=name,
            verdict=VERDICT_FAIL,
            reason=f"Public command exited {proc.returncode}.",
            command=command,
            artifacts=artifacts,
        )
    return SurfaceResult(
        name=name,
        verdict=VERDICT_PASS if ok else VERDICT_FAIL,
        reason=reason,
        command=command,
        artifacts=artifacts,
    )


def run_cli(prompt: str, timeout: int) -> SurfaceResult:
    blocker = _config_blocker()
    if blocker:
        return _blocked(SURFACE_CLI, blocker)
    scholarseed = _find_executable("scholarseed")
    if not scholarseed:
        return _blocked(SURFACE_CLI, "scholarseed executable not found in .venv/bin or PATH.")
    workdir = _new_workdir(SURFACE_CLI)
    env = _base_env(workdir)
    command = [scholarseed, *CLI_COMMAND, prompt, *CLI_MODE_ARGS]
    return _run_command(SURFACE_CLI, command, env, workdir, timeout)


def _write_opentui_tape(scholarseed_ui: str, workdir: Path, prompt: str) -> Path:
    TMP_SNAPSHOT.mkdir(parents=True, exist_ok=True)
    tape = TMP_SNAPSHOT / "p09-opentui.tape"
    screenshot = TMP_SNAPSHOT / "p09-opentui.png"
    output = TMP_SNAPSHOT / "p09-opentui.gif"
    env = _base_env(workdir)
    path_env = env.get("PATH", "")
    lines = [
        f"Output {output}",
        f"Set FontSize {VHS_FONT_SIZE}",
        f"Set Width {VHS_WIDTH}",
        f"Set Height {VHS_HEIGHT}",
        f"Set TypingSpeed {VHS_TYPING_SPEED}",
        f'Set Theme "{VHS_THEME}"',
        'Set Shell "bash"',
        f'Env PATH "{path_env}"',
        f'Env {ENV_SCHOLARSEED_HOME} "{env.get(ENV_SCHOLARSEED_HOME, "")}"',
        f'Env {ENV_SCHOLARSEED_DEFAULT_WORKSPACE} "{workdir}"',
        f'Type "cd {REPO} && {scholarseed_ui}"',
        "Enter",
        f"Sleep {VHS_STARTUP_SLEEP}",
        f'Type "{prompt}"',
        "Enter",
        f"Sleep {VHS_REPLY_SLEEP}",
        f"Screenshot {screenshot}",
        "Ctrl+C",
    ]
    tape.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return tape


def run_opentui(prompt: str, timeout: int) -> SurfaceResult:
    blocker = _config_blocker()
    if blocker:
        return _blocked(SURFACE_OPENTUI, blocker)
    scholarseed_ui = _find_executable("scholarseed-ui")
    if not scholarseed_ui:
        return _blocked(
            SURFACE_OPENTUI, "scholarseed-ui executable not found in .venv/bin or PATH."
        )
    if not shutil.which("bun"):
        return _blocked(SURFACE_OPENTUI, "Bun executable is missing; opentui requires Bun.")
    vhs = shutil.which("vhs")
    if not vhs:
        return _blocked(
            SURFACE_OPENTUI, "vhs executable is missing; install vhs for opentui acceptance."
        )
    workdir = _new_workdir(SURFACE_OPENTUI)
    env = _base_env(workdir)
    tape = _write_opentui_tape(scholarseed_ui, workdir, prompt)
    command = [vhs, str(tape)]
    result = _run_command(SURFACE_OPENTUI, command, env, workdir, timeout)
    result.artifacts["tape"] = str(tape)
    return result


def run_desktop(prompt: str, timeout: int) -> SurfaceResult:
    blocker = _config_blocker()
    if blocker:
        return _blocked(SURFACE_DESKTOP, blocker)
    desktop = _find_executable("scholarseed-desktop")
    if not desktop:
        return _blocked(
            SURFACE_DESKTOP, "scholarseed-desktop executable not found in .venv/bin or PATH."
        )
    if not shutil.which("npm"):
        return _blocked(
            SURFACE_DESKTOP, "npm executable is missing; Electron desktop requires npm."
        )
    workdir = _new_workdir(SURFACE_DESKTOP)
    env = _base_env(workdir)
    env[ENV_SCHOLARSEED_DESKTOP_DIR] = str(REPO / "ui" / "desktop")
    env[ENV_SCHOLARSEED_SHOOT_SCENES] = DESKTOP_SHOOT_SCENES
    command = [desktop, "--say", prompt]
    return _run_command(SURFACE_DESKTOP, command, env, workdir, timeout)


def _surface_list(raw: str) -> list[str]:
    if raw == SURFACE_ALL:
        return list(SURFACES)
    return [raw]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--surface",
        choices=(SURFACE_ALL, *SURFACES),
        default=SURFACE_CLI,
        help="Public product surface to run.",
    )
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    runners = {
        SURFACE_CLI: run_cli,
        SURFACE_OPENTUI: run_opentui,
        SURFACE_DESKTOP: run_desktop,
    }
    results: list[SurfaceResult] = []
    for surface in _surface_list(args.surface):
        results.append(runners[surface](args.prompt, args.timeout))
    if any(item.verdict == VERDICT_FAIL for item in results):
        verdict = VERDICT_FAIL
    elif any(item.verdict == VERDICT_BLOCKED for item in results):
        verdict = VERDICT_BLOCKED
    else:
        verdict = VERDICT_PASS
    for item in results:
        print(f"[{item.verdict}] {item.name}: {item.reason}")
    print(_json_line(verdict, results))
    return 0 if verdict == VERDICT_PASS else 1


if __name__ == "__main__":
    sys.exit(main())
