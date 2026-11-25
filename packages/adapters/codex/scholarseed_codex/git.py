"""Read worktree status without loading executable configuration from the repository."""

import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

GIT_MARKER = ".git"
GIT_TIMEOUT_SECONDS = 5
GIT_LOCATIONS = (
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-path",
    "index",
    "--git-path",
    "objects",
    "--git-path",
    "info/exclude",
    "--show-object-format",
    "--shared-index-path",
    "--verify",
    "--quiet",
    "HEAD",
)
GIT_STATUS = (
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    "--ignore-submodules=all",
)
GIT_BINARY = "git.exe" if os.name == "nt" else "git"
UNTRACKED_STATUS = b"??"
ADDED_STATUS = b"A"
GIT_HASH_LENGTHS = {"sha1": 40, "sha256": 64}
GIT_STATUS_SETTINGS = r"^core\.(excludesfile|filemode|ignorecase|autocrlf|symlinks|precomposeunicode|trustctime|checkstat)$"
MAX_EXCLUDE_BYTES = 1024 * 1024


def _copy_excludes(source: Path, git_dir: Path) -> None:
    try:
        flags = (
            os.O_RDONLY
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_BINARY", 0)
        )
        with os.fdopen(os.open(source, flags), "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise OSError("Unsupported Git excludes file")
            rules = stream.read(MAX_EXCLUDE_BYTES + 1)
    except FileNotFoundError:
        return
    if len(rules) > MAX_EXCLUDE_BYTES:
        raise OSError("Git excludes file exceeds observation limit")
    info = git_dir / "info"
    info.mkdir()
    (info / "exclude").write_bytes(rules)


def worktree_status(workspace: Path) -> dict[str, bool] | None:
    """Return dirty paths and whether Git knows them as added, or None for a full snapshot."""
    marker = workspace / GIT_MARKER
    if marker.is_symlink() or not (marker.is_dir() or marker.is_file()):
        return None
    search_path = os.pathsep.join(path for path in os.get_exec_path() if os.path.isabs(path))
    executable = shutil.which(GIT_BINARY, path=search_path)
    if not executable or Path(executable).resolve().is_relative_to(workspace):
        return None
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    for key in ("GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"):
        if key in os.environ:
            environment[key] = os.environ[key]
    environment.update(
        GIT_ATTR_NOSYSTEM="1",
        GIT_NO_LAZY_FETCH="1",
        GIT_ALLOW_PROTOCOL="",
        GIT_TERMINAL_PROMPT="0",
    )

    def run(*args: str) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [executable, "--no-optional-locks", *args],
            cwd=workspace,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )

    try:
        settings = run("config", "--null", "--get-regexp", GIT_STATUS_SETTINGS)
        if settings.returncode not in (0, 1):
            return None
        overrides = []
        for setting in settings.stdout.split(b"\x00"):
            if setting:
                key, separator, value = os.fsdecode(setting).partition("\n")
                if not re.fullmatch(GIT_STATUS_SETTINGS, key):
                    return None
                overrides.extend(("-c", f"{key}={value}" if separator else key))
        environment.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        locations = run(*GIT_LOCATIONS)
        fields = os.fsdecode(locations.stdout).splitlines()
        if locations.returncode == 1 and len(fields) == 5:
            # An unborn repository has no HEAD object yet.
            fields.append("")
        elif locations.returncode or len(fields) != 6:
            # A split index needs its shared base in the original Git directory.
            return None
        top, index, objects, exclude, object_format, head = fields
        hash_length = GIT_HASH_LENGTHS.get(object_format)
        if (
            Path(top) != workspace
            or not hash_length
            or (head and not re.fullmatch(f"[0-9a-f]{{{hash_length}}}", head))
        ):
            return None
        # Status may execute filters configured in .git/config. Give Git a private
        # metadata directory with only a detached HEAD and the real index/objects.
        with tempfile.TemporaryDirectory(prefix="scholarseed-git-") as temporary:
            git_dir = Path(temporary)
            _copy_excludes(Path(exclude), git_dir)
            (git_dir / "refs").mkdir()
            (git_dir / "HEAD").write_text(
                (head or "ref: refs/heads/unborn") + "\n", encoding="ascii"
            )
            if object_format == "sha256":
                (git_dir / "config").write_text(
                    "[core]\nrepositoryFormatVersion = 1\n[extensions]\nobjectFormat = sha256\n",
                    encoding="ascii",
                )
            environment.update(
                GIT_DIR=temporary,
                GIT_WORK_TREE=str(workspace),
                GIT_INDEX_FILE=index,
                GIT_OBJECT_DIRECTORY=objects,
            )
            status = run(
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                *overrides,
                *GIT_STATUS,
            )
        if status.returncode:
            return None
    except (OSError, subprocess.TimeoutExpired):
        return None
    result = {}
    for entry in status.stdout.split(b"\0"):
        if not entry:
            continue
        if len(entry) < 4 or entry[2:3] != b" ":
            return None
        path = Path(os.fsdecode(entry[3:]))
        if path.is_absolute() or path.drive or ".." in path.parts:
            return None
        result[str(path)] = entry[:2] == UNTRACKED_STATUS or ADDED_STATUS in entry[:2]
    return result
