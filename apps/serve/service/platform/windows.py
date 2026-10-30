"""Handle-relative storage operations and domain-specific Windows ACL admission."""

from __future__ import annotations

import ctypes
import errno
import os
from ctypes import wintypes
from enum import IntEnum
from typing import Any, Callable, Literal, NoReturn, overload

from service.platform import security as permission

WINDOWS = "nt"
READ = 0x80000000
WRITE = 0x40000000
DELETE = 0x00010000
DELETE_CHILD = 0x00000040
READ_ATTRIBUTES = 0x00000080
READ_CONTROL = 0x00020000
WRITE_DAC = 0x00040000
WRITE_OWNER = 0x00080000
PROTECTED_DACL_INFORMATION = 0x80000000
SECURITY_ACCESS = READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | WRITE_OWNER
SYNCHRONIZE = 0x00100000
SHARE_READ = 1
SHARE_WRITE = 2
OPEN = 1
CREATE = 2
OPEN_IF = 3
DIRECTORY = 0x00000001
SYNCHRONOUS = 0x00000020
NON_DIRECTORY = 0x00000040
OPEN_REPARSE = 0x00200000
REPARSE_ATTRIBUTE = 0x400
DIRECTORY_ATTRIBUTE = 0x10
TAG_INFO = 9
FILE_ID_INFO = 18
FILE_ID_BYTES = 16
RENAME_INFORMATION = 10
DISPOSITION_INFO = 4
FILE_OBJECT = 1
OWNER_INFORMATION = 1
DACL_INFORMATION = 4
TOKEN_QUERY = 8
TOKEN_USER = 1
TOKEN_GROUPS = 2
GROUP_ENABLED = 0x00000004
GROUP_DENY_ONLY = 0x00000010
GROUP_LOGON_ID = 0xC0000000
READ_EXECUTE_ACCESS = 0xA01200A9
SECURITY_MAX_SID_SIZE = 68
VALID_ACE_FLAGS = 0x1F
ACL_SIZE_INFORMATION = 2
ALLOW_ACE = 0
SDDL_REVISION = 1
LOCK_EXCLUSIVE_IMMEDIATE = 3
DIRECTORY_INFORMATION = 1
STATUS_NO_MORE_FILES = 0x80000006
DIRECTORY_QUERY_BYTES = 1024
OBJECT_CASE_INSENSITIVE = 0x40
ERROR_FILE_NOT_FOUND = 2
ERROR_ALREADY_EXISTS = 183
INVALID_HANDLE = ctypes.c_void_p(-1).value
GET_LAST_ERROR: Callable[[], int] | None = getattr(ctypes, "get_last_error", None)

DLL = getattr(ctypes, "WinDLL", None)
KERNEL = DLL("kernel32", use_last_error=True) if os.name == WINDOWS and DLL else None
SECURITY = DLL("advapi32", use_last_error=True) if os.name == WINDOWS and DLL else None
NT = DLL("ntdll") if os.name == WINDOWS and DLL else None


class ReleaseError(OSError):
    code = "ERR_LEASE_RELEASE"


class WellKnownSid(IntEnum):
    """Windows WELL_KNOWN_SID_TYPE values; never machine-specific identities."""

    EVERYONE = 1
    SYSTEM = 22
    ADMINISTRATORS = 26
    OWNER_RIGHTS = 71


class UnicodeString(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.USHORT),
        ("maximum", wintypes.USHORT),
        ("buffer", wintypes.LPWSTR),
    ]


class ObjectAttributes(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.ULONG),
        ("root", wintypes.HANDLE),
        ("name", ctypes.POINTER(UnicodeString)),
        ("attributes", wintypes.ULONG),
        ("security", wintypes.LPVOID),
        ("quality", wintypes.LPVOID),
    ]


class IoStatus(ctypes.Structure):
    _fields_ = [("status", ctypes.c_void_p), ("information", ctypes.c_size_t)]


class TagInfo(ctypes.Structure):
    _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]


class FileInfo(ctypes.Structure):
    _fields_ = [
        ("attributes", wintypes.DWORD),
        ("created", wintypes.FILETIME),
        ("accessed", wintypes.FILETIME),
        ("written", wintypes.FILETIME),
        ("volume", wintypes.DWORD),
        ("size_high", wintypes.DWORD),
        ("size_low", wintypes.DWORD),
        ("links", wintypes.DWORD),
        ("index_high", wintypes.DWORD),
        ("index_low", wintypes.DWORD),
    ]


class FileIdentity(ctypes.Structure):
    _fields_ = [
        ("volume", ctypes.c_ulonglong),
        ("identifier", ctypes.c_ubyte * FILE_ID_BYTES),
    ]


class SidAndAttributes(ctypes.Structure):
    _fields_ = [("sid", wintypes.LPVOID), ("attributes", wintypes.DWORD)]


class TokenGroups(ctypes.Structure):
    _fields_ = [("count", wintypes.DWORD), ("groups", SidAndAttributes * 1)]


class AclSize(ctypes.Structure):
    _fields_ = [("count", wintypes.DWORD), ("used", wintypes.DWORD), ("free", wintypes.DWORD)]


class AllowedAce(ctypes.Structure):
    _fields_ = [
        ("kind", ctypes.c_ubyte),
        ("flags", ctypes.c_ubyte),
        ("size", wintypes.USHORT),
        ("mask", wintypes.DWORD),
        ("sid", wintypes.DWORD),
    ]


class RenameInfo(ctypes.Structure):
    _fields_ = [
        ("replace", wintypes.BOOLEAN),
        ("root", wintypes.HANDLE),
        ("length", wintypes.DWORD),
        ("name", wintypes.WCHAR * 1),
    ]


class Overlapped(ctypes.Structure):
    _fields_ = [
        ("internal", ctypes.c_size_t),
        ("internal_high", ctypes.c_size_t),
        ("offset", wintypes.DWORD),
        ("offset_high", wintypes.DWORD),
        ("event", wintypes.HANDLE),
    ]


class DirectoryInformation(ctypes.Structure):
    _fields_ = [
        ("next", ctypes.c_uint32),
        ("index", ctypes.c_uint32),
        ("created", ctypes.c_int64),
        ("accessed", ctypes.c_int64),
        ("written", ctypes.c_int64),
        ("changed", ctypes.c_int64),
        ("size", ctypes.c_int64),
        ("allocation", ctypes.c_int64),
        ("attributes", ctypes.c_uint32),
        ("length", ctypes.c_uint32),
        ("name", ctypes.c_uint16 * 1),
    ]


def _configure(library, name, arguments, result):
    function = getattr(library, name)
    function.argtypes = arguments
    function.restype = result


if KERNEL is not None and SECURITY is not None and NT is not None:
    _configure(
        SECURITY,
        "CreateWellKnownSid",
        [ctypes.c_int, wintypes.LPVOID, wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD)],
        wintypes.BOOL,
    )
    _configure(
        NT,
        "NtSetSecurityObject",
        [wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID],
        ctypes.c_long,
    )
    _configure(
        KERNEL,
        "ReOpenFile",
        [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD],
        wintypes.HANDLE,
    )
    _configure(
        SECURITY,
        "SetSecurityInfo",
        [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.LPVOID,
            wintypes.LPVOID,
        ],
        wintypes.DWORD,
    )
    _configure(
        SECURITY,
        "GetSecurityDescriptorOwner",
        [wintypes.LPVOID, ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.BOOL)],
        wintypes.BOOL,
    )
    _configure(
        SECURITY,
        "GetSecurityDescriptorDacl",
        [
            wintypes.LPVOID,
            ctypes.POINTER(wintypes.BOOL),
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.BOOL),
        ],
        wintypes.BOOL,
    )
    _configure(KERNEL, "GetCurrentProcess", [], wintypes.HANDLE)
    _configure(KERNEL, "CloseHandle", [wintypes.HANDLE], wintypes.BOOL)
    _configure(KERNEL, "LocalFree", [wintypes.LPVOID], wintypes.LPVOID)
    _configure(
        KERNEL,
        "GetFileInformationByHandle",
        [wintypes.HANDLE, ctypes.POINTER(FileInfo)],
        wintypes.BOOL,
    )
    _configure(
        KERNEL,
        "GetFileInformationByHandleEx",
        [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD],
        wintypes.BOOL,
    )
    _configure(
        KERNEL,
        "SetFileInformationByHandle",
        [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD],
        wintypes.BOOL,
    )
    _configure(
        KERNEL,
        "LockFileEx",
        [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(Overlapped),
        ],
        wintypes.BOOL,
    )
    _configure(
        KERNEL,
        "UnlockFileEx",
        [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(Overlapped),
        ],
        wintypes.BOOL,
    )
    _configure(
        SECURITY,
        "OpenProcessToken",
        [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)],
        wintypes.BOOL,
    )
    _configure(
        SECURITY,
        "GetTokenInformation",
        [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ],
        wintypes.BOOL,
    )
    _configure(
        SECURITY,
        "ConvertSidToStringSidW",
        [wintypes.LPVOID, ctypes.POINTER(wintypes.LPWSTR)],
        wintypes.BOOL,
    )
    _configure(
        SECURITY,
        "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.ULONG),
        ],
        wintypes.BOOL,
    )
    _configure(SECURITY, "IsValidAcl", [wintypes.LPVOID], wintypes.BOOL)
    _configure(
        SECURITY,
        "GetSecurityInfo",
        [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.LPVOID),
            ctypes.POINTER(wintypes.LPVOID),
        ],
        wintypes.DWORD,
    )
    _configure(
        SECURITY,
        "GetAclInformation",
        [wintypes.LPVOID, wintypes.LPVOID, wintypes.DWORD, ctypes.c_int],
        wintypes.BOOL,
    )
    _configure(
        SECURITY,
        "GetAce",
        [wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID)],
        wintypes.BOOL,
    )
    _configure(
        NT,
        "NtCreateFile",
        [
            ctypes.POINTER(wintypes.HANDLE),
            wintypes.DWORD,
            ctypes.POINTER(ObjectAttributes),
            ctypes.POINTER(IoStatus),
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
        ],
        ctypes.c_long,
    )
    _configure(NT, "RtlNtStatusToDosError", [ctypes.c_long], wintypes.ULONG)
    _configure(
        NT,
        "NtSetInformationFile",
        [
            wintypes.HANDLE,
            ctypes.POINTER(IoStatus),
            wintypes.LPVOID,
            wintypes.ULONG,
            ctypes.c_int,
        ],
        ctypes.c_long,
    )
    _configure(
        NT,
        "NtQueryDirectoryFile",
        [
            wintypes.HANDLE,
            wintypes.HANDLE,
            wintypes.LPVOID,
            wintypes.LPVOID,
            ctypes.POINTER(IoStatus),
            wintypes.LPVOID,
            wintypes.ULONG,
            ctypes.c_int,
            wintypes.BOOLEAN,
            wintypes.LPVOID,
            wintypes.BOOLEAN,
        ],
        ctypes.c_long,
    )


def _native(library: Any) -> Any:
    if library is None:
        raise OSError("Windows native backend unavailable")
    return library


def _handle(handle) -> int:
    value = handle.value
    if value is None or value == 0 or value == INVALID_HANDLE:
        raise OSError("invalid Windows native handle")
    return int(value)


def _error(code: int) -> OSError:
    factory = getattr(ctypes, "WinError", None)
    error = OSError(code, "Windows native filesystem error") if factory is None else factory(code)
    if code == 5:
        permission.record_denial(error, "windows_api", "inspect", "os_access_denied")
    return error


@overload
def check(success: Literal[False]) -> NoReturn: ...


@overload
def check(success: object) -> None: ...


def check(success: object) -> None:
    if not success:
        if not callable(GET_LAST_ERROR):
            raise OSError("Windows error API unavailable")
        raise _error(GET_LAST_ERROR())


def close(handle: int) -> None:
    try:
        check(_native(KERNEL).CloseHandle(handle))
    except OSError as error:
        raise ReleaseError(*error.args) from error


def sid_text(sid) -> str:
    text = wintypes.LPWSTR()
    check(_native(SECURITY).ConvertSidToStringSidW(sid, ctypes.byref(text)))
    try:
        if text.value is None:
            raise OSError("empty Windows SID")
        return text.value
    finally:
        _native(KERNEL).LocalFree(ctypes.cast(text, wintypes.LPVOID))


def well_known_sid(kind: WellKnownSid) -> bytes:
    """Resolve a standard identity through Windows for every storage consumer."""
    size = wintypes.DWORD(SECURITY_MAX_SID_SIZE)
    buffer = ctypes.create_string_buffer(size.value)
    check(_native(SECURITY).CreateWellKnownSid(kind, None, buffer, ctypes.byref(size)))
    return buffer.raw[: size.value]


def _token_information(kind: int):
    token = wintypes.HANDLE()
    check(
        _native(SECURITY).OpenProcessToken(
            _native(KERNEL).GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)
        )
    )
    try:
        size = wintypes.DWORD()
        _native(SECURITY).GetTokenInformation(token, kind, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        check(
            _native(SECURITY).GetTokenInformation(
                token, kind, buffer, size.value, ctypes.byref(size)
            )
        )
        return buffer
    finally:
        close(_handle(token))


def current_sid() -> str:
    buffer = _token_information(TOKEN_USER)
    return sid_text(ctypes.cast(buffer, ctypes.POINTER(wintypes.LPVOID))[0])


def current_groups(*, required_attributes: int = 0, excluded_attributes: int = 0) -> frozenset[str]:
    """Token membership for owner compatibility, never an access grant.

    UAC deny-only groups still identify membership: a normal process must be
    able to read a private file created with its elevated token's default owner.
    The DACL and native open enforce actual access independently.
    """
    buffer = _token_information(TOKEN_GROUPS)
    info = ctypes.cast(buffer, ctypes.POINTER(TokenGroups)).contents
    groups = (SidAndAttributes * info.count).from_buffer(buffer, TokenGroups.groups.offset)
    return frozenset(
        sid_text(group.sid)
        for group in groups
        if group.attributes & required_attributes == required_attributes
        and not group.attributes & excluded_attributes
    )


def current_logon_sids() -> frozenset[str]:
    """Only enabled logon identities of this token, never arbitrary group membership."""
    return current_groups(
        required_attributes=GROUP_LOGON_ID | GROUP_ENABLED,
        excluded_attributes=GROUP_DENY_ONLY,
    )


def _private_owner(owner: str, user: str) -> bool:
    administrators = sid_text(well_known_sid(WellKnownSid.ADMINISTRATORS))
    return permission.private_owner(
        owner, user, owner != user and owner == administrators and owner in current_groups()
    )


def validate_private(handle: int) -> None:
    """Accept private Windows principals without rewriting existing security.

    Administrators and SYSTEM are the same trusted machine authorities used by
    directory admission. Codex's OWNER RIGHTS is an alias of the validated owner,
    never an independent trusted principal. Other users (even read-only ACEs)
    remain forbidden for private configuration content. A non-inheritable directory
    attribute-only ACE exposes no listing or file content and is permitted.
    Current-token logon identities may only read/execute, as in Windows default
    DACLs; they cannot become an owner or grant write authority.
    """
    owner, dacl, descriptor = wintypes.LPVOID(), wintypes.LPVOID(), wintypes.LPVOID()
    code = _native(SECURITY).GetSecurityInfo(
        handle,
        FILE_OBJECT,
        OWNER_INFORMATION | DACL_INFORMATION,
        ctypes.byref(owner),
        None,
        ctypes.byref(dacl),
        None,
        ctypes.byref(descriptor),
    )
    denial_profile, denial_stage, denial_reason = "private_owner", "owner", "policy_denied"
    try:
        if code:
            raise _error(code)
        user = current_sid()
        if not owner:
            denial_reason = "invalid_descriptor"
            raise PermissionError("private Windows owner/DACL required")
        if not _private_owner(sid_text(owner), user):
            denial_reason = "untrusted_owner"
            raise PermissionError("private Windows owner/DACL required")
        denial_profile, denial_stage = "private_writer", "acl"
        if not dacl or not _native(SECURITY).IsValidAcl(dacl):
            denial_reason = "invalid_descriptor"
            raise PermissionError("private Windows owner/DACL required")
        size = AclSize()
        check(
            _native(SECURITY).GetAclInformation(
                dacl, ctypes.byref(size), ctypes.sizeof(size), ACL_SIZE_INFORMATION
            )
        )
        if not size.count:
            raise PermissionError("private Windows DACL required")
        owner_rights = sid_text(well_known_sid(WellKnownSid.OWNER_RIGHTS))
        logons = current_logon_sids()
        tag = TagInfo()
        check(
            _native(KERNEL).GetFileInformationByHandleEx(
                handle, TAG_INFO, ctypes.byref(tag), ctypes.sizeof(tag)
            )
        )
        directory = bool(tag.attributes & DIRECTORY_ATTRIBUTE) and not bool(
            tag.attributes & REPARSE_ATTRIBUTE
        )
        for index in range(size.count):
            pointer = wintypes.LPVOID()
            check(_native(SECURITY).GetAce(dacl, index, ctypes.byref(pointer)))
            ace = ctypes.cast(pointer, ctypes.POINTER(AllowedAce)).contents
            if ace.kind != ALLOW_ACE or ace.flags & ~VALID_ACE_FLAGS:
                raise PermissionError("unsupported private Windows ACE")
            principal = sid_text(_handle(pointer) + AllowedAce.sid.offset)
            if principal == owner_rights:
                principal = sid_text(owner)
            logon_read = principal in logons and not ace.mask & ~READ_EXECUTE_ACCESS
            metadata_only = directory and ace.flags == 0 and ace.mask == READ_ATTRIBUTES
            if (
                not permission.private_writer(principal, user)
                and not logon_read
                and not metadata_only
            ):
                raise PermissionError("broad Windows DACL rejected")
    except Exception as error:
        permission.record_denial(error, denial_profile, denial_stage, denial_reason)
        raise
    finally:
        if descriptor:
            _native(KERNEL).LocalFree(descriptor)


def restrict_private(handle: int) -> None:
    """Tighten a qualified product root without taking another user's ownership."""
    try:
        owner, descriptor = wintypes.LPVOID(), wintypes.LPVOID()
        code = _native(SECURITY).GetSecurityInfo(
            handle,
            FILE_OBJECT,
            OWNER_INFORMATION,
            ctypes.byref(owner),
            None,
            None,
            None,
            ctypes.byref(descriptor),
        )
        try:
            if code:
                raise _error(code)
            if not owner or not _private_owner(sid_text(owner), current_sid()):
                raise PermissionError("private Windows owner required")
        finally:
            if descriptor:
                _native(KERNEL).LocalFree(descriptor)
        try:
            validate_private(handle)
        except PermissionError:
            protect_private(handle, propagate=False)
    except Exception as error:
        permission.record_denial(error, "private_owner", "owner", "untrusted_owner")
        raise


def protect_private(handle: int, *, propagate: bool = True) -> None:
    """Set an owner-only protected DACL on a pinned, non-reparse object."""
    try:
        tag, info = TagInfo(), FileInfo()
        check(
            _native(KERNEL).GetFileInformationByHandleEx(
                handle, TAG_INFO, ctypes.byref(tag), ctypes.sizeof(tag)
            )
        )
        check(_native(KERNEL).GetFileInformationByHandle(handle, ctypes.byref(info)))
        if tag.attributes & REPARSE_ATTRIBUTE:
            raise PermissionError("private ACL refuses reparse points")
        directory = bool(tag.attributes & DIRECTORY_ATTRIBUTE)
        if not directory and info.links != 1:
            raise PermissionError("private ACL refuses multiple-link files")
        user = current_sid()
        inheritance = "OICI" if directory else ""
        descriptor = wintypes.LPVOID()
        check(
            _native(SECURITY).ConvertStringSecurityDescriptorToSecurityDescriptorW(
                f"O:{user}D:P(A;{inheritance};FA;;;{user})",
                SDDL_REVISION,
                ctypes.byref(descriptor),
                None,
            )
        )
        try:
            owner, dacl = wintypes.LPVOID(), wintypes.LPVOID()
            defaulted, present = wintypes.BOOL(), wintypes.BOOL()
            check(
                _native(SECURITY).GetSecurityDescriptorOwner(
                    descriptor, ctypes.byref(owner), ctypes.byref(defaulted)
                )
            )
            check(
                _native(SECURITY).GetSecurityDescriptorDacl(
                    descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)
                )
            )
            if not present.value or not dacl or not owner:
                raise PermissionError("private security descriptor lacks owner/DACL")
            information = OWNER_INFORMATION | DACL_INFORMATION | PROTECTED_DACL_INFORMATION
            if propagate:
                code = _native(SECURITY).SetSecurityInfo(
                    handle,
                    FILE_OBJECT,
                    information,
                    owner,
                    None,
                    dacl,
                    None,
                )
                if code:
                    raise _error(code)
            else:
                status = _native(NT).NtSetSecurityObject(handle, information, descriptor)
                if status < 0:
                    raise _error(_native(NT).RtlNtStatusToDosError(status))
            validate_private(handle)
        finally:
            _native(KERNEL).LocalFree(descriptor)
    except Exception as error:
        permission.record_denial(error, "private_writer", "grant", "invalid_descriptor")
        raise


def protect_open_file(handle: int) -> None:
    """Reopen the same file object for ACL access; never resolve its pathname again."""
    reopened = _native(KERNEL).ReOpenFile(handle, SECURITY_ACCESS, SHARE_READ | SHARE_WRITE, 0)
    if reopened is None or reopened == INVALID_HANDLE:
        check(False)
    try:
        protect_private(int(reopened))
    finally:
        close(int(reopened))


def identity(handle: int) -> tuple[int, int]:
    info = FileIdentity()
    check(
        _native(KERNEL).GetFileInformationByHandleEx(
            handle, FILE_ID_INFO, ctypes.byref(info), ctypes.sizeof(info)
        )
    )
    return info.volume, int.from_bytes(info.identifier, "little")


def open_relative(
    parent: int,
    name: str,
    *,
    directory: bool | None,
    disposition: int = OPEN,
    access: int = READ | SYNCHRONIZE,
    share: int = SHARE_READ,
    private: bool = True,
) -> int:
    """Open product data using OS access; private controls creation only.

    Existing data ACLs are preserved and do not need to match our newly-created
    descriptor. Explicit protection and sandbox admission retain their own checks.
    """
    if NT is None:
        raise OSError("Windows native backend unavailable")
    encoded = name.encode("utf-16-le")
    buffer = ctypes.create_unicode_buffer(name)
    string = UnicodeString(len(encoded), len(encoded), ctypes.cast(buffer, wintypes.LPWSTR))
    security = wintypes.LPVOID()
    handle = wintypes.HANDLE()
    if private and disposition != OPEN:
        check(
            _native(SECURITY).ConvertStringSecurityDescriptorToSecurityDescriptorW(
                f"O:{current_sid()}D:P(A;;FA;;;{current_sid()})(A;;FA;;;SY)",
                SDDL_REVISION,
                ctypes.byref(security),
                None,
            )
        )
    try:
        attributes = ObjectAttributes(
            ctypes.sizeof(ObjectAttributes),
            parent,
            ctypes.pointer(string),
            OBJECT_CASE_INSENSITIVE,
            security,
            None,
        )
        status = IoStatus()
        result = _native(NT).NtCreateFile(
            ctypes.byref(handle),
            access,
            ctypes.byref(attributes),
            ctypes.byref(status),
            None,
            0,
            share,
            disposition,
            SYNCHRONOUS
            | OPEN_REPARSE
            | (0 if directory is None else DIRECTORY if directory else NON_DIRECTORY),
            None,
            0,
        )
        if result < 0:
            code = _native(NT).RtlNtStatusToDosError(result)
            if code == ERROR_FILE_NOT_FOUND:
                raise FileNotFoundError(code, "missing private entry")
            if code == ERROR_ALREADY_EXISTS:
                raise FileExistsError(code, "private entry exists")
            raise _error(code)
        try:
            tag, info = TagInfo(), FileInfo()
            check(
                _native(KERNEL).GetFileInformationByHandleEx(
                    handle, TAG_INFO, ctypes.byref(tag), ctypes.sizeof(tag)
                )
            )
            check(_native(KERNEL).GetFileInformationByHandle(handle, ctypes.byref(info)))
            if tag.attributes & REPARSE_ATTRIBUTE or (
                directory is not None and bool(tag.attributes & DIRECTORY_ATTRIBUTE) != directory
            ):
                raise OSError("reparse or incorrect entry type rejected")
            if not tag.attributes & DIRECTORY_ATTRIBUTE and info.links != 1:
                raise OSError("multiple-link private file rejected")
            return _handle(handle)
        except BaseException:
            close(_handle(handle))
            raise
    finally:
        if security:
            _native(KERNEL).LocalFree(security)


def rename(handle: int, directory: int, name: str, replace: bool) -> None:
    encoded = name.encode("utf-16-le")
    size = RenameInfo.name.offset + len(encoded)
    buffer = ctypes.create_string_buffer(max(size, ctypes.sizeof(RenameInfo)))
    info = ctypes.cast(buffer, ctypes.POINTER(RenameInfo)).contents
    info.replace, info.root, info.length = replace, directory, len(encoded)
    ctypes.memmove(ctypes.addressof(buffer) + RenameInfo.name.offset, encoded, len(encoded))
    # Win32's SetFileInformationByHandle converts a relative name to an absolute
    # path while retaining RootDirectory, which fails with ERROR_INVALID_PARAMETER.
    # NtSetInformationFile preserves the already qualified directory handle.
    status = IoStatus()
    result = _native(NT).NtSetInformationFile(
        handle, ctypes.byref(status), buffer, size, RENAME_INFORMATION
    )
    if result < 0:
        raise _error(_native(NT).RtlNtStatusToDosError(result))


def remove(handle: int) -> None:
    disposition = wintypes.BOOLEAN(True)
    check(
        _native(KERNEL).SetFileInformationByHandle(
            handle, DISPOSITION_INFO, ctypes.byref(disposition), ctypes.sizeof(disposition)
        )
    )


def lock(handle: int, acquire: bool) -> None:
    overlapped = Overlapped()
    if acquire:
        check(
            _native(KERNEL).LockFileEx(
                handle, LOCK_EXCLUSIVE_IMMEDIATE, 0, 1, 0, ctypes.byref(overlapped)
            )
        )
    else:
        check(_native(KERNEL).UnlockFileEx(handle, 0, 1, 0, ctypes.byref(overlapped)))


def entries(handle: int, limit: int) -> tuple[str, ...]:
    names: list[str] = []
    restart = True
    while True:
        buffer = ctypes.create_string_buffer(DIRECTORY_QUERY_BYTES)
        status = IoStatus()
        result = _native(NT).NtQueryDirectoryFile(
            handle,
            None,
            None,
            None,
            ctypes.byref(status),
            buffer,
            len(buffer),
            DIRECTORY_INFORMATION,
            True,
            None,
            restart,
        )
        restart = False
        if result & 0xFFFFFFFF == STATUS_NO_MORE_FILES:
            return tuple(names)
        if result < 0:
            raise _error(_native(NT).RtlNtStatusToDosError(result))
        info = ctypes.cast(buffer, ctypes.POINTER(DirectoryInformation)).contents
        if info.length > len(buffer) - DirectoryInformation.name.offset or info.length % 2:
            raise OSError("invalid directory query")
        name = ctypes.string_at(
            ctypes.addressof(buffer) + DirectoryInformation.name.offset, info.length
        ).decode("utf-16-le", errors="strict")
        if name in (".", ".."):
            continue
        if len(names) >= limit:
            raise OSError(errno.ENOSPC, "private directory entry quota")
        names.append(name)
