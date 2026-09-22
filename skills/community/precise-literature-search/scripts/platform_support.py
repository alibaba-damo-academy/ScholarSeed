"""Small standard-library platform helpers; POSIX behavior remains unchanged."""
from __future__ import annotations

import errno
import os
from pathlib import Path
import shlex
import stat
import sys
import time

WINDOWS = os.name == "nt"


def lock_file(handle, *, blocking=True):
    """Exclusive lock, released on close, with an unlimited blocking wait."""
    descriptor = handle if isinstance(handle, int) else handle.fileno()
    if not WINDOWS:
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return
    import msvcrt
    # Locking beyond EOF is supported. Every participant locks byte zero.
    while True:
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            return
        except OSError as exc:
            if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            if not blocking:
                raise BlockingIOError(exc.errno, "File is locked") from exc
            time.sleep(0.05)


def venv_executable(root, name):
    return Path(root) / ("Scripts" if WINDOWS else "bin") / (name + ".exe" if WINDOWS else name)


def command_display(command):
    # A command pasted into PowerShell needs its call operator and literal quoting.
    if WINDOWS:
        return "& " + " ".join("'" + str(arg).replace("'", "''") + "'" for arg in command)
    return shlex.join([str(arg) for arg in command])


def executable_command(command):
    values = [str(arg) for arg in command]
    if values and Path(values[0]).suffix.lower() == ".py":
        return [sys.executable, *values]
    if WINDOWS and values and Path(values[0]).suffix.lower() in {".cmd", ".bat"}:
        raise ValueError("Use an .exe or .py executable; .cmd/.bat launchers are not supported")
    return values


def utf8_environment(environment=None):
    result = dict(os.environ if environment is None else environment)
    if WINDOWS:
        result.update(PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    return result


def is_reparse(info):
    return bool(getattr(info, "st_file_attributes", 0) & 0x400)


def private_directory(path):
    path = Path(path)
    if path.is_symlink() or is_reparse(path.lstat()):
        raise ValueError("Private directory must not be a symlink or reparse point")
    if WINDOWS:
        from windows_support import secure_directory
        secure_directory(path)
    elif path.stat().st_mode & 0o077:
        raise ValueError("Browser pool root must be private (mode 0700); choose a dedicated pool directory")


def open_regular_nofollow(path, expected):
    if WINDOWS:
        from windows_support import open_regular
        descriptor = open_regular(path)
    else:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        identity = (info.st_mode, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if not stat.S_ISREG(info.st_mode) or identity != expected:
            raise ValueError("Profile file changed while opening it")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise
