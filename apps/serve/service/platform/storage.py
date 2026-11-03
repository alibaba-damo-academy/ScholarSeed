"""Cross-platform pinned-directory primitives for product filesystem domains."""

from __future__ import annotations

import ctypes
import errno
import ntpath
import os
import platform
import re
import stat
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from ctypes import wintypes
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from types import ModuleType
from typing import NoReturn, Protocol, cast
from uuid import UUID

from service.platform import security, windows

fcntl: ModuleType | None
try:
    import fcntl
except ModuleNotFoundError:
    fcntl = None

pwd: ModuleType | None
try:
    import pwd
except ModuleNotFoundError:
    pwd = None

_msvcrt: ModuleType | None
try:
    import msvcrt as _msvcrt
except ModuleNotFoundError:
    _msvcrt = None


class DirectoryRole(str, Enum):
    """Private authority records versus user-controlled project content."""

    PRIVATE = "private"
    PROJECT = "project"


_INSTALLATION_SEED_PARTS = ("current", "resources", "defaults")
_INSTALLATION_SEED_NAME = "config.json"
_INSTALLATION_READ_ONLY = "ERR_LEASE_READ_ONLY"


@dataclass(frozen=True)
class InstallationBinding:
    """Composition-selected, existing-only packaged configuration source."""

    root: str
    relative: tuple[str, ...] = _INSTALLATION_SEED_PARTS

    def __post_init__(self) -> None:
        if not isinstance(self.root, str) or self.relative != _INSTALLATION_SEED_PARTS:
            raise ValueError("installation binding requires the fixed packaged seed layout")
        root = self.root.removeprefix(WINDOWS_PATH_PREFIX).replace("/", "\\")
        if (
            not re.match(r"^[a-zA-Z]:\\", root)
            or len(root) <= 3
            or "\0" in root
            or any(
                not part or part in {".", ".."} or ":" in part or part.endswith((".", " "))
                for part in root[3:].split("\\")
            )
        ):
            raise ValueError("installation binding requires an absolute local installation root")
        object.__setattr__(self, "root", root)

    @property
    def target(self) -> str:
        return ntpath.join(self.root, *self.relative)

    def matches(self, path: str) -> bool:
        return ntpath.normcase(path.removeprefix(WINDOWS_PATH_PREFIX)) == ntpath.normcase(
            self.target
        )


WINDOWS_PLATFORM = "nt"
DIRECTORY_MODE = 0o700
DIRECTORY_PATH_INVALID = "filesystem_directory_path_invalid"
DIRECTORY_EXISTS_ERROR = "ERR_LEASE_EXISTS"
FILE_PUBLICATION_CONFLICT = "filesystem_publication_conflict"
TREE_ENTRY_LIMIT = 262_144
FILE_ATTRIBUTE_DIRECTORY = 0x00000010
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
FILE_ATTRIBUTE_NORMAL = 0x00000080
FILE_READ_ATTRIBUTES = 0x00000080
DELETE_ACCESS = 0x00010000
FILE_DISPOSITION_INFO_EX_CLASS = 21
FILE_DISPOSITION_DELETE = 0x00000001
FILE_DISPOSITION_POSIX_SEMANTICS = 0x00000002
FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE = 0x00000010
READ_CONTROL = 0x00020000
WRITE_DAC = 0x00040000
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
SYNCHRONIZE = 0x00100000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
FILE_SHARE_DELETE = 0x00000004
CREATE_NEW = 1
CREATE_ALWAYS = 2
OPEN_EXISTING = 3
OPEN_ALWAYS = 4
TRUNCATE_EXISTING = 5
FILE_ATTRIBUTE_TAG_INFO_CLASS = 9
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
WINDOWS_PATH_PREFIX = "\\\\?\\"
WINDOWS_NAMED_STREAM = ":scholarseed.creation"
LEGACY_WINDOWS_NAMED_STREAM = ":shushen.creation"
WINDOWS_NAMED_STREAMS = (WINDOWS_NAMED_STREAM, LEGACY_WINDOWS_NAMED_STREAM)
CREATION_ATTRIBUTE = b"user.scholarseed.creation"
LEGACY_CREATION_ATTRIBUTE = b"user.shushen.creation"
CREATION_ATTRIBUTES = (CREATION_ATTRIBUTE, LEGACY_CREATION_ATTRIBUTE)
WINDOWS_PATH_BUFFER = 32768
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
NONBLOCK = getattr(os, "O_NONBLOCK", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
ACCESS_MODE_MASK = getattr(os, "O_ACCMODE", os.O_WRONLY | os.O_RDWR)
PATH_CHANGE_TIME_COMPARABLE = os.name != WINDOWS_PLATFORM
SE_FILE_OBJECT = 1
DACL_SECURITY_INFORMATION = 0x00000004
FILE_ALL_ACCESS = 0x001F01FF
SET_ACCESS = 2
NO_MULTIPLE_TRUSTEE = 0
TRUSTEE_IS_NAME = 1
TRUSTEE_IS_USER = 1
SUB_CONTAINERS_AND_OBJECTS_INHERIT = 3
PRIVATE_FILE_MODE = 0o600
WINDOWS_BINARY_MODE = 0x8000
WINDOWS_RESERVED_NAMES = frozenset(
    (
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "CONIN$",
        "CONOUT$",
        *(f"COM{number}" for number in range(1, 10)),
        *(f"LPT{number}" for number in range(1, 10)),
    )
)
MAX_LEAF_UTF16_BYTES = 510
DARWIN = "darwin"
ACL_TYPE_EXTENDED = 0x100
ACL_FIRST_ENTRY = 0
FILESEC_ACL = 5
STAT_BUFFER_BYTES = 512
LOCK_EXCLUSIVE_NONBLOCK = 6
LOCK_UNLOCK = 8
NAMESPACE_SYNCED = "namespace-synced"
FILE_FLUSHED = "file-flushed"
_LIBC = ctypes.CDLL(None, use_errno=True) if os.name != WINDOWS_PLATFORM else None
_RENAME_SPECS = {DARWIN: ("renameatx_np", 4), "linux": ("renameat2", 1)}
_RENAME_SPEC = _RENAME_SPECS.get(sys.platform)
_RENAME_EXCLUSIVE = getattr(_LIBC, _RENAME_SPEC[0], None) if _RENAME_SPEC else None
if _RENAME_EXCLUSIVE is not None:
    _RENAME_EXCLUSIVE.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    _RENAME_EXCLUSIVE.restype = ctypes.c_int
if _LIBC is not None:
    _LIBC.flock.argtypes = [ctypes.c_int, ctypes.c_int]
    _LIBC.flock.restype = ctypes.c_int
if sys.platform == DARWIN and _LIBC is not None:
    _LIBC.filesec_init.argtypes = []
    _LIBC.filesec_init.restype = ctypes.c_void_p
    _LIBC.filesec_free.argtypes = [ctypes.c_void_p]
    _LIBC.filesec_free.restype = None
    _LIBC.fstatx_np.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
    _LIBC.fstatx_np.restype = ctypes.c_int
    _LIBC.filesec_query_property.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_int),
    ]
    _LIBC.filesec_query_property.restype = ctypes.c_int
    _LIBC.acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
    _LIBC.acl_get_fd_np.restype = ctypes.c_void_p
    _LIBC.acl_get_entry.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
    _LIBC.acl_get_entry.restype = ctypes.c_int
    _LIBC.acl_free.argtypes = [ctypes.c_void_p]
    _LIBC.acl_free.restype = ctypes.c_int


class FileAttributeTagInfo(ctypes.Structure):
    _fields_ = [("file_attributes", wintypes.DWORD), ("reparse_tag", wintypes.DWORD)]


class TrusteeW(ctypes.Structure):
    _fields_ = [
        ("multiple_trustee", wintypes.LPVOID),
        ("multiple_trustee_operation", wintypes.DWORD),
        ("trustee_form", wintypes.DWORD),
        ("trustee_type", wintypes.DWORD),
        ("name", wintypes.LPWSTR),
    ]


class ExplicitAccessW(ctypes.Structure):
    _fields_ = [
        ("access_permissions", wintypes.DWORD),
        ("access_mode", wintypes.DWORD),
        ("inheritance", wintypes.DWORD),
        ("trustee", TrusteeW),
    ]


class _StatIdentity(Protocol):
    @property
    def st_dev(self) -> int: ...

    @property
    def st_ino(self) -> int: ...

    @property
    def st_size(self) -> int: ...

    @property
    def st_mtime_ns(self) -> int: ...

    @property
    def st_ctime_ns(self) -> int: ...


class _WindowsCrtApi(Protocol):
    def open_osfhandle(self, handle: int, flags: int) -> int: ...

    def get_osfhandle(self, descriptor: int) -> int: ...


WINDOWS_CRT = cast(_WindowsCrtApi, _msvcrt) if _msvcrt is not None else None


_WIN_DLL = getattr(ctypes, "WinDLL", None)
_GET_LAST_ERROR = getattr(ctypes, "get_last_error", None)
_KERNEL32 = (
    _WIN_DLL("kernel32", use_last_error=True)
    if os.name == WINDOWS_PLATFORM and _WIN_DLL is not None
    else None
)
_ADVAPI32 = (
    _WIN_DLL("advapi32", use_last_error=True)
    if os.name == WINDOWS_PLATFORM and _WIN_DLL is not None
    else None
)
if _KERNEL32 is not None:
    _KERNEL32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    _KERNEL32.CreateFileW.restype = wintypes.HANDLE
    _KERNEL32.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    _KERNEL32.GetFileInformationByHandleEx.restype = wintypes.BOOL
    _KERNEL32.SetFileInformationByHandle.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    _KERNEL32.SetFileInformationByHandle.restype = wintypes.BOOL
    _KERNEL32.CloseHandle.argtypes = [wintypes.HANDLE]
    _KERNEL32.CloseHandle.restype = wintypes.BOOL
    _KERNEL32.GetFinalPathNameByHandleW.argtypes = [
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    _KERNEL32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    _KERNEL32.LocalFree.argtypes = [wintypes.HLOCAL]
    _KERNEL32.LocalFree.restype = wintypes.HLOCAL
if _ADVAPI32 is not None:
    _ADVAPI32.GetUserNameW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    _ADVAPI32.GetUserNameW.restype = wintypes.BOOL
    _ADVAPI32.GetSecurityInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.LPVOID),
    ]
    _ADVAPI32.GetSecurityInfo.restype = wintypes.DWORD
    _ADVAPI32.SetEntriesInAclW.argtypes = [
        wintypes.ULONG,
        ctypes.POINTER(ExplicitAccessW),
        wintypes.LPVOID,
        ctypes.POINTER(wintypes.LPVOID),
    ]
    _ADVAPI32.SetEntriesInAclW.restype = wintypes.DWORD
    _ADVAPI32.SetSecurityInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.LPVOID,
    ]
    _ADVAPI32.SetSecurityInfo.restype = wintypes.DWORD


def _raise_windows_error() -> None:
    code = _GET_LAST_ERROR() if callable(_GET_LAST_ERROR) else 0
    raise OSError(None, f"Windows filesystem error {code}", None, code)


def _posix_api() -> ctypes.CDLL:
    if _LIBC is None:
        raise OSError("POSIX native backend unavailable")
    return _LIBC


def _borrowed_handle(descriptor: int) -> int:
    if WINDOWS_CRT is None:
        raise OSError("Windows CRT unavailable")
    return WINDOWS_CRT.get_osfhandle(descriptor)


def _validate_part(part: str) -> None:
    if (
        part in {"", ".", ".."}
        or any(character in part for character in ("/", "\\", ":", "\x00"))
        or part.endswith((".", " "))
        or part.split(".", maxsplit=1)[0].upper() in WINDOWS_RESERVED_NAMES
        or len(part.encode("utf-16-le")) > MAX_LEAF_UTF16_BYTES
    ):
        raise ValueError(DIRECTORY_PATH_INVALID)


def _read_signature(identity: _StatIdentity) -> tuple[int, ...]:
    return (
        identity.st_dev,
        identity.st_ino,
        identity.st_size,
        identity.st_mtime_ns,
        identity.st_ctime_ns,
    )


def _path_signature(identity: _StatIdentity) -> tuple[int, ...]:
    signature = (
        identity.st_dev,
        identity.st_ino,
        identity.st_size,
        identity.st_mtime_ns,
    )
    if PATH_CHANGE_TIME_COMPARABLE:
        return (*signature, identity.st_ctime_ns)
    return signature


def stable_read_matches(
    before: _StatIdentity,
    after: _StatIdentity,
    current: _StatIdentity,
    payload_size: int,
) -> bool:
    """Check one stable read without equating incompatible platform timestamps.

    Windows Python 3.12 reports ``st_ctime`` differently for a descriptor-backed
    ``fstat`` and a path-backed ``stat``.  The open handle still supplies a stable
    change-time comparison across the read, while device/file identity, size, and
    modification time prove that the authorized path still names that handle.
    """

    return (
        _read_signature(before) == _read_signature(after)
        and _path_signature(after) == _path_signature(current)
        and payload_size == before.st_size
    )


def filesystem_path(path: str | os.PathLike[str]) -> Path:
    """Use extended Windows paths for internal IO without resolving symlinks.

    This is path spelling, not authorization. Callers retain their ordinary
    directory/identity checks; UNC shares and already extended paths stay valid.
    """
    if os.name != WINDOWS_PLATFORM:
        return Path(path)
    absolute = os.path.abspath(path)
    if absolute.startswith(WINDOWS_PATH_PREFIX):
        return Path(absolute)
    if absolute.startswith("\\\\"):
        absolute = "UNC\\" + absolute[2:]
    return Path(WINDOWS_PATH_PREFIX + absolute)


def canonical_root(root: Path) -> Path:
    """Canonicalize POSIX ancestors while leaving the selected root itself no-follow.

    macOS exposes temporary directories through ``/var`` -> ``/private/var``.  Callers
    that historically opened an already-authorized absolute root in one operation use
    this helper before switching to component-wise pinning.  Windows keeps the original
    spelling so every component can be checked for reparse points by its native backend.
    """
    if os.name == WINDOWS_PLATFORM or root == Path(root.anchor):
        return root
    return root.parent.resolve(strict=True) / root.name


def open_parent(path: str | os.PathLike[str]) -> tuple[DirectoryHandle, str]:
    """Pin the parent of one absolute platform path and return its leaf name."""
    source = Path(path)
    if not source.is_absolute() or not source.name:
        raise ValueError(DIRECTORY_PATH_INVALID)
    return open_directory(canonical_root(source.parent), ()), source.name


def _open_windows_directory(path: Path, access: int = FILE_READ_ATTRIBUTES | SYNCHRONIZE) -> int:
    if _KERNEL32 is None:
        raise OSError("Windows filesystem backend unavailable")
    handle = _KERNEL32.CreateFileW(
        str(filesystem_path(path)),
        access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        None,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    if handle == INVALID_HANDLE_VALUE:
        _raise_windows_error()
    info = FileAttributeTagInfo()
    if not _KERNEL32.GetFileInformationByHandleEx(
        handle,
        FILE_ATTRIBUTE_TAG_INFO_CLASS,
        ctypes.byref(info),
        ctypes.sizeof(info),
    ):
        try:
            _raise_windows_error()
        finally:
            windows.close(int(handle))
    if not info.file_attributes & FILE_ATTRIBUTE_DIRECTORY:
        windows.close(int(handle))
        raise NotADirectoryError(str(path))
    if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
        windows.close(int(handle))
        raise OSError("reparse-point directory rejected")
    return int(handle)


def _current_windows_user() -> ctypes.Array[ctypes.c_wchar]:
    if _ADVAPI32 is None:
        raise OSError("Windows security backend unavailable")
    size = wintypes.DWORD(0)
    _ADVAPI32.GetUserNameW(None, ctypes.byref(size))
    if not size.value:
        _raise_windows_error()
    buffer = ctypes.create_unicode_buffer(size.value)
    if not _ADVAPI32.GetUserNameW(buffer, ctypes.byref(size)):
        _raise_windows_error()
    return buffer


def grant_current_user_directory_access(path: Path) -> None:
    """Preserve host access for descendants created by the Windows sandbox."""

    if os.name != WINDOWS_PLATFORM:
        return
    if _ADVAPI32 is None or _KERNEL32 is None:
        raise OSError("Windows security backend unavailable")
    directory = open_directory(
        canonical_root(path), (), final_access=READ_CONTROL | WRITE_DAC | SYNCHRONIZE
    )
    security_descriptor = wintypes.LPVOID()
    current_dacl = wintypes.LPVOID()
    updated_dacl = wintypes.LPVOID()
    username = _current_windows_user()
    try:
        code = _ADVAPI32.GetSecurityInfo(
            directory.native_handles[-1],
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            ctypes.byref(current_dacl),
            None,
            ctypes.byref(security_descriptor),
        )
        if code:
            raise OSError(code, f"GetSecurityInfo failed: {code}")
        entry = ExplicitAccessW(
            access_permissions=FILE_ALL_ACCESS,
            access_mode=SET_ACCESS,
            inheritance=SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            trustee=TrusteeW(
                multiple_trustee=None,
                multiple_trustee_operation=NO_MULTIPLE_TRUSTEE,
                trustee_form=TRUSTEE_IS_NAME,
                trustee_type=TRUSTEE_IS_USER,
                name=ctypes.cast(username, wintypes.LPWSTR),
            ),
        )
        code = _ADVAPI32.SetEntriesInAclW(
            1, ctypes.byref(entry), current_dacl, ctypes.byref(updated_dacl)
        )
        if code:
            raise OSError(code, f"SetEntriesInAclW failed: {code}")
        code = _ADVAPI32.SetSecurityInfo(
            directory.native_handles[-1],
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            updated_dacl,
            None,
        )
        if code:
            raise OSError(code, f"SetSecurityInfo failed: {code}")
    finally:
        if updated_dacl:
            _KERNEL32.LocalFree(updated_dacl)
        if security_descriptor:
            _KERNEL32.LocalFree(security_descriptor)
        directory.close()


def _windows_disposition(flags: int) -> int:
    if flags & os.O_CREAT and flags & os.O_EXCL:
        return CREATE_NEW
    if flags & os.O_CREAT and flags & os.O_TRUNC:
        return CREATE_ALWAYS
    if flags & os.O_CREAT:
        return OPEN_ALWAYS
    if flags & os.O_TRUNC:
        return TRUNCATE_EXISTING
    return OPEN_EXISTING


def _windows_access(flags: int) -> int:
    access = flags & ACCESS_MODE_MASK
    if access == os.O_RDWR:
        return GENERIC_READ | GENERIC_WRITE
    if access == os.O_WRONLY:
        return GENERIC_WRITE
    return GENERIC_READ


def _open_windows_file(path: Path, flags: int) -> int:
    if _KERNEL32 is None or WINDOWS_CRT is None:
        raise OSError("Windows filesystem backend unavailable")
    handle = _KERNEL32.CreateFileW(
        str(filesystem_path(path)),
        _windows_access(flags),
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        _windows_disposition(flags),
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    if handle == INVALID_HANDLE_VALUE:
        _raise_windows_error()
    info = FileAttributeTagInfo()
    try:
        if not _KERNEL32.GetFileInformationByHandleEx(
            handle,
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            _raise_windows_error()
        if info.file_attributes & FILE_ATTRIBUTE_DIRECTORY:
            raise IsADirectoryError(str(path))
        if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
            raise OSError(errno.ELOOP, "reparse-point entry rejected", str(path))
        descriptor_flags = flags & (ACCESS_MODE_MASK | os.O_APPEND)
        descriptor = WINDOWS_CRT.open_osfhandle(
            int(handle),
            descriptor_flags | getattr(os, "O_BINARY", 0),
        )
        handle = INVALID_HANDLE_VALUE
        return descriptor
    finally:
        if handle != INVALID_HANDLE_VALUE:
            _KERNEL32.CloseHandle(handle)


def _unlink_windows_file(path: Path, expected: _StatIdentity | None) -> None:
    if _KERNEL32 is None or WINDOWS_CRT is None:
        raise OSError("Windows filesystem backend unavailable")
    handle = _KERNEL32.CreateFileW(
        str(filesystem_path(path)),
        DELETE_ACCESS | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        None,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )
    if handle == INVALID_HANDLE_VALUE:
        _raise_windows_error()
    descriptor = None
    try:
        info = FileAttributeTagInfo()
        if not _KERNEL32.GetFileInformationByHandleEx(
            handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, ctypes.byref(info), ctypes.sizeof(info)
        ):
            _raise_windows_error()
        if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
            raise OSError(errno.ELOOP, "reparse-point entry rejected", str(path))
        if info.file_attributes & FILE_ATTRIBUTE_DIRECTORY:
            raise IsADirectoryError(str(path))
        descriptor = WINDOWS_CRT.open_osfhandle(int(handle), os.O_RDONLY)
        owned_handle = handle
        handle = INVALID_HANDLE_VALUE
        observed = os.fstat(descriptor)
        if expected is not None and (observed.st_dev, observed.st_ino) != (
            expected.st_dev,
            expected.st_ino,
        ):
            raise OSError(errno.ESTALE, "file identity changed before deletion", str(path))
        disposition = wintypes.DWORD(
            FILE_DISPOSITION_DELETE
            | FILE_DISPOSITION_POSIX_SEMANTICS
            | FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE
        )
        if not _KERNEL32.SetFileInformationByHandle(
            owned_handle,
            FILE_DISPOSITION_INFO_EX_CLASS,
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        ):
            _raise_windows_error()
    finally:
        if descriptor is not None:
            os.close(descriptor)
        elif handle != INVALID_HANDLE_VALUE:
            _KERNEL32.CloseHandle(handle)


@dataclass
class DirectoryHandle:
    """Pinned authorized directory; platform resources are closed as one unit."""

    path: Path
    descriptor: int | None = None
    native_handles: tuple[int, ...] = ()
    closed: bool = False
    owned_parent: DirectoryHandle | None = None

    def fileno(self) -> int:
        if self.closed or self.descriptor is None:
            raise OSError("directory has no POSIX descriptor")
        return self.descriptor

    def __index__(self) -> int:
        return self.fileno()

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        errors: list[Exception] = []
        if self.descriptor is not None:
            try:
                os.close(self.descriptor)
            except OSError as error:
                errors.append(error)
        if _KERNEL32 is not None:
            for handle in reversed(self.native_handles):
                try:
                    if not _KERNEL32.CloseHandle(handle):
                        _raise_windows_error()
                except OSError as error:
                    errors.append(error)
        if self.owned_parent is not None:
            try:
                self.owned_parent.close()
            except Exception as error:
                errors.append(error)
        if errors:
            raise windows.ReleaseError("filesystem close is uncertain") from ExceptionGroup(
                "filesystem close failures", errors
            )

    def sync(self) -> None:
        if self.descriptor is not None:
            os.fsync(self.descriptor)

    def child(self, name: str) -> Path:
        _validate_part(name)
        return self.path / name

    def identity(self) -> tuple[int, int]:
        if self.closed:
            raise OSError("closed directory")
        if self.descriptor is not None:
            identity = os.fstat(self.descriptor)
            return identity.st_dev, identity.st_ino
        return windows.identity(self.native_handles[-1])

    def directory(self, name: str) -> DirectoryHandle:
        target = self.child(name)
        if self.closed:
            raise OSError("closed directory")
        if self.descriptor is not None:
            descriptor = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=self.descriptor)
            return DirectoryHandle(target, descriptor=descriptor)
        handle = windows.open_relative(
            self.native_handles[-1],
            name,
            directory=True,
            private=False,
            access=FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            share=windows.SHARE_READ | windows.SHARE_WRITE,
        )
        return DirectoryHandle(target, native_handles=(handle,))

    def open_regular(self, name: str) -> int:
        if self.closed:
            raise OSError("closed directory")
        descriptor = self.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        try:
            if not is_regular(os.fstat(descriptor)):
                raise OSError(errno.EINVAL, "regular file required")
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def mkdir(self, name: str, mode: int = DIRECTORY_MODE) -> None:
        target = self.child(name)
        if self.descriptor is not None:
            os.mkdir(name, mode, dir_fd=self.descriptor)
            self.sync()
            return
        os.mkdir(filesystem_path(target), mode)

    def rmdir(self, name: str) -> None:
        target = self.child(name)
        if self.descriptor is not None:
            os.rmdir(name, dir_fd=self.descriptor)
            self.sync()
            return
        filesystem_path(target).rmdir()

    def stat(self, name: str) -> os.stat_result:
        target = self.child(name)
        if self.descriptor is not None:
            return os.stat(name, dir_fd=self.descriptor, follow_symlinks=False)
        return filesystem_path(target).stat(follow_symlinks=False)

    def open(self, name: str, flags: int, mode: int = 0o777) -> int:
        target = self.child(name)
        if self.descriptor is not None:
            return os.open(name, flags, mode, dir_fd=self.descriptor)
        del mode
        return _open_windows_file(target, flags)

    def unlink(self, name: str, *, expected: _StatIdentity | None = None) -> None:
        target = self.child(name)
        if self.descriptor is not None:
            if expected is not None:
                observed = self.stat(name)
                if (observed.st_dev, observed.st_ino) != (expected.st_dev, expected.st_ino):
                    raise OSError(
                        errno.ESTALE, "file identity changed before deletion", str(target)
                    )
            os.unlink(name, dir_fd=self.descriptor)
            self.sync()
            return
        _unlink_windows_file(target, expected)

    def open_private(self, name: str, flags: int, *, lock: bool = False) -> int:
        _validate_part(name)
        if self.closed:
            raise OSError("closed private directory")
        if self.descriptor is not None:
            descriptor = os.open(
                name,
                flags | NOFOLLOW | NONBLOCK | getattr(os, "O_CLOEXEC"),
                PRIVATE_FILE_MODE,
                dir_fd=self.descriptor,
            )
            try:
                validate_private_descriptor(descriptor, directory=False)
                return descriptor
            except BaseException:
                os.close(descriptor)
                raise
        if WINDOWS_CRT is None:
            raise OSError("Windows CRT unavailable")
        disposition = (
            windows.CREATE
            if flags & os.O_EXCL
            else windows.OPEN_IF if flags & os.O_CREAT else windows.OPEN
        )
        access = windows.READ | windows.SYNCHRONIZE
        if flags & (os.O_WRONLY | os.O_RDWR):
            access |= windows.WRITE
        if not lock and flags & (os.O_WRONLY | os.O_RDWR):
            access |= windows.DELETE
        handle = windows.open_relative(
            self.native_handles[-1],
            name,
            directory=False,
            disposition=disposition,
            access=access,
            share=windows.SHARE_READ | (windows.SHARE_WRITE if lock else 0),
        )
        try:
            descriptor = WINDOWS_CRT.open_osfhandle(
                handle, (flags & ACCESS_MODE_MASK) | WINDOWS_BINARY_MODE
            )
        except BaseException:
            windows.close(handle)
            raise
        return descriptor

    def rename_directory(
        self, source: str, destination: str, *, destination_directory: DirectoryHandle | None = None
    ) -> None:
        """Move a directory leaf without following links or replacing a destination."""
        _validate_part(source)
        _validate_part(destination)
        if self.closed:
            raise OSError("closed directory")
        target = destination_directory or self
        if self.descriptor is not None:
            child = self.directory(source)
            try:
                if _RENAME_EXCLUSIVE is None or _RENAME_SPEC is None:
                    raise OSError(errno.ENOTSUP, "exclusive directory rename unavailable")
                if (
                    _RENAME_EXCLUSIVE(
                        self.descriptor,
                        os.fsencode(source),
                        target.fileno(),
                        os.fsencode(destination),
                        _RENAME_SPEC[1],
                    )
                    < 0
                ):
                    code = ctypes.get_errno()
                    raise OSError(code, os.strerror(code))
                observed = target.stat(destination)
                if (observed.st_dev, observed.st_ino) != child.identity():
                    raise OSError(errno.ESTALE, "directory changed during rename")
            finally:
                child.close()
            return
        handle = windows.open_relative(
            self.native_handles[-1],
            source,
            directory=True,
            private=False,
            access=windows.DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            share=windows.SHARE_READ | windows.SHARE_WRITE,
        )
        try:
            windows.rename(handle, target.native_handles[-1], destination, False)
        finally:
            windows.close(handle)

    def replace_private(
        self,
        source: str,
        destination: str,
        *,
        exclusive: bool = False,
        destination_directory: DirectoryHandle | None = None,
    ) -> str:
        _validate_part(source)
        _validate_part(destination)
        target = destination_directory or self
        if self.descriptor is not None:
            if exclusive:
                if _RENAME_EXCLUSIVE is None or _RENAME_SPEC is None:
                    raise OSError(errno.ENOTSUP, "exclusive rename unavailable")
                if (
                    _RENAME_EXCLUSIVE(
                        self.descriptor,
                        os.fsencode(source),
                        target.fileno(),
                        os.fsencode(destination),
                        _RENAME_SPEC[1],
                    )
                    < 0
                ):
                    code = ctypes.get_errno()
                    raise OSError(code, os.strerror(code))
            else:
                os.replace(
                    source, destination, src_dir_fd=self.descriptor, dst_dir_fd=target.fileno()
                )
            self.sync()
            if target is not self:
                target.sync()
            return NAMESPACE_SYNCED
        descriptor = self.open_private(source, os.O_RDWR)
        try:
            windows.rename(
                _borrowed_handle(descriptor),
                target.native_handles[-1],
                destination,
                not exclusive,
            )
        finally:
            os.close(descriptor)
        return FILE_FLUSHED

    def remove_private(self, name: str) -> None:
        _validate_part(name)
        descriptor = self.open_private(name, os.O_RDWR)
        try:
            if self.descriptor is not None:
                os.unlink(name, dir_fd=self.descriptor)
                self.sync()
            else:
                windows.remove(_borrowed_handle(descriptor))
        finally:
            os.close(descriptor)

    def names(self, maximum_entries: int) -> tuple[str, ...]:
        if self.closed:
            raise OSError("closed directory")
        if self.descriptor is not None:
            names: list[str] = []
            with os.scandir(self.fileno()) as entries:
                for entry in entries:
                    if len(names) >= maximum_entries:
                        raise OSError(errno.ENOSPC, "private directory entry quota")
                    names.append(entry.name)
        else:
            # Keep the original directory pinned while opening an enumeration
            # handle. Metadata-only handles cannot query directory contents;
            # ReOpenFile cannot add this access on supported Windows runners.
            # Reject reparse points and verify object identity before reading.
            handle = _open_windows_directory(
                self.path, FILE_READ_ATTRIBUTES | _WIN_FILE_LIST_DIRECTORY | SYNCHRONIZE
            )
            try:
                if windows.identity(handle) != windows.identity(self.native_handles[-1]):
                    raise OSError("directory identity changed before enumeration")
                names = list(windows.entries(handle, maximum_entries))
            finally:
                windows.close(handle)
        if len(names) >= maximum_entries:
            raise OSError(errno.ENOSPC, "private directory entry quota")
        return tuple(names)

    def private_usage(self, maximum_entries: int, maximum_bytes: int) -> tuple[int, int]:
        names = self.names(maximum_entries)
        total = 0
        for name in names:
            descriptor = self.open_private(name, os.O_RDONLY)
            try:
                total += os.fstat(descriptor).st_size
            finally:
                os.close(descriptor)
            if total > maximum_bytes:
                raise OSError(errno.ENOSPC, "private directory byte quota")
        return len(names), total

    @contextmanager
    def arbitration(self, name: str):
        descriptor = self.open_private(name, os.O_RDWR | os.O_CREAT, lock=True)
        acquired = False
        try:
            if self.descriptor is not None:
                if _posix_api().flock(descriptor, LOCK_EXCLUSIVE_NONBLOCK) < 0:
                    code = ctypes.get_errno()
                    raise OSError(code, os.strerror(code))
            else:
                windows.lock(_borrowed_handle(descriptor), True)
            acquired = True
            yield
        finally:
            try:
                if acquired:
                    if self.descriptor is not None:
                        if _posix_api().flock(descriptor, LOCK_UNLOCK) < 0:
                            code = ctypes.get_errno()
                            raise OSError(code, os.strerror(code))
                    else:
                        windows.lock(_borrowed_handle(descriptor), False)
            finally:
                os.close(descriptor)


def validate_private_descriptor(descriptor: int, *, directory: bool) -> None:
    identity = os.fstat(descriptor)
    if (stat.S_ISDIR(identity.st_mode) if directory else stat.S_ISREG(identity.st_mode)) is False:
        raise OSError("private entry type rejected")
    if not directory and identity.st_nlink != 1:
        raise OSError("private entry multiple links rejected")
    if identity.st_uid != getattr(os, "getuid")() or stat.S_IMODE(identity.st_mode) != (
        DIRECTORY_MODE if directory else PRIVATE_FILE_MODE
    ):
        raise PermissionError("private owner/mode required")
    if sys.platform == DARWIN:
        security = _posix_api().filesec_init()
        if not security:
            raise OSError(ctypes.get_errno(), "private security allocation failed")
        try:
            metadata = ctypes.create_string_buffer(STAT_BUFFER_BYTES)
            present = ctypes.c_int()
            if (
                _posix_api().fstatx_np(descriptor, metadata, security) < 0
                or _posix_api().filesec_query_property(security, FILESEC_ACL, ctypes.byref(present))
                < 0
            ):
                raise OSError(ctypes.get_errno(), "private security query failed")
            if not present.value:
                return
        finally:
            _posix_api().filesec_free(security)
        acl = _posix_api().acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED)
        if not acl:
            code = ctypes.get_errno()
            raise OSError(code, "private ACL unavailable")
        try:
            entry = ctypes.c_void_p()
            result = _posix_api().acl_get_entry(acl, ACL_FIRST_ENTRY, ctypes.byref(entry))
            if result < 0:
                raise OSError(ctypes.get_errno(), "private ACL unreadable")
            if result != 0:
                raise PermissionError("extended private ACL rejected")
        finally:
            _posix_api().acl_free(acl)


def open_private_child(root: Path, name: str, *, create: bool = False) -> DirectoryHandle:
    """Pin a private leaf beneath an existing, possibly non-private parent.

    The caller supplies the parent's ordinary filesystem qualification. Creation
    does not change existing owner/mode/DACL, follow links, or confer exclusive
    domain admission. All parent pins live until the returned child is closed.
    """
    _validate_part(name)
    access = windows.READ | windows.SYNCHRONIZE
    if create:
        access |= windows.WRITE
    parent = open_directory(root, (), final_access=access)
    child: DirectoryHandle | None = None
    descriptor: int | None = None
    try:
        if parent.descriptor is not None:
            if create:
                try:
                    os.mkdir(name, DIRECTORY_MODE, dir_fd=parent.descriptor)
                except FileExistsError:
                    pass
                else:
                    parent.sync()
            descriptor = os.open(
                name,
                os.O_RDONLY | DIRECTORY | NOFOLLOW | getattr(os, "O_CLOEXEC"),
                dir_fd=parent.descriptor,
            )
            validate_private_descriptor(descriptor, directory=True)
            child = DirectoryHandle(parent.child(name), descriptor=descriptor, owned_parent=parent)
            descriptor = None
        else:
            handle = windows.open_relative(
                parent.native_handles[-1],
                name,
                directory=True,
                private=True,
                disposition=windows.OPEN_IF if create else windows.OPEN,
                access=access | (windows.DELETE_CHILD if create else 0),
                share=windows.SHARE_READ | windows.SHARE_WRITE,
            )
            child = DirectoryHandle(
                parent.child(name), native_handles=(handle,), owned_parent=parent
            )
        return child
    except BaseException as error:
        failures: list[BaseException] = [error]
        if descriptor is not None:
            try:
                os.close(descriptor)
            except BaseException as cleanup_error:
                failures.append(cleanup_error)
        try:
            parent.close()
        except BaseException as cleanup_error:
            failures.append(cleanup_error)
        if len(failures) > 1:
            raise BaseExceptionGroup("private child initialization failed", failures) from None
        raise


def restrict_private_directory(root: Path) -> None:
    """Tighten a qualified product root without rewriting descendants.

    The Windows native setter changes only the pinned root's security descriptor.
    New private entries still receive their own explicit security descriptors.
    """
    if os.name == WINDOWS_PLATFORM:
        directory = open_directory(
            canonical_root(root), (), final_access=windows.SECURITY_ACCESS | windows.SYNCHRONIZE
        )
    else:
        directory = open_directory(canonical_root(root), ())
    try:
        if os.name != WINDOWS_PLATFORM:
            identity = os.fstat(directory.fileno())
            if identity.st_uid != getattr(os, "getuid")():
                raise PermissionError("private owner/mode required")
            if stat.S_IMODE(identity.st_mode) != DIRECTORY_MODE:
                getattr(os, "fchmod")(directory.fileno(), DIRECTORY_MODE)
            validate_private_descriptor(directory.fileno(), directory=True)
        else:
            windows.restrict_private(directory.native_handles[-1])
    finally:
        directory.close()


def open_private_directory(root: Path, parts: tuple[str, ...]) -> DirectoryHandle:
    if os.name != WINDOWS_PLATFORM:
        directory = open_directory(root, ())
        try:
            validate_private_descriptor(directory.fileno(), directory=True)
            for name in parts:
                _validate_part(name)
                try:
                    directory.mkdir(name)
                except FileExistsError:
                    pass
                descriptor = os.open(
                    name,
                    os.O_RDONLY | DIRECTORY | NOFOLLOW | getattr(os, "O_CLOEXEC"),
                    dir_fd=directory.fileno(),
                )
                try:
                    validate_private_descriptor(descriptor, directory=True)
                except BaseException:
                    os.close(descriptor)
                    raise
                previous = directory
                directory = DirectoryHandle(previous.path / name, descriptor=descriptor)
                previous.close()
            return directory
        except BaseException:
            directory.close()
            raise
    if not root.is_absolute():
        raise ValueError(DIRECTORY_PATH_INVALID)
    handles: list[int] = []
    path = Path(root.anchor)
    try:
        handles.append(_open_windows_directory(path))
        for name in root.parts[1:]:
            _validate_part(name)
            handles.append(
                windows.open_relative(
                    handles[-1],
                    name,
                    directory=True,
                    private=False,
                    access=windows.READ | windows.SYNCHRONIZE,
                    share=windows.SHARE_READ | windows.SHARE_WRITE,
                )
            )
            path /= name
        for name in parts:
            _validate_part(name)
            handles.append(
                windows.open_relative(
                    handles[-1],
                    name,
                    directory=True,
                    disposition=windows.OPEN_IF,
                    access=windows.READ
                    | windows.WRITE
                    | windows.DELETE_CHILD
                    | windows.SYNCHRONIZE,
                    share=windows.SHARE_READ | windows.SHARE_WRITE,
                )
            )
            path /= name
        return DirectoryHandle(path=path, native_handles=tuple(handles))
    except BaseException:
        errors: list[BaseException] = []
        for handle in reversed(handles):
            try:
                windows.close(handle)
            except BaseException as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup("private directory cleanup failures", errors)
        raise


class FilePublicationConflict(ValueError):
    def __init__(self) -> None:
        super().__init__(FILE_PUBLICATION_CONFLICT)


def _published_bytes(directory: DirectoryHandle, name: str, limit: int) -> bytes:
    descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise FilePublicationConflict()
        payload = handle.read(limit + 1)
    if len(payload) > limit:
        raise FilePublicationConflict()
    return payload


def publish_exact_bytes(root: Path, parts: tuple[str, ...], payload: bytes, mode: int) -> bool:
    """Create one exact file, reuse identical bytes, and never replace a destination."""
    if not parts:
        raise ValueError(DIRECTORY_PATH_INVALID)
    for part in parts:
        _validate_part(part)
    directory = open_directory(canonical_root(root), parts[:-1], create=True)
    descriptor = None
    created = False
    try:
        try:
            descriptor = directory.open(
                parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, mode
            )
            created = True
        except FileExistsError:
            if _published_bytes(directory, parts[-1], len(payload)) != payload:
                raise FilePublicationConflict()
            return True
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        directory.sync()
        return False
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        if created:
            try:
                directory.unlink(parts[-1])
            except FileNotFoundError:
                pass
        raise
    finally:
        directory.close()


def path_for_file(descriptor: int) -> Path:
    """Resolve an already-open Windows file handle for named-stream operations."""
    if _KERNEL32 is None:
        return Path(f"/dev/fd/{descriptor}").resolve()
    if WINDOWS_CRT is None:
        raise OSError("Windows C runtime unavailable")
    handle = WINDOWS_CRT.get_osfhandle(descriptor)
    buffer = ctypes.create_unicode_buffer(WINDOWS_PATH_BUFFER)
    length = _KERNEL32.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
    if not length or length >= len(buffer):
        _raise_windows_error()
    value = buffer.value
    return Path(value.removeprefix(WINDOWS_PATH_PREFIX))


def preserve_mode(descriptor: int, mode: int) -> None:
    """Preserve POSIX mode bits while retaining ordinary-file semantics on Windows.

    Windows CRT descriptors do not support ``fchmod`` and their ``st_mode`` bits do
    not round-trip POSIX permissions.  Access control remains owned by Windows ACLs;
    staged product files stay ordinary writable files until their atomic publication.
    """
    if os.name != WINDOWS_PLATFORM:
        getattr(os, "fchmod")(descriptor, mode)


def set_marker(descriptor: int, marker: str) -> None:
    if os.name != WINDOWS_PLATFORM:
        setter = getattr(os, "setxattr", None)
        create = getattr(os, "XATTR_CREATE", None)
        if not callable(setter) or create is None:
            raise OSError(errno.ENOTSUP, "creation marker unsupported")
        setter(  # pylint: disable=not-callable
            descriptor, CREATION_ATTRIBUTE, marker.encode("ascii"), flags=create
        )
        return
    stream = Path(f"{path_for_file(descriptor)}{WINDOWS_NAMED_STREAM}")
    with filesystem_path(stream).open("xb") as handle:
        handle.write(marker.encode("ascii"))
        handle.flush()
        os.fsync(handle.fileno())


def marker(descriptor: int) -> str:
    if os.name != WINDOWS_PLATFORM:
        getter = getattr(os, "getxattr", None)
        if not callable(getter):
            raise OSError(errno.ENOTSUP, "creation marker unsupported")
        raw = b""
        for attribute in CREATION_ATTRIBUTES:
            try:
                raw = getter(descriptor, attribute)  # pylint: disable=not-callable
                break
            except OSError as error:
                if error.errno not in (getattr(errno, "ENOATTR", None), errno.ENODATA):
                    raise
    else:
        raw = b""
        for stream in WINDOWS_NAMED_STREAMS:
            try:
                raw = filesystem_path(Path(f"{path_for_file(descriptor)}{stream}")).read_bytes()
                break
            except FileNotFoundError:
                continue
    if not isinstance(raw, bytes):
        raise OSError(errno.EIO, "invalid creation marker bytes")
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError:
        return ""


def remove_tree(
    root: Path, parts: tuple[str, ...], *, expected: tuple[int, int] | None = None
) -> None:
    """Remove an exact owned subtree without traversing links or reparse points."""
    if not parts:
        raise ValueError(DIRECTORY_PATH_INVALID)
    for part in parts:
        _validate_part(part)
    try:
        parent = open_directory(root, parts[:-1])
    except FileNotFoundError:
        return
    try:
        _remove_tree_child(parent, parts[-1], expected=expected)
    finally:
        parent.close()


def _remove_tree_child(
    parent: DirectoryHandle, name: str, *, expected: tuple[int, int] | None = None
) -> None:
    try:
        identity = parent.stat(name)
    except FileNotFoundError:
        return
    if expected is not None and (identity.st_dev, identity.st_ino) != expected:
        raise OSError(errno.ESTALE, "owned subtree identity changed before removal")
    if not stat.S_ISDIR(identity.st_mode):
        parent.unlink(name, expected=identity)
        return
    if parent.descriptor is None:
        handle = windows.open_relative(
            parent.native_handles[-1],
            name,
            directory=True,
            private=False,
            access=windows.DELETE | FILE_READ_ATTRIBUTES | _WIN_FILE_LIST_DIRECTORY | SYNCHRONIZE,
            share=windows.SHARE_READ | windows.SHARE_WRITE,
        )
        child = DirectoryHandle(parent.child(name), native_handles=(handle,))
    else:
        child = parent.directory(name)
    try:
        if child.identity() != (identity.st_dev, identity.st_ino):
            raise OSError(errno.ESTALE, "directory identity changed before deletion")
        if parent.descriptor is None:
            entries = windows.entries(child.native_handles[-1], TREE_ENTRY_LIMIT)
            if len(entries) >= TREE_ENTRY_LIMIT:
                raise OSError(errno.ENOSPC, "private directory entry quota")
        else:
            entries = child.names(TREE_ENTRY_LIMIT)
        for entry in entries:
            _remove_tree_child(child, entry)
        if parent.descriptor is None:
            windows.remove(child.native_handles[-1])
        else:
            observed = parent.stat(name)
            if (observed.st_dev, observed.st_ino) != child.identity():
                raise OSError(errno.ESTALE, "directory identity changed before deletion")
            parent.rmdir(name)
    finally:
        child.close()


def open_directory(
    root: Path,
    parts: tuple[str, ...],
    *,
    create: bool = False,
    final_access: int = FILE_READ_ATTRIBUTES | SYNCHRONIZE,
) -> DirectoryHandle:
    """Open every ancestor without following a symlink or Windows reparse point."""
    if not root.is_absolute():
        raise ValueError(DIRECTORY_PATH_INVALID)
    steps = tuple((part, False) for part in root.parts[1:]) + tuple(
        (part, create) for part in parts
    )
    if os.name != WINDOWS_PLATFORM:
        descriptor = os.open(root.anchor, os.O_RDONLY | DIRECTORY | NOFOLLOW)
        path = Path(root.anchor)
        try:
            for part, may_create in steps:
                _validate_part(part)
                if may_create:
                    try:
                        os.mkdir(part, DIRECTORY_MODE, dir_fd=descriptor)
                        os.fsync(descriptor)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
                path /= part
            return DirectoryHandle(path=path, descriptor=descriptor)
        except BaseException:
            os.close(descriptor)
            raise

    handles: list[int] = []
    path = Path(root.anchor)
    try:
        handles.append(
            _open_windows_directory(path, final_access if not steps else FILE_READ_ATTRIBUTES)
        )
        for index, (part, may_create) in enumerate(steps):
            _validate_part(part)
            path /= part
            if may_create:
                try:
                    os.mkdir(path, DIRECTORY_MODE)
                except FileExistsError:
                    pass
            access = final_access if index == len(steps) - 1 else FILE_READ_ATTRIBUTES
            handles.append(_open_windows_directory(path, access))
        return DirectoryHandle(path=path, native_handles=tuple(handles))
    except BaseException:
        if _KERNEL32 is not None:
            for handle in reversed(handles):
                windows.close(handle)
        raise


def protect_windows_path(path: Path, descriptor: int | None = None) -> None:
    """Protect the actual open file, or pin a no-follow path before setting its ACL."""
    if WINDOWS_CRT is None:
        raise OSError("Windows filesystem backend unavailable")
    if descriptor is not None:
        windows.protect_open_file(WINDOWS_CRT.get_osfhandle(descriptor))
        return
    source = filesystem_path(path.absolute())
    if source.is_dir():
        directory = open_directory(source, (), final_access=windows.SECURITY_ACCESS)
        try:
            windows.protect_private(directory.native_handles[-1])
        finally:
            directory.close()
        return
    parent, name = open_parent(source)
    try:
        handle = windows.open_relative(
            parent.native_handles[-1],
            name,
            directory=False,
            private=False,
            access=windows.SECURITY_ACCESS | windows.SYNCHRONIZE,
            share=windows.SHARE_READ | windows.SHARE_WRITE,
        )
        try:
            windows.protect_private(handle)
        finally:
            windows.close(handle)
    finally:
        parent.close()


def is_regular(identity: os.stat_result) -> bool:
    return stat.S_ISREG(identity.st_mode)


__all__ = [
    "DIRECTORY",
    "NOFOLLOW",
    "NONBLOCK",
    "DirectoryHandle",
    "DirectoryRole",
    "account_directory",
    "canonical_root",
    "filesystem_path",
    "grant_current_user_directory_access",
    "marker",
    "open_directory",
    "protect_windows_path",
    "open_parent",
    "path_for_file",
    "preserve_mode",
    "prepare_private_directory",
    "restrict_private_directory",
    "set_marker",
    "stable_read_matches",
]


# Strict admission capabilities are separate from the content IO helpers above.
# Raw descriptors have no finalizer: losing a Python owner cannot release a
# qualification while its application's threads or descendants may still write.
class LeaseError(OSError):
    def __init__(self, code: str, system: int = 0) -> None:
        super().__init__(system, code)
        self.code = code
        if os.name == WINDOWS_PLATFORM and system == 5:
            security.record_denial(self, "native_directory", "binding", "os_access_denied")


class _WinGuid(ctypes.Structure):
    _fields_ = [
        ("first", ctypes.c_uint32),
        ("second", ctypes.c_uint16),
        ("third", ctypes.c_uint16),
        ("tail", ctypes.c_ubyte * 8),
    ]


_WIN_PROFILE_FOLDER = UUID("5e6c858f-0e22-4760-9afe-ea3317b67173")


def account_directory() -> str:
    """Query the OS account record, ignoring product and home environment overrides.

    This only selects a pathname; callers still have to pin and qualify it.
    No fallback, directory creation, permission repair or user-data IO occurs.
    """
    if sys.platform == "win32" and _WIN_DLL is not None:
        shell = _WIN_DLL("shell32", use_last_error=True)
        ole = _WIN_DLL("ole32", use_last_error=True)
        shell.SHGetKnownFolderPath.argtypes = [
            ctypes.POINTER(_WinGuid),
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        shell.SHGetKnownFolderPath.restype = ctypes.c_int32
        ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole.CoTaskMemFree.restype = None
        identifier = _WinGuid.from_buffer_copy(_WIN_PROFILE_FOLDER.bytes_le)
        pointer = ctypes.c_void_p()
        try:
            result = shell.SHGetKnownFolderPath(
                ctypes.byref(identifier), 0, None, ctypes.byref(pointer)
            )
            if result < 0 or not pointer.value:
                raise LeaseError("ERR_LEASE_ACCOUNT", result)
            value = ctypes.wstring_at(pointer)
        finally:
            # The API can allocate even when it reports failure.
            ole.CoTaskMemFree(pointer)
    elif sys.platform in {"darwin", "linux"} and pwd is not None:
        try:
            value = pwd.getpwuid(getattr(os, "geteuid")()).pw_dir
        except (KeyError, OSError) as error:
            raise LeaseError("ERR_LEASE_ACCOUNT", getattr(error, "errno", 0) or 0) from error
    else:
        raise LeaseError("ERR_LEASE_UNSUPPORTED")
    if not value or "\0" in value or not os.path.isabs(value):
        raise LeaseError("ERR_LEASE_ACCOUNT")
    return value


class _DarwinStat(ctypes.Structure):
    _fields_ = [
        ("st_dev", ctypes.c_int32),
        ("st_mode", ctypes.c_uint16),
        ("st_nlink", ctypes.c_uint16),
        ("st_ino", ctypes.c_uint64),
        ("st_uid", ctypes.c_uint32),
        ("st_gid", ctypes.c_uint32),
        ("st_rdev", ctypes.c_int32),
        ("atime", ctypes.c_int64 * 2),
        ("mtime", ctypes.c_int64 * 2),
        ("ctime", ctypes.c_int64 * 2),
        ("birthtime", ctypes.c_int64 * 2),
        ("st_size", ctypes.c_int64),
        ("blocks", ctypes.c_int64),
        ("blksize", ctypes.c_int32),
        ("flags", ctypes.c_uint32),
        ("gen", ctypes.c_uint32),
        ("lspare", ctypes.c_int32),
        ("qspare", ctypes.c_int64 * 2),
    ]


class _DarwinMount(ctypes.Structure):
    _fields_ = [
        ("bsize", ctypes.c_uint32),
        ("iosize", ctypes.c_int32),
        ("blocks", ctypes.c_uint64),
        ("bfree", ctypes.c_uint64),
        ("bavail", ctypes.c_uint64),
        ("files", ctypes.c_uint64),
        ("ffree", ctypes.c_uint64),
        ("fsid", ctypes.c_int32 * 2),
        ("owner", ctypes.c_uint32),
        ("type", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("subtype", ctypes.c_uint32),
        ("fstypename", ctypes.c_char * 16),
        ("mntonname", ctypes.c_char * 1024),
        ("mntfromname", ctypes.c_char * 1024),
        ("flags_ext", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32 * 7),
    ]


_DARWIN_MNT_LOCAL = 0x1000
_DARWIN_FILESEC_ACL = 5
_DARWIN_ACL_ALLOW = 1
_DARWIN_ACL_DENY = 2
_DARWIN_ACL_FIRST = 0
_DARWIN_ACL_NEXT = -1
_DARWIN_ACL_INHERIT_ONLY = 1 << 8
_DARWIN_ACL_WRITES = tuple(1 << bit for bit in (2, 4, 5, 6, 8, 10, 12, 13))
_DARWIN_GETPATH = 50
_DARWIN_GETPATH_NOFIRMLINK = 102
_LEASE_PATH_BYTES = 4096
_LEASE_DEPTH = 256
_LEASE_METADATA_LIMIT = 1024 * 1024
_LEASE_SNAPSHOT_LIMIT = 256 * 1024 * 1024
_LEASE_RECORD_LIMIT = 4096
_LEASE_NAME_BYTES = 128
_LEASE_LEAF = re.compile(r"[a-z0-9_-](?:[a-z0-9._-]{0,126}[a-z0-9_-])?")


_NANOSECONDS = 1_000_000_000


@dataclass(frozen=True)
class _PosixMetadata:
    st_dev: int
    st_ino: int
    st_mode: int
    st_nlink: int
    st_uid: int
    st_gid: int
    st_size: int
    st_mtime_ns: int
    st_ctime_ns: int


class _PosixSecurity(Protocol):
    def validate(
        self, descriptor: int, ancestor: bool, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> _PosixMetadata: ...


def _darwin_directory_mode_trusted(owner: int, group: int, mode: int, ancestor: bool) -> bool:
    """Allow root:admin Data-volume ancestors, never group-writable data leaves."""
    if owner not in {0, getattr(os, "geteuid")()}:
        return False
    if not mode & (stat.S_IWGRP | stat.S_IWOTH):
        return True
    if ancestor and mode & stat.S_ISVTX:
        return True
    return ancestor and owner == 0 and group == 80 and not mode & stat.S_IWOTH


class _DarwinSecurity:
    """Darwin 64-bit stat/filesec ABI; permission checks never repair ACLs."""

    lib: ctypes.CDLL
    stat: Callable[..., int]
    mount: Callable[..., int]

    def __init__(self) -> None:
        if sys.platform != "darwin" or platform.machine() not in {"arm64", "x86_64"}:
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        self.lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        suffix = "" if platform.machine() == "arm64" else "$INODE64"
        pointer = ctypes.c_void_p
        out_pointer = ctypes.POINTER(pointer)
        integer = ctypes.c_int
        # Match the SDK's __DARWIN_INODE64 symbol selection, not symbol fallback.
        stat_function = getattr(self.lib, "fstatx_np" + suffix)
        stat_function.argtypes = [integer, ctypes.POINTER(_DarwinStat), pointer]
        stat_function.restype = integer
        self.stat = stat_function
        mount_function = getattr(self.lib, "fstatfs" + suffix)
        mount_function.argtypes = [integer, ctypes.POINTER(_DarwinMount)]
        mount_function.restype = integer
        self.mount = mount_function
        declarations = {
            "filesec_init": ([], pointer),
            "filesec_free": ([pointer], None),
            "filesec_query_property": ([pointer, integer, ctypes.POINTER(integer)], integer),
            "filesec_get_property": ([pointer, integer, pointer], integer),
            "acl_free": ([pointer], integer),
            "acl_get_entry": ([pointer, integer, out_pointer], integer),
            "acl_get_tag_type": ([pointer, ctypes.POINTER(integer)], integer),
            "acl_get_permset": ([pointer, out_pointer], integer),
            "acl_get_flagset_np": ([pointer, out_pointer], integer),
            "acl_get_flag_np": ([pointer, integer], integer),
            "acl_get_qualifier": ([pointer], pointer),
            "acl_get_perm_np": ([pointer, integer], integer),
            "mbr_uid_to_uuid": ([ctypes.c_uint32, pointer], integer),
        }
        for name, (arguments, result) in declarations.items():
            function = getattr(self.lib, name)
            function.argtypes = arguments
            function.restype = result

    @staticmethod
    def _check(result: int) -> None:
        if result:
            raise LeaseError("ERR_LEASE_NATIVE", ctypes.get_errno())

    def _acl(self, acl: ctypes.c_void_p) -> None:
        current, root = ctypes.create_string_buffer(16), ctypes.create_string_buffer(16)
        if self.lib.mbr_uid_to_uuid(getattr(os, "geteuid")(), current) or self.lib.mbr_uid_to_uuid(
            0, root
        ):
            raise LeaseError("ERR_LEASE_PERMISSION")
        entry = ctypes.c_void_p()
        selector = _DARWIN_ACL_FIRST
        while True:
            ctypes.set_errno(0)
            result = self.lib.acl_get_entry(acl, selector, ctypes.byref(entry))
            if result == -1 and ctypes.get_errno() == errno.EINVAL:
                return
            if result != 0:
                raise LeaseError("ERR_LEASE_PERMISSION")
            selector = _DARWIN_ACL_NEXT
            tag, permissions, flags = ctypes.c_int(), ctypes.c_void_p(), ctypes.c_void_p()
            self._check(self.lib.acl_get_tag_type(entry, ctypes.byref(tag)))
            self._check(self.lib.acl_get_permset(entry, ctypes.byref(permissions)))
            self._check(self.lib.acl_get_flagset_np(entry, ctypes.byref(flags)))
            if tag.value not in {_DARWIN_ACL_ALLOW, _DARWIN_ACL_DENY}:
                raise LeaseError("ERR_LEASE_PERMISSION")
            inherit_only = self.lib.acl_get_flag_np(flags, _DARWIN_ACL_INHERIT_ONLY)
            if inherit_only < 0:
                raise LeaseError("ERR_LEASE_PERMISSION")
            if tag.value == _DARWIN_ACL_ALLOW and not inherit_only:
                principal = self.lib.acl_get_qualifier(entry)
                if not principal:
                    raise LeaseError("ERR_LEASE_PERMISSION")
                try:
                    trusted = ctypes.string_at(principal, 16) in {current.raw, root.raw}
                finally:
                    self.lib.acl_free(principal)
                if not trusted and any(
                    self.lib.acl_get_perm_np(permissions, write) != 0
                    for write in _DARWIN_ACL_WRITES
                ):
                    raise LeaseError("ERR_LEASE_PERMISSION")

    def validate(
        self, descriptor: int, ancestor: bool, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> _PosixMetadata:
        volume = _DarwinMount()
        self._check(self.mount(descriptor, ctypes.byref(volume)))
        if not volume.flags & _DARWIN_MNT_LOCAL:
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        security = self.lib.filesec_init()
        if not security:
            raise LeaseError("ERR_LEASE_ALLOCATION")
        info, acl, present = _DarwinStat(), ctypes.c_void_p(), ctypes.c_int()
        try:
            self._check(self.stat(descriptor, ctypes.byref(info), security))
            self._check(
                self.lib.filesec_query_property(
                    security, _DARWIN_FILESEC_ACL, ctypes.byref(present)
                )
            )
            if present.value:
                self._check(
                    self.lib.filesec_get_property(security, _DARWIN_FILESEC_ACL, ctypes.byref(acl))
                )
        finally:
            self.lib.filesec_free(security)
        try:
            if role is DirectoryRole.PRIVATE and not _darwin_directory_mode_trusted(
                info.st_uid, info.st_gid, info.st_mode, ancestor
            ):
                raise LeaseError("ERR_LEASE_PERMISSION")
            if present.value and role is DirectoryRole.PRIVATE:
                if not acl:
                    raise LeaseError("ERR_LEASE_PERMISSION")
                self._acl(acl)
            return _PosixMetadata(
                info.st_dev,
                info.st_ino,
                info.st_mode,
                info.st_nlink,
                info.st_uid,
                info.st_gid,
                info.st_size,
                info.mtime[0] * _NANOSECONDS + info.mtime[1],
                info.ctime[0] * _NANOSECONDS + info.ctime[1],
            )
        finally:
            if acl:
                self.lib.acl_free(acl)


@dataclass(eq=False)
class _LeasePin:
    descriptors: list[int]
    lineage: tuple[str, ...]
    leaf: int
    children: int = 0
    role: DirectoryRole = DirectoryRole.PRIVATE


@dataclass(eq=False)
class _InstallationPin(_LeasePin):
    binding: InstallationBinding | None = None


@dataclass(eq=False)
class _LeaseLock:
    descriptor: int
    parent: _LeasePin


def _lease_identity(info: _PosixMetadata) -> str:
    return f"posix:{info.st_dev & ((1 << 64) - 1):016x}:{info.st_ino:016x}"


def _lease_close(descriptors: list[int]) -> None:
    while descriptors:
        descriptor = descriptors.pop()
        try:
            os.close(descriptor)
        except BaseException as error:
            # Never retry a close or relinquish any later qualification.
            raise LeaseError("ERR_LEASE_RELEASE", getattr(error, "errno", 0) or 0) from error


_RECLAMATION_IDENTITY = re.compile(
    r"(?:posix-[a-f0-9]{16}-[a-f0-9]{16}|windows-[a-f0-9]{16}-[a-f0-9]{32})"
)
_RECLAMATION_GUARD = "-admission-a"
_RECLAMATION_SIBLINGS = ("-admission-b", "-occupancy-a", "-occupancy-b")
_RECLAMATION_UNSAFE = frozenset(
    {
        "ERR_LEASE_FILE",
        "ERR_LEASE_DIRECTORY",
        "ERR_LEASE_PERMISSION",
        "ERR_LEASE_CHANGED",
        "ERR_LEASE_SIZE",
    }
)
_WIN_RECLAMATION_ACCESS_DENIED = 5
_WIN_SHARING_VIOLATION = 32
_WIN_DELETE_PENDING = 303
_WIN_FILE_DISPOSITION_INFO = 4


class _LeaseOwner:
    """Shared process ownership and fail-closed lifecycle for native handles."""

    def __init__(self, close: Callable[[list[int]], None]) -> None:
        self._close = close
        self._pid = os.getpid()
        self._handles: set[_LeasePin | _LeaseLock] = set()
        self._mutex = threading.RLock()
        self._active = threading.Lock()
        self._uncertain = False

    @contextmanager
    def _operation(self) -> Iterator[None]:
        # Reject inherited capabilities before touching a possibly orphaned lock.
        if self._pid != os.getpid():
            raise LeaseError("ERR_LEASE_OWNER")
        with self._mutex:
            if self._uncertain:
                raise LeaseError("ERR_LEASE_RELEASE")
            if not self._active.acquire(blocking=False):
                raise LeaseError("ERR_LEASE_REENTRANT")
            try:
                yield
            except LeaseError as error:
                if error.code == "ERR_LEASE_RELEASE":
                    self._uncertain = True
                raise
            except OSError as error:
                raise LeaseError("ERR_LEASE_NATIVE", error.errno or 0) from error
            finally:
                self._active.release()

    def _pin(self, handle: object) -> _LeasePin:
        if not isinstance(handle, _LeasePin) or handle not in self._handles:
            raise LeaseError("ERR_LEASE_HANDLE")
        return handle

    def _cleanup(self, handles: list[int], cause: BaseException) -> NoReturn:
        # A metadata helper may itself have encountered an uncertain close.
        # Do not release the surrounding file or directory pins in that case.
        if getattr(cause, "code", None) != "ERR_LEASE_RELEASE":
            self._close(handles)
        raise cause

    @contextmanager
    def _temporary(self, handles: list[int]) -> Iterator[None]:
        try:
            yield
        except BaseException as error:
            self._cleanup(handles, error)
        else:
            self._close(handles)

    def lineage(self, pin: object) -> tuple[str, ...]:
        with self._operation():
            return self._pin(pin).lineage

    @staticmethod
    def _name(name: str) -> None:
        if not isinstance(name, str) or not _LEASE_LEAF.fullmatch(name):
            raise LeaseError("ERR_LEASE_ARGUMENT")

    def reclaim_at(self, pin: object, encoded_identity: str) -> dict[str, int]:
        """Reclaim idle siblings while retaining their permanent admission anchor.

        All legacy domain entrants open/hold admission-a before these siblings.
        Open existing files only; uncertain close retains the remaining guards.
        """
        with self._operation():
            parent = self._pin(pin)
            if (
                parent.role is not DirectoryRole.PRIVATE
                or not isinstance(encoded_identity, str)
                or not _RECLAMATION_IDENTITY.fullmatch(encoded_identity)
            ):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            handles: list[int] = []
            removed = 0
            try:
                # Avoid briefly blocking admission of a known live writer.
                probe = self._reclaim_open(parent, encoded_identity + "-occupancy-a", False)
                if probe is not None:
                    self._close([probe])
                guard = self._reclaim_open(parent, encoded_identity + _RECLAMATION_GUARD, False)
                if guard is None:
                    return {"removed": 0, "busy": 0, "retained": 1}
                handles.append(guard)
                siblings: list[tuple[str, int]] = []
                for suffix in _RECLAMATION_SIBLINGS:
                    name = encoded_identity + suffix
                    descriptor = self._reclaim_open(parent, name, True)
                    if descriptor is not None:
                        handles.append(descriptor)
                        siblings.append((name, descriptor))
                self._reclaim_validate(parent, encoded_identity + _RECLAMATION_GUARD, guard)
                # Validate the entire group before the first destructive action.
                for name, descriptor in siblings:
                    self._reclaim_validate(parent, name, descriptor)
                for name, descriptor in siblings:
                    self._reclaim_remove(parent, name, descriptor)
                    removed += 1
            except BaseException as error:
                if getattr(error, "code", None) == "ERR_LEASE_RELEASE":
                    raise
                self._close(handles)
                if getattr(error, "code", None) == "ERR_LEASE_BUSY":
                    return {"removed": removed, "busy": 1, "retained": 0}
                if getattr(error, "code", None) in _RECLAMATION_UNSAFE:
                    return {"removed": removed, "busy": 0, "retained": 1}
                raise
            self._close(handles)
            return {"removed": removed, "busy": 0, "retained": 0}

    def _reclaim_open(self, parent: _LeasePin, name: str, deleting: bool) -> int | None:
        raise NotImplementedError

    def _reclaim_validate(self, parent: _LeasePin, name: str, descriptor: int) -> None:
        raise NotImplementedError

    def _reclaim_remove(self, parent: _LeasePin, name: str, descriptor: int) -> None:
        raise NotImplementedError

    def list_records(self, pin: object, max_entries: int, max_bytes: int) -> dict[str, bytes]:
        """Read bounded records under the caller's namespace qualification.

        All namespace writers must share that guard: this is not an OS snapshot.
        max_bytes bounds each record and the entire returned payload together.
        No partial inventory is returned on an invalid, missing or oversized entry.
        """
        with self._operation():
            parent = self._pin(pin)
            if (
                (not isinstance(max_entries, int) or isinstance(max_entries, bool))
                or not 0 < max_entries <= _LEASE_RECORD_LIMIT
                or (not isinstance(max_bytes, int) or isinstance(max_bytes, bool))
                or not 0 < max_bytes <= _LEASE_METADATA_LIMIT
            ):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            names = self._record_names(parent, max_entries)
            records: dict[str, bytes] = {}
            total = 0
            for name in names:
                value = self._read_at(pin, name, max_bytes)
                if value is None:
                    raise LeaseError("ERR_LEASE_CHANGED")
                total += len(value)
                if total > max_bytes:
                    raise LeaseError("ERR_LEASE_SIZE")
                records[name] = value
            return records

    def _record_names(
        self, parent: _LeasePin, max_entries: int, *, records: bool = True
    ) -> list[str]:
        raise NotImplementedError

    def _read_at(self, pin: object, name: str, max_bytes: int) -> bytes | None:
        raise NotImplementedError

    @staticmethod
    def _entry_name(name: str) -> None:
        if (
            not isinstance(name, str)
            or name in {"", ".", ".."}
            or "/" in name
            or "\0" in name
            or len(os.fsencode(name)) >= _LEASE_PATH_BYTES
            or (os.name == "nt" and ("\\" in name or ":" in name or name.endswith((".", " "))))
        ):
            raise LeaseError("ERR_LEASE_ARGUMENT")

    def _record_name(
        self, names: list[str], name: str, max_entries: int, *, records: bool = True
    ) -> None:
        self._name(name) if records else self._entry_name(name)
        if name in names:
            raise LeaseError("ERR_LEASE_CHANGED")
        if len(names) >= max_entries:
            raise LeaseError("ERR_LEASE_SIZE")
        names.append(name)

    def release(self, handle: object) -> None:
        with self._operation():
            if not isinstance(handle, (_LeasePin, _LeaseLock)) or handle not in self._handles:
                raise LeaseError("ERR_LEASE_HANDLE")
            if isinstance(handle, _LeasePin) and handle.children:
                raise LeaseError("ERR_LEASE_IN_USE")
            # Consume once, including on an uncertain close; retain all others.
            self._handles.remove(handle)
            if isinstance(handle, _LeasePin):
                self._close(handle.descriptors)
            else:
                self._close([handle.descriptor])
                handle.parent.children -= 1


class _PosixDirectoryNative(_LeaseOwner):
    """Shared no-follow POSIX operations; platform policy supplies metadata."""

    def __init__(self, security: _PosixSecurity) -> None:
        if fcntl is None:
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        self._fcntl = fcntl
        self._security = security
        super().__init__(_lease_close)

    def _walk(
        self,
        path: str,
        create: bool,
        descriptors: list[int],
        role: DirectoryRole = DirectoryRole.PRIVATE,
    ) -> tuple[list[str], int]:
        if (
            not isinstance(path, str)
            or not path.startswith("/")
            or "\0" in path
            or len(os.fsencode(path)) >= _LEASE_PATH_BYTES
        ):
            raise LeaseError("ERR_LEASE_ARGUMENT")
        parts = [] if path == "/" else path[1:].split("/")
        if len(parts) >= _LEASE_DEPTH or any(part in {"", ".", ".."} for part in parts):
            raise LeaseError("ERR_LEASE_ARGUMENT")
        flags = (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY")
            | getattr(os, "O_NOFOLLOW")
            | getattr(os, "O_CLOEXEC")
        )
        descriptor = os.open("/", flags)
        descriptors.append(descriptor)

        def validate(descriptor: int, checked_path: str, ancestor: bool) -> _PosixMetadata:
            try:
                return self._security.validate(descriptor, ancestor, role)
            except LeaseError as error:
                if error.code == "ERR_LEASE_PERMISSION":
                    metadata = os.fstat(descriptor)
                    error.add_note(
                        f"directory={checked_path!r} uid={metadata.st_uid} "
                        f"gid={metadata.st_gid} mode={stat.S_IMODE(metadata.st_mode):#06o} "
                        f"ancestor={ancestor} euid={getattr(os, "geteuid")()}"
                    )
                raise

        lineage = [_lease_identity(validate(descriptor, "/", bool(parts)))]
        for index, part in enumerate(parts):
            final = index == len(parts) - 1
            if final and create:
                try:
                    os.mkdir(part, DIRECTORY_MODE, dir_fd=descriptor)
                except FileExistsError:
                    pass
            try:
                descriptor = os.open(part, flags, dir_fd=descriptor)
            except OSError as error:
                code = "ERR_LEASE_MISSING" if error.errno == errno.ENOENT else "ERR_LEASE_DIRECTORY"
                raise LeaseError(code, error.errno or 0) from error
            descriptors.append(descriptor)
            lineage.append(
                _lease_identity(validate(descriptor, "/" + "/".join(parts[: index + 1]), not final))
            )
        return lineage, descriptor

    def entry_kind(self, pin: object, name: str) -> str | None:
        with self._operation():
            parent = self._pin(pin)
            self._entry_name(name)
            try:
                descriptor = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_NOFOLLOW")
                    | getattr(os, "O_NONBLOCK")
                    | getattr(os, "O_CLOEXEC"),
                    dir_fd=parent.leaf,
                )
            except FileNotFoundError:
                return None
            with self._temporary([descriptor]):
                info = self._security.validate(descriptor, False, parent.role)
                if stat.S_ISDIR(info.st_mode):
                    return "directory"
                if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    return "file"
                raise LeaseError("ERR_LEASE_FILE")

    def directory_entries(self, pin: object, max_entries: int) -> tuple[tuple[str, bool], ...]:
        with self._operation():
            if (
                not isinstance(max_entries, int) or isinstance(max_entries, bool)
            ) or not 0 < max_entries <= _LEASE_RECORD_LIMIT:
                raise LeaseError("ERR_LEASE_ARGUMENT")
            parent = self._pin(pin)
            before = self._security.validate(parent.leaf, False, parent.role)
            names = self._record_names(parent, max_entries, records=False)
            entries = []
            for name in names:
                descriptor = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_NOFOLLOW")
                    | getattr(os, "O_NONBLOCK")
                    | getattr(os, "O_CLOEXEC"),
                    dir_fd=parent.leaf,
                )
                with self._temporary([descriptor]):
                    info = self._security.validate(descriptor, False, parent.role)
                    directory = stat.S_ISDIR(info.st_mode)
                    if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
                        raise LeaseError("ERR_LEASE_FILE")
                    entries.append((name, directory))
            after = self._security.validate(parent.leaf, False, parent.role)
            if (
                before != after
                or _lease_identity(after) != parent.lineage[-1]
                or sorted(names) != sorted(self._record_names(parent, max_entries, records=False))
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            return tuple(sorted(entries))

    def directory_metadata(self, pin: object) -> dict[str, int | str | None]:
        """Observe the selected directory through its retained native handle."""
        with self._operation():
            parent = self._pin(pin)
            before = self._security.validate(parent.leaf, False, parent.role)
            metadata = os.fstat(parent.leaf)
            after = self._security.validate(parent.leaf, False, parent.role)
            if before != after or _lease_identity(after) != parent.lineage[-1]:
                raise LeaseError("ERR_LEASE_CHANGED")
            if (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_ctime_ns) != (
                after.st_dev,
                after.st_ino,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            birth = getattr(metadata, "st_birthtime", None)
            return {
                "identity": parent.lineage[-1],
                "created_at_ms": None if birth is None else int(birth * 1000),
                "modified_at_ms": after.st_mtime_ns // 1_000_000,
                "changed_at_ms": after.st_ctime_ns // 1_000_000,
            }

    def _file(self, pin: _LeasePin, name: str, flags: int) -> int:
        self._name(name)
        flags |= getattr(os, "O_CLOEXEC") | getattr(os, "O_NOFOLLOW") | getattr(os, "O_NONBLOCK")
        if flags & os.O_CREAT:
            # Separate creation from opening an existing permanent slot. A
            # concurrent Darwin O_CREAT open can fail with ENOENT. Only EEXIST
            # permits the second open; disappearance must never recreate it.
            try:
                return os.open(name, flags | os.O_EXCL, 0o600, dir_fd=pin.leaf)
            except FileExistsError:
                flags &= ~os.O_CREAT
        return os.open(name, flags, 0o600, dir_fd=pin.leaf)

    def _reclaim_open(self, parent: _LeasePin, name: str, deleting: bool) -> int | None:
        del deleting
        try:
            descriptor = self._file(parent, name, os.O_RDWR)
        except FileNotFoundError:
            return None
        except OSError as error:
            if error.errno in {errno.ELOOP, errno.EISDIR, errno.EACCES, errno.EPERM}:
                raise LeaseError("ERR_LEASE_FILE", error.errno) from error
            raise
        try:
            self._reclaim_validate(parent, name, descriptor)
            try:
                self._fcntl.flock(descriptor, self._fcntl.LOCK_NB | self._fcntl.LOCK_EX)
            except BlockingIOError as error:
                raise LeaseError("ERR_LEASE_BUSY", error.errno or 0) from error
            return descriptor
        except BaseException as error:
            self._cleanup([descriptor], error)

    def _reclaim_validate(self, parent: _LeasePin, name: str, descriptor: int) -> None:
        info = self._regular(descriptor)
        if info.st_size:
            raise LeaseError("ERR_LEASE_SIZE")
        try:
            named = os.stat(name, dir_fd=parent.leaf, follow_symlinks=False)
        except FileNotFoundError as error:
            raise LeaseError("ERR_LEASE_CHANGED") from error
        if not stat.S_ISREG(named.st_mode) or (named.st_dev, named.st_ino) != (
            info.st_dev,
            info.st_ino,
        ):
            raise LeaseError("ERR_LEASE_CHANGED")

    def _reclaim_remove(self, parent: _LeasePin, name: str, descriptor: int) -> None:
        self._reclaim_validate(parent, name, descriptor)
        os.unlink(name, dir_fd=parent.leaf)

    def create_child(self, pin: object, name: str, *, exclusive: bool = False) -> str:
        with self._operation():
            parent = self._pin(pin)
            if (
                not isinstance(name, str)
                or name in {"", ".", ".."}
                or "/" in name
                or "\0" in name
                or len(os.fsencode(name)) >= _LEASE_PATH_BYTES
            ):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            created = False
            try:
                os.mkdir(name, DIRECTORY_MODE, dir_fd=parent.leaf)
                created = True
            except FileExistsError:
                if exclusive:
                    raise LeaseError(DIRECTORY_EXISTS_ERROR, errno.EEXIST) from None
            descriptor = os.open(
                name,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY")
                | getattr(os, "O_NOFOLLOW")
                | getattr(os, "O_CLOEXEC"),
                dir_fd=parent.leaf,
            )
            with self._temporary([descriptor]):
                identity = _lease_identity(self._security.validate(descriptor, False, parent.role))
                if created:
                    os.fsync(parent.leaf)
                return identity

    def _record_names(
        self, parent: _LeasePin, max_entries: int, *, records: bool = True
    ) -> list[str]:
        # A fresh open file description avoids sharing the retained pin's offset.
        descriptor = os.open(
            ".",
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY")
            | getattr(os, "O_NOFOLLOW")
            | getattr(os, "O_CLOEXEC"),
            dir_fd=parent.leaf,
        )
        with self._temporary([descriptor]):
            if (
                _lease_identity(self._security.validate(descriptor, False, parent.role))
                != parent.lineage[-1]
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            names: list[str] = []
            with os.scandir(descriptor) as listing:
                for entry in listing:
                    self._record_name(names, entry.name, max_entries, records=records)
            return names

    def _regular(
        self, descriptor: int, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> _PosixMetadata:
        info = self._security.validate(descriptor, False, role)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise LeaseError("ERR_LEASE_FILE")
        return info

    def acquire_at(self, pin: object, name: str, exclusive: bool) -> object:
        with self._operation():
            if not isinstance(exclusive, bool):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            parent = self._pin(pin)
            descriptor = self._file(parent, name, os.O_RDWR | os.O_CREAT)
            try:
                self._regular(descriptor)
                try:
                    self._fcntl.flock(
                        descriptor,
                        self._fcntl.LOCK_NB
                        | (self._fcntl.LOCK_EX if exclusive else self._fcntl.LOCK_SH),
                    )
                except BlockingIOError as error:
                    raise LeaseError("ERR_LEASE_BUSY", error.errno or 0) from error
                handle = _LeaseLock(descriptor, parent)
                self._handles.add(handle)
                parent.children += 1
                return handle
            except BaseException as error:
                self._cleanup([descriptor], error)

    def create_at(self, pin: object, name: str, data: bytes) -> None:
        """Create bounded private metadata without replacing any existing entry.

        The caller owns exclusive directory qualification. Partial or unflushed
        files are retained on failure; they are not evidence of completed publication.
        """
        with self._operation():
            parent = self._pin(pin)
            self._name(name)
            if not isinstance(data, bytes) or not 0 < len(data) <= _LEASE_METADATA_LIMIT:
                raise LeaseError("ERR_LEASE_ARGUMENT")
            try:
                descriptor = os.open(
                    name,
                    os.O_WRONLY
                    | os.O_CREAT
                    | os.O_EXCL
                    | getattr(os, "O_NOFOLLOW")
                    | getattr(os, "O_CLOEXEC"),
                    0o600,
                    dir_fd=parent.leaf,
                )
            except FileExistsError:
                raise LeaseError(DIRECTORY_EXISTS_ERROR, errno.EEXIST) from None
            with self._temporary([descriptor]):
                self._regular(descriptor)
                offset = 0
                while offset < len(data):
                    written = os.write(descriptor, data[offset:])
                    if written <= 0:
                        raise OSError(errno.EIO, "metadata write made no progress")
                    offset += written
                self._regular(descriptor)
                os.fsync(descriptor)
                os.fsync(parent.leaf)

    def read_at(self, pin: object, name: str, max_bytes: int) -> bytes | None:
        with self._operation():
            return self._read_at(pin, name, max_bytes)

    def read_snapshot_at(self, pin: object, name: str, max_bytes: int) -> bytes | None:
        """Read one drained-store image; the caller owns cross-file consistency."""
        with self._operation():
            return self._read_file(pin, name, max_bytes, _LEASE_SNAPSHOT_LIMIT, 0)

    def _read_at(self, pin: object, name: str, max_bytes: int) -> bytes | None:
        return self._read_file(pin, name, max_bytes, _LEASE_METADATA_LIMIT, 1)

    def _read_file(
        self,
        pin: object,
        name: str,
        max_bytes: int,
        limit: int,
        minimum: int,
    ) -> bytes | None:
        parent = self._pin(pin)
        if (
            not isinstance(max_bytes, int) or isinstance(max_bytes, bool)
        ) or not minimum <= max_bytes <= limit:
            raise LeaseError("ERR_LEASE_ARGUMENT")
        try:
            descriptor = self._file(parent, name, os.O_RDONLY)
        except FileNotFoundError:
            return None
        with self._temporary([descriptor]):
            before = self._regular(descriptor, parent.role)
            if not 0 <= before.st_size <= max_bytes:
                raise LeaseError("ERR_LEASE_SIZE")
            value = bytearray()
            while len(value) <= max_bytes:
                chunk = os.read(descriptor, min(64 * 1024, max_bytes + 1 - len(value)))
                if not chunk:
                    break
                value.extend(chunk)
            if len(value) > max_bytes:
                raise LeaseError("ERR_LEASE_SIZE")
            after = self._regular(descriptor, parent.role)
            if before != after or after.st_size != len(value):
                raise LeaseError("ERR_LEASE_CHANGED")
            return bytes(value)


class DarwinDirectoryNative(_PosixDirectoryNative):
    """Process-owned strict directory capabilities for Darwin domain admission."""

    def __init__(self) -> None:
        super().__init__(_DarwinSecurity())

    def _descriptor_path(self, descriptor: int) -> str:
        raw = self._fcntl.fcntl(descriptor, _DARWIN_GETPATH_NOFIRMLINK, bytes(1024))
        path = os.fsdecode(raw.split(b"\0", 1)[0])
        if not path.startswith("/") or len(os.fsencode(path)) >= 1024:
            raise LeaseError("ERR_LEASE_CHANGED")
        return path

    def directory_path(self, pin: object) -> str:
        with self._operation():
            parent = self._pin(pin)
            if (
                _lease_identity(self._security.validate(parent.leaf, False, parent.role))
                != parent.lineage[-1]
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            return self._descriptor_path(parent.leaf)

    def pin(self, path: str, create: bool, role: DirectoryRole = DirectoryRole.PRIVATE) -> object:
        role = DirectoryRole(role)
        with self._operation():
            if not isinstance(create, bool):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            descriptors: list[int] = []
            try:
                lineage, leaf = self._walk(path, create, descriptors, role)
                # fcntl's Python buffer API is limited to 1024 bytes; Darwin
                # F_GETPATH is MAXPATHLEN=1024 even though input paths allow more.
                aliases = [
                    os.fsdecode(self._fcntl.fcntl(leaf, command, bytes(1024)).split(b"\0", 1)[0])
                    for command in (_DARWIN_GETPATH_NOFIRMLINK, _DARWIN_GETPATH)
                ]
                for alias in dict.fromkeys(aliases):
                    if alias == path:
                        continue
                    ancestors, _ = self._walk(alias, False, descriptors, role)
                    if ancestors[-1] != lineage[-1]:
                        raise LeaseError("ERR_LEASE_CHANGED")
                    lineage = ancestors[:-1] + lineage
                pin = _LeasePin(descriptors, tuple(lineage), leaf, role=role)
                self._handles.add(pin)
                return pin
            except BaseException as error:
                self._cleanup(descriptors, error)


class _WinUnicode(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_uint16),
        ("maximum", ctypes.c_uint16),
        ("buffer", ctypes.c_void_p),
    ]


class _WinObject(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_uint32),
        ("root", ctypes.c_void_p),
        ("name", ctypes.POINTER(_WinUnicode)),
        ("attributes", ctypes.c_uint32),
        ("security", ctypes.c_void_p),
        ("quality", ctypes.c_void_p),
    ]


class _WinStatus(ctypes.Structure):
    _fields_ = [("status", ctypes.c_void_p), ("information", ctypes.c_size_t)]


class _WinId(ctypes.Structure):
    _fields_ = [("volume", ctypes.c_uint64), ("file", ctypes.c_ubyte * 16)]


class _WinBasic(ctypes.Structure):
    _fields_ = [
        ("creation", ctypes.c_int64),
        ("access", ctypes.c_int64),
        ("write", ctypes.c_int64),
        ("change", ctypes.c_int64),
        ("attributes", ctypes.c_uint32),
    ]


class _WinStandard(ctypes.Structure):
    _fields_ = [
        ("allocation", ctypes.c_int64),
        ("size", ctypes.c_int64),
        ("links", ctypes.c_uint32),
        ("deleting", ctypes.c_ubyte),
        ("directory", ctypes.c_ubyte),
    ]


class _WinOverlap(ctypes.Structure):
    _fields_ = [
        ("internal", ctypes.c_size_t),
        ("internal_high", ctypes.c_size_t),
        ("offset", ctypes.c_uint32),
        ("offset_high", ctypes.c_uint32),
        ("event", ctypes.c_void_p),
    ]


class _WinAcl(ctypes.Structure):
    _fields_ = [
        ("revision", ctypes.c_ubyte),
        ("spare", ctypes.c_ubyte),
        ("size", ctypes.c_uint16),
        ("count", ctypes.c_uint16),
        ("spare2", ctypes.c_uint16),
    ]


class _WinAce(ctypes.Structure):
    _fields_ = [
        ("kind", ctypes.c_ubyte),
        ("flags", ctypes.c_ubyte),
        ("size", ctypes.c_uint16),
        ("mask", ctypes.c_uint32),
    ]


_WIN_OWNER_SECURITY = 1
_WIN_TOKEN_QUERY = 8
_WIN_TOKEN_USER = 1
_WIN_INSUFFICIENT_BUFFER = 122
_WIN_OBJECT_CASE_INSENSITIVE = 0x40
_WIN_FILE_OPEN = 1
_WIN_FILE_CREATE = 2
_WIN_FILE_OPEN_IF = 3
_WIN_ALREADY_EXISTS = 183
_WIN_FILE_EXISTS = 80
_WIN_FILE_DIRECTORY = 1
_WIN_FILE_WRITE_THROUGH = 2
_WIN_FILE_NON_DIRECTORY = 0x40
_WIN_FILE_SYNCHRONOUS = 0x20
_WIN_FILE_REPARSE = 0x00200000
_WIN_FILE_BASIC_INFO = 0
_WIN_FILE_STANDARD_INFO = 1
_WIN_FILE_ID_INFO = 18
_WIN_FILE_DISK = 1
_WIN_FILE_LIST_DIRECTORY = 1
_WIN_FILE_NAMES_INFORMATION = 12
_WIN_NO_MORE_FILES = 0x80000006
_WIN_NAMES_HEADER_BYTES = 12
_WIN_NAMES_BUFFER_BYTES = _WIN_NAMES_HEADER_BYTES + 2 * _LEASE_NAME_BYTES
_WIN_VOLUME_GUID = 1
_WIN_READ_EXECUTE = windows.READ_EXECUTE_ACCESS
_WIN_ADD_CHILDREN = 2 | 4
_WIN_ACL_INHERIT_ONLY = 8
_WIN_LOCK_FAIL_IMMEDIATELY = 1
_WIN_LOCK_EXCLUSIVE = 2
_WIN_LOCK_VIOLATION = 33
_WIN_NOT_FOUND = 2
_WIN_PATH_NOT_FOUND = 3
_WIN_PATH_UNITS = 32760
_WIN_VOLUME_ROOT = re.compile(r"\\\\\?\\Volume\{[a-fA-F0-9-]{36}\}\\")


def _win_sid(authority: int, *subauthorities: int) -> bytes:
    return (
        bytes([1, len(subauthorities)])
        + authority.to_bytes(6, "big")
        + b"".join(value.to_bytes(4, "little") for value in subauthorities)
    )


_WIN_CAPABILITY_AUTHORITY = 15
_WIN_CAPABILITY_BASE = 3
_WIN_CAPABILITY_MIN_PARTS = 2
_WIN_SID_MAX_PARTS = 15
_WIN_SID_REVISION = 1
_WIN_SID_HEADER_BYTES = 8
_WIN_SID_PART_BYTES = 4


def _win_capability_sid(sid: bytes) -> bool:
    return (
        len(sid) >= _WIN_SID_HEADER_BYTES
        and sid[0] == _WIN_SID_REVISION
        and _WIN_CAPABILITY_MIN_PARTS <= sid[1] <= _WIN_SID_MAX_PARTS
        and len(sid) == _WIN_SID_HEADER_BYTES + _WIN_SID_PART_BYTES * sid[1]
        and int.from_bytes(sid[2:_WIN_SID_HEADER_BYTES], "big") == _WIN_CAPABILITY_AUTHORITY
        and int.from_bytes(
            sid[_WIN_SID_HEADER_BYTES : _WIN_SID_HEADER_BYTES + _WIN_SID_PART_BYTES], "little"
        )
        == _WIN_CAPABILITY_BASE
    )


class _WindowsLeaseApi:
    """Handle-relative Win32/NT filesystem and read-only authority checks."""

    def __init__(self) -> None:
        if os.name != WINDOWS_PLATFORM or _WIN_DLL is None:
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        # Separate function objects avoid mutating content-storage API signatures.
        self.kernel = _WIN_DLL("kernel32", use_last_error=True)
        self.security = _WIN_DLL("advapi32", use_last_error=True)
        self.nt = _WIN_DLL("ntdll", use_last_error=True)
        p, u, i = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int32
        out = ctypes.POINTER(p)
        signatures = [
            (self.kernel, "CreateFileW", [ctypes.c_wchar_p, u, u, p, u, u, p], p),
            (self.kernel, "CloseHandle", [p], i),
            (self.kernel, "GetFileInformationByHandleEx", [p, i, p, u], i),
            (self.kernel, "SetFileInformationByHandle", [p, i, p, u], i),
            (self.kernel, "GetFileType", [p], u),
            (self.kernel, "GetFinalPathNameByHandleW", [p, ctypes.c_wchar_p, u, u], u),
            (self.kernel, "GetCurrentProcess", [], p),
            (self.kernel, "LocalFree", [p], p),
            (self.kernel, "ReadFile", [p, p, u, ctypes.POINTER(u), p], i),
            (self.kernel, "WriteFile", [p, p, u, ctypes.POINTER(u), p], i),
            (self.kernel, "FlushFileBuffers", [p], i),
            (self.kernel, "LockFileEx", [p, u, u, u, u, ctypes.POINTER(_WinOverlap)], i),
            (self.security, "OpenProcessToken", [p, u, out], i),
            (self.security, "GetTokenInformation", [p, i, p, u, ctypes.POINTER(u)], i),
            (self.security, "GetSecurityInfo", [p, i, u, out, out, out, out, out], u),
            (self.security, "IsValidSid", [p], i),
            (self.security, "GetLengthSid", [p], u),
            (self.security, "IsValidAcl", [p], i),
            (self.security, "GetAce", [p, u, out], i),
            (
                self.security,
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
                [ctypes.c_wchar_p, u, out, ctypes.POINTER(u)],
                i,
            ),
            (
                self.nt,
                "NtCreateFile",
                [
                    out,
                    u,
                    ctypes.POINTER(_WinObject),
                    ctypes.POINTER(_WinStatus),
                    p,
                    u,
                    u,
                    u,
                    u,
                    p,
                    u,
                ],
                i,
            ),
            (
                self.nt,
                "NtQueryDirectoryFile",
                [
                    p,
                    p,
                    p,
                    p,
                    ctypes.POINTER(_WinStatus),
                    p,
                    u,
                    i,
                    ctypes.c_ubyte,
                    p,
                    ctypes.c_ubyte,
                ],
                i,
            ),
            (self.nt, "RtlNtStatusToDosError", [i], u),
        ]
        for library, name, args, result in signatures:
            function = getattr(library, name)
            function.argtypes = args
            function.restype = result
        self.user = self._user()

        self.everyone = windows.well_known_sid(windows.WellKnownSid.EVERYONE)
        self.owner_rights = windows.well_known_sid(windows.WellKnownSid.OWNER_RIGHTS)
        authority = int.from_bytes(self.user[2:8], "big")
        subauthorities = [
            int.from_bytes(self.user[start : start + 4], "little")
            for start in range(8, len(self.user), 4)
        ]
        sid = "S-1-" + "-".join(map(str, [authority, *subauthorities]))
        descriptor, length = p(), u()
        self.check(
            self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                f"O:{sid}D:P(A;;FA;;;{sid})(A;;FA;;;SY)",
                1,
                ctypes.byref(descriptor),
                ctypes.byref(length),
            )
        )
        try:
            self.private = ctypes.create_string_buffer(ctypes.string_at(descriptor, length.value))
        finally:
            self.kernel.LocalFree(descriptor)

    @staticmethod
    def last_error() -> int:
        if not callable(_GET_LAST_ERROR):
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        code = _GET_LAST_ERROR()
        if not isinstance(code, int):
            raise LeaseError("ERR_LEASE_NATIVE")
        return code

    @staticmethod
    def check(success: int) -> None:
        if not success:
            raise LeaseError("ERR_LEASE_NATIVE", _WindowsLeaseApi.last_error())

    def close(self, handles: list[int]) -> None:
        while handles:
            handle = handles.pop()
            try:
                if not self.kernel.CloseHandle(handle):
                    raise LeaseError("ERR_LEASE_RELEASE", _WindowsLeaseApi.last_error())
            except BaseException as error:
                raise LeaseError("ERR_LEASE_RELEASE", getattr(error, "errno", 0) or 0) from error

    def _sid(self, pointer: int | None) -> bytes:
        if not pointer or not self.security.IsValidSid(pointer):
            raise LeaseError("ERR_LEASE_PERMISSION")
        return ctypes.string_at(pointer, self.security.GetLengthSid(pointer))

    def _user(self) -> bytes:
        token, length = ctypes.c_void_p(), ctypes.c_uint32()
        self.check(
            self.security.OpenProcessToken(
                self.kernel.GetCurrentProcess(), _WIN_TOKEN_QUERY, ctypes.byref(token)
            )
        )
        token_handle = token.value
        if token_handle is None:
            raise LeaseError("ERR_LEASE_NATIVE")
        try:
            result = self.security.GetTokenInformation(
                token, _WIN_TOKEN_USER, None, 0, ctypes.byref(length)
            )
            if (
                result
                or _WindowsLeaseApi.last_error() != _WIN_INSUFFICIENT_BUFFER
                or not 8 <= length.value <= 65536
            ):
                raise LeaseError("ERR_LEASE_NATIVE", _WindowsLeaseApi.last_error())
            buffer = ctypes.create_string_buffer(length.value)
            self.check(
                self.security.GetTokenInformation(
                    token, _WIN_TOKEN_USER, buffer, length.value, ctypes.byref(length)
                )
            )
            return self._sid(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p)).contents.value)
        finally:
            self.close([token_handle])

    def permissions(self, handle: int, ancestor: bool) -> None:
        def reject(reason: str) -> NoReturn:
            error = LeaseError("ERR_LEASE_PERMISSION")
            error.add_note(f"Windows directory permission rejected: {reason}; ancestor={ancestor}")
            security.record_denial(
                error,
                "installation",
                "acl",
                (
                    "untrusted_owner"
                    if reason == "untrusted owner"
                    else (
                        "foreign_writer"
                        if reason.startswith("ACE index=")
                        else (
                            "unsupported_ace"
                            if reason.startswith("invalid ACE index=")
                            else "invalid_descriptor"
                        )
                    )
                ),
            )
            raise error

        owner, acl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        status = self.security.GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            _WIN_OWNER_SECURITY | DACL_SECURITY_INFORMATION,
            ctypes.byref(owner),
            None,
            ctypes.byref(acl),
            None,
            ctypes.byref(descriptor),
        )
        if status:
            raise LeaseError("ERR_LEASE_NATIVE", status)
        try:
            actual_owner = self._sid(owner.value)
            if not acl or not self.security.IsValidAcl(acl):
                reject("invalid DACL")
            header = ctypes.cast(acl, ctypes.POINTER(_WinAcl)).contents
            role = security.ROLE_ANCESTOR if ancestor else security.ROLE_CONTENT
            if ancestor:
                volume_path = ctypes.create_unicode_buffer(_WIN_PATH_UNITS)
                length = self.kernel.GetFinalPathNameByHandleW(
                    handle, volume_path, len(volume_path), 1
                )
                if not 0 < length < len(volume_path):
                    reject("volume identity unavailable")
                if re.fullmatch(r"\\\\\?\\Volume\{[0-9A-Fa-f-]{36}\}\\", volume_path.value):
                    role = security.ROLE_VOLUME
            if not security.owner(role, security.authority(actual_owner, self.user)):
                reject("untrusted owner")
            entries: list[security.Entry] = []
            identities: dict[bytes, int] = {}
            for index in range(header.count):
                pointer = ctypes.c_void_p()
                self.check(self.security.GetAce(acl, index, ctypes.byref(pointer)))
                ace_address = pointer.value
                if ace_address is None:
                    reject("missing ACE pointer")
                ace = ctypes.cast(pointer, ctypes.POINTER(_WinAce)).contents
                if ace.kind not in {0, 1} or ace.flags & ~0x1F or ace.size < 16:
                    reject(f"invalid ACE index={index} kind={ace.kind} flags={ace.flags:#x}")
                sid_pointer = ace_address + ctypes.sizeof(_WinAce)
                count = ctypes.string_at(sid_pointer, 8)[1]
                if count > 15 or 8 + 4 * count + ctypes.sizeof(_WinAce) != ace.size:
                    reject(f"invalid ACE SID index={index}")
                sid = self._sid(sid_pointer)
                # OWNER RIGHTS applies to this object's already validated owner,
                # not another principal. Match the native launcher's admission.
                if sid == self.owner_rights:
                    sid = actual_owner
                principal_id = identities.setdefault(sid, len(identities))
                entries.append(
                    security.Entry(
                        principal_id,
                        ace.mask,
                        ace.flags,
                        ace.kind == 1,
                        security.authority(sid, self.user),
                        sid == self.everyone,
                        False,
                        False,
                    )
                )
            verdict = security.evaluate(entries, role, False)
            if verdict.reason:
                reject(f"ACE index={verdict.index} mask={verdict.mask:#x} scope={verdict.scope}")
        except Exception as error:
            security.record_denial(error, "installation", "inspect", "os_error")
            raise
        finally:
            self.kernel.LocalFree(descriptor)

    def info(self, handle: int, kind: int, result: ctypes.Structure) -> None:
        self.check(
            self.kernel.GetFileInformationByHandleEx(
                handle, kind, ctypes.byref(result), ctypes.sizeof(result)
            )
        )

    def validate(
        self,
        handle: int,
        directory: bool,
        ancestor: bool = False,
        role: DirectoryRole = DirectoryRole.PRIVATE,
        *,
        installation: bool = False,
    ) -> tuple[_WinBasic, _WinStandard]:
        basic, standard = _WinBasic(), _WinStandard()
        self.info(handle, _WIN_FILE_BASIC_INFO, basic)
        self.info(handle, _WIN_FILE_STANDARD_INFO, standard)
        if (
            self.kernel.GetFileType(handle) != _WIN_FILE_DISK
            or basic.attributes & FILE_ATTRIBUTE_REPARSE_POINT
            or bool(basic.attributes & FILE_ATTRIBUTE_DIRECTORY) != directory
            or bool(standard.directory) != directory
            or standard.deleting
            or (not directory and standard.links != 1)
        ):
            raise LeaseError("ERR_LEASE_DIRECTORY")
        try:
            if installation:
                self.permissions(handle, ancestor)
        except LeaseError as error:
            if error.code == "ERR_LEASE_PERMISSION":
                buffer = ctypes.create_unicode_buffer(_WIN_PATH_UNITS)
                count = self.kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
                if 0 < count < len(buffer):
                    error.add_note(f"directory={buffer.value!r}")
            raise
        return basic, standard

    def identity(self, handle: int) -> str:
        identity = _WinId()
        self.info(handle, _WIN_FILE_ID_INFO, identity)
        return f"windows:{identity.volume:016x}:{bytes(identity.file).hex()}"

    def relative(
        self,
        parent: int,
        name: str,
        *,
        directory: bool | None,
        create: bool,
        exclusive: bool = False,
        durable: bool = False,
        listing: bool = False,
        reclaim: bool = False,
        lock_probe: bool = False,
        role: DirectoryRole = DirectoryRole.PRIVATE,
        installation: bool = False,
    ) -> int:
        if reclaim and (directory is not False or create or exclusive or durable or listing):
            raise ValueError("reclamation requires an existing file")
        if directory is None and (create or exclusive or durable or listing):
            raise ValueError("untyped entry opens are metadata-only")
        if exclusive and not create:
            raise ValueError("exclusive creation requires create")
        encoded = name.encode("utf-16-le")
        wide = ctypes.create_unicode_buffer(name, len(encoded) // 2 + 1)
        relative = _WinUnicode(len(encoded), len(encoded) + 2, ctypes.cast(wide, ctypes.c_void_p))
        attributes = _WinObject(
            ctypes.sizeof(_WinObject),
            parent,
            ctypes.pointer(relative),
            _WIN_OBJECT_CASE_INSENSITIVE,
            ctypes.cast(self.private, ctypes.c_void_p),
            None,
        )
        status, handle = _WinStatus(), ctypes.c_void_p()
        access = (
            (
                (FILE_READ_ATTRIBUTES | _WIN_FILE_LIST_DIRECTORY)
                if directory is True
                else FILE_READ_ATTRIBUTES if directory is None else GENERIC_READ
            )
            | (READ_CONTROL if installation else 0)
            | SYNCHRONIZE
        )
        if reclaim:
            access |= DELETE_ACCESS | GENERIC_WRITE
        if listing:
            access |= _WIN_FILE_LIST_DIRECTORY
        if create and not directory:
            access |= GENERIC_WRITE
        result = self.nt.NtCreateFile(
            ctypes.byref(handle),
            access,
            ctypes.byref(attributes),
            ctypes.byref(status),
            None,
            FILE_ATTRIBUTE_DIRECTORY if directory else FILE_ATTRIBUTE_NORMAL,
            (
                0
                if reclaim
                else (
                    FILE_SHARE_READ
                    | (
                        FILE_SHARE_WRITE
                        if directory is not False or (create and not exclusive) or lock_probe
                        else 0
                    )
                )
            ),
            _WIN_FILE_CREATE if exclusive else (_WIN_FILE_OPEN_IF if create else _WIN_FILE_OPEN),
            (
                0
                if directory is None
                else (_WIN_FILE_DIRECTORY if directory else _WIN_FILE_NON_DIRECTORY)
            )
            | _WIN_FILE_REPARSE
            | _WIN_FILE_SYNCHRONOUS
            | (_WIN_FILE_WRITE_THROUGH if durable else 0),
            None,
            0,
        )
        if result < 0:
            error = self.nt.RtlNtStatusToDosError(result)
            if exclusive and error in {_WIN_ALREADY_EXISTS, _WIN_FILE_EXISTS}:
                raise LeaseError(DIRECTORY_EXISTS_ERROR, error)
            missing = not create and error in (
                {_WIN_NOT_FOUND, _WIN_PATH_NOT_FOUND} if directory else {_WIN_NOT_FOUND}
            )
            raise LeaseError("ERR_LEASE_MISSING" if missing else "ERR_LEASE_NATIVE", error)
        if handle.value is None:
            raise LeaseError("ERR_LEASE_NATIVE")
        return handle.value


def prepare_private_directory(
    root: Path,
    parts: tuple[str, ...],
    *,
    exclusive: bool = False,
    role: DirectoryRole = DirectoryRole.PRIVATE,
) -> str:
    """Prepare private descendants under caller-held exclusive root qualification.

    Existing directories are validated, never chmod'ed or given replacement ACLs.
    This creates no data files and grants no qualification for subsequent IO.
    """
    if exclusive and len(parts) != 1:
        raise ValueError("exclusive directory preparation requires one child")
    if not parts or any(
        not isinstance(part, str)
        or part in {"", ".", ".."}
        or any(character in part for character in ("/", "\\", ":", "\0"))
        or part.endswith((".", " "))
        for part in parts
    ):
        raise ValueError("private directory components must be plain names")
    if sys.platform == "win32":
        native = WindowsDirectoryNative()
    elif sys.platform == "darwin":
        native = DarwinDirectoryNative()
    elif sys.platform == "linux":
        native = LinuxDirectoryNative()
    else:
        raise LeaseError("ERR_LEASE_UNSUPPORTED")
    pins = []
    current = str(root)
    identity: str | None = None
    try:
        pin = native.pin(current, False, role)
        pins.append(pin)
        for part in parts:
            identity = native.create_child(pin, part, exclusive=exclusive)
            current = os.path.join(current, part)
            pin = native.pin(current, False, role)
            pins.append(pin)
            if native.lineage(pin)[-1] != identity:
                raise LeaseError("ERR_LEASE_CHANGED")
    finally:
        # Stop on uncertain release; unreleased native handles survive until
        # process death. Retrying close or releasing siblings is unsafe.
        while pins:
            native.release(pins.pop())
    if identity is None:
        raise LeaseError("ERR_LEASE_ARGUMENT")
    return identity


class WindowsDirectoryNative(_LeaseOwner):
    """Local-volume identity and locks; OS access governs Windows user data.

    Only the frozen, read-only installation binding audits ACL authority. Existing
    user-data ACLs are preserved; new records still receive private descriptors.
    """

    def __init__(self, installation: InstallationBinding | None = None) -> None:
        if installation is not None and not isinstance(installation, InstallationBinding):
            raise TypeError("installation requires a frozen InstallationBinding")
        self._installation = installation
        self._installation_lineage: tuple[str, ...] | None = None
        self._installation_file: str | None = None
        self._api = _WindowsLeaseApi()
        super().__init__(self._api.close)

    def _pin(self, handle: object, *, read_only: bool = False) -> _LeasePin:
        pin = super()._pin(handle)
        if isinstance(pin, _InstallationPin):
            if not read_only:
                raise LeaseError(_INSTALLATION_READ_ONLY)
            binding = pin.binding
            if binding is None or binding != self._installation:
                raise LeaseError("ERR_LEASE_HANDLE")
            boundary = len(binding.root[3:].split("\\"))
            for index, descriptor in enumerate(pin.descriptors):
                role = DirectoryRole.PRIVATE if index >= boundary else DirectoryRole.PROJECT
                self._api.validate(descriptor, True, False, role, installation=index >= boundary)
                if self._api.identity(descriptor) != pin.lineage[index]:
                    raise LeaseError("ERR_LEASE_CHANGED")
            if pin.lineage != self._installation_lineage:
                raise LeaseError("ERR_LEASE_CHANGED")
        return pin

    def lineage(self, pin: object) -> tuple[str, ...]:
        with self._operation():
            return self._pin(pin, read_only=True).lineage

    def _descriptor_path(self, descriptor: int) -> str:
        buffer = ctypes.create_unicode_buffer(_WIN_PATH_UNITS)
        count = self._api.kernel.GetFinalPathNameByHandleW(descriptor, buffer, len(buffer), 0)
        if not count or count >= len(buffer):
            raise LeaseError("ERR_LEASE_CHANGED")
        path = buffer.value.removeprefix(WINDOWS_PATH_PREFIX)
        if not re.match(r"^[a-zA-Z]:[\\/]", path):
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        return path

    def directory_path(self, pin: object) -> str:
        with self._operation():
            parent = self._pin(pin)
            self._api.validate(parent.leaf, True, role=parent.role)
            if self._api.identity(parent.leaf) != parent.lineage[-1]:
                raise LeaseError("ERR_LEASE_CHANGED")
            return self._descriptor_path(parent.leaf)

    def pin(self, path: str, create: bool, role: DirectoryRole = DirectoryRole.PRIVATE) -> object:
        role = DirectoryRole(role)
        with self._operation():
            if not isinstance(path, str) or not isinstance(create, bool) or "\0" in path:
                raise LeaseError("ERR_LEASE_ARGUMENT")
            installation = (
                self._installation
                if role is DirectoryRole.PRIVATE
                and self._installation is not None
                and self._installation.matches(path)
                else None
            )
            if installation is not None:
                if create:
                    raise LeaseError(_INSTALLATION_READ_ONLY)
                path = installation.target
            if not re.match(r"^[a-zA-Z]:[\\/]", path):
                raise LeaseError("ERR_LEASE_UNSUPPORTED")
            if len(path.encode("utf-16-le")) // 2 >= _WIN_PATH_UNITS:
                raise LeaseError("ERR_LEASE_ARGUMENT")
            path = path.replace("/", "\\")
            parts = path[3:].split("\\") if len(path) > 3 else []
            if len(parts) >= _LEASE_DEPTH or any(
                not part or part in {".", ".."} or ":" in part or part.endswith((".", " "))
                for part in parts
            ):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            handles: list[int] = []
            boundary = len(installation.root[3:].split("\\")) if installation else 0
            try:
                root = self._api.kernel.CreateFileW(
                    "\\\\?\\" + path[:3],
                    _WIN_FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                    None,
                )
                if root == INVALID_HANDLE_VALUE:
                    status = _WindowsLeaseApi.last_error()
                    raise LeaseError(
                        (
                            "ERR_LEASE_MISSING"
                            if status in {_WIN_NOT_FOUND, _WIN_PATH_NOT_FOUND}
                            else "ERR_LEASE_NATIVE"
                        ),
                        status,
                    )
                handles.append(root)
                volume = ctypes.create_unicode_buffer(64)
                count = self._api.kernel.GetFinalPathNameByHandleW(
                    root, volume, len(volume), _WIN_VOLUME_GUID
                )
                if count != 49 or not _WIN_VOLUME_ROOT.fullmatch(volume.value):
                    raise LeaseError("ERR_LEASE_UNSUPPORTED")
                self._api.validate(
                    root, True, bool(parts), DirectoryRole.PROJECT if installation else role
                )
                lineage = [self._api.identity(root)]
                for index, part in enumerate(parts):
                    final = index == len(parts) - 1
                    selected_role = (
                        DirectoryRole.PROJECT if installation and index + 1 < boundary else role
                    )
                    handle = self._api.relative(
                        handles[-1],
                        part,
                        directory=True,
                        create=create and final,
                        role=selected_role,
                        installation=installation is not None and index + 1 >= boundary,
                    )
                    handles.append(handle)
                    self._api.validate(
                        handle,
                        True,
                        False if installation else not final,
                        selected_role,
                        installation=installation is not None and index + 1 >= boundary,
                    )
                    lineage.append(self._api.identity(handle))
                pin: _LeasePin
                if installation:
                    identities = tuple(lineage)
                    if (
                        self._installation_lineage is not None
                        and identities != self._installation_lineage
                    ):
                        raise LeaseError("ERR_LEASE_CHANGED")
                    pin = _InstallationPin(
                        handles, identities, handles[-1], role=role, binding=installation
                    )
                    self._installation_lineage = identities
                else:
                    pin = _LeasePin(handles, tuple(lineage), handles[-1], role=role)
                self._handles.add(pin)
                return pin
            except BaseException as error:
                self._cleanup(handles, error)

    def entry_kind(self, pin: object, name: str) -> str | None:
        with self._operation():
            parent = self._pin(pin)
            self._entry_name(name)
            try:
                descriptor = self._api.relative(
                    parent.leaf, name, directory=None, create=False, role=parent.role
                )
            except LeaseError as error:
                if error.code == "ERR_LEASE_MISSING":
                    return None
                raise
            with self._temporary([descriptor]):
                basic = _WinBasic()
                self._api.info(descriptor, _WIN_FILE_BASIC_INFO, basic)
                directory = bool(basic.attributes & FILE_ATTRIBUTE_DIRECTORY)
                self._api.validate(descriptor, directory, role=parent.role)
                return "directory" if directory else "file"

    def directory_entries(self, pin: object, max_entries: int) -> tuple[tuple[str, bool], ...]:
        with self._operation():
            if (
                not isinstance(max_entries, int) or isinstance(max_entries, bool)
            ) or not 0 < max_entries <= _LEASE_RECORD_LIMIT:
                raise LeaseError("ERR_LEASE_ARGUMENT")
            parent = self._pin(pin)
            before, _ = self._api.validate(parent.leaf, True, role=parent.role)
            names = self._record_names(parent, max_entries, records=False)
            entries = []
            for name in names:
                descriptor = self._api.relative(
                    parent.leaf, name, directory=None, create=False, role=parent.role
                )
                with self._temporary([descriptor]):
                    basic = _WinBasic()
                    self._api.info(descriptor, _WIN_FILE_BASIC_INFO, basic)
                    directory = bool(basic.attributes & FILE_ATTRIBUTE_DIRECTORY)
                    self._api.validate(descriptor, directory, role=parent.role)
                    entries.append((name, directory))
            after, _ = self._api.validate(parent.leaf, True, role=parent.role)
            if (
                (before.creation, before.write, before.change, before.attributes)
                != (after.creation, after.write, after.change, after.attributes)
                or self._api.identity(parent.leaf) != parent.lineage[-1]
                or sorted(names) != sorted(self._record_names(parent, max_entries, records=False))
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            return tuple(sorted(entries))

    def directory_metadata(self, pin: object) -> dict[str, int | str | None]:
        with self._operation():
            parent = self._pin(pin)
            before, _ = self._api.validate(parent.leaf, True, role=parent.role)
            identity = self._api.identity(parent.leaf)
            after, _ = self._api.validate(parent.leaf, True, role=parent.role)
            if identity != parent.lineage[-1] or (
                before.creation,
                before.write,
                before.change,
                before.attributes,
            ) != (after.creation, after.write, after.change, after.attributes):
                raise LeaseError("ERR_LEASE_CHANGED")
            # FILETIME counts 100 ns ticks from 1601-01-01.
            epoch_ms = 11_644_473_600_000
            return {
                "identity": identity,
                "created_at_ms": after.creation // 10_000 - epoch_ms,
                "modified_at_ms": after.write // 10_000 - epoch_ms,
                "changed_at_ms": after.change // 10_000 - epoch_ms,
            }

    def _record_names(
        self, parent: _LeasePin, max_entries: int, *, records: bool = True
    ) -> list[str]:
        # NT empty-relative name reopens this exact directory with an independent
        # enumeration cursor. Public record names still reject empty strings.
        descriptor = self._api.relative(
            parent.leaf, "", directory=True, create=False, listing=True, role=parent.role
        )
        with self._temporary([descriptor]):
            self._api.validate(descriptor, True, role=parent.role)
            if self._api.identity(descriptor) != parent.lineage[-1]:
                raise LeaseError("ERR_LEASE_CHANGED")
            names: list[str] = []
            # FILE_NAMES_INFORMATION requires eight-byte buffer alignment.
            word_bytes = ctypes.sizeof(ctypes.c_uint64)
            buffer = (
                ctypes.c_uint64 * ((_WIN_NAMES_BUFFER_BYTES + word_bytes - 1) // word_bytes)
            )()
            buffer_bytes = ctypes.sizeof(buffer)
            restart = True
            seen_dots: set[str] = set()
            while True:
                status = _WinStatus()
                result = self._api.nt.NtQueryDirectoryFile(
                    descriptor,
                    None,
                    None,
                    None,
                    ctypes.byref(status),
                    buffer,
                    buffer_bytes,
                    _WIN_FILE_NAMES_INFORMATION,
                    True,
                    None,
                    restart,
                )
                restart = False
                if result & 0xFFFFFFFF == _WIN_NO_MORE_FILES:
                    return names
                if result != 0:
                    raise LeaseError("ERR_LEASE_NATIVE", self._api.nt.RtlNtStatusToDosError(result))
                count = status.information
                if not _WIN_NAMES_HEADER_BYTES <= count <= buffer_bytes:
                    raise LeaseError("ERR_LEASE_CHANGED")
                raw = ctypes.string_at(buffer, count)
                following = int.from_bytes(raw[:4], "little")
                length = int.from_bytes(raw[8:_WIN_NAMES_HEADER_BYTES], "little")
                if (
                    following
                    or not length
                    or length % 2
                    or length > count - _WIN_NAMES_HEADER_BYTES
                ):
                    raise LeaseError("ERR_LEASE_CHANGED")
                try:
                    name = raw[_WIN_NAMES_HEADER_BYTES : _WIN_NAMES_HEADER_BYTES + length].decode(
                        "utf-16-le"
                    )
                except UnicodeDecodeError as error:
                    raise LeaseError("ERR_LEASE_ARGUMENT") from error
                if name in {".", ".."}:
                    if name in seen_dots:
                        raise LeaseError("ERR_LEASE_CHANGED")
                    seen_dots.add(name)
                    continue
                self._record_name(names, name, max_entries, records=records)

    def acquire_at(self, pin: object, name: str, exclusive: bool) -> object:
        with self._operation():
            parent = self._pin(pin)
            self._name(name)
            if not isinstance(exclusive, bool):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            descriptor = self._api.relative(parent.leaf, name, directory=False, create=True)
            try:
                self._api.validate(descriptor, False)
                overlap = _WinOverlap()
                flags = _WIN_LOCK_FAIL_IMMEDIATELY | (_WIN_LOCK_EXCLUSIVE if exclusive else 0)
                if not self._api.kernel.LockFileEx(
                    descriptor, flags, 0, 1, 0, ctypes.byref(overlap)
                ):
                    status = _WindowsLeaseApi.last_error()
                    raise LeaseError(
                        "ERR_LEASE_BUSY" if status == _WIN_LOCK_VIOLATION else "ERR_LEASE_NATIVE",
                        status,
                    )
                handle = _LeaseLock(descriptor, parent)
                self._handles.add(handle)
                parent.children += 1
                return handle
            except BaseException as error:
                self._cleanup([descriptor], error)

    def _reclaim_open(self, parent: _LeasePin, name: str, deleting: bool) -> int | None:
        try:
            descriptor = self._api.relative(
                parent.leaf,
                name,
                directory=False,
                create=False,
                reclaim=deleting,
                lock_probe=not deleting,
            )
        except LeaseError as error:
            if error.code == "ERR_LEASE_MISSING":
                return None
            if error.errno in {_WIN_SHARING_VIOLATION, _WIN_DELETE_PENDING}:
                raise LeaseError("ERR_LEASE_BUSY", error.errno) from error
            if error.errno == _WIN_RECLAMATION_ACCESS_DENIED:
                raise LeaseError("ERR_LEASE_PERMISSION", error.errno) from error
            raise
        try:
            self._reclaim_validate(parent, name, descriptor)
            overlap = _WinOverlap()
            if not self._api.kernel.LockFileEx(
                descriptor,
                _WIN_LOCK_FAIL_IMMEDIATELY | _WIN_LOCK_EXCLUSIVE,
                0,
                1,
                0,
                ctypes.byref(overlap),
            ):
                status = self._api.last_error()
                raise LeaseError(
                    "ERR_LEASE_BUSY" if status == _WIN_LOCK_VIOLATION else "ERR_LEASE_NATIVE",
                    status,
                )
            return descriptor
        except BaseException as error:
            self._cleanup([descriptor], error)

    def _reclaim_validate(self, parent: _LeasePin, name: str, descriptor: int) -> None:
        del parent, name
        _, standard = self._api.validate(descriptor, False)
        if standard.size:
            raise LeaseError("ERR_LEASE_SIZE")

    def _reclaim_remove(self, parent: _LeasePin, name: str, descriptor: int) -> None:
        self._reclaim_validate(parent, name, descriptor)
        # Ordinary disposition removes this exact object when its exclusive
        # handle closes. No path reopen and no POSIX delete-sharing relaxation.
        disposition = ctypes.c_ubyte(1)
        self._api.check(
            self._api.kernel.SetFileInformationByHandle(
                descriptor,
                _WIN_FILE_DISPOSITION_INFO,
                ctypes.byref(disposition),
                ctypes.sizeof(disposition),
            )
        )

    def create_child(self, pin: object, name: str, *, exclusive: bool = False) -> str:
        with self._operation():
            parent = self._pin(pin)
            if (
                not isinstance(name, str)
                or name in {"", ".", ".."}
                or any(value in name for value in ("/", "\\", ":", "\0"))
                or name.endswith((".", " "))
                or len(name.encode("utf-16-le")) // 2 >= _WIN_PATH_UNITS
            ):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            descriptor = self._api.relative(
                parent.leaf,
                name,
                directory=True,
                create=True,
                exclusive=exclusive,
                durable=True,
                role=parent.role,
            )
            with self._temporary([descriptor]):
                self._api.validate(descriptor, True, role=parent.role)
                return self._api.identity(descriptor)

    def create_at(self, pin: object, name: str, data: bytes) -> None:
        """Publish private metadata through the pinned parent, never a path fallback."""
        with self._operation():
            parent = self._pin(pin)
            self._name(name)
            if not isinstance(data, bytes) or not 0 < len(data) <= _LEASE_METADATA_LIMIT:
                raise LeaseError("ERR_LEASE_ARGUMENT")
            descriptor = self._api.relative(
                parent.leaf, name, directory=False, create=True, exclusive=True, durable=True
            )
            with self._temporary([descriptor]):
                self._api.validate(descriptor, False)
                buffer = ctypes.create_string_buffer(data)
                offset = 0
                while offset < len(data):
                    written = ctypes.c_uint32()
                    self._api.check(
                        self._api.kernel.WriteFile(
                            descriptor,
                            ctypes.byref(buffer, offset),
                            len(data) - offset,
                            ctypes.byref(written),
                            None,
                        )
                    )
                    if not written.value:
                        raise OSError(errno.EIO, "metadata write made no progress")
                    offset += written.value
                self._api.validate(descriptor, False)
                self._api.check(self._api.kernel.FlushFileBuffers(descriptor))

    def read_at(self, pin: object, name: str, max_bytes: int) -> bytes | None:
        with self._operation():
            return self._read_at(pin, name, max_bytes)

    def read_snapshot_at(self, pin: object, name: str, max_bytes: int) -> bytes | None:
        """Read one drained-store image; the caller owns cross-file consistency."""
        with self._operation():
            return self._read_file(pin, name, max_bytes, _LEASE_SNAPSHOT_LIMIT, 0)

    def _read_at(self, pin: object, name: str, max_bytes: int) -> bytes | None:
        return self._read_file(pin, name, max_bytes, _LEASE_METADATA_LIMIT, 1)

    def _read_file(
        self,
        pin: object,
        name: str,
        max_bytes: int,
        limit: int,
        minimum: int,
    ) -> bytes | None:
        parent = self._pin(pin, read_only=True)
        if isinstance(parent, _InstallationPin):
            if name != _INSTALLATION_SEED_NAME:
                raise LeaseError(_INSTALLATION_READ_ONLY)
            limit = min(limit, _LEASE_METADATA_LIMIT)
        self._name(name)
        if (
            not isinstance(max_bytes, int) or isinstance(max_bytes, bool)
        ) or not minimum <= max_bytes <= limit:
            raise LeaseError("ERR_LEASE_ARGUMENT")
        try:
            descriptor = self._api.relative(
                parent.leaf,
                name,
                directory=False,
                create=False,
                role=parent.role,
                installation=isinstance(parent, _InstallationPin),
            )
        except LeaseError as error:
            if error.code == "ERR_LEASE_MISSING":
                return None
            raise
        with self._temporary([descriptor]):
            before, size_before = self._api.validate(
                descriptor,
                False,
                role=parent.role,
                installation=isinstance(parent, _InstallationPin),
            )
            identity = (
                self._api.identity(descriptor) if isinstance(parent, _InstallationPin) else None
            )
            if (
                identity is not None
                and self._installation_file is not None
                and identity != self._installation_file
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            if not 0 <= size_before.size <= max_bytes:
                raise LeaseError("ERR_LEASE_SIZE")
            # Allocate for the observed file, not the remaining inventory budget.
            # The extra byte detects growth; post-read metadata also revalidates it.
            capacity = int(size_before.size) + 1
            buffer = ctypes.create_string_buffer(capacity)
            total = 0
            while total < capacity:
                count = ctypes.c_uint32()
                self._api.check(
                    self._api.kernel.ReadFile(
                        descriptor,
                        ctypes.byref(buffer, total),
                        min(64 * 1024, capacity - total),
                        ctypes.byref(count),
                        None,
                    )
                )
                if not count.value:
                    break
                total += count.value
            if total > max_bytes:
                raise LeaseError("ERR_LEASE_SIZE")
            after, size_after = self._api.validate(
                descriptor,
                False,
                role=parent.role,
                installation=isinstance(parent, _InstallationPin),
            )
            if (
                size_before.size != size_after.size
                or size_after.size != total
                or before.creation != after.creation
                or before.write != after.write
                or before.change != after.change
                or before.attributes != after.attributes
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            if isinstance(parent, _InstallationPin):
                self._pin(pin, read_only=True)
                self._installation_file = identity
            return buffer.raw[:total]


class _LinuxTime(ctypes.Structure):
    _fields_ = [
        ("seconds", ctypes.c_int64),
        ("nanoseconds", ctypes.c_uint32),
        ("reserved", ctypes.c_int32),
    ]


class _LinuxStatx(ctypes.Structure):
    # Linux UAPI statx is a fixed 256-byte structure on all supported ABIs.
    _fields_ = [
        ("mask", ctypes.c_uint32),
        ("block_size", ctypes.c_uint32),
        ("attributes", ctypes.c_uint64),
        ("links", ctypes.c_uint32),
        ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32),
        ("mode", ctypes.c_uint16),
        ("spare", ctypes.c_uint16),
        ("inode", ctypes.c_uint64),
        ("size", ctypes.c_uint64),
        ("blocks", ctypes.c_uint64),
        ("attributes_mask", ctypes.c_uint64),
        ("atime", _LinuxTime),
        ("btime", _LinuxTime),
        ("ctime", _LinuxTime),
        ("mtime", _LinuxTime),
        ("rdev_major", ctypes.c_uint32),
        ("rdev_minor", ctypes.c_uint32),
        ("dev_major", ctypes.c_uint32),
        ("dev_minor", ctypes.c_uint32),
        ("mount_id", ctypes.c_uint64),
        ("tail", ctypes.c_ubyte * 104),
    ]


_LINUX_AT_EMPTY_PATH = 0x1000
_LINUX_STATX_BASIC_STATS = 0x7FF
_LINUX_STATX_MOUNT_ID = 0x1000
_LINUX_STATX_REQUIRED = _LINUX_STATX_BASIC_STATS | _LINUX_STATX_MOUNT_ID
_LINUX_FILESYSTEMS = frozenset({"ext4", "xfs", "tmpfs"})
_LINUX_MOUNTINFO_LIMIT = 4 * 1024 * 1024
_LINUX_ALIAS_LIMIT = 256
_LINUX_PROC_ROOT = "/proc/self"
_LINUX_MOUNT_ESCAPES = {"040": " ", "011": "\t", "012": "\n", "134": "\\"}


@dataclass(frozen=True)
class _LinuxMount:
    identity: int
    parent: int
    device: int
    root: str
    point: str
    filesystem: str


def _linux_mount_path(value: str) -> str:
    def decode(match: re.Match[str]) -> str:
        try:
            return _LINUX_MOUNT_ESCAPES[match[1]]
        except KeyError as error:
            raise LeaseError("ERR_LEASE_UNSUPPORTED") from error

    path = re.sub(r"\\([0-9]{3})", decode, value)
    if (
        not path.startswith("/")
        or "\0" in path
        or (path != "/" and any(part in {"", ".", ".."} for part in path[1:].split("/")))
    ):
        raise LeaseError("ERR_LEASE_UNSUPPORTED")
    return path


def _linux_parse_mounts(contents: bytes) -> dict[int, _LinuxMount]:
    mounts: dict[int, _LinuxMount] = {}
    try:
        # The kernel separates records with LF and fields with ASCII spaces.
        # Other Unicode whitespace (and CR/VT in names) is literal path data.
        for line in contents.rstrip(b"\n").split(b"\n"):
            head, tail = line.split(b" - ", 1)
            fields, filesystem = head.split(b" "), tail.split(b" ")
            if len(fields) < 6 or len(filesystem) != 3:
                raise ValueError("invalid mountinfo fields")
            major, minor = map(int, fields[2].split(b":"))
            mount = _LinuxMount(
                int(fields[0]),
                int(fields[1]),
                getattr(os, "makedev")(major, minor),
                _linux_mount_path(os.fsdecode(fields[3])),
                _linux_mount_path(os.fsdecode(fields[4])),
                os.fsdecode(filesystem[0]),
            )
            if mount.identity <= 0 or mount.parent <= 0 or mount.identity in mounts:
                raise ValueError("invalid or duplicate mount identity")
            mounts[mount.identity] = mount
    except (ValueError, OverflowError) as error:
        raise LeaseError("ERR_LEASE_UNSUPPORTED") from error
    if not mounts:
        raise LeaseError("ERR_LEASE_UNSUPPORTED")
    return mounts


def _linux_mounts() -> dict[int, _LinuxMount]:
    descriptor = os.open(
        _LINUX_PROC_ROOT + "/mountinfo",
        os.O_RDONLY | getattr(os, "O_CLOEXEC") | getattr(os, "O_NOFOLLOW"),
    )
    try:
        value = bytearray()
        while len(value) <= _LINUX_MOUNTINFO_LIMIT:
            chunk = os.read(descriptor, min(65536, _LINUX_MOUNTINFO_LIMIT + 1 - len(value)))
            if not chunk:
                break
            value.extend(chunk)
        if len(value) > _LINUX_MOUNTINFO_LIMIT:
            raise LeaseError("ERR_LEASE_SIZE")
        return _linux_parse_mounts(bytes(value))
    finally:
        _lease_close([descriptor])


class _LinuxSecurity:
    stat: Callable[..., int]

    def __init__(self) -> None:
        if sys.platform != "linux":
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        self.lib = ctypes.CDLL(None, use_errno=True)
        try:
            native_stat = self.lib.statx
        except AttributeError as error:
            raise LeaseError("ERR_LEASE_UNSUPPORTED") from error
        native_stat.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_uint32,
            ctypes.POINTER(_LinuxStatx),
        ]
        native_stat.restype = ctypes.c_int
        self.stat = native_stat

    def observe(self, descriptor: int) -> tuple[_PosixMetadata, int]:
        info = _LinuxStatx()
        if self.stat(
            descriptor, b"", _LINUX_AT_EMPTY_PATH, _LINUX_STATX_REQUIRED, ctypes.byref(info)
        ):
            raise LeaseError("ERR_LEASE_NATIVE", ctypes.get_errno())
        if info.mask & _LINUX_STATX_REQUIRED != _LINUX_STATX_REQUIRED:
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        return (
            _PosixMetadata(
                getattr(os, "makedev")(info.dev_major, info.dev_minor),
                info.inode,
                info.mode,
                info.links,
                info.uid,
                info.gid,
                info.size,
                info.mtime.seconds * _NANOSECONDS + info.mtime.nanoseconds,
                info.ctime.seconds * _NANOSECONDS + info.ctime.nanoseconds,
            ),
            info.mount_id,
        )

    def validate(
        self, descriptor: int, ancestor: bool, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> _PosixMetadata:
        info, mount_id = self.observe(descriptor)
        mount = _linux_mounts().get(mount_id)
        if (
            mount is None
            or mount.device != info.st_dev
            or mount.filesystem not in _LINUX_FILESYSTEMS
        ):
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
        # On these POSIX ACL filesystems, group mode is the effective ACL mask.
        # Conservatively reject any untrusted write mask, even if named entries
        # happen to belong to the current user. Never infer this for NFSv4 ACLs.
        if role is DirectoryRole.PRIVATE and (
            info.st_uid not in {0, getattr(os, "geteuid")()}
            or (
                info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
                and not (ancestor and info.st_mode & stat.S_ISVTX)
            )
        ):
            raise LeaseError("ERR_LEASE_PERMISSION")
        return info


def _linux_relative(path: str, root: str) -> str | None:
    if path == root:
        return ""
    prefix = root.rstrip("/") + "/"
    return path[len(prefix) :] if path.startswith(prefix) else None


class LinuxDirectoryNative(_PosixDirectoryNative):
    """Local POSIX filesystems with checked, namespace-visible physical ancestry."""

    def __init__(self) -> None:
        self._linux = _LinuxSecurity()
        super().__init__(self._linux)

    def _descriptor_path(self, descriptor: int) -> str:
        path = os.readlink(f"/proc/self/fd/{descriptor}")
        if (
            not path.startswith("/")
            or path.endswith(" (deleted)")
            or len(os.fsencode(path)) >= _LEASE_PATH_BYTES
        ):
            raise LeaseError("ERR_LEASE_CHANGED")
        return path

    def directory_path(self, pin: object) -> str:
        with self._operation():
            parent = self._pin(pin)
            if (
                _lease_identity(self._security.validate(parent.leaf, False, parent.role))
                != parent.lineage[-1]
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            return self._descriptor_path(parent.leaf)

    def pin(self, path: str, create: bool, role: DirectoryRole = DirectoryRole.PRIVATE) -> object:
        role = DirectoryRole(role)
        with self._operation():
            if not isinstance(create, bool):
                raise LeaseError("ERR_LEASE_ARGUMENT")
            before = _linux_mounts()
            descriptors: list[int] = []
            try:
                lineage, leaf = self._walk(path, create, descriptors, role)
                identity = lineage[-1]
                ancestors = set(lineage[:-1])
                # Every alternative is independently walked, including logical
                # ancestors of bind aliases. A table path alone proves nothing.
                pending = [(path, tuple(descriptors))]
                walked = {path: (identity, leaf)}
                checked_roots: set[tuple[int, str]] = set()

                def visit(alias: str) -> tuple[str, int]:
                    if alias in walked:
                        return walked[alias]
                    if len(walked) >= _LINUX_ALIAS_LIMIT:
                        raise LeaseError("ERR_LEASE_UNSUPPORTED")
                    start = len(descriptors)
                    try:
                        selected, descriptor = self._walk(alias, False, descriptors, role)
                    except LeaseError as error:
                        if error.code == "ERR_LEASE_MISSING":
                            raise LeaseError("ERR_LEASE_CHANGED") from error
                        raise
                    walked[alias] = (selected[-1], descriptor)
                    ancestors.update(selected)
                    pending.append((alias, tuple(descriptors[start:])))
                    return walked[alias]

                while pending:
                    spelling, chain = pending.pop()
                    prefixes = ["/"]
                    if spelling != "/":
                        parts = spelling[1:].split("/")
                        prefixes += [
                            "/" + "/".join(parts[:index]) for index in range(1, len(parts) + 1)
                        ]
                    for prefix, descriptor in zip(prefixes, chain, strict=True):
                        info, mount_id = self._linux.observe(descriptor)
                        observed_identity = _lease_identity(info)
                        if prefix in walked and walked[prefix][0] != observed_identity:
                            raise LeaseError("ERR_LEASE_CHANGED")
                        walked[prefix] = (observed_identity, descriptor)
                        mount = before.get(mount_id)
                        if mount is None or mount.device != info.st_dev:
                            raise LeaseError("ERR_LEASE_CHANGED")
                        relative = _linux_relative(prefix, mount.point)
                        if relative is None:
                            raise LeaseError("ERR_LEASE_CHANGED")
                        physical = os.path.join(mount.root, relative).rstrip("/") or "/"
                        alternatives = [
                            value
                            for value in before.values()
                            if value.device == mount.device and value.filesystem == mount.filesystem
                        ]
                        filesystem_key = (mount.device, mount.filesystem)
                        if filesystem_key not in checked_roots:
                            full_roots = [value for value in alternatives if value.root == "/"]
                            if not full_roots:
                                raise LeaseError("ERR_LEASE_UNSUPPORTED")
                            for candidate in full_roots:
                                _, root_descriptor = visit(candidate.point)
                                _, root_mount_id = self._linux.observe(root_descriptor)
                                if root_mount_id != candidate.identity:
                                    # A lower stacked mount's root='/' record
                                    # does not make that filesystem root visible.
                                    raise LeaseError("ERR_LEASE_UNSUPPORTED")
                            checked_roots.add(filesystem_key)
                        for alternative in alternatives:
                            suffix = _linux_relative(physical, alternative.root)
                            if suffix is None:
                                continue
                            alias = os.path.join(alternative.point, suffix).rstrip("/") or "/"
                            selected_identity, _ = visit(alias)
                            if selected_identity != observed_identity:
                                raise LeaseError("ERR_LEASE_CHANGED")
                if _linux_mounts() != before:
                    raise LeaseError("ERR_LEASE_CHANGED")
                pin = _LeasePin(
                    descriptors, (*sorted(ancestors - {identity}), identity), leaf, role=role
                )
                self._handles.add(pin)
                return pin
            except BaseException as error:
                self._cleanup(descriptors, error)
