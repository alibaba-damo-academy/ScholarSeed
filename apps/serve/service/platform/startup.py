"""Acquire a stable, complete startup directory set before data admission."""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Protocol, TypeVar

from service.persistence.project import DatabaseSidecarChangedError
from service.platform.domains import (
    DataInspection,
    DomainChangedError,
    DomainNative,
    DomainQualificationError,
    Domains,
    measure_directory_validation,
)
from service.platform.storage import (
    WINDOWS_PLATFORM,
    DirectoryRole,
    account_directory,
    canonical_root,
    open_private_directory,
    restrict_private_directory,
)

_log = logging.getLogger(__name__)
SQLITE_SNAPSHOT_ATTEMPTS = 8


def prepare_private_root(native: DomainNative, coordinator: str, root: Path) -> None:
    """Repair only a product-owned root under exclusive native qualification."""
    if root == Path(root.anchor) or Path(account_directory()).is_relative_to(root):
        raise PermissionError("private product directory cannot contain the user profile")
    try:
        with closing(open_private_directory(canonical_root(root), ())):
            return
    except PermissionError:
        # Windows data admission already uses actual OS access. A denial is not
        # evidence that an existing ACL should be rewritten by the application.
        if os.name == WINDOWS_PLATFORM:
            raise
    qualification = Domains(native, coordinator, (str(root),), maintenance=True)
    try:
        qualification.occupy()
        with qualification.mutation(), startup_phase("storage.private_permissions"):
            restrict_private_directory(root)
    finally:
        qualification.close()


@contextmanager
def startup_phase(phase: str, **counts: int) -> Iterator[None]:
    """Emit bounded stage diagnostics; never log configuration or source contents."""
    started = time.monotonic()
    status = "finished"
    error_type = ""
    _log.info("startup_phase phase=%s event=started pid=%s counts=%s", phase, os.getpid(), counts)
    with measure_directory_validation() as metrics:
        try:
            yield
        except BaseException as error:
            status = "failed"
            error_type = type(error).__name__
            raise
        finally:
            _log.info(
                "startup_phase phase=%s event=%s pid=%s elapsed_seconds=%.3f counts=%s "
                "validation_calls=%s validation_directories=%s validation_seconds=%.3f error_type=%s",
                phase,
                status,
                os.getpid(),
                time.monotonic() - started,
                counts,
                metrics.calls,
                metrics.directories,
                metrics.elapsed_seconds,
                error_type,
            )


class StartupSnapshot(Protocol):
    """Immutable owner data compared and retained with its directory set."""

    @property
    def roots(self) -> tuple[str, ...]: ...


Snapshot = TypeVar("Snapshot", bound=StartupSnapshot)


def _roots(values: Sequence[str]) -> tuple[str, ...]:
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)) or not values:
        raise ValueError("startup requires explicit directory roots")
    if any(
        not isinstance(value, str) or not os.path.isabs(value) or "\0" in value for value in values
    ):
        raise ValueError("startup roots must be absolute directory paths")
    return tuple(sorted(set(values)))


def _close_failed(domains: Domains, cause: BaseException) -> None:
    try:
        domains.close()
    except BaseException as error:
        raise BaseExceptionGroup("startup inspection and cleanup failed", [cause, error]) from None


def acquire_startup_domains(
    native: DomainNative,
    coordinator: str,
    discovery_roots: Sequence[str],
    read_snapshot: Callable[[DataInspection], Snapshot],
    *,
    attempts: int = SQLITE_SNAPSHOT_ATTEMPTS,
    maintenance: bool = False,
    busy_timeout: float = 0.0,
    prepare_structure: Callable[[Snapshot], None] | None = None,
    discovery_roles: Mapping[str, DirectoryRole] | None = None,
    qualification_failure: Callable[[Snapshot, str, BaseException], bool] | None = None,
) -> tuple[Snapshot, Domains]:
    """Discard transient sidecar observations and reacquire complete qualifications.

    Shared startup can overlap SQLite writers. Retrying is safe only after the
    failed discovery has closed every qualification successfully. Maintenance
    remains strict, as do main-file changes and uncertain release failures.
    """
    if type(attempts) is not int or not 1 <= attempts <= 16:
        raise ValueError("startup discovery attempts must be between 1 and 16")
    for attempt in range(attempts):
        try:
            return _acquire_startup_domains(
                native,
                coordinator,
                discovery_roots,
                read_snapshot,
                attempts=attempts,
                maintenance=maintenance,
                busy_timeout=busy_timeout,
                prepare_structure=prepare_structure,
                discovery_roles=discovery_roles,
                qualification_failure=qualification_failure,
            )
        except Exception as error:
            if (
                maintenance
                or not isinstance(error.__cause__, DatabaseSidecarChangedError)
                or attempt + 1 == attempts
            ):
                raise
            _log.warning(
                "startup sidecar observation discarded; reacquiring directories "
                "attempt=%s limit=%s: %s",
                attempt + 1,
                attempts,
                error,
            )
    raise AssertionError("unreachable startup retry")


def _acquire_startup_domains(
    native: DomainNative,
    coordinator: str,
    discovery_roots: Sequence[str],
    read_snapshot: Callable[[DataInspection], Snapshot],
    *,
    attempts: int,
    maintenance: bool,
    busy_timeout: float,
    prepare_structure: Callable[[Snapshot], None] | None,
    discovery_roles: Mapping[str, DirectoryRole] | None,
    qualification_failure: Callable[[Snapshot, str, BaseException], bool] | None,
) -> tuple[Snapshot, Domains]:
    """Discover, acquire all roots in native order, and resample before return.

    Without prepare_structure all directories must already exist. An explicit
    owner callback may prepare declared structure only between qualifications;
    the complete snapshot is resampled afterwards. This never recreates a registered
    project or an offline mount. The reader receives only DataInspection, uses
    its inspection/read operations, and must
    finish synchronous IO/handle closure before returning its immutable snapshot.
    Equality covers all source data and migration decisions, not only roots.

    The view cannot mutate, admit, extend or close qualifications; its original
    owner checks process, state and directory bindings on inspection operations.
    Returned domains remain OCCUPIED, not ADMITTED. The composition owner still
    owes actual format validation before admit and complete writer drain before
    close. This function supplies neither proof and grants no restart permission.
    Explicit maintenance busy_timeout shares a native-lock wait budget across
    discovery and full qualification; ordinary startup remains nonblocking.
    """
    if type(attempts) is not int or not 1 <= attempts <= 16:
        raise ValueError("startup discovery attempts must be between 1 and 16")
    sources = _roots(discovery_roots)
    deadline = time.monotonic() + busy_timeout

    def discover() -> Snapshot:
        with startup_phase("directory.discovery.acquire", roots=len(sources)):
            discovery = Domains(
                native,
                coordinator,
                sources,
                maintenance=maintenance,
                roles=discovery_roles,
                busy_timeout=max(0.0, deadline - time.monotonic()) if busy_timeout else 0.0,
            )
        try:
            with startup_phase("directory.discovery.occupy", roots=len(sources)):
                discovery.occupy()
            with startup_phase("source.discovery", roots=len(sources)):
                snapshot = read_snapshot(discovery.inspection_view())
            _roots(snapshot.roots)
        except BaseException as error:
            _close_failed(discovery, error)
            raise
        discovery.close()
        return snapshot

    expected = discover()
    expected_roots = _roots(expected.roots)

    for _ in range(attempts):
        if not set(sources) <= set(expected_roots):
            raise ValueError("startup inventory omitted its discovery directories")
        # Never extend an acquired set in-place: Domains sorts the complete
        # physical identity/ancestry plan, including roots shared through aliases.
        if prepare_structure is not None:
            prepare_structure(expected)
        roles = getattr(expected, "root_roles", {})
        if any(
            roles.get(root, DirectoryRole.PRIVATE)
            != (discovery_roles or {}).get(root, DirectoryRole.PRIVATE)
            for root in sources
        ):
            raise ValueError("startup inventory changed discovery directory roles")
        try:
            with startup_phase("directory.qualified.acquire", roots=len(expected_roots)):
                qualified = Domains(
                    native,
                    coordinator,
                    expected_roots,
                    maintenance=maintenance,
                    roles=roles,
                    busy_timeout=max(0.0, deadline - time.monotonic()) if busy_timeout else 0.0,
                    isolate_qualification=qualification_failure is not None,
                )
        except DomainQualificationError as error:
            if qualification_failure is None or not qualification_failure(
                expected, error.path, error.cause
            ):
                raise error.cause from None
            expected = discover()
            expected_roots = _roots(expected.roots)
            continue
        try:
            with startup_phase("directory.qualified.occupy", roots=len(expected_roots)):
                qualified.occupy()
            with startup_phase("source.qualified", roots=len(expected_roots)):
                observed = read_snapshot(qualified.inspection_view())
            observed_roots = _roots(observed.roots)
        except BaseException as error:
            _close_failed(qualified, error)
            if isinstance(error, DomainQualificationError):
                if qualification_failure is not None and qualification_failure(
                    expected, error.path, error.cause
                ):
                    expected = discover()
                    expected_roots = _roots(expected.roots)
                    continue
                raise error.cause from None
            raise
        if observed == expected and observed_roots == expected_roots:
            return observed, qualified
        qualified.close()
        expected = observed
        expected_roots = observed_roots
    raise DomainChangedError("startup source snapshot did not stabilize")


def prepare_startup_domains(
    native: DomainNative,
    coordinator: str,
    discovery_roots: Sequence[str],
    read_snapshot: Callable[[DataInspection], Snapshot],
    needs_maintenance: Callable[[Snapshot], bool],
    initialize: Callable[[Snapshot], None],
    *,
    attempts: int = 8,
    busy_timeout: float = 0.0,
    prepare_structure: Callable[[Snapshot], None] | None = None,
    discovery_roles: Mapping[str, DirectoryRole] | None = None,
    qualification_failure: Callable[[Snapshot, str, BaseException], bool] | None = None,
    removed_roots: Callable[[Snapshot, Snapshot], Sequence[str]] | None = None,
) -> tuple[Snapshot, Domains]:
    """Reacquire exclusive roots for synchronous migration, then shared roots.

    Only a snapshot unchanged under exclusive occupation may be initialized.
    The initializer must restrict writes to the snapshot's qualified roots and
    finish all IO/handle closure before returning or raising; it must not spawn
    background work. This is not a drain mechanism or business admission.
    A busy lock fails immediately unless explicit maintenance busy_timeout is
    supplied. Only native contention waits; durable blockers still fail. Changed metadata is resampled within the
    bounded transition count. Never upgrade or downgrade a held lock in place.
    Directory preparation may add physically covered descendants to the next
    snapshot. Release and reacquire the full set before initializing their data;
    removing roots or introducing roots outside maintenance coverage is rejected.
    """
    snapshot, occupied = acquire_startup_domains(
        native,
        coordinator,
        discovery_roots,
        read_snapshot,
        attempts=attempts,
        prepare_structure=prepare_structure,
        discovery_roles=discovery_roles,
        qualification_failure=qualification_failure,
    )
    for _ in range(attempts):
        try:
            with startup_phase("storage.write_check", roots=len(snapshot.roots)):
                occupied.check_writable()
            with startup_phase("storage.maintenance_check", roots=len(snapshot.roots)):
                required = needs_maintenance(snapshot)
        except BaseException as error:
            _close_failed(occupied, error)
            raise
        if not required:
            return snapshot, occupied
        occupied.close()
        try:
            with startup_phase("directory.maintenance.acquire", roots=len(snapshot.roots)):
                maintenance = Domains(
                    native,
                    coordinator,
                    snapshot.roots,
                    maintenance=True,
                    roles=getattr(snapshot, "root_roles", None),
                    busy_timeout=busy_timeout,
                    isolate_qualification=qualification_failure is not None,
                )
        except DomainQualificationError as error:
            if qualification_failure is None or not qualification_failure(
                snapshot, error.path, error.cause
            ):
                raise error.cause from None
            snapshot, occupied = acquire_startup_domains(
                native,
                coordinator,
                discovery_roots,
                read_snapshot,
                attempts=attempts,
                prepare_structure=prepare_structure,
                discovery_roles=discovery_roles,
                qualification_failure=qualification_failure,
            )
            continue
        try:
            with startup_phase("directory.maintenance.occupy", roots=len(snapshot.roots)):
                maintenance.occupy()
            with startup_phase("source.maintenance", roots=len(snapshot.roots)):
                observed = read_snapshot(maintenance.inspection_view())
            if observed == snapshot and _roots(observed.roots) == _roots(snapshot.roots):
                with startup_phase("storage.initialize", roots=len(observed.roots)):
                    with maintenance.mutation():
                        initialize(observed)
                with startup_phase("source.initialized", roots=len(observed.roots)):
                    prepared = read_snapshot(maintenance.inspection_view())
                before_roots = set(_roots(observed.roots))
                after_roots = set(_roots(prepared.roots))
                added = after_roots - before_roots
                removed = before_roots - after_roots
                allowed_removed = (
                    set(removed_roots(observed, prepared)) if removed_roots is not None else set()
                )
                prepared_roles = getattr(prepared, "root_roles", {})
                if (
                    not removed <= allowed_removed
                    or removed & set(_roots(discovery_roots))
                    or not allowed_removed <= before_roots
                    or any(
                        not maintenance.covers_directory(
                            root, prepared_roles.get(root, DirectoryRole.PRIVATE)
                        )
                        for root in sorted(added)
                    )
                ):
                    raise DomainChangedError("maintenance changed roots outside its coverage")
                # Newly created descendants require a complete reacquisition
                # before the next initializer may access their storage.
                if not added and not removed and needs_maintenance(prepared):
                    raise RuntimeError("startup initialization did not converge")
        except BaseException as error:
            _close_failed(maintenance, error)
            if isinstance(error, DomainQualificationError):
                if qualification_failure is not None and qualification_failure(
                    snapshot, error.path, error.cause
                ):
                    snapshot, occupied = acquire_startup_domains(
                        native,
                        coordinator,
                        discovery_roots,
                        read_snapshot,
                        attempts=attempts,
                        prepare_structure=prepare_structure,
                        discovery_roles=discovery_roles,
                        qualification_failure=qualification_failure,
                    )
                    continue
                raise error.cause from None
            raise
        maintenance.close()
        snapshot, occupied = acquire_startup_domains(
            native,
            coordinator,
            discovery_roots,
            read_snapshot,
            attempts=attempts,
            prepare_structure=prepare_structure,
            discovery_roles=discovery_roles,
            qualification_failure=qualification_failure,
        )
        try:
            with startup_phase("storage.write_check", roots=len(snapshot.roots)):
                occupied.check_writable()
            with startup_phase("storage.maintenance_check", roots=len(snapshot.roots)):
                required = needs_maintenance(snapshot)
        except BaseException as error:
            _close_failed(occupied, error)
            raise
        if not required:
            return snapshot, occupied
    occupied.close()
    raise DomainChangedError("startup maintenance snapshot did not stabilize")


__all__ = ["StartupSnapshot", "acquire_startup_domains", "prepare_startup_domains"]
