"""Cross-platform pinned-directory primitives for product filesystem domains."""

from __future__ import annotations

import ctypes
import errno
import os
import stat
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Protocol, cast

_msvcrt: ModuleType | None
try:
    import msvcrt as _msvcrt
except ModuleNotFoundError:
    _msvcrt = None

WINDOWS_PLATFORM = "nt"
DIRECTORY_MODE = 0o700
DIRECTORY_PATH_INVALID = "filesystem_directory_path_invalid"
FILE_ATTRIBUTE_DIRECTORY = 0x00000010
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
FILE_ATTRIBUTE_NORMAL = 0x00000080
FILE_READ_ATTRIBUTES = 0x00000080
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


class FileAttributeTagInfo(ctypes.Structure):
    _fields_ = [("file_attributes", wintypes.DWORD), ("reparse_tag", wintypes.DWORD)]


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
    _KERNEL32.CloseHandle.argtypes = [wintypes.HANDLE]
    _KERNEL32.CloseHandle.restype = wintypes.BOOL
    _KERNEL32.GetFinalPathNameByHandleW.argtypes = [
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    _KERNEL32.GetFinalPathNameByHandleW.restype = wintypes.DWORD


def _raise_windows_error() -> None:
    code = _GET_LAST_ERROR() if callable(_GET_LAST_ERROR) else 0
    raise OSError(code, f"Windows filesystem error {code}")


def _validate_part(part: str) -> None:
    if part in {"", ".", ".."} or "/" in part or "\\" in part:
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


def _open_windows_directory(path: Path) -> int:
    if _KERNEL32 is None:
        raise OSError("Windows filesystem backend unavailable")
    handle = _KERNEL32.CreateFileW(
        str(path),
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
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
        _KERNEL32.CloseHandle(handle)
        _raise_windows_error()
    if not info.file_attributes & FILE_ATTRIBUTE_DIRECTORY:
        _KERNEL32.CloseHandle(handle)
        raise NotADirectoryError(str(path))
    if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
        _KERNEL32.CloseHandle(handle)
        raise OSError("reparse-point directory rejected")
    return int(handle)


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
        str(path),
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


@dataclass
class DirectoryHandle:
    """Pinned authorized directory; platform resources are closed as one unit."""

    path: Path
    descriptor: int | None = None
    native_handles: tuple[int, ...] = ()
    closed: bool = False

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
        if self.descriptor is not None:
            os.close(self.descriptor)
        if _KERNEL32 is not None:
            for handle in reversed(self.native_handles):
                if not _KERNEL32.CloseHandle(handle):
                    _raise_windows_error()

    def sync(self) -> None:
        if self.descriptor is not None:
            os.fsync(self.descriptor)

    def child(self, name: str) -> Path:
        _validate_part(name)
        return self.path / name

    def mkdir(self, name: str, mode: int = DIRECTORY_MODE) -> None:
        target = self.child(name)
        if self.descriptor is not None:
            os.mkdir(name, mode, dir_fd=self.descriptor)
            self.sync()
            return
        os.mkdir(target, mode)

    def stat(self, name: str) -> os.stat_result:
        target = self.child(name)
        if self.descriptor is not None:
            return os.stat(name, dir_fd=self.descriptor, follow_symlinks=False)
        return target.stat(follow_symlinks=False)

    def open(self, name: str, flags: int, mode: int = 0o777) -> int:
        target = self.child(name)
        if self.descriptor is not None:
            return os.open(name, flags, mode, dir_fd=self.descriptor)
        del mode
        return _open_windows_file(target, flags)

    def unlink(self, name: str) -> None:
        target = self.child(name)
        if self.descriptor is not None:
            os.unlink(name, dir_fd=self.descriptor)
            self.sync()
            return
        target.unlink()


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
        os.fchmod(descriptor, mode)


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
    with stream.open("xb") as handle:
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
                raw = Path(f"{path_for_file(descriptor)}{stream}").read_bytes()
                break
            except FileNotFoundError:
                continue
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError:
        return ""


def open_directory(root: Path, parts: tuple[str, ...], *, create: bool = False) -> DirectoryHandle:
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
        handles.append(_open_windows_directory(path))
        for part, may_create in steps:
            _validate_part(part)
            path /= part
            if may_create:
                try:
                    os.mkdir(path, DIRECTORY_MODE)
                except FileExistsError:
                    pass
            handles.append(_open_windows_directory(path))
        return DirectoryHandle(path=path, native_handles=tuple(handles))
    except BaseException:
        if _KERNEL32 is not None:
            for handle in reversed(handles):
                _KERNEL32.CloseHandle(handle)
        raise


def is_regular(identity: os.stat_result) -> bool:
    return stat.S_ISREG(identity.st_mode)


__all__ = [
    "DIRECTORY",
    "NOFOLLOW",
    "NONBLOCK",
    "DirectoryHandle",
    "canonical_root",
    "marker",
    "open_directory",
    "open_parent",
    "path_for_file",
    "preserve_mode",
    "set_marker",
    "stable_read_matches",
]
