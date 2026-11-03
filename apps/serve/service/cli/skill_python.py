"""Run Skill Python commands with the active product interpreter."""

from __future__ import annotations

import json
import ntpath
import os
import subprocess
import sys
from pathlib import Path
from typing import Sequence

import httpx

from service.capabilities.domain import SKILL_ADMISSION_ROUTE, SkillAdmission
from service.capabilities.service.source import verify_compiled_skill
from service.cli.task import main as task_main
from service.paths import SERVICE_BUNDLED_SKILLS_DIR
from service.platform.channel import decode, request
from service.platform.python import TASK_OPTION
from service.platform.storage import filesystem_path
from service.platform.vocabulary import BRIDGE_SESSION_ENV

EXIT_FAILURE = 1
EXIT_USAGE = 2
DIAGNOSTIC_ARGUMENT = "--diagnostic-v1"
DIAGNOSTIC_EVENT = "launcher_ready"

VERSION_ARGUMENTS = (["--version"], ["-V"])
PRODUCT_PYTHON_RESERVED = "product_python_reserved_for_bundled_skills"
MODULE_ARGUMENT = "-m"
PRODUCT_COMMANDS = frozenset({"service.cli.plugins"})


def admit_script(arguments: Sequence[str]) -> None:
    if list(arguments) in VERSION_ARGUMENTS:
        return
    if arguments[0].startswith("-"):
        raise ValueError(PRODUCT_PYTHON_RESERVED)
    script = filesystem_path(Path(arguments[0]).expanduser()).resolve(strict=True)
    bundled = filesystem_path(SERVICE_BUNDLED_SKILLS_DIR).resolve(strict=True)
    relative = script.relative_to(bundled)
    if len(relative.parts) < 2:
        raise ValueError(PRODUCT_PYTHON_RESERVED)
    inventory = verify_compiled_skill(bundled / relative.parts[0])
    if Path(*relative.parts[1:]).as_posix() not in {item["path"] for item in inventory["files"]}:
        raise ValueError(PRODUCT_PYTHON_RESERVED)
    if not os.environ.get(BRIDGE_SESSION_ENV):
        return
    result = request(
        SKILL_ADMISSION_ROUTE,
        decode(json.dumps({"path": str(script)}), SkillAdmission),
    )
    if result.get("ok") is not True:
        raise ValueError("skill_admission_denied")
    if result.get("builtin") is not True:
        raise ValueError(PRODUCT_PYTHON_RESERVED)


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
    if arguments and arguments[0] == TASK_OPTION:
        return task_main(arguments[1:])
    if not arguments:
        print("usage: scholarseed-skill-python <bundled-skill-script> [args ...]", file=sys.stderr)
        return EXIT_USAGE
    try:
        if not (
            len(arguments) >= 2
            and arguments[0] == MODULE_ARGUMENT
            and arguments[1] in PRODUCT_COMMANDS
        ):
            admit_script(arguments)
    except (ValueError, OSError, httpx.HTTPError) as error:
        print(f"Skill unavailable: {error}", file=sys.stderr)
        return EXIT_FAILURE
    command = [sys.executable, "-B", *arguments]
    if sys.platform == "win32":
        # CRT exec does not preserve argv quoting or POSIX process replacement.
        # Keep the launcher alive until the actual interpreter has exited.
        return subprocess.run(command, executable=sys.executable, check=False).returncode
    os.execv(sys.executable, command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
