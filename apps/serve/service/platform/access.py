"""Add bounded read access to pinned tool assets and directory metadata."""

from __future__ import annotations

import ctypes
import hashlib
import logging
from collections import defaultdict
from contextlib import ExitStack, closing, contextmanager
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol

from service.platform import security, windows
from service.platform.storage import (
    ExplicitAccessW,
    TrusteeW,
    account_directory,
    canonical_root,
    open_directory,
)

FILE_GENERIC_READ = 0x00120089
FILE_GENERIC_EXECUTE = 0x001200A0
FILE_GENERIC_WRITE = 0x00120116
FILE_ALL_ACCESS = 0x001F01FF
GENERIC_EXECUTE = 0x20000000
GENERIC_ALL = 0x10000000
GENERIC_MAPPING = {
    windows.READ: FILE_GENERIC_READ,
    windows.WRITE: FILE_GENERIC_WRITE,
    GENERIC_EXECUTE: FILE_GENERIC_EXECUTE,
    GENERIC_ALL: FILE_ALL_ACCESS,
}
READ_EXECUTE = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE
DIRECTORY_ATTRIBUTES = 0x80
DIRECTORY_LOOKUP = 0x1 | DIRECTORY_ATTRIBUTES | windows.SYNCHRONIZE
GRANT_MASKS = frozenset({READ_EXECUTE, DIRECTORY_ATTRIBUTES, DIRECTORY_LOOKUP})
INHERIT_ONLY = 0x08
DENY_ACE = 1
GRANT_ACCESS = 1
TRUSTEE_IS_SID = 0
TRUSTEE_IS_GROUP = 2
SID_TYPE_ALIAS = 4
ERROR_INSUFFICIENT_BUFFER = 122
MAX_COMPUTER_NAME = 256
MAX_GROUP_SID_BYTES = 1024
MAX_TOOL_ENTRIES = 100000
MUTEX_WAIT_MS = 30000
WAIT_OBJECT = 0
WAIT_ABANDONED = 0x80
SID_HEADER_BYTES = 8
SID_SUBAUTHORITY_BYTES = 4
SID_MAX_SUBAUTHORITIES = 15
SID_COUNT_OFFSET = 1
SUPPORTED_ACE_FLAGS = 0x1F
SECURITY_DESCRIPTOR_REVISION = 1
SELF_RELATIVE_DESCRIPTOR = 0x8000
DACL_AUTO_INHERIT_REQUEST = 0x0100
DACL_AUTO_INHERITED = 0x0400
MUTEX_PREFIX = "Local\\ScholarSeedToolReadAccess-"
LOGGER = logging.getLogger(__name__)


class SecurityDescriptor(ctypes.Structure):
    _fields_ = [
        ("revision", ctypes.c_ubyte),
        ("reserved", ctypes.c_ubyte),
        ("control", wintypes.USHORT),
        ("owner", wintypes.LPVOID),
        ("group", wintypes.LPVOID),
        ("sacl", wintypes.LPVOID),
        ("dacl", wintypes.LPVOID),
    ]


RESOURCE_PRINCIPAL_CHANGED = "bundled_tool_principal_changed"


class ToolAsset(Protocol):
    @property
    def kind(self) -> str: ...

    @property
    def path(self) -> Path: ...


@dataclass(frozen=True)
class AccessSnapshot:
    owner: str
    control: int
    entries: tuple[tuple[int, int, str, int], ...]


def _configure() -> None:
    if windows.SECURITY is None or windows.KERNEL is None:
        return
    signatures = (
        (
            windows.KERNEL,
            "GetComputerNameW",
            [wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)],
            wintypes.BOOL,
        ),
        (
            windows.KERNEL,
            "CreateMutexW",
            [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR],
            wintypes.HANDLE,
        ),
        (windows.KERNEL, "WaitForSingleObject", [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        (windows.KERNEL, "ReleaseMutex", [wintypes.HANDLE], wintypes.BOOL),
        (
            windows.SECURITY,
            "LookupAccountNameW",
            [
                wintypes.LPCWSTR,
                wintypes.LPCWSTR,
                wintypes.LPVOID,
                ctypes.POINTER(wintypes.DWORD),
                wintypes.LPWSTR,
                ctypes.POINTER(wintypes.DWORD),
                ctypes.POINTER(wintypes.DWORD),
            ],
            wintypes.BOOL,
        ),
        (
            windows.SECURITY,
            "SetEntriesInAclW",
            [
                wintypes.ULONG,
                ctypes.POINTER(ExplicitAccessW),
                wintypes.LPVOID,
                ctypes.POINTER(wintypes.LPVOID),
            ],
            wintypes.DWORD,
        ),
        (
            windows.SECURITY,
            "GetSecurityDescriptorControl",
            [wintypes.LPVOID, ctypes.POINTER(wintypes.USHORT), ctypes.POINTER(wintypes.DWORD)],
            wintypes.BOOL,
        ),
        (windows.SECURITY, "IsValidAcl", [wintypes.LPVOID], wintypes.BOOL),
        (windows.SECURITY, "IsValidSid", [wintypes.LPVOID], wintypes.BOOL),
    )
    for library, name, arguments, result in signatures:
        function = getattr(library, name)
        function.argtypes = arguments
        function.restype = result


_configure()


def local_group_sid(name: str):
    if windows.KERNEL is None or windows.SECURITY is None:
        raise OSError("Windows ACL backend unavailable")
    if not name or any(character in name for character in "\\/:\x00"):
        raise ValueError("local sandbox group name invalid")
    machine = ctypes.create_unicode_buffer(MAX_COMPUTER_NAME)
    machine_size = wintypes.DWORD(len(machine))
    windows.check(
        windows._native(windows.KERNEL).GetComputerNameW(machine, ctypes.byref(machine_size))
    )
    account = f"{machine.value}\\{name}"
    sid_size, domain_size, kind = wintypes.DWORD(), wintypes.DWORD(), wintypes.DWORD()
    windows._native(windows.SECURITY).LookupAccountNameW(
        None,
        account,
        None,
        ctypes.byref(sid_size),
        None,
        ctypes.byref(domain_size),
        ctypes.byref(kind),
    )
    if (
        windows.GET_LAST_ERROR is None
        or windows.GET_LAST_ERROR() != ERROR_INSUFFICIENT_BUFFER
        or not 0 < sid_size.value <= MAX_GROUP_SID_BYTES
    ):
        raise PermissionError("sandbox local group SID unavailable")
    sid = ctypes.create_string_buffer(sid_size.value)
    domain = ctypes.create_unicode_buffer(domain_size.value)
    windows.check(
        windows._native(windows.SECURITY).LookupAccountNameW(
            None,
            account,
            sid,
            ctypes.byref(sid_size),
            domain,
            ctypes.byref(domain_size),
            ctypes.byref(kind),
        )
    )
    if kind.value != SID_TYPE_ALIAS or domain.value.casefold() != machine.value.casefold():
        raise PermissionError("sandbox principal is not a machine-local group")
    windows.check(windows._native(windows.SECURITY).IsValidSid(sid))
    return sid


@contextmanager
def resource_mutex(identity: tuple[int, int]) -> Iterator[None]:
    digest = hashlib.sha256(repr(identity).encode()).hexdigest()
    mutex = windows._native(windows.KERNEL).CreateMutexW(None, False, MUTEX_PREFIX + digest)
    windows.check(bool(mutex))
    acquired = False
    try:
        result = windows._native(windows.KERNEL).WaitForSingleObject(mutex, MUTEX_WAIT_MS)
        if result not in (WAIT_OBJECT, WAIT_ABANDONED):
            raise OSError("bundled tool ACL coordination timed out or failed")
        acquired = True
        yield
    finally:
        try:
            if acquired:
                windows.check(windows._native(windows.KERNEL).ReleaseMutex(mutex))
        finally:
            windows.close(mutex)


def _snapshot(owner, dacl, descriptor) -> AccessSnapshot:
    if not owner or not dacl:
        raise PermissionError("tool resource requires an owner and a non-null DACL")
    windows.check(windows._native(windows.SECURITY).IsValidAcl(dacl))
    control, revision = wintypes.USHORT(), wintypes.DWORD()
    windows.check(
        windows._native(windows.SECURITY).GetSecurityDescriptorControl(
            descriptor, ctypes.byref(control), ctypes.byref(revision)
        )
    )
    size = windows.AclSize()
    windows.check(
        windows._native(windows.SECURITY).GetAclInformation(
            dacl, ctypes.byref(size), ctypes.sizeof(size), windows.ACL_SIZE_INFORMATION
        )
    )
    entries = []
    for index in range(size.count):
        pointer = wintypes.LPVOID()
        windows.check(windows._native(windows.SECURITY).GetAce(dacl, index, ctypes.byref(pointer)))
        ace = ctypes.cast(pointer, ctypes.POINTER(windows.AllowedAce)).contents
        if (
            ace.kind not in (windows.ALLOW_ACE, DENY_ACE)
            or ace.flags & ~SUPPORTED_ACE_FLAGS
            or ace.size < windows.AllowedAce.sid.offset + SID_HEADER_BYTES
        ):
            raise PermissionError("unsupported tool resource ACE")
        if pointer.value is None:
            raise PermissionError("missing tool resource ACE")
        sid = pointer.value + windows.AllowedAce.sid.offset
        count = ctypes.c_ubyte.from_address(sid + SID_COUNT_OFFSET).value
        if (
            count > SID_MAX_SUBAUTHORITIES
            or windows.AllowedAce.sid.offset + SID_HEADER_BYTES + SID_SUBAUTHORITY_BYTES * count
            != ace.size
        ):
            raise PermissionError("invalid tool resource ACE SID length")
        windows.check(windows._native(windows.SECURITY).IsValidSid(sid))
        entries.append((ace.kind, ace.flags, windows.sid_text(sid), ace.mask))
    return AccessSnapshot(windows.sid_text(owner), control.value, tuple(entries))


@contextmanager
def security_snapshot(handle: int):
    owner, dacl, descriptor = wintypes.LPVOID(), wintypes.LPVOID(), wintypes.LPVOID()
    code = windows._native(windows.SECURITY).GetSecurityInfo(
        handle,
        windows.FILE_OBJECT,
        windows.OWNER_INFORMATION | windows.DACL_INFORMATION,
        ctypes.byref(owner),
        None,
        ctypes.byref(dacl),
        None,
        ctypes.byref(descriptor),
    )
    try:
        if code:
            raise OSError(code, "read tool resource security failed")
        yield _snapshot(owner, dacl, descriptor), dacl
    finally:
        if descriptor:
            windows._native(windows.KERNEL).LocalFree(descriptor)


def _masks(snapshot: AccessSnapshot) -> dict[tuple[int, int, str], int]:
    masks: dict[tuple[int, int, str], int] = defaultdict(int)
    for kind, flags, sid, mask in snapshot.entries:
        masks[kind, flags, sid] |= mask
    return dict(masks)


def needs_access(snapshot: AccessSnapshot, principal: str, required: int = READ_EXECUTE) -> bool:
    if required not in GRANT_MASKS:
        raise ValueError("unsupported sandbox access increment")
    allowed = 0
    identities: dict[str, int] = {}
    entries = [
        security.Entry(
            identities.setdefault(sid, len(identities)),
            mask,
            flags,
            kind == DENY_ACE,
            True,
            sid == security.SID_EVERYONE,
            sid in {principal, security.SID_EVERYONE},
            sid in {principal, security.SID_EVERYONE},
        )
        for kind, flags, sid, mask in snapshot.entries
    ]
    for index, (kind, flags, sid, mask) in enumerate(snapshot.entries):
        if not security.applies(flags, security.ROLE_CONTENT, 0):
            continue
        if security.blocked(entries, index, 0) & required:
            raise PermissionError("tool resource has a read/execute deny; automatic grant refused")
        if kind == windows.ALLOW_ACE and sid == principal:
            allowed |= security.mask(mask)
    # Workspace metadata may already belong to a native writable root. Keep
    # those existing grants; only fixed tools/installation lookup require RX.
    if required != DIRECTORY_ATTRIBUTES and allowed & ~READ_EXECUTE:
        raise PermissionError(
            "sandbox group already has broader tool access; automatic grant refused"
        )
    return allowed & required != required


def verify_increment(
    before: AccessSnapshot, after: AccessSnapshot, principal: str, required: int = READ_EXECUTE
) -> None:
    expected = _masks(before)
    key = (windows.ALLOW_ACE, 0, principal)
    expected[key] = expected.get(key, 0) | required
    if before.owner != after.owner or before.control != after.control or _masks(after) != expected:
        raise PermissionError("tool ACL changed concurrently or beyond the required increment")
    if needs_access(after, principal, required):
        raise PermissionError("tool access grant verification failed")


def grant_access(handle: int, sid, required: int = READ_EXECUTE) -> bool:
    principal = windows.sid_text(sid)
    with security_snapshot(handle) as (before, _):
        if not needs_access(before, principal, required):
            return False
    # ReOpenFile does not support directory handles. An empty NT relative name
    # opens the pinned object itself, without resolving a mutable absolute path.
    writable = windows.open_relative(
        handle,
        "",
        directory=None,
        private=False,
        access=windows.READ | windows.READ_CONTROL | windows.WRITE_DAC | windows.SYNCHRONIZE,
        share=windows.SHARE_READ | windows.SHARE_WRITE,
    )
    updated = wintypes.LPVOID()
    try:
        if windows.identity(writable) != windows.identity(handle):
            raise PermissionError("tool ACL handle identity changed")
        with security_snapshot(writable) as (before, dacl):
            if not needs_access(before, principal, required):
                return False
            trustee = TrusteeW(
                None, 0, TRUSTEE_IS_SID, TRUSTEE_IS_GROUP, ctypes.cast(sid, wintypes.LPWSTR)
            )
            entry = ExplicitAccessW(required, GRANT_ACCESS, 0, trustee)
            code = windows._native(windows.SECURITY).SetEntriesInAclW(
                1, ctypes.byref(entry), dacl, ctypes.byref(updated)
            )
            if code:
                raise OSError(code, "merge tool access ACL failed")
            with security_snapshot(writable) as (current, _):
                if current != before:
                    raise PermissionError("tool ACL changed before grant")
            # SetSecurityInfo recalculates inheritance and propagates changes to
            # children. Each pinned asset instead receives exactly its own DACL,
            # preserving the original inheritance/protection control bits.
            control = before.control & ~SELF_RELATIVE_DESCRIPTOR
            if control & DACL_AUTO_INHERITED:
                control |= DACL_AUTO_INHERIT_REQUEST
            descriptor = SecurityDescriptor(
                SECURITY_DESCRIPTOR_REVISION,
                0,
                control,
                None,
                None,
                None,
                updated,
            )
            status = windows._native(windows.NT).NtSetSecurityObject(
                writable, windows.DACL_INFORMATION, ctypes.byref(descriptor)
            )
            if status < 0:
                code = windows._native(windows.NT).RtlNtStatusToDosError(status)
                raise OSError(code, "apply tool access ACL failed")
            with security_snapshot(writable) as (after, _):
                verify_increment(before, after, principal, required)
            return True
    finally:
        if updated:
            windows._native(windows.KERNEL).LocalFree(updated)
        windows.close(writable)


def _asset_tree(root: int, path: Path, stack: ExitStack) -> list[tuple[int, Path]]:
    assets = [(root, path)]
    pending = [(root, path)]
    while pending:
        parent, parent_path = pending.pop()
        for name in windows.entries(parent, MAX_TOOL_ENTRIES):
            if len(assets) >= MAX_TOOL_ENTRIES:
                raise OSError("bundled tool resource entry limit exceeded")
            handle = windows.open_relative(
                parent,
                name,
                directory=None,
                private=False,
                access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
                share=windows.SHARE_READ | windows.SHARE_WRITE,
            )
            stack.callback(windows.close, handle)
            tag = windows.TagInfo()
            windows.check(
                windows._native(windows.KERNEL).GetFileInformationByHandleEx(
                    handle, windows.TAG_INFO, ctypes.byref(tag), ctypes.sizeof(tag)
                )
            )
            child = (handle, parent_path / name)
            assets.append(child)
            if tag.attributes & windows.DIRECTORY_ATTRIBUTE:
                pending.append(child)
    return assets


def cwd_ancestors(cwd: Path, account: Path) -> tuple[Path, ...]:
    """Select only necessary metadata below the OS account, without resolving links."""
    if not cwd.is_absolute() or ".." in cwd.parts:
        raise ValueError("sandbox cwd must be an absolute path without parent traversal")
    if not account.is_absolute() or ".." in account.parts:
        raise ValueError("invalid OS account directory")
    if account == Path(account.anchor):
        raise ValueError("OS account directory must not be a volume root")
    if cwd.drive.startswith("\\\\") or account.drive.startswith("\\\\"):
        return ()
    try:
        parts = cwd.relative_to(account).parts
    except ValueError:
        return ()
    return tuple(account.joinpath(*parts[:index]) for index in range(1, len(parts)))


def _prepare_cwd_access(cwd: Path, sid) -> None:
    ancestors = cwd_ancestors(cwd, Path(account_directory()))
    if not ancestors:
        return
    principal = windows.sid_text(sid)
    with ExitStack() as stack:
        # Pin the complete actual chain before changing any ancestor. Keeping these
        # handles excludes rename/delete and detects every reparse component.
        current = open_directory(cwd, ())
        stack.callback(current.close)
        pinned = []
        for path in ancestors:
            directory = open_directory(
                path, (), final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE
            )
            stack.callback(directory.close)
            stack.enter_context(resource_mutex(directory.identity()))
            handle = directory.native_handles[-1]
            with security_snapshot(handle) as (snapshot, _):
                needs_access(snapshot, principal, DIRECTORY_ATTRIBUTES)
            pinned.append(handle)
        changed = sum(grant_access(handle, sid, DIRECTORY_ATTRIBUTES) for handle in pinned)
    LOGGER.info(
        "Sandbox cwd ancestor metadata prepared: directories=%s changed=%s", len(ancestors), changed
    )


def prepare_tool_access(
    resources: tuple[ToolAsset, ...],
    local_group: str,
    directories: tuple[Path, ...] = (),
    workspace: Path | None = None,
    *,
    expected_principal: str | None = None,
    metadata_directories: tuple[Path, ...] = (),
    cwd: Path | None = None,
) -> str:
    sid = local_group_sid(local_group)
    principal = windows.sid_text(sid)
    if expected_principal is not None and principal != expected_principal:
        raise PermissionError(RESOURCE_PRINCIPAL_CHANGED)
    if cwd is not None:
        _prepare_cwd_access(cwd, sid)
    metadata = [(path, DIRECTORY_LOOKUP) for path in directories]
    # Supplied only by the product path owner, never derived by climbing cwd.
    metadata.extend((path, DIRECTORY_ATTRIBUTES) for path in metadata_directories)
    if workspace is not None:
        metadata.append((workspace, DIRECTORY_ATTRIBUTES))
    for path, required in dict.fromkeys(metadata):
        try:
            directory = open_directory(
                canonical_root(path),
                (),
                final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
            )
        except FileNotFoundError:
            # A project-only install need not have created global session storage.
            # Every later runtime preparation rechecks these product-owned paths.
            if path in metadata_directories and path != workspace and path not in directories:
                continue
            raise
        with closing(directory):
            with resource_mutex(directory.identity()):
                grant_access(directory.native_handles[-1], sid, required)
    for resource in resources:
        current_path = resource.path
        try:
            with ExitStack() as stack:
                directory = open_directory(
                    canonical_root(resource.path),
                    (),
                    final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
                )
                stack.callback(directory.close)
                identity = directory.identity()
                stack.enter_context(resource_mutex(identity))
                assets = _asset_tree(directory.native_handles[-1], resource.path, stack)
                for handle, current_path in assets:
                    with security_snapshot(handle) as (snapshot, _):
                        needs_access(snapshot, principal)
                changed = 0
                for handle, current_path in assets:
                    changed += grant_access(handle, sid)
                LOGGER.info(
                    "Built-in tool RX prepared: kind=%s path=%s sid=%s identity=%s objects=%s changed=%s",
                    resource.kind,
                    resource.path,
                    principal,
                    identity,
                    len(assets),
                    changed,
                )
        except Exception as error:
            security.record_denial(
                error, "tool_access", "grant", "policy_denied", logger=LOGGER, resource=current_path
            )
            raise
    return principal
