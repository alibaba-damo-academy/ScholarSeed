"""Desktop-owned read-only storage selection before Electron is created.

The verified launcher supplies the signed product policy and receives this result
on private inherited pipes. The result is an observation, not write permission:
the launcher must qualify the complete discovered root set and recheck the source
before publishing family memberships or starting Electron.
"""

from __future__ import annotations

import base64
import ctypes
import json
import ntpath
import os
import re
import sys
from ctypes import wintypes
from pathlib import Path
from uuid import UUID

from service.platform.storage import WindowsDirectoryNative

VERSION = 1
MAX_FRAME_BYTES = 1024 * 1024
MAX_POINTER_BYTES = 64 * 1024
MAX_PATH_BYTES = 4096
POINTER_NAME = "storage-config.json"
HOME_ENV = "SCHOLARSEED_HOME"
WORKSPACE_ENV = "SCHOLARSEED_DEFAULT_WORKSPACE"
HOME_DIRECTORY = ".scholarseed"
LEGACY_DIRECTORY = ".veda"
COORDINATOR_DIRECTORY = ".scholarseed-coordination"
SESSION_PREFIX = "scholarseed-desktop-session-"
PROJECTS_DIRECTORY = "Projects"
DEFAULT_WORKSPACE_DIRECTORY = "ScholarSeed"
NAMESPACE = re.compile(r"[a-z][a-z0-9-]*\Z")
APP_NAME = re.compile(r"[a-z][a-z0-9-]*\Z")
PROFILE_FOLDER = "5e6c858f-0e22-4760-9afe-ea3317b67173"
APPDATA_FOLDER = "3eb685db-65f9-4cf6-a03a-e3ef65729f3d"
DOCUMENTS_FOLDER = "fdd39ad0-238f-46af-adb4-6c85480369c7"
FAILURE_EXIT = 2


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate startup field")
        result[key] = value
    return result


def absolute(value: object) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_PATH_BYTES:
        raise ValueError("invalid startup path")
    drive, tail = ntpath.splitdrive(value)
    if len(drive) != 2 or drive[1] != ":" or not drive[0].isascii() or not drive[0].isalpha():
        raise ValueError("startup requires a local drive")
    if not tail.startswith(("/", "\\")) or "\0" in value:
        raise ValueError("startup requires an absolute path")
    parts = tail.replace("/", "\\").split("\\")[1:]
    if any(part in (".", "..") or part.endswith((".", " ")) or ":" in part for part in parts):
        raise ValueError("ambiguous startup path")
    return ntpath.normpath(value)


def known_folder(identifier: str) -> str:
    # A zero flags query does not create the folder or repair its permissions.
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    ole = ctypes.WinDLL("ole32", use_last_error=True)
    query = shell.SHGetKnownFolderPath
    query.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.HANDLE,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    query.restype = ctypes.c_long
    free = ole.CoTaskMemFree
    free.argtypes = [ctypes.c_void_p]
    free.restype = None
    guid = ctypes.create_string_buffer(UUID(identifier).bytes_le)
    output = ctypes.c_void_p()
    status = query(ctypes.byref(guid), 0, None, ctypes.byref(output))
    try:
        if status < 0 or not output.value:
            raise ValueError("OS account directory unavailable")
        return absolute(ctypes.wstring_at(output))
    finally:
        if output.value:
            free(output)


def user_data_argument(arguments: list[str], default: str) -> str:
    selected = None
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            break
        if argument == "--user-data-dir":
            index += 1
            if index == len(arguments):
                raise ValueError("missing user-data-dir")
            value = arguments[index]
        elif argument.startswith("--user-data-dir="):
            value = argument.split("=", 1)[1]
        else:
            index += 1
            continue
        if selected is not None:
            raise ValueError("duplicate user-data-dir")
        selected = absolute(value)
        index += 1
    return default if selected is None else selected


def pointer(native: WindowsDirectoryNative, user_data: str) -> bytes | None:
    try:
        pin = native.pin(user_data, False)
    except BaseException as error:
        if getattr(error, "code", None) == "ERR_LEASE_MISSING":
            return None
        raise
    try:
        result = native.read_at(pin, POINTER_NAME, MAX_POINTER_BYTES)
    except BaseException as error:
        if getattr(error, "code", None) != "ERR_LEASE_RELEASE":
            native.release(pin)
        raise
    native.release(pin)
    return result


def empty_or_missing(directory: str) -> bool:
    try:
        # Native pin rejects reparse traversal and untrusted directories before
        # this observation. Directory enumeration is eligibility only, not a lease.
        native = WindowsDirectoryNative()
        pin = native.pin(directory, False)
    except BaseException as error:
        return getattr(error, "code", None) == "ERR_LEASE_MISSING"
    try:
        with os.scandir(directory) as entries:
            return next(entries, None) is None
    finally:
        native.release(pin)


def select(policy: dict, arguments: list[str]) -> dict:
    lane = policy.get("release_lane")
    profile = policy.get("credential_profiles", {}).get(lane)
    name = policy.get("desktop_name")
    if not isinstance(name, str) or not APP_NAME.fullmatch(name) or not isinstance(profile, dict):
        raise ValueError("invalid signed Desktop policy")
    namespace = profile.get("session_namespace")
    if not isinstance(namespace, str) or not NAMESPACE.fullmatch(namespace):
        raise ValueError("invalid signed session namespace")
    account = known_folder(PROFILE_FOLDER)
    home_base = absolute(os.environ.get("USERPROFILE") or account)
    app_data = absolute(os.environ.get("APPDATA") or known_folder(APPDATA_FOLDER))
    user_data = user_data_argument(arguments, ntpath.join(app_data, name))
    default_home = ntpath.join(home_base, HOME_DIRECTORY)
    explicit_home = os.environ.get(HOME_ENV, "").strip()
    explicit_workspace = os.environ.get(WORKSPACE_ENV, "")
    observed = None if explicit_home else pointer(WindowsDirectoryNative(), user_data)
    if explicit_home:
        home = absolute(explicit_home)
        source = {"kind": "environment", "value": home}
    elif observed is not None:
        value = json.loads(observed.decode("utf-8"), object_pairs_hook=unique_object)
        if (
            not isinstance(value, dict)
            or type(value.get("schemaVersion")) is not int
            or value["schemaVersion"] != VERSION
        ):
            raise ValueError("invalid storage pointer")
        home = absolute(value.get("dataHome"))
        source = {"kind": "pointer", "bytes": base64.b64encode(observed).decode("ascii")}
    else:
        home = default_home
        source = {"kind": "default"}
    workspace = (
        absolute(explicit_workspace)
        if explicit_workspace
        else (
            ntpath.join(known_folder(DOCUMENTS_FOLDER), DEFAULT_WORKSPACE_DIRECTORY)
            if home == default_home
            else ntpath.join(ntpath.dirname(home), PROJECTS_DIRECTORY)
        )
    )
    legacy = ntpath.join(user_data, LEGACY_DIRECTORY)
    return {
        "version": VERSION,
        "coordinator": ntpath.join(account, COORDINATOR_DIRECTORY),
        "source": source,
        "home": home,
        "userData": user_data,
        "sessionData": ntpath.join(app_data, SESSION_PREFIX + namespace),
        "workspace": workspace,
        "createWorkspace": not explicit_workspace,
        "legacyHome": legacy,
        "configured": home != default_home,
        "firstLaunchEligible": not explicit_home
        and observed is None
        and empty_or_missing(default_home)
        and empty_or_missing(legacy),
    }


def main() -> int:
    try:
        if sys.platform != "win32" or len(sys.argv) != 2:
            raise ValueError("unsupported startup owner")
        with Path(sys.argv[1]).open("rb") as stream:
            policy_bytes = stream.read(MAX_FRAME_BYTES + 1)
        if len(policy_bytes) > MAX_FRAME_BYTES:
            raise ValueError("startup policy too large")
        policy = json.loads(policy_bytes.decode("utf-8"), object_pairs_hook=unique_object)
        request = sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1)
        if len(request) > MAX_FRAME_BYTES or not request.endswith(b"\n"):
            raise ValueError("invalid startup frame")
        value = json.loads(request, object_pairs_hook=unique_object)
        if (
            not isinstance(value, dict)
            or set(value) != {"version", "arguments"}
            or type(value["version"]) is not int
            or value["version"] != VERSION
        ):
            raise ValueError("unsupported startup request")
        arguments = value["arguments"]
        if not isinstance(arguments, list) or any(
            not isinstance(arg, str) or "\0" in arg for arg in arguments
        ):
            raise ValueError("invalid startup arguments")
        response = (
            json.dumps(select(policy, arguments), ensure_ascii=True, separators=(",", ":")).encode(
                "ascii"
            )
            + b"\n"
        )
        if len(response) > MAX_FRAME_BYTES:
            raise ValueError("startup response too large")
        sys.stdout.buffer.write(response)
        sys.stdout.buffer.flush()
        # Keep the verified helper under its original Job until the owner has
        # consumed the frame and explicitly closes it. No second request exists.
        if sys.stdin.buffer.read(1):
            raise ValueError("startup selection already consumed")
        return 0
    except BaseException:
        # Pointer values and launch inputs can contain user paths or credentials.
        sys.stderr.write("startup_selection_failed\n")
        return FAILURE_EXIT


if __name__ == "__main__":
    raise SystemExit(main())
