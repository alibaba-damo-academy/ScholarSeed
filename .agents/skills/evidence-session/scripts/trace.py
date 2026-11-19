#!/usr/bin/env python3
"""Run the DamoATrace CLI with an existing ScholarSeed Python environment."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_HOME_DIRNAME = ".scholarseed"
HOME_ENV = "SCHOLARSEED_HOME"
TRACE_HOME_ENV = "DAMOATRACE_HOME"
PYTHON_ENV = "SCHOLARSEED_PYTHON"
VENV_RELATIVE = Path(".venv/bin/python")
WINDOWS_VENV_RELATIVE = Path(".venv/Scripts/python.exe")
IMPORT_PROBE = "import damoatrace"
EXIT_UNAVAILABLE = 4


def arguments() -> tuple[argparse.ArgumentParser, argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--home", type=Path, help="explicit SCHOLARSEED_HOME")
    source.add_argument("--trace-file", type=Path, help="offline JSONL file")
    source.add_argument("--trace-dir", type=Path, help="offline diagnostic directory")
    parser.add_argument("--python", type=Path, help="Python that can import damoatrace")
    parser.add_argument(
        "--launcher-help",
        action="store_true",
        help="show launcher options; use '<command> --help' for DamoATrace help",
    )
    args, command = parser.parse_known_args()
    return parser, args, command


def candidates(explicit: Path | None) -> tuple[Path, ...]:
    configured = os.environ.get(PYTHON_ENV, "").strip()
    values = [
        explicit,
        Path(configured).expanduser() if configured else None,
        Path.cwd() / VENV_RELATIVE,
        Path(__file__).resolve().parents[4] / VENV_RELATIVE,
        Path.cwd() / WINDOWS_VENV_RELATIVE,
        Path(__file__).resolve().parents[4] / WINDOWS_VENV_RELATIVE,
        Path(sys.executable),
    ]
    unique: list[Path] = []
    for value in values:
        if value is None:
            continue
        executable = value.expanduser().absolute()
        if executable not in unique:
            unique.append(executable)
    return tuple(unique)


def supports_damoatrace(python: Path) -> bool:
    if not python.is_file() or not os.access(python, os.X_OK):
        return False
    result = subprocess.run(
        [str(python), "-B", "-c", IMPORT_PROBE],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def main() -> int:
    parser, args, command = arguments()
    if args.launcher_help:
        parser.print_help()
        return 0
    if not command:
        print("error: missing DamoATrace command", file=sys.stderr)
        return EXIT_UNAVAILABLE
    python = next(
        (candidate for candidate in candidates(args.python) if supports_damoatrace(candidate)),
        None,
    )
    if python is None:
        print(
            "error: no existing Python can import damoatrace; "
            "set SCHOLARSEED_PYTHON or pass --python",
            file=sys.stderr,
        )
        return EXIT_UNAVAILABLE
    environment = dict(os.environ)
    source_arguments: list[str] = []
    if args.trace_file is not None:
        source_arguments = ["--trace-file", str(args.trace_file.expanduser().resolve())]
    elif args.trace_dir is not None:
        source_arguments = ["--trace-dir", str(args.trace_dir.expanduser().resolve())]
    else:
        fallback = Path.home() / DEFAULT_HOME_DIRNAME
        home = args.home or Path(os.environ.get(HOME_ENV, "").strip() or fallback)
        if args.home is not None or not environment.get(TRACE_HOME_ENV, "").strip():
            environment[TRACE_HOME_ENV] = str(home.expanduser().resolve())
    result = subprocess.run(
        [str(python), "-B", "-m", "damoatrace", *source_arguments, *command],
        env=environment,
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
