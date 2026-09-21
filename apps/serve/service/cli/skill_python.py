"""Run Skill Python commands with the active product interpreter."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Sequence

import httpx

from service.capabilities.service.install import SKILL_MANIFEST_NAME
from service.cli.bridge import execute
from service.platform.bridge import (
    BRIDGE_SESSION_ENV,
    SKILL_ADMISSION_OPERATION,
    SKILL_CAPABILITY,
)

EXIT_FAILURE = 1
EXIT_USAGE = 2


def admit_script(arguments: Sequence[str]) -> None:
    if not os.environ.get(BRIDGE_SESSION_ENV) or arguments[0].startswith("-"):
        return
    script = Path(arguments[0]).expanduser().resolve()
    if not any((parent / SKILL_MANIFEST_NAME).is_file() for parent in script.parents):
        return
    result = execute(
        SKILL_CAPABILITY,
        SKILL_ADMISSION_OPERATION,
        json.dumps({"path": str(script)}),
    )
    if result.get("ok") is not True:
        raise ValueError("skill_admission_denied")


def main(argv: Sequence[str] | None = None) -> int:
    """Replace the console-script process with the active Python interpreter."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        print("usage: scholarseed-skill-python <script-or-module> [args ...]", file=sys.stderr)
        return EXIT_USAGE
    try:
        admit_script(arguments)
    except (ValueError, OSError, httpx.HTTPError) as error:
        print(f"Skill unavailable: {error}", file=sys.stderr)
        return EXIT_FAILURE
    os.execv(sys.executable, [sys.executable, *arguments])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
