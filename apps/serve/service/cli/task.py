"""Bootstrap and execute task Python without granting backend process authority."""

from __future__ import annotations

import os
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from typing import Sequence

from service.paths import TASK_PYTHON_PARTS
from service.platform.python import (
    TASK_CWD_ENV,
    WINDOWS_OS,
    prepare_environment,
    task_environment,
    task_interpreter,
)
from service.platform.storage import filesystem_path, open_directory

TASK_FAILURE = 1
TASK_USAGE = 2
TASK_INSTALL_LOCK = "install.lock"
PIP_MODULE_ARGUMENTS = ("-m", "pip")


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    cwd = os.environ.get(TASK_CWD_ENV, "")
    if not arguments or not cwd or not Path(cwd).is_absolute():
        print(
            "Task Python requires a bound execution directory and Python arguments.",
            file=sys.stderr,
        )
        return TASK_USAGE
    try:
        prepare_environment(Path(cwd))
        environment = task_environment(Path(cwd))
        executable = str(filesystem_path(task_interpreter(Path(cwd))))
        command = [executable, *arguments]
        if tuple(arguments[: len(PIP_MODULE_ARGUMENTS)]) == PIP_MODULE_ARGUMENTS:
            with closing(open_directory(Path(cwd), TASK_PYTHON_PARTS[:-1])) as parent:
                with parent.arbitration(TASK_INSTALL_LOCK):
                    return subprocess.run(
                        command, executable=executable, env=environment, check=False
                    ).returncode
        if os.name == WINDOWS_OS:
            return subprocess.run(
                command, executable=executable, env=environment, check=False
            ).returncode
        os.execve(executable, command, environment)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Task Python unavailable: {error}", file=sys.stderr)
        return TASK_FAILURE
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
