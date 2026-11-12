"""Cwd-owned task Python packages, independent of the product environment."""

from __future__ import annotations

import json
import os
import re
import shlex
import stat
import subprocess
import sys
import sysconfig
import venv
from contextlib import ExitStack, closing
from pathlib import Path
from typing import Mapping

from service.paths import (
    TASK_PYTHON_COMMAND_PARTS,
    TASK_PYTHON_PARTS,
    task_python_commands,
    task_python_root,
)
from service.platform.executables import SKILL_PYTHON_COMMAND, command_directories, resolve_command
from service.platform.storage import DirectoryHandle, filesystem_path, open_directory

ENVIRONMENT_LOCK = "prepare.lock"
ENVIRONMENT_RECEIPT = "environment.json"
ENVIRONMENT_CONFIG = "pyvenv.cfg"
ENVIRONMENT_ENCODING = "utf-8"
ENVIRONMENT_METADATA_LIMIT = 16384
ENVIRONMENT_INCOMPLETE = "task_python_environment_incomplete"
ENVIRONMENT_CHANGED = "task_python_environment_changed"
ENVIRONMENT_INVALID = "task_python_environment_invalid"
BASE_EXECUTABLE_ATTRIBUTE = "_base_executable"
PIP_MISSING_EXIT = 3
PIP_PROBE_ARGUMENTS = (
    "-I",
    "-c",
    "import importlib.util; "
    f"raise SystemExit(0 if importlib.util.find_spec('pip') is not None else {PIP_MISSING_EXIT})",
)
ENSUREPIP_ARGUMENTS = ("-I", "-m", "ensurepip", "--upgrade", "--default-pip")
WINDOWS_ENSUREPIP_BOOTSTRAP = """import ensurepip, subprocess
original_run = subprocess.run
def launch(command, **options):
    options.setdefault('executable', command[0])
    return original_run(command, **options)
subprocess.run = launch
ensurepip.bootstrap(upgrade=True, default_pip=True)
"""
TASK_PYTHON_ENV = "SCHOLARSEED_TASK_PYTHON"
TASK_CWD_ENV = "SCHOLARSEED_TASK_CWD"
TASK_OPTION = "--task"
VIRTUAL_ENV = "VIRTUAL_ENV"
PATH_ENV = "PATH"
WINDOWS_OS = "nt"
MACOS_PLATFORM = "darwin"
PYTHON_EXECUTABLE = "python.exe" if os.name == WINDOWS_OS else "python"
COMMAND_SUFFIX = ".cmd" if os.name == WINDOWS_OS else ""
COMMAND_MODE = 0o755
COMMAND_ARGUMENTS = {"python": "", "python3": "", "pip": "-m pip", "pip3": "-m pip"}
ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENVIRONMENT_OVERRIDES = frozenset(
    {
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONUSERBASE",
        "PYTHONSTARTUP",
        "PIP_TARGET",
        "PIP_PREFIX",
        "PIP_ROOT",
        "UV_PROJECT_ENVIRONMENT",
        "UV_PYTHON",
        "UV_SYSTEM_PYTHON",
        "PYTHONNOUSERSITE",
        "PIP_REQUIRE_VIRTUALENV",
        "PIP_USER",
        "PIP_CONFIG_FILE",
    }
)


def _scripts(root: Path) -> Path:
    return Path(sysconfig.get_path("scripts", vars={"base": str(root), "platbase": str(root)}))


def _base_interpreter() -> Path:
    executable = vars(sys).get(BASE_EXECUTABLE_ATTRIBUTE)
    if not isinstance(executable, str) or not executable:
        raise ValueError(ENVIRONMENT_INVALID)
    return Path(executable).resolve(strict=True)


def task_interpreter(cwd: Path) -> Path:
    """Return the actual venv interpreter, distinct from its lazy command entry."""
    return _scripts(task_python_root(cwd)) / PYTHON_EXECUTABLE


def _validate_interpreter_link(scripts: DirectoryHandle) -> None:
    base = _base_interpreter()
    targets = {str(base), str(Path(vars(sys)[BASE_EXECUTABLE_ATTRIBUTE]).absolute())}
    aliases = {
        PYTHON_EXECUTABLE,
        f"python{sys.version_info.major}",
        f"python{sys.version_info.major}.{sys.version_info.minor}",
    }
    with closing(open_directory(base.parent, ())) as parent:
        with os.fdopen(parent.open_regular(base.name), "rb") as stream:
            base_identity = os.fstat(stream.fileno())
            name = PYTHON_EXECUTABLE
            observed = {}
            for _ in range(len(aliases)):
                before = scripts.stat(name)
                if not stat.S_ISLNK(before.st_mode):
                    raise ValueError(ENVIRONMENT_INVALID)
                target = scripts.readlink(name)
                after = scripts.stat(name)
                if (before.st_dev, before.st_ino, before.st_ctime_ns) != (
                    after.st_dev,
                    after.st_ino,
                    after.st_ctime_ns,
                ):
                    raise ValueError(ENVIRONMENT_CHANGED)
                observed[name] = (after.st_dev, after.st_ino, after.st_ctime_ns)
                if target in targets:
                    for alias, identity in observed.items():
                        current = scripts.stat(alias)
                        if identity != (current.st_dev, current.st_ino, current.st_ctime_ns):
                            raise ValueError(ENVIRONMENT_CHANGED)
                    current = parent.stat(base.name)
                    if (base_identity.st_dev, base_identity.st_ino, base_identity.st_ctime_ns) != (
                        current.st_dev,
                        current.st_ino,
                        current.st_ctime_ns,
                    ) or _base_interpreter() != base:
                        raise ValueError(ENVIRONMENT_CHANGED)
                    return
                if target not in aliases:
                    raise ValueError(ENVIRONMENT_INVALID)
                name = target
    raise ValueError(ENVIRONMENT_INVALID)


def task_environment(cwd: Path, inherited: Mapping[str, str] | None = None) -> dict[str, str]:
    """Project one session's environment without modifying the backend or shared host."""
    source = os.environ if inherited is None else inherited
    environment = {
        name: value
        for name, value in source.items()
        if ENVIRONMENT_NAME.fullmatch(name)
        and name.upper() not in ENVIRONMENT_OVERRIDES
        and name.upper() not in {PATH_ENV, VIRTUAL_ENV, TASK_PYTHON_ENV, TASK_CWD_ENV}
    }
    root = task_python_root(cwd)
    scripts = _scripts(root)
    inherited_path = next(
        (value for name, value in source.items() if name.upper() == PATH_ENV), os.defpath
    )
    product_directories = {
        os.path.normcase(str(directory.resolve()))
        for directory in (
            _scripts(Path(sys.prefix)),
            Path(sys.executable).parent,
            _base_interpreter().parent,
            scripts,
            task_python_commands(cwd),
        )
    }
    inherited_path = os.pathsep.join(
        directory
        for directory in inherited_path.split(os.pathsep)
        if directory and os.path.normcase(str(Path(directory).resolve())) not in product_directories
    )
    environment.update(
        {
            PATH_ENV: os.pathsep.join(
                (str(task_python_commands(cwd)), str(scripts), inherited_path)
            ),
            VIRTUAL_ENV: str(root),
            TASK_PYTHON_ENV: str(task_python_commands(cwd) / ("python" + COMMAND_SUFFIX)),
            TASK_CWD_ENV: str(cwd.expanduser().resolve()),
            "PYTHONPATH": "",
            "PYTHONHOME": "",
            "PYTHONNOUSERSITE": "1",
            "PIP_REQUIRE_VIRTUALENV": "1",
            "PIP_USER": "0",
            "PIP_CONFIG_FILE": os.devnull,
            "UV_PYTHON": str(scripts / PYTHON_EXECUTABLE),
            "UV_PROJECT_ENVIRONMENT": str(root),
            "UV_SYSTEM_PYTHON": "false",
        }
    )
    return environment


def prepare_commands(cwd: Path) -> None:
    """Publish fixed aliases with no-follow IO; environment creation runs in the tool sandbox."""
    canonical = cwd.expanduser().resolve(strict=True)
    if canonical.is_relative_to(Path(sys.prefix).resolve()):
        raise ValueError(ENVIRONMENT_INVALID)
    launcher = next(
        (
            resolved
            for directory in command_directories(inherit_path=False)
            if (resolved := resolve_command(SKILL_PYTHON_COMMAND, directory)) is not None
        ),
        None,
    )
    if launcher is None:
        raise ValueError(ENVIRONMENT_INVALID)
    with ExitStack() as resources:
        parent = resources.enter_context(
            closing(open_directory(canonical, TASK_PYTHON_COMMAND_PARTS[:-1], create=True))
        )
        resources.enter_context(parent.arbitration(ENVIRONMENT_LOCK))
        commands = resources.enter_context(
            closing(open_directory(parent.path, (TASK_PYTHON_COMMAND_PARTS[-1],), create=True))
        )
        for name, arguments in COMMAND_ARGUMENTS.items():
            if os.name == WINDOWS_OS:
                command = str(launcher).replace("%", "%%")
                content = f'@echo off\r\nsetlocal DisableDelayedExpansion\r\n"{command}" {TASK_OPTION} {arguments} %*\r\n'
            else:
                content = (
                    f'#!/bin/sh\nexec {shlex.quote(str(launcher))} {TASK_OPTION} {arguments} "$@"\n'
                )
            payload = content.encode(ENVIRONMENT_ENCODING)
            filename = name + COMMAND_SUFFIX
            try:
                descriptor = commands.open(
                    filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, COMMAND_MODE
                )
            except FileExistsError:
                with os.fdopen(commands.open_regular(filename), "rb") as stream:
                    if stream.read(ENVIRONMENT_METADATA_LIMIT) != payload:
                        raise ValueError(ENVIRONMENT_CHANGED)
            else:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
        commands.sync()


def prepare_environment(cwd: Path) -> None:
    """Prepare only inside the task execution boundary, never in the backend process."""
    canonical = cwd.expanduser().resolve(strict=True)
    if canonical.is_relative_to(Path(sys.prefix).resolve()):
        raise ValueError(ENVIRONMENT_INVALID)
    root = task_python_root(canonical)
    receipt = {
        "cwd": str(canonical),
        "base_prefix": str(Path(sys.base_prefix).resolve()),
        "base_executable": str(_base_interpreter()),
        "version": sys.version,
    }
    with ExitStack() as resources:
        parent = resources.enter_context(
            closing(open_directory(canonical, TASK_PYTHON_PARTS[:-1], create=True))
        )
        resources.enter_context(parent.arbitration(ENVIRONMENT_LOCK))
        try:
            existing = parent.directory(root.name)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            resources.enter_context(closing(existing))
            try:
                descriptor = parent.open_regular(ENVIRONMENT_RECEIPT)
            except FileNotFoundError as error:
                raise ValueError(ENVIRONMENT_INCOMPLETE) from error
            with os.fdopen(descriptor, encoding=ENVIRONMENT_ENCODING) as stream:
                stored = json.loads(stream.read(ENVIRONMENT_METADATA_LIMIT))
            if stored != receipt:
                raise ValueError(ENVIRONMENT_CHANGED)
            descriptor = existing.open_regular(ENVIRONMENT_CONFIG)
            with os.fdopen(descriptor, encoding=ENVIRONMENT_ENCODING) as stream:
                configuration = dict(
                    row.split("=", 1)
                    for row in stream.read(ENVIRONMENT_METADATA_LIMIT).splitlines()
                    if "=" in row
                )
            configuration = {key.strip(): value.strip() for key, value in configuration.items()}
            if (
                configuration.get("include-system-site-packages") != "false"
                or Path(configuration.get("home", "")).resolve() != _base_interpreter().parent
            ):
                raise ValueError(ENVIRONMENT_INVALID)
            scripts = existing
            for part in _scripts(root).relative_to(root).parts:
                scripts = resources.enter_context(closing(scripts.directory(part)))
            if sys.platform == MACOS_PLATFORM and stat.S_ISLNK(
                scripts.stat(PYTHON_EXECUTABLE).st_mode
            ):
                _validate_interpreter_link(scripts)
            else:
                os.close(scripts.open_regular(PYTHON_EXECUTABLE))
            return
        parent.mkdir(root.name)
        pinned = resources.enter_context(closing(parent.directory(root.name)))
        venv.EnvBuilder(
            with_pip=False,
            symlinks=sys.platform == MACOS_PLATFORM,
            system_site_packages=False,
        ).create(root)
        with closing(parent.directory(root.name)) as actual:
            if actual.identity() != pinned.identity():
                raise ValueError(ENVIRONMENT_CHANGED)
            if sys.platform == MACOS_PLATFORM:
                scripts = actual
                for part in _scripts(root).relative_to(root).parts:
                    scripts = resources.enter_context(closing(scripts.directory(part)))
                _validate_interpreter_link(scripts)
        descriptor = parent.open_private(ENVIRONMENT_RECEIPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        with os.fdopen(descriptor, "w", encoding=ENVIRONMENT_ENCODING) as stream:
            json.dump(receipt, stream)
            stream.flush()
            os.fsync(stream.fileno())
        parent.sync()


def prepare_pip(cwd: Path) -> None:
    """Bootstrap a missing task installer while the caller holds its installation lock."""
    executable = str(filesystem_path(task_interpreter(cwd)))
    probe = subprocess.run(
        [executable, *PIP_PROBE_ARGUMENTS],
        executable=executable,
        env=task_environment(cwd),
        cwd=_base_interpreter().parent,
        capture_output=True,
        check=False,
    )
    if probe.returncode != PIP_MISSING_EXIT:
        probe.check_returncode()
        return
    subprocess.run(
        [
            executable,
            *(
                ("-I", "-c", WINDOWS_ENSUREPIP_BOOTSTRAP)
                if os.name == WINDOWS_OS
                else ENSUREPIP_ARGUMENTS
            ),
        ],
        executable=executable,
        env=task_environment(cwd),
        cwd=_base_interpreter().parent,
        capture_output=True,
        check=True,
    )
