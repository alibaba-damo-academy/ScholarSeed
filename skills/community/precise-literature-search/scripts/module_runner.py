#!/usr/bin/env scholarseed-skill-python
"""Run one configured internal module through the stable file contract."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from validate_json import ContractError, validate_file
from platform_support import WINDOWS
from process_control import ChildProcessCancelled, run_cancellable
from progress import heartbeat_if_due, read_progress, update_progress


EXIT_INPUT = 2
EXIT_MODULE = 3
EXIT_OUTPUT = 4
DOWNLOAD_MANIFEST_CONTRACT = "download-manifest"
OUTPUT_CONTRACTS = {
    "search": "metadata",
    "open-download": DOWNLOAD_MANIFEST_CONTRACT,
    "paid-download": DOWNLOAD_MANIFEST_CONTRACT,
}
MODULE_PROGRESS = {
    "open-download": ("download", "Downloading arXiv papers"),
    "paid-download": ("download", "Downloading paper-dl/non-arXiv papers"),
}


def load_config(skill_dir: Path) -> dict[str, Any]:
    path = skill_dir / "config" / "modules.json"
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise ValueError(f"module configuration is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"module configuration is invalid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("modules"), dict):
        raise ValueError(f"module configuration has no modules object: {path}")
    return data


def build_command(
    module_name: str,
    module: dict[str, Any],
    skill_dir: Path,
    input_path: Path,
    output_path: Path,
    run_dir: Path,
    resume: bool,
) -> list[str]:
    module_dir_value = module.get("module_dir")
    if not isinstance(module_dir_value, str):
        raise ValueError(f"module {module_name!r} has no valid module_dir")
    module_dir = Path(module_dir_value)
    if not module_dir.is_absolute():
        module_dir = skill_dir / module_dir
    if not module_dir.is_dir():
        raise ValueError(f"module {module_name!r} directory does not exist: {module_dir}")
    if module.get("type") == "host_llm":
        prompt = module.get("prompt")
        instruction = f"; follow {prompt}" if isinstance(prompt, str) and prompt else ""
        raise ValueError(
            f"module {module_name!r} is a host-LLM module and cannot be executed by "
            f"module_runner{instruction}"
        )
    template = module.get("command")
    if not isinstance(template, list) or not template or not all(isinstance(part, str) for part in template):
        raise ValueError(f"module {module_name!r} has no valid command array")
    values = {
        "{python}": sys.executable,
        "{skill_dir}": str(skill_dir),
        "{input}": str(input_path),
        "{output}": str(output_path),
        "{run_dir}": str(run_dir),
        "{resume}": "--resume" if resume else "",
    }
    command: list[str] = []
    for part in template:
        replaced = part
        for marker, value in values.items():
            replaced = replaced.replace(marker, value)
        if replaced:
            candidate = Path(replaced)
            if not candidate.is_absolute() and not replaced.startswith("-"):
                skill_relative = skill_dir / candidate
                if skill_relative.exists():
                    replaced = str(skill_relative.resolve())
            command.append(replaced)
    joined = "\0".join(template)
    if "{input}" not in joined:
        command.extend(["--input", str(input_path)])
    if "{output}" not in joined:
        command.extend(["--output", str(output_path)])
    if "{run_dir}" not in joined:
        command.extend(["--run-dir", str(run_dir)])
    if resume and "{resume}" not in joined:
        command.append("--resume")
    return command


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--show-config", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    skill_dir = Path(__file__).resolve().parent.parent
    try:
        config = load_config(skill_dir)
        if args.show_config:
            print(json.dumps(config, ensure_ascii=False, indent=2))
            if not args.module:
                return 0
        if not args.module or args.module not in config["modules"]:
            known = ", ".join(sorted(config["modules"]))
            raise ValueError(f"unknown or missing module {args.module!r}; expected one of: {known}")
        if args.input is None or args.output is None or args.run_dir is None:
            raise ValueError("--input, --output, and --run-dir are required when running a module")
        input_path = args.input.resolve()
        output_path = args.output.resolve()
        run_dir = args.run_dir.resolve()
        if not input_path.is_file():
            raise ValueError(f"module input does not exist or is not a file: {input_path}")
        if not run_dir.is_dir():
            raise ValueError(f"run directory does not exist: {run_dir}")
        command = build_command(
            args.module, config["modules"][args.module], skill_dir,
            input_path, output_path, run_dir, args.resume,
        )
    except ValueError as exc:
        print(f"module runner input/config error: {exc}", file=sys.stderr)
        return EXIT_INPUT

    stream_output = bool(config["modules"][args.module].get("stream_output"))
    print(f"module: {args.module}", flush=stream_output)
    print(f"input: {input_path}", flush=stream_output)
    print(f"output: {output_path}", flush=stream_output)
    module_config = config["modules"][args.module]
    if module_config.get("fallback_placeholder") and not module_config.get("command"):
        print("[PLACEHOLDER] configured fallback implementation")
    elif module_config.get("placeholder"):
        print("[PLACEHOLDER] configured implementation")
    if args.dry_run:
        print("command:", json.dumps(command, ensure_ascii=False))
        return 0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    progress_stage, progress_activity = MODULE_PROGRESS.get(
        args.module, (args.module, f"Running {args.module}")
    )
    update_progress(
        run_dir,
        stage=progress_stage,
        activity=progress_activity,
        emit=lambda message: print(message, flush=True),
    )

    def mark_progress(status: str, activity: str) -> None:
        previous = read_progress(run_dir) or {}
        update_progress(
            run_dir,
            stage=progress_stage,
            activity=activity,
            status=status,
            current=previous.get("current") if isinstance(previous.get("current"), int) else None,
            total=previous.get("total") if isinstance(previous.get("total"), int) else None,
            completed=previous.get("completed") if isinstance(previous.get("completed"), int) else None,
            emit=lambda message: print(message, flush=True),
        )

    try:
        completed = run_cancellable(
            command,
            text=True,
            capture_output=not stream_output,
            heartbeat=lambda _elapsed: heartbeat_if_due(
                run_dir,
                interval_seconds=20,
                emit=lambda message: print(message, flush=True),
            ),
            heartbeat_interval=1,
        )
    except ChildProcessCancelled as exc:
        mark_progress("cancelled", f"{progress_activity} cancelled")
        cleanup = ("command stopped; check browser_pool status for retained browser leases after forced cancellation"
                   if WINDOWS else "child process tree stopped")
        print(
            f"module {args.module!r} cancelled by signal {exc.signum}; {cleanup}",
            file=sys.stderr,
        )
        return 128 + exc.signum
    except OSError as exc:
        mark_progress("failed", f"{progress_activity} could not start")
        print(f"module {args.module!r} could not start: {exc}", file=sys.stderr)
        return EXIT_MODULE
    if not stream_output and completed.stdout:
        print(completed.stdout, end="" if completed.stdout.endswith("\n") else "\n")
    if not stream_output and completed.stderr:
        print(completed.stderr, file=sys.stderr, end="" if completed.stderr.endswith("\n") else "\n")
    if completed.returncode != 0:
        mark_progress("failed", f"{progress_activity} failed")
        print(
            f"module {args.module!r} failed with exit code {completed.returncode}; inspect its stderr and input {input_path}",
            file=sys.stderr,
        )
        return EXIT_MODULE
    if not output_path.is_file() or output_path.stat().st_size == 0:
        mark_progress("failed", f"{progress_activity} produced no output")
        print(
            f"module {args.module!r} did not create a non-empty output: {output_path}",
            file=sys.stderr,
        )
        return EXIT_OUTPUT
    contract = OUTPUT_CONTRACTS.get(args.module)
    if contract:
        try:
            validate_file(contract, output_path)
        except ContractError as exc:
            mark_progress("failed", f"{progress_activity} produced invalid output")
            print(
                f"module {args.module!r} produced invalid {contract} output at {output_path}: {exc}",
                file=sys.stderr,
            )
            return EXIT_OUTPUT
    current_progress = read_progress(run_dir) or {}
    if current_progress.get("status") != "action_required":
        mark_progress("completed", f"{progress_activity} completed")
    print(f"module completed: {args.module}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
