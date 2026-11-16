"""Admit and execute Skill Python commands with the product interpreter."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Sequence

import httpx

from service.capabilities.domain import SKILL_ADMISSION_ROUTE, SkillAdmission
from service.cli.task import main as task_main
from service.paths import SERVICE_BUNDLED_SKILLS_DIR
from service.platform.channel import decode, request
from service.platform.python import TASK_OPTION
from service.platform.storage import filesystem_path
from service.platform.vocabulary import BRIDGE_SESSION_ENV

EXIT_FAILURE = 1
EXIT_USAGE = 2
PRODUCT_PYTHON_RESERVED = "product_python_reserved_for_bundled_skills"
SCRIPT_ENVIRONMENT = {
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
    "PYTHONDONTWRITEBYTECODE": "1",
}


def admit_script(arguments: Sequence[str]) -> None:
    if arguments[0].startswith("-"):
        raise ValueError(PRODUCT_PYTHON_RESERVED)
    script = filesystem_path(Path(arguments[0]).expanduser()).resolve(strict=True)
    bundled = filesystem_path(SERVICE_BUNDLED_SKILLS_DIR).resolve(strict=True)
    relative = script.relative_to(bundled)
    if len(relative.parts) < 2 or not script.is_file():
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
    """Run an admitted script, preserving its arguments and exit status."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == TASK_OPTION:
        return task_main(arguments[1:])
    if not arguments:
        print("usage: scholarseed-skill-python <bundled-skill-script> [args ...]", file=sys.stderr)
        return EXIT_USAGE
    try:
        admit_script(arguments)
    except (ValueError, OSError, httpx.HTTPError) as error:
        print(f"Skill unavailable: {error}", file=sys.stderr)
        return EXIT_FAILURE
    command = [sys.executable, "-B", "-X", "utf8", *arguments]
    environment = {**os.environ, **SCRIPT_ENVIRONMENT}
    if sys.platform == "win32":
        return subprocess.run(
            command, executable=sys.executable, env=environment, check=False
        ).returncode
    os.execve(sys.executable, command, environment)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
