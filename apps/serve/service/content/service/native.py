"""Descriptor-bound exclusive publication and its durable creation marker.

No backend may fall back to linking an ordinary source pathname: that would
reintroduce the verification/publication substitution race.
"""

from __future__ import annotations

import ctypes
import errno
import os
import stat
import sys
from collections.abc import Callable
from uuid import uuid4

from service.platform import storage
from service.platform.storage import DirectoryHandle

DARWIN = "darwin"
LINUX = "linux"
WINDOWS = "win32"
CREATION_ATTRIBUTE = b"user.scholarseed.creation"
LEGACY_CREATION_ATTRIBUTE = b"user.shushen.creation"
CREATION_ATTRIBUTES = (CREATION_ATTRIBUTE, LEGACY_CREATION_ATTRIBUTE)
CREATION_MARKER_BYTES = 32
COPY_CHUNK_BYTES = 1024 * 1024
COPY_STAGING_MODE = 0o600
NATIVE_DEFAULT_FLAGS = 0
CLONE_NOFOLLOW = 0x0001
RENAME_EXCL_DARWIN = 0x00000004
RENAME_NOREPLACE_LINUX = 0x00000001
RENAME_EXCHANGE_FLAGS = {DARWIN: 0x00000002, LINUX: 0x00000002}
XATTR_CREATE_DARWIN = 0x0002
PROC_DESCRIPTOR_ROOT = "/proc/self/fd"
MISSING_ATTRIBUTE_ERRORS = frozenset(
    value
    for name in ("ENOATTR", "ENODATA", "ERANGE")
    if (value := getattr(errno, name, None)) is not None
)

_LIBC = ctypes.CDLL(None, use_errno=True) if sys.platform in (DARWIN, LINUX) else None
_RENAME_APIS = {
    DARWIN: ("renameatx_np", RENAME_EXCL_DARWIN),
    LINUX: ("renameat2", RENAME_NOREPLACE_LINUX),
}
_RENAME_SPEC = _RENAME_APIS.get(sys.platform)
_RENAME = getattr(_LIBC, _RENAME_SPEC[0], None) if _RENAME_SPEC is not None else None
if _RENAME is not None:
    _RENAME.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    _RENAME.restype = ctypes.c_int
_CLONE = getattr(_LIBC, "fclonefileat", None)
_SET_ATTRIBUTE = getattr(_LIBC, "fsetxattr", None)
_GET_ATTRIBUTE = getattr(_LIBC, "fgetxattr", None)
if sys.platform == DARWIN:
    if _CLONE is not None:
        _CLONE.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        _CLONE.restype = ctypes.c_int
    if _SET_ATTRIBUTE is not None:
        _SET_ATTRIBUTE.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_uint32,
            ctypes.c_int,
        ]
        _SET_ATTRIBUTE.restype = ctypes.c_int
    if _GET_ATTRIBUTE is not None:
        _GET_ATTRIBUTE.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_uint32,
            ctypes.c_int,
        ]
        _GET_ATTRIBUTE.restype = ctypes.c_ssize_t


def _check(result: int) -> int:
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


def _clone(source: int, directory: int, name: str) -> None:
    if _CLONE is None:
        raise OSError(errno.ENOTSUP, "descriptor publication unsupported")
    _check(_CLONE(source, directory, os.fsencode(name), CLONE_NOFOLLOW))


def rename_exclusive(
    source_directory: DirectoryHandle,
    source: str,
    directory: DirectoryHandle,
    name: str,
) -> None:
    """Rename between pinned directories without replacing any destination entry.

    The kernel guards destination creation atomically, including dangling links.
    This does not bind a mutable source entry to a previously inspected inode.
    Unsupported kernels/filesystems fail explicitly; plain rename is not a fallback.
    """
    if sys.platform == WINDOWS:
        os.rename(source_directory.child(source), directory.child(name))
        return
    if _RENAME is None or _RENAME_SPEC is None:
        raise OSError(errno.ENOTSUP, "exclusive rename unsupported")
    if any(
        not value or value in (".", "..") or "/" in value or "\x00" in value
        for value in (source, name)
    ):
        raise ValueError("rename requires a basename")
    _check(
        _RENAME(
            source_directory.fileno(),
            os.fsencode(source),
            directory.fileno(),
            os.fsencode(name),
            _RENAME_SPEC[1],
        )
    )


def _link(source: int, directory: DirectoryHandle, name: str) -> None:
    # With dst_dir_fd supplied, Python uses linkat; AT_SYMLINK_FOLLOW resolves
    # the kernel's fd reference, not the mutable staging pathname.
    os.link(
        f"{PROC_DESCRIPTOR_ROOT}/{source}",
        name,
        dst_dir_fd=directory.fileno(),
        follow_symlinks=True,
    )


def exchange_entries(directory: DirectoryHandle, source: str, target: str) -> None:
    """Atomically swap two entries, keeping the displaced file recoverable."""
    if sys.platform == WINDOWS:
        temporary = f".scholarseed-exchange-{uuid4().hex}"
        source_path = directory.child(source)
        target_path = directory.child(target)
        temporary_path = directory.child(temporary)
        os.rename(target_path, temporary_path)
        try:
            os.rename(source_path, target_path)
            os.rename(temporary_path, source_path)
        except BaseException:
            if target_path.exists() and not source_path.exists():
                os.rename(target_path, source_path)
            if temporary_path.exists() and not target_path.exists():
                os.rename(temporary_path, target_path)
            raise
        return
    flags = RENAME_EXCHANGE_FLAGS.get(sys.platform)
    if _RENAME is None or flags is None:
        raise OSError(errno.ENOTSUP, "atomic exchange unsupported")
    if any(
        not value or value in (".", "..") or "/" in value or "\x00" in value
        for value in (source, target)
    ):
        raise ValueError("exchange requires a basename")
    _check(
        _RENAME(
            directory.fileno(),
            os.fsencode(source),
            directory.fileno(),
            os.fsencode(target),
            flags,
        )
    )


_PUBLISHERS: dict[str, Callable[[int, DirectoryHandle, str], None]] = {
    DARWIN: lambda source, directory, name: _clone(source, directory.fileno(), name),
    LINUX: _link,
}


def publish_descriptor(source: int, directory: DirectoryHandle, name: str) -> bool:
    """Publish exclusively and report whether the staging name was consumed."""
    if sys.platform == WINDOWS:
        os.rename(storage.path_for_file(source), directory.child(name))
        return True
    publisher = _PUBLISHERS.get(sys.platform)
    if publisher is None:
        raise OSError(errno.ENOTSUP, "descriptor publication unsupported")
    publisher(source, directory, name)
    return False


def copy_descriptor_exclusive(
    source: int,
    directory: DirectoryHandle,
    name: str,
    mode: int,
    *,
    marker: str = "",
) -> os.stat_result:
    """Create an independent destination file without consuming the source."""

    if not stat.S_ISREG(os.fstat(source).st_mode):
        raise OSError(errno.EINVAL, "copy source is not a regular file")
    target = directory.open(
        name,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | storage.NOFOLLOW,
        COPY_STAGING_MODE,
    )
    identity = os.fstat(target)
    source_position = os.lseek(source, 0, os.SEEK_CUR)
    try:
        if not stat.S_ISREG(identity.st_mode):
            raise OSError(errno.EINVAL, "copy target is not a regular file")
        if marker:
            set_creation_marker(target, marker)
        os.lseek(source, 0, os.SEEK_SET)
        with os.fdopen(os.dup(target), "wb") as stream:
            while chunk := os.read(source, COPY_CHUNK_BYTES):
                stream.write(chunk)
            stream.flush()
        storage.preserve_mode(target, mode)
        os.fsync(target)
        directory.sync()
        return os.fstat(target)
    except BaseException:
        os.close(target)
        target = -1
        try:
            current = directory.stat(name)
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                directory.unlink(name)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.lseek(source, source_position, os.SEEK_SET)
        if target >= 0:
            os.close(target)


def sync_published_descriptor(source: int, directory: DirectoryHandle, name: str) -> None:
    """Durably sync the published regular file with platform-correct access.

    Windows publication renames the file referenced by ``source``.  Keep using
    that writable CRT descriptor because ``os.fsync`` rejects read-only Windows
    descriptors.  POSIX publication may clone the source into a distinct inode,
    so sync the published destination instead.
    """

    descriptor = source
    close_descriptor = False
    if sys.platform != WINDOWS:
        descriptor = directory.open(name, os.O_RDONLY | storage.NOFOLLOW | storage.NONBLOCK)
        close_descriptor = True
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError(errno.EINVAL, "published entry is not a regular file")
        os.fsync(descriptor)
    finally:
        if close_descriptor:
            os.close(descriptor)


def set_creation_marker(descriptor: int, marker: str) -> None:
    raw = marker.encode("ascii")
    if len(raw) != CREATION_MARKER_BYTES:
        raise ValueError("invalid creation marker")
    if sys.platform == WINDOWS:
        storage.set_marker(descriptor, marker)
        return
    if sys.platform == DARWIN:
        if _SET_ATTRIBUTE is None:
            raise OSError(errno.ENOTSUP, "creation marker unsupported")
        buffer = ctypes.create_string_buffer(raw)
        _check(
            _SET_ATTRIBUTE(
                descriptor,
                CREATION_ATTRIBUTE,
                buffer,
                len(raw),
                NATIVE_DEFAULT_FLAGS,
                XATTR_CREATE_DARWIN,
            )
        )
        return
    setter = getattr(os, "setxattr", None)
    create_flag = getattr(os, "XATTR_CREATE", None)
    if setter is None or create_flag is None:
        raise OSError(errno.ENOTSUP, "creation marker unsupported")
    setter(descriptor, CREATION_ATTRIBUTE, raw, flags=create_flag)


def _read_attribute(descriptor: int, attribute: bytes) -> bytes:
    if sys.platform == WINDOWS:
        return storage.marker(descriptor).encode("ascii")
    if sys.platform == DARWIN:
        if _GET_ATTRIBUTE is None:
            raise OSError(errno.ENOTSUP, "creation marker unsupported")
        buffer = ctypes.create_string_buffer(CREATION_MARKER_BYTES)
        size = _check(
            _GET_ATTRIBUTE(
                descriptor,
                attribute,
                buffer,
                len(buffer),
                NATIVE_DEFAULT_FLAGS,
                NATIVE_DEFAULT_FLAGS,
            )
        )
        raw = buffer.raw[:size]
    else:
        getter = getattr(os, "getxattr", None)
        if getter is None:
            raise OSError(errno.ENOTSUP, "creation marker unsupported")
        raw = getter(descriptor, attribute)
    return raw


def _read_marker(descriptor: int) -> bytes:
    if sys.platform == WINDOWS:
        return storage.marker(descriptor).encode("ascii")
    for attribute in CREATION_ATTRIBUTES:
        try:
            return _read_attribute(descriptor, attribute)
        except OSError as error:
            if error.errno not in MISSING_ATTRIBUTE_ERRORS:
                raise
    return b""


def creation_marker(descriptor: int) -> str:
    try:
        raw = _read_marker(descriptor)
    except OSError as error:
        if error.errno in MISSING_ATTRIBUTE_ERRORS:
            return ""
        raise
    if len(raw) != CREATION_MARKER_BYTES:
        return ""
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError:
        return ""
