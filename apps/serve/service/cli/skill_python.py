"""Run Skill Python commands with the active product interpreter."""

from __future__ import annotations

import argparse
import json
import ntpath
import os
import subprocess
import sys
from pathlib import Path
from typing import Sequence

EXIT_USAGE = 2
DIAGNOSTIC_ARGUMENT = "--diagnostic-v1"
DIAGNOSTIC_EVENT = "launcher_ready"
UTF8_ARGUMENTS = ("-X", "utf8")
UTF8_ENVIRONMENT = {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

VERSION_ARGUMENTS = (["--version"], ["-V"])
MODULE_ARGUMENT = "-m"
PRODUCT_COMMANDS = {"service.cli.plugins": ("describe", "prepare", "validate", "check", "pack")}


EXECUTION_MODULE = "service.cli.skill"


def main(argv: Sequence[str] | None = None) -> int:
    """Run the active interpreter, preserving its arguments and exit status."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments == [DIAGNOSTIC_ARGUMENT]:

        def normalize(value: str | Path) -> str:
            return ntpath.normcase(str(value).removeprefix("\\\\?\\"))

        print(
            json.dumps(
                {
                    "event": DIAGNOSTIC_EVENT,
                    "root": normalize(sys.base_prefix),
                    "service": normalize(Path(__file__).resolve().parents[1]),
                }
            )
        )
        return 0
    if len(arguments) >= 2 and arguments[0] == MODULE_ARGUMENT:
        if arguments[1] in PRODUCT_COMMANDS:
            if not any(argument in {"--help", "-h"} for argument in arguments[2:]):
                parser = argparse.ArgumentParser(prog=arguments[1], add_help=False)
                parser.add_argument("--host-version")
                parser.add_argument("operation", choices=PRODUCT_COMMANDS[arguments[1]])
                parser.parse_known_args(arguments[2:])
            result = subprocess.run(
                [sys.executable, "-B", *arguments],
                capture_output=True,
                text=True,
                check=False,
            )
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            return result.returncode
    if arguments in VERSION_ARGUMENTS:
        print(f"Python {sys.version.split()[0]}")
        return 0
    if not arguments:
        print("usage: scholarseed-skill-python <bundled-skill-script> [args ...]", file=sys.stderr)
        return EXIT_USAGE
    isolation = ["-I"] if sys.flags.isolated else []
    command = [
        sys.executable,
        *isolation,
        "-B",
        *UTF8_ARGUMENTS,
        "-m",
        EXECUTION_MODULE,
        *arguments,
    ]
    environment = {**os.environ, **UTF8_ENVIRONMENT}
    if sys.platform == "win32":
        # CRT exec does not preserve argv quoting or POSIX process replacement.
        # Keep the launcher alive until the actual interpreter has exited.
        return subprocess.run(
            command, executable=sys.executable, env=environment, check=False
        ).returncode
    os.execve(sys.executable, command, environment)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
