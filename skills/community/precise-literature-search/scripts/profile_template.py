"""Offline Chrome login templates; never copy a live profile or replace a slot."""
from __future__ import annotations

from platform_support import WINDOWS, is_reparse, lock_file, open_regular_nofollow, private_directory
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

from io_utils import atomic_write_json, read_json

MARKER = ".paper-dl-template.json"
SESSION_FILES = {
    "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs",
    "History", "History-journal", "History-wal", "History-shm",
}
OMIT = SESSION_FILES | {"Cache", "Code Cache", "GPUCache", "DawnCache", "Media Cache"}


class ProfileInUse(ValueError):
    pass


def require_offline(profile):
    # Even a stale singleton is ambiguous. Never remove the source's locks.
    if any(os.path.lexists(profile / name) for name in
           ("SingletonLock", "SingletonCookie", "SingletonSocket")):
        raise ProfileInUse("Profile has Chrome singleton files; fully quit its Chrome before reusing or copying it")
    if WINDOWS:
        from windows_support import command_arguments, process_commands
        try:
            commands = process_commands()
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            raise ValueError("Cannot verify that the source Chrome has exited") from exc
        # A Chrome command line that cannot be read cannot prove the profile offline.
        for entry in commands:
            command = entry.get("CommandLine") or ""
            chrome = str(entry.get("Name", "")).lower() in {"chrome.exe", "chromium.exe"}
            if chrome and not command:
                raise ProfileInUse("Cannot inspect a running Chrome; fully quit Chrome before copying")
            arguments = command_arguments(command) if command else []
            profile_argument = None
            for index, argument in enumerate(arguments):
                if argument.lower().startswith("--user-data-dir="):
                    profile_argument = argument.split("=", 1)[1]
                elif argument.lower() == "--user-data-dir" and index + 1 < len(arguments):
                    profile_argument = arguments[index + 1]
            if profile_argument and os.path.normcase(os.path.abspath(profile_argument)) == os.path.normcase(str(profile)):
                raise ProfileInUse("Profile is in use; fully quit its Chrome before copying")
            if chrome and not profile_argument:
                local = os.getenv("LOCALAPPDATA")
                defaults = [Path(local) / vendor / "User Data" for vendor in ("Google/Chrome", "Chromium")] if local else []
                if not defaults or any(p.resolve() == profile.resolve() for p in defaults):
                    raise ProfileInUse("Default Chrome profile may be in use; fully quit Chrome before copying")
        return
    try:
        result = subprocess.run(["ps", "-axo", "command="], capture_output=True,
                                text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError("Cannot verify that the source Chrome has exited") from exc
    if result.returncode:
        raise ValueError("Cannot verify that the source Chrome has exited")
    argument = re.compile(r"--user-data-dir(?:=|\s+)[\"']?" + re.escape(str(profile))
                          + r"[\"']?(?=\s|$)")
    if any(argument.search(line) for line in result.stdout.splitlines()):
        raise ProfileInUse("Profile is in use; fully quit its Chrome before reusing or copying it")


def inventory(profile):
    """Only Local State and Default are imported; refuse links/special files."""
    entries = {}

    def visit(path):
        relative = path.relative_to(profile)
        if len(relative.parts) == 2 and relative.parts[1] in OMIT:
            return
        info = path.lstat()
        if is_reparse(info) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError(f"Profile contains a link or special file: {relative}")
        entries[relative.as_posix()] = (info.st_mode, info.st_ino, info.st_size,
                                  info.st_mtime_ns, info.st_ctime_ns)
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir()):
                visit(child)

    for name in ("Local State", "Default"):
        visit(profile / name)
    if not stat.S_ISREG(entries["Local State"][0]) or not stat.S_ISDIR(entries["Default"][0]):
        raise ValueError("Source must be a Chrome user-data directory with Local State and Default")
    if "Default/Preferences" not in entries or not stat.S_ISREG(entries["Default/Preferences"][0]):
        raise ValueError("Source must contain Default/Preferences; other Chrome profile names are not supported")
    return entries


def copy_entries(source, destination, entries):
    for relative, info in entries.items():
        target = destination / relative
        if stat.S_ISDIR(info[0]):
            target.mkdir(mode=0o700)
        else:
            # Do not dereference a link introduced after inventory was taken.
            descriptor = open_regular_nofollow(source / relative, info)
            with os.fdopen(descriptor, "rb") as incoming, target.open("xb") as outgoing:
                os.chmod(target, 0o600)
                shutil.copyfileobj(incoming, outgoing)


def sanitize_profile(profile):
    default = profile / "Default"
    if WINDOWS:
        for path in (profile, default, default / "Preferences", profile / "Local State"):
            if os.path.lexists(path) and (path.is_symlink() or is_reparse(path.lstat())):
                raise ValueError("Pool profile contains a reparse point; refusing cleanup")
    default.mkdir(exist_ok=True, mode=0o700)
    for name in SESSION_FILES:
        path = default / name
        if WINDOWS and path.exists() and is_reparse(path.lstat()):
            raise ValueError("Pool profile contains a reparse point; refusing cleanup")
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    prefs_path = default / "Preferences"
    prefs = read_json(prefs_path) if prefs_path.exists() else {}
    prefs.setdefault("session", {})["restore_on_startup"] = 5
    prefs.setdefault("profile", {}).update(exit_type="Normal", exited_cleanly=True)
    for section in ("download", "savefile"):
        for key in ("default_directory", "last_directory"):
            prefs.get(section, {}).pop(key, None)
    atomic_write_json(prefs_path, prefs)
    local_state = profile / "Local State"
    if local_state.exists():
        state = read_json(local_state)
        settings = state.setdefault("profile", {})
        settings.update(last_used="Default", last_active_profiles=["Default"])
        if "info_cache" in settings:
            settings["info_cache"] = {key: value for key, value in settings["info_cache"].items()
                                      if key == "Default"}
        atomic_write_json(local_state, state)
    (profile / "DevToolsActivePort").unlink(missing_ok=True)


def copy_offline(source, destination, *, template=False):
    source = Path(source).expanduser().resolve()
    destination = Path(destination).expanduser().absolute()
    resolved_destination = destination.resolve()
    if (source == resolved_destination or source in resolved_destination.parents
            or resolved_destination in source.parents):
        raise ValueError("Source and destination profiles must not overlap")
    if os.path.lexists(destination):
        raise ValueError("Destination already exists; use a new template path, never overwrite a profile")
    require_offline(source)
    before = inventory(source)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = Path(tempfile.mkdtemp(prefix=".profile-copy-", dir=destination.parent))
    try:
        if WINDOWS:
            private_directory(staging)
        copy_entries(source, staging, before)
        require_offline(source)
        if inventory(source) != before:
            raise ValueError("Source profile changed during copying; keep Chrome closed and retry")
        sanitize_profile(staging)
        if template:
            atomic_write_json(staging / MARKER, {"version": 1, "profile_directory": "Default"})
        # Serialize publication only, not copying or process inspection.
        with (destination.parent / ".profile-template.lock").open("a+") as lock:
            lock_file(lock)
            if os.path.lexists(destination):
                raise ValueError("Destination already exists; refusing to overwrite it")
            staging.rename(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return destination


def create_template(source, destination):
    return copy_offline(source, destination, template=True)


def initialize_profile(profile, pool_root):
    # Existing profiles (including empty ones) belong to their slot already.
    if os.path.lexists(profile):
        return
    configured = os.getenv("PAPER_DL_PROFILE_TEMPLATE")
    template = Path(configured).expanduser() if configured else pool_root / "profile-template"
    if not configured and not os.path.lexists(template):
        return
    if read_json(template / MARKER) != {"version": 1, "profile_directory": "Default"}:
        raise ValueError("Invalid profile template; use browser_pool.py create-template")
    copy_offline(template, profile)
