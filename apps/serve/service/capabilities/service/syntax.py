"""Compile archived component entries as classic scripts without running them."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from service.platform.toolchain import ELECTRON_EXECUTABLE_ENV

PARSER_TIMEOUT_SECONDS = 10
ENTRY_SYNTAX_INVALID = "component_entry_syntax_invalid"
ENTRY_PARSER_UNAVAILABLE = "component_entry_parser_unavailable"
PARSE_SCRIPT = r"""
const { Script } = require('node:vm');
const { readFileSync } = require('node:fs');
try {
  new Script(readFileSync(0, 'utf8'), { filename: 'entry' });
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  const line = /^entry:(\d+)/.exec(error.stack);
  process.stdout.write(JSON.stringify({
    message: error.message,
    line: line ? Number(line[1]) : null
  }));
}
"""


def check_entry_syntax(entries: dict[str, bytes]) -> dict[str, Any]:
    """Return issues against ZIP member paths, independent of source files."""
    checked: list[str] = []
    issues: list[dict[str, Any]] = []
    environment = {
        key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR"}
    }
    electron = os.environ.get(ELECTRON_EXECUTABLE_ENV)
    if electron:
        executable = electron if Path(electron).is_absolute() else None
        environment["ELECTRON_RUN_AS_NODE"] = "1"
    else:
        executable = shutil.which("node.exe" if os.name == "nt" else "node")
    for path, contents in entries.items():
        try:
            if not executable:
                raise OSError("no JavaScript parser")
            parsed = subprocess.run(
                [executable, "-e", PARSE_SCRIPT],
                input=contents,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=environment,
                timeout=PARSER_TIMEOUT_SECONDS,
                check=True,
            )
        except (OSError, subprocess.SubprocessError):
            issues.append(
                {
                    "code": ENTRY_PARSER_UNAVAILABLE,
                    "severity": "error",
                    "path": path,
                    "message": "The host JavaScript parser is unavailable.",
                }
            )
            break
        checked.append(path)
        if parsed.stdout:
            error = json.loads(parsed.stdout)
            issues.append(
                {
                    "code": ENTRY_SYNTAX_INVALID,
                    "severity": "error",
                    "path": path,
                    "message": error["message"],
                    "detail": {"line": error["line"]},
                }
            )
    return {"valid": not issues, "checked": checked, "issues": issues}
