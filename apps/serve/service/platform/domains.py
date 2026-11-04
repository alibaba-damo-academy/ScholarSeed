"""Process-owned hierarchical storage admission.

The caller supplies strict, process-owned filesystem capabilities. This protocol
coordinates cooperative writers; it does not validate data formats or prove that
external writer processes have drained. No finalizer releases qualifications.
"""

from __future__ import annotations

import math
import os
import re
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from enum import Enum
from typing import Never, Protocol, overload

from service.platform.guardian import GuardianQualificationError
from service.platform.guardian import from_environment as directory_guardian
from service.platform.locator import DirectoryLocator, directory_locator, pin_directory
from service.platform.storage import DirectoryRole

_IDENTITY = re.compile(r"(?:posix:[a-f0-9]{16}:[a-f0-9]{16}|windows:[a-f0-9]{16}:[a-f0-9]{32})")
_BUSY = "ERR_LEASE_BUSY"
_NATIVE_RELEASE = "ERR_LEASE_RELEASE"
_DOMAIN_RELEASE = "ERR_DOMAIN_RELEASE"
_FAMILY_INDEX = "domains-v1"
_MUTATION_INDEX = "mutations-v1"
_MUTATION_GATE_SUFFIX = "-mutations"
_FAMILY_SELF = "self"
_FAMILY_DESCENDANTS = "descendants"
_FAMILY_GATE_SUFFIX = "-families"
_FAMILY_MAX_ENTRIES = 4096
_FAMILY_MAX_BYTES = 1024 * 1024
_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
_SNAPSHOT_MAX_FILES = 64


@dataclass
class DirectoryValidationMetrics:
    calls: int = 0
    directories: int = 0
    elapsed_seconds: float = 0.0


_VALIDATION_METRICS: ContextVar[tuple[DirectoryValidationMetrics, ...]] = ContextVar(
    "directory_validation_metrics", default=()
)


@contextmanager
def measure_directory_validation() -> Iterator[DirectoryValidationMetrics]:
    """Count native namespace checks without changing their authority or lifetime."""
    metrics = DirectoryValidationMetrics()
    token = _VALIDATION_METRICS.set((*_VALIDATION_METRICS.get(), metrics))
    try:
        yield metrics
    finally:
        _VALIDATION_METRICS.reset(token)


_MODES: dict[str, tuple[tuple[str, bool], ...]] = {
    "intent": (("a", False),),
    "shared": (("a", False), ("b", False)),
    "maintain_intent": (("a", False), ("b", True)),
    "exclusive": (("a", True), ("b", True)),
}


class DataInspection(Protocol):
    """Synchronous reads while the outer owner retains occupied admission.

    This interface neither grants format compatibility nor owns lock lifetime.
    Inspection must finish all IO before its context exits.
    """

    def selected(self, root: str) -> bool: ...

    def locator_hint(
        self, root: str, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> DirectoryLocator: ...
    def directory_identity(self, root: str) -> str: ...
    def directory_path(self, root: str) -> str: ...
    def entry_kind(self, root: str, name: str) -> str | None: ...
    def directory_metadata(self, root: str) -> dict[str, int | str | None]: ...
    def directory_entries(self, root: str, max_entries: int) -> tuple[tuple[str, bool], ...]: ...
    def read(self, root: str, name: str, max_bytes: int) -> bytes | None: ...
    def snapshots(
        self, root: str, names: Sequence[str], max_bytes: int
    ) -> dict[str, bytes | None]: ...
    def inspection(self, root: str) -> AbstractContextManager[str]: ...
    def batch_inspection(self) -> AbstractContextManager[DataInspection]: ...
    def project_inspection(
        self, roots: Sequence[str]
    ) -> AbstractContextManager[DataInspection]: ...


class _InspectionView:
    """Expose only the read interface to trusted source discovery callbacks.

    This is API separation, not a sandbox against hostile Python reflection.
    The original owner still enforces process, state and binding checks per call.
    """

    __slots__ = ("__owner",)

    def __init__(self, owner: DataInspection) -> None:
        self.__owner = owner

    def project_inspection(self, roots: Sequence[str]) -> AbstractContextManager[DataInspection]:
        return self.__owner.project_inspection(roots)

    def selected(self, root: str) -> bool:
        return self.__owner.selected(root)

    def locator_hint(
        self, root: str, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> DirectoryLocator:
        return self.__owner.locator_hint(root, role)

    def directory_identity(self, root: str) -> str:
        return self.__owner.directory_identity(root)

    def directory_entries(self, root: str, max_entries: int) -> tuple[tuple[str, bool], ...]:
        return self.__owner.directory_entries(root, max_entries)

    def entry_kind(self, root: str, name: str) -> str | None:
        return self.__owner.entry_kind(root, name)

    def directory_path(self, root: str) -> str:
        return self.__owner.directory_path(root)

    def directory_metadata(self, root: str) -> dict[str, int | str | None]:
        return self.__owner.directory_metadata(root)

    def read(self, root: str, name: str, max_bytes: int) -> bytes | None:
        return self.__owner.read(root, name, max_bytes)

    def snapshots(self, root: str, names: Sequence[str], max_bytes: int) -> dict[str, bytes | None]:
        return self.__owner.snapshots(root, names, max_bytes)

    def inspection(self, root: str) -> AbstractContextManager[str]:
        return self.__owner.inspection(root)

    def batch_inspection(self) -> AbstractContextManager[DataInspection]:
        return self.__owner.batch_inspection()


@contextmanager
def inspect_directories(domains: DataInspection, roots: Sequence[str]) -> Iterator[tuple[str, ...]]:
    """Check a selected root set in one non-reentrant inspection operation.

    Both native views retain every binding and revalidate that whole namespace
    at inspection entry/exit. Check membership before entering; never nest view
    calls while the owner is active. This acquires no new directory authority.
    """
    if (
        not isinstance(roots, Sequence)
        or isinstance(roots, (str, bytes))
        or not roots
        or any(not isinstance(root, str) or not root for root in roots)
    ):
        raise ValueError("inspection requires explicit directory roots")
    selected = tuple(sorted(set(roots)))
    if any(not domains.selected(root) for root in selected):
        raise ValueError("inspection requires explicitly selected roots")
    with domains.inspection(selected[0]):
        yield selected


class DomainNative(Protocol):
    """Strict native capability owner, never an ordinary pathname IO adapter."""

    def pin(
        self, path: str, create: bool, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> object: ...
    def lineage(self, pin: object) -> Sequence[str]: ...
    def directory_path(self, pin: object) -> str: ...
    def entry_kind(self, pin: object, name: str) -> str | None: ...
    def create_child(self, pin: object, name: str, *, exclusive: bool = False) -> str: ...
    def create_at(self, pin: object, name: str, data: bytes) -> None: ...
    def acquire_at(self, pin: object, name: str, exclusive: bool) -> object: ...
    def directory_metadata(self, pin: object) -> dict[str, int | str | None]: ...
    def directory_entries(self, pin: object, max_entries: int) -> tuple[tuple[str, bool], ...]: ...
    def read_at(self, pin: object, name: str, max_bytes: int) -> bytes | None: ...
    def read_snapshot_at(self, pin: object, name: str, max_bytes: int) -> bytes | None: ...
    def list_records(self, pin: object, max_entries: int, max_bytes: int) -> dict[str, bytes]: ...
    def release(self, handle: object) -> None: ...


def _snapshots(
    native: DomainNative, pin: object, names: Sequence[str], max_bytes: int
) -> dict[str, bytes | None]:
    """Read a bounded image set under the caller's single inspection scope.

    Directory qualification alone does not freeze external writers. The update
    transaction must drain the source family and retain maintenance throughout
    this operation. These bytes are input to private projections, not admission.
    """
    if (
        not isinstance(names, Sequence)
        or isinstance(names, (str, bytes))
        or not 0 < len(names) <= _SNAPSHOT_MAX_FILES
        or any(not isinstance(name, str) or not name for name in names)
        or len(set(names)) != len(names)
        or (not isinstance(max_bytes, int) or isinstance(max_bytes, bool))
        or not 0 < max_bytes <= _SNAPSHOT_MAX_BYTES
    ):
        raise ValueError("invalid snapshot inventory or budget")
    result = {}
    remaining = max_bytes
    for name in names:
        value = native.read_snapshot_at(pin, name, remaining)
        if value is not None:
            if not isinstance(value, bytes) or len(value) > remaining:
                raise ValueError("native snapshot exceeded its byte budget")
            remaining -= len(value)
        result[name] = value
    return result


class DomainReleaseError(RuntimeError):
    """Close state is uncertain; retain remaining qualifications until death."""

    code = _DOMAIN_RELEASE


class DomainBusyError(RuntimeError):
    """Durable family protection still prevents maintenance qualification."""

    code = _BUSY


class DomainChangedError(RuntimeError):
    """A selected directory no longer has its original identity or ancestry."""

    code = "ERR_DOMAIN_CHANGED"


class DomainQualificationError(RuntimeError):
    """A single initial pin failed after every earlier handle was safely released."""

    def __init__(self, path: str, cause: BaseException) -> None:
        super().__init__(f"directory qualification failed: {path}")
        self.path = path
        self.cause = cause


class _State(Enum):
    GUARDED = "guarded"
    OCCUPIED = "occupied"
    ADMITTED = "admitted"
    FAILED = "failed"
    UNCERTAIN = "uncertain"
    CLOSED = "closed"


@dataclass(frozen=True)
class DirectoryBinding:
    """Physical directory evidence; this record conveys no lock authority."""

    path: str
    identity: str
    ancestors: tuple[str, ...]
    role: DirectoryRole = DirectoryRole.PRIVATE


@dataclass(frozen=True)
class _CreatedRoot:
    path: str
    identity: str


def _binding(
    native: DomainNative, pin: object, path: str, role: DirectoryRole = DirectoryRole.PRIVATE
) -> DirectoryBinding:
    lineage = tuple(native.lineage(pin))
    if not lineage or any(
        not isinstance(value, str) or not _IDENTITY.fullmatch(value) for value in lineage
    ):
        raise ValueError("unsupported native directory identity")
    return DirectoryBinding(path, lineage[-1], tuple(sorted(set(lineage[:-1]))), role)


def _uncertain(error: BaseException) -> bool:
    return getattr(error, "code", None) in {_NATIVE_RELEASE, _DOMAIN_RELEASE}


def _release(native: DomainNative, handles: list[object]) -> None:
    while handles:
        # Consume the failed handle without retrying it; do not release siblings.
        handle = handles.pop()
        try:
            native.release(handle)
        except BaseException as error:
            raise DomainReleaseError("domain resource release is uncertain") from error


@overload
def _cleanup(
    native: DomainNative, groups: Sequence[list[object]], cause: BaseException
) -> Never: ...


@overload
def _cleanup(native: DomainNative, groups: Sequence[list[object]], cause: None = None) -> None: ...


def _cleanup(
    native: DomainNative, groups: Sequence[list[object]], cause: BaseException | None = None
) -> None:
    if isinstance(cause, DomainReleaseError):
        raise cause
    if cause is not None and _uncertain(cause):
        raise DomainReleaseError("native directory release is uncertain") from cause
    for group in groups:
        try:
            _release(native, group)
        except DomainReleaseError as error:
            if cause is not None:
                raise DomainReleaseError(
                    "operation failed with uncertain cleanup"
                ) from BaseExceptionGroup("domain operation and cleanup failed", [cause, error])
            raise
    if cause is not None:
        raise cause


def _revalidate(native: DomainNative, bindings: Sequence[DirectoryBinding]) -> None:
    checks: list[object] = []
    metrics = _VALIDATION_METRICS.get()
    started = time.monotonic() if metrics else 0.0
    inspected = 0
    try:
        try:
            for expected in bindings:
                inspected += 1
                pin = pin_directory(native, expected.path, False, expected.role)
                checks.append(pin)
                if _binding(native, pin, expected.path, expected.role) != expected:
                    raise DomainChangedError("domain directory identity or ancestry changed")
        except BaseException as error:
            _cleanup(native, [checks], error)
        _release(native, checks)
    finally:
        if metrics:
            elapsed = time.monotonic() - started
            for counter in metrics:
                counter.calls += 1
                counter.directories += inspected
                counter.elapsed_seconds += elapsed


class _PinnedInspection:
    """Single-thread synchronous reader; lifecycle belongs to its outer scope."""

    def __init__(self, native: DomainNative, bindings: tuple[DirectoryBinding, ...]) -> None:
        self.native = native
        self.bindings = bindings
        self.readers: dict[str, object] = {}
        self.pid = os.getpid()
        self.thread = threading.get_ident()
        self.active = False
        self.state = _State.OCCUPIED
        self.failure: BaseException | None = None

    def _check(self) -> None:
        if self.pid != os.getpid() or self.thread != threading.get_ident():
            raise RuntimeError("pinned inspection owner changed")
        if self.state is not _State.OCCUPIED or self.active:
            raise RuntimeError("pinned inspection is inactive or reentrant")

    def project_inspection(self, roots: Sequence[str]) -> AbstractContextManager[DataInspection]:
        self._check()
        return _project_inspection(
            self.native, self.readers, self.bindings, roots, self._project_failure
        )

    def _project_failure(self, error: BaseException) -> None:
        self.failure = error
        self.state = _State.UNCERTAIN

    def selected(self, root: str) -> bool:
        self._check()
        return root in self.readers

    def locator_hint(
        self, root: str, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> DirectoryLocator:
        self._check()
        self.active = True
        try:
            _revalidate(self.native, self.bindings)
            value = directory_locator(self.native, root, role)
            _revalidate(self.native, self.bindings)
            return value
        except BaseException as error:
            self.state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
            _cleanup(self.native, [], error)
        finally:
            self.active = False

    @contextmanager
    def inspection(self, root: str) -> Iterator[str]:
        self._check()
        self.active = True
        try:
            if root not in self.readers:
                raise ValueError("inspection requires an explicitly selected root")
            _revalidate(self.native, self.bindings)
            yield root
            _revalidate(self.native, self.bindings)
        except BaseException as error:
            self.state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
            _cleanup(self.native, [], error)
        finally:
            self.active = False

    def directory_identity(self, root: str) -> str:
        with self.inspection(root):
            return self.native.lineage(self.readers[root])[-1]

    def directory_entries(self, root: str, max_entries: int) -> tuple[tuple[str, bool], ...]:
        with self.inspection(root):
            return self.native.directory_entries(self.readers[root], max_entries)

    def entry_kind(self, root: str, name: str) -> str | None:
        with self.inspection(root):
            return self.native.entry_kind(self.readers[root], name)

    def directory_path(self, root: str) -> str:
        with self.inspection(root):
            return self.native.directory_path(self.readers[root])

    def directory_metadata(self, root: str) -> dict[str, int | str | None]:
        with self.inspection(root):
            return self.native.directory_metadata(self.readers[root])

    def batch_inspection(self) -> AbstractContextManager[DataInspection]:
        return _batch_inspection(self, self.native, self.readers, self.bindings)

    def read(self, root: str, name: str, max_bytes: int) -> bytes | None:
        with self.inspection(root):
            return self.native.read_at(self.readers[root], name, max_bytes)

    def snapshots(self, root: str, names: Sequence[str], max_bytes: int) -> dict[str, bytes | None]:
        with self.inspection(root):
            return _snapshots(self.native, self.readers[root], names, max_bytes)


class _BatchInspection(_PinnedInspection):
    """Ephemeral read-only view inside one fully qualified source observation."""

    def __init__(self, native: DomainNative, bindings: tuple[DirectoryBinding, ...]) -> None:
        super().__init__(native, bindings)
        self.failure: BaseException | None = None

    @contextmanager
    def inspection(self, root: str) -> Iterator[str]:
        self._check()
        if root not in self.readers:
            raise ValueError("inspection requires an explicitly selected root")
        self.active = True
        try:
            yield root
        except BaseException as error:
            self.failure = error
            self.state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
            raise
        finally:
            self.active = False

    def locator_hint(
        self, root: str, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> DirectoryLocator:
        self._check()
        self.active = True
        try:
            return directory_locator(self.native, root, role)
        except BaseException as error:
            self.failure = error
            self.state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
            raise
        finally:
            self.active = False

    def batch_inspection(self) -> AbstractContextManager[DataInspection]:
        raise RuntimeError("source inspection batches cannot be nested")


@contextmanager
def _project_inspection(
    native: DomainNative,
    readers: dict[str, object],
    bindings: tuple[DirectoryBinding, ...],
    roots: Sequence[str],
    uncertain: Callable[[BaseException], None],
) -> Iterator[DataInspection]:
    """Isolate content failures while the parent retains every qualification.

    This is a read-only subview, not a new lease or a suppression boundary. The
    caller receives every error and must preserve unavailable-project evidence.
    Native release uncertainty remains fatal; the outer observation still checks
    all namespace identities before accepting its result.
    """
    selected = tuple(roots)
    evidence = {binding.path: binding for binding in bindings}
    if (
        not selected
        or len(set(selected)) != len(selected)
        or any(root not in readers or root not in evidence for root in selected)
    ):
        raise ValueError("project inspection requires explicitly selected directories")
    view = _BatchInspection(native, tuple(evidence[root] for root in selected))
    view.readers = {root: readers[root] for root in selected}
    try:
        yield _InspectionView(view)
        if view.failure is not None:
            raise view.failure
        view._check()
    except BaseException as error:
        if _uncertain(error) or (view.failure is not None and _uncertain(view.failure)):
            uncertain(
                view.failure if view.failure is not None and _uncertain(view.failure) else error
            )
        if view.failure is not None and _uncertain(view.failure) and error is not view.failure:
            raise DomainReleaseError(
                "project inspection release is uncertain"
            ) from BaseExceptionGroup(
                "project inspection and native release failed", [view.failure, error]
            )
        raise
    finally:
        view.state = _State.CLOSED


@contextmanager
def _batch_inspection(
    owner: DataInspection,
    native: DomainNative,
    readers: dict[str, object],
    bindings: tuple[DirectoryBinding, ...],
) -> Iterator[DataInspection]:
    """Retain all bindings and verify the complete namespace before and after IO.

    The view exposes no writer or new qualification authority. Every native file
    operation retains its ordinary permission/identity/budget checks. Failure at
    the outer exit rejects the whole observation, never a partial source result.
    """
    if not readers:
        raise ValueError("source inspection requires selected roots")
    with owner.inspection(next(iter(readers))):
        view = _BatchInspection(native, bindings)
        view.readers = dict(readers)
        try:
            yield _InspectionView(view)
            if view.failure is not None:
                raise view.failure
            view._check()
        except BaseException as error:
            if view.failure is not None and _uncertain(view.failure) and error is not view.failure:
                raise DomainReleaseError(
                    "source inspection release is uncertain"
                ) from BaseExceptionGroup(
                    "source inspection and native release failed", [view.failure, error]
                )
            raise
        finally:
            view.state = _State.CLOSED


@contextmanager
def pinned_inspection(
    native: DomainNative, bindings: Sequence[DirectoryBinding]
) -> Iterator[DataInspection]:
    """Compare independent pins with parent evidence, without acquiring locks.

    The trusted parent must retain full qualification until this process and all
    IO end. Supplied evidence cannot prove that obligation or authorize writes.
    Only synchronous IO on the entering process/thread is permitted. Native close
    uncertainty retains remaining pins for process exit, never a finalizer retry.
    """
    expected = tuple(bindings)
    if not expected or any(
        not isinstance(b, DirectoryBinding)
        or not isinstance(b.role, DirectoryRole)
        or not isinstance(b.path, str)
        or not b.path
        or not isinstance(b.identity, str)
        or not _IDENTITY.fullmatch(b.identity)
        or not isinstance(b.ancestors, tuple)
        or any(not isinstance(a, str) or not _IDENTITY.fullmatch(a) for a in b.ancestors)
        or b.ancestors != tuple(sorted(set(b.ancestors)))
        or b.identity in b.ancestors
        for b in expected
    ):
        raise ValueError("invalid inspection directory evidence")
    if len({b.path for b in expected}) != len(expected):
        raise ValueError("duplicate inspection directory path")
    owner = _PinnedInspection(native, expected)
    pins: list[object] = []
    try:
        for binding in expected:
            pin = pin_directory(native, binding.path, False, binding.role)
            pins.append(pin)
            if _binding(native, pin, binding.path, binding.role) != binding:
                raise DomainChangedError("inspection differs from parent directory evidence")
            owner.readers[binding.path] = pin
        _revalidate(native, expected)
        yield _InspectionView(owner)
        owner._check()
        _revalidate(native, expected)
    except BaseException as error:
        if (
            owner.state is _State.UNCERTAIN
            or owner.active
            or owner.pid != os.getpid()
            or owner.thread != threading.get_ident()
        ):
            raise DomainReleaseError("inspection cannot prove safe cleanup") from error
        _cleanup(native, [pins], error)
    finally:
        owner.state = _State.CLOSED
    _release(native, pins)


def _acquire(
    native: DomainNative,
    coordinator: object,
    plan: Sequence[tuple[str, str]],
    phase: str,
    deadline: float = 0.0,
    failure_paths: Mapping[str, str] | None = None,
) -> list[object]:
    handles: list[object] = []
    failed_identity = ""
    try:
        for identity, mode in plan:
            failed_identity = identity
            for slot, exclusive in _MODES[mode]:
                name = f"{identity.replace(':', '-')}-{phase}-{slot}"
                while True:
                    try:
                        handles.append(native.acquire_at(coordinator, name, exclusive))
                        break
                    except BaseException as error:
                        remaining = deadline - time.monotonic()
                        if getattr(error, "code", None) != _BUSY or remaining <= 0:
                            raise
                        # Keep the ordered predecessor locks. Once admission is
                        # held, new related writers cannot overtake occupancy.
                        # Only a definite native busy result permits another try;
                        # uncertain release and durable memberships never do.
                        time.sleep(min(0.01, remaining))
        return handles
    except BaseException as error:
        try:
            _cleanup(native, [handles], error)
        except BaseException as cleaned:
            path = (failure_paths or {}).get(failed_identity)
            if cleaned is error and path is not None and getattr(error, "code", None) == _BUSY:
                raise DomainQualificationError(path, error) from error
            raise
    raise AssertionError("cleanup must propagate acquisition failure")


class Domains:
    """Two-phase qualification over a fixed set of existing directory objects.

    Occupy, validate actual data compatibility, then admit a writer. Maintenance
    retains admission while existing writers drain and throughout its mutation.
    Close is explicit and requires the caller's real IO drain, not a GC event.
    Explicit maintenance waits share one monotonic budget across native admission
    and occupancy. Persistent membership or uncertain release is never retried.
    """

    def __init__(
        self,
        native: DomainNative,
        coordinator_path: str,
        roots: Sequence[str],
        *,
        maintenance: bool = False,
        roles: Mapping[str, DirectoryRole] | None = None,
        busy_timeout: float = 0.0,
        _created: _CreatedRoot | None = None,
        isolate_qualification: bool = False,
    ) -> None:
        if (
            isinstance(busy_timeout, bool)
            or not isinstance(busy_timeout, (int, float))
            or not math.isfinite(busy_timeout)
            or not 0 <= busy_timeout <= 5
            or (busy_timeout and not maintenance)
        ):
            raise ValueError("only maintenance may wait up to five seconds for native leases")
        self._lease_deadline = time.monotonic() + busy_timeout if busy_timeout else 0.0
        if (
            not isinstance(roots, Sequence)
            or isinstance(roots, (str, bytes))
            or not roots
            or not isinstance(maintenance, bool)
        ):
            raise TypeError("domains require nonempty roots and an explicit maintenance mode")
        if not isinstance(coordinator_path, str) or any(
            not isinstance(root, str) for root in roots
        ):
            raise TypeError("domain paths must be strings")
        self._roles = {path: DirectoryRole(role) for path, role in (roles or {}).items()}
        if (
            set(self._roles) - set(roots)
            or self._roles.get(coordinator_path, DirectoryRole.PRIVATE) is not DirectoryRole.PRIVATE
        ):
            raise ValueError("roles require selected roots and a private coordinator")
        self._native = native
        self._guardian = directory_guardian()
        if self._guardian is not None:
            try:
                self._guardian.request(
                    "extend",
                    [
                        {
                            "path": root,
                            "create": False,
                            "role": self._roles.get(root, DirectoryRole.PRIVATE).value,
                        }
                        for root in roots
                    ],
                )
            except GuardianQualificationError as error:
                # Broker response validates the original project request and
                # returns only after native cleanup; pipe cleanup must also finish.
                if isolate_qualification and self._roles.get(error.path) is DirectoryRole.PROJECT:
                    raise DomainQualificationError(error.path, error) from error
                raise
        self._maintenance = maintenance
        self._created = _created
        if _created is not None and (not maintenance or tuple(roots) != (_created.path,)):
            raise ValueError("created qualification requires its exclusive new root")
        self._pid = os.getpid()
        self._mutex = threading.RLock()
        self._active = threading.Lock()
        self._state = _State.GUARDED
        self._pins: list[object] = []
        self._coordination: list[object] = []
        self._admission: list[object] = []
        self._occupancy: list[object] = []
        self._readers: dict[str, object] = {}
        self._bindings: list[DirectoryBinding] = []
        failed_path: str | None = None
        try:
            self._coordinator = native.pin(coordinator_path, False)
            self._coordination.append(self._coordinator)
            coordination = _binding(native, self._coordinator, coordinator_path)
            self._bindings.append(coordination)
            coordinator_lineage = {coordination.identity, *coordination.ancestors}
            selected: set[str] = set()
            ancestors: set[str] = set()
            for root in roots:
                role = self._roles.get(root, DirectoryRole.PRIVATE)
                failed_path = root
                pin = pin_directory(native, root, False, role)
                failed_path = None
                self._pins.append(pin)
                current = _binding(native, pin, root, role)
                if _created is not None and current.identity != _created.identity:
                    raise DomainChangedError("created directory was replaced")
                self._bindings.append(current)
                self._readers[root] = pin
                if (
                    current.identity in coordinator_lineage
                    or coordination.identity in current.ancestors
                ):
                    raise ValueError("coordination directory must remain outside every data root")
                selected.add(current.identity)
                ancestors.update(current.ancestors)
            self._plan = tuple(
                (
                    identity,
                    (
                        ("exclusive" if maintenance else "shared")
                        if identity in selected
                        else ("maintain_intent" if maintenance and _created is None else "intent")
                    ),
                )
                for identity in sorted(selected | ancestors)
            )
            # Only a unique project leaf can explain local lock contention.
            # Common ancestors, aliases and private roots remain whole-domain failures.
            self._qualification_paths = {
                binding.identity: binding.path
                for binding in self._bindings[1:]
                if isolate_qualification
                and binding.role is DirectoryRole.PROJECT
                and binding.identity not in ancestors
                and sum(other.identity == binding.identity for other in self._bindings[1:]) == 1
            }
            self._admission = _acquire(
                native,
                self._coordinator,
                self._plan,
                "admission",
                self._lease_deadline,
                self._qualification_paths,
            )
            _revalidate(native, self._bindings)
        except BaseException as error:
            self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
            try:
                _cleanup(
                    native,
                    [self._pins, self._occupancy, self._admission, self._coordination],
                    error,
                )
            except BaseException as cleaned:
                if (
                    cleaned is error
                    and isolate_qualification
                    and failed_path is not None
                    and (
                        isinstance(error, (PermissionError, FileNotFoundError))
                        or getattr(error, "code", None) == "ERR_LEASE_PERMISSION"
                    )
                ):
                    raise DomainQualificationError(failed_path, error) from error
                raise

    @contextmanager
    def _operation(self) -> Iterator[None]:
        # A fork can inherit a mutex owned by a thread that no longer exists.
        if self._pid != os.getpid():
            raise RuntimeError("domain owner process changed")
        with self._mutex:
            # RLock serializes threads, but synchronous callbacks/signals must
            # not change qualifications inside an in-flight native operation.
            if not self._active.acquire(blocking=False):
                raise RuntimeError("reentrant domain operation")
            try:
                yield
            finally:
                self._active.release()

    def _check_families(self) -> None:
        """Reject other durable members under the publisher's namespace gate.

        Membership bytes never grant retirement authority. The authorized retiree
        must remove the entry; malformed or unrecognized content remains blocking.
        This reader does not create family records or prove process-family exit.
        """
        owned: dict[str, bytes] = {}
        if self._guardian is not None:
            # Only ask after exclusive volatile occupancy, and never retain a
            # grant for another attempt or a later directory qualification.
            owned = {
                name: payload.encode("ascii")
                for name, payload in self._guardian.request(
                    "authorize",
                    [
                        {
                            "path": binding.path,
                            "identity": binding.identity,
                            "ancestors": list(binding.ancestors),
                            "role": binding.role.value,
                        }
                        for binding in self._bindings[1:]
                    ],
                ).items()
            }
            _revalidate(self._native, self._bindings)
        plan = self._plan
        if self._created is not None:
            plan = tuple(row for row in plan if row[0] == self._created.identity)
        _check_index_records(
            self._native,
            self._coordinator,
            self._bindings,
            plan,
            _FAMILY_INDEX,
            _FAMILY_GATE_SUFFIX,
            owned,
            "durable family membership prevents maintenance",
        )

    def _check_records(
        self, index_name: str, gate_suffix: str, owned: dict[str, bytes], message: str
    ) -> None:
        _check_index_records(
            self._native,
            self._coordinator,
            self._bindings,
            self._plan,
            index_name,
            gate_suffix,
            owned,
            message,
        )

    def check_writable(self) -> None:
        """Reject a durable unfinished mutation before constructors perform IO."""
        with self._operation():
            if self._state is not _State.OCCUPIED:
                raise RuntimeError("write check requires occupied admission")
            try:
                _revalidate(self._native, self._bindings)
                self._check_records(
                    _MUTATION_INDEX,
                    _MUTATION_GATE_SUFFIX,
                    {},
                    "unfinished mutation prevents data admission",
                )
                _revalidate(self._native, self._bindings)
            except BaseException as error:
                self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
                _cleanup(self._native, [], error)

    def occupy(self) -> None:
        with self._operation():
            if self._state is not _State.GUARDED:
                raise RuntimeError("domain occupancy requires guarded admission")
            try:
                self._occupancy = _acquire(
                    self._native,
                    self._coordinator,
                    self._plan,
                    "occupancy",
                    self._lease_deadline,
                    self._qualification_paths,
                )
                _revalidate(self._native, self._bindings)
                if self._maintenance:
                    self._check_families()
                self._state = _State.OCCUPIED
            except BaseException as error:
                if getattr(error, "code", None) == _BUSY:
                    # Durable scan contention occurs after occupancy acquisition.
                    # Keep admission, but undo this attempt before permitting retry.
                    try:
                        _release(self._native, self._occupancy)
                    except DomainReleaseError:
                        self._state = _State.UNCERTAIN
                        raise
                else:
                    self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
                raise

    @contextmanager
    def inspection(self, root: str) -> Iterator[str]:
        """Hold qualifications around synchronous data-owner inspection and close.

        SQLite and other owners must finish all IO and close their handles before
        leaving this scope. This does not authorize migration or background work.
        The selected directory is revalidated before and after owner inspection.
        """
        with self._operation():
            if self._state is not _State.OCCUPIED:
                raise RuntimeError("domain inspection requires occupied admission")
            try:
                if root not in self._readers:
                    raise ValueError("domain inspection requires an explicitly selected root")
                _revalidate(self._native, self._bindings)
                yield root
                _revalidate(self._native, self._bindings)
            except BaseException as error:
                self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
                _cleanup(self._native, [], error)

    def directory_identity(self, root: str) -> str:
        """Return the selected physical identity after revalidating its binding."""
        with self._operation():
            if self._state is not _State.OCCUPIED or root not in self._readers:
                raise RuntimeError("directory identity requires selected occupied domains")
            _revalidate(self._native, self._bindings)
            return self._native.lineage(self._readers[root])[-1]

    def retained_identity(self, root: str) -> str | None:
        """Revalidate a selected root retained by an occupied or admitted owner."""
        with self._operation():
            if self._state not in (_State.OCCUPIED, _State.ADMITTED):
                raise RuntimeError("directory identity requires retained domains")
            if root not in self._readers:
                return None
            _revalidate(self._native, self._bindings)
            return self._native.lineage(self._readers[root])[-1]

    def selected(self, root: str) -> bool:
        """Report explicit selection only; inspection still revalidates bindings."""
        with self._operation():
            if self._state is not _State.OCCUPIED:
                raise RuntimeError("domain selection requires occupied admission")
            return root in self._readers

    @contextmanager
    def mutation(self) -> Iterator[None]:
        """Protect synchronous maintenance across the entire selected root set.

        The owner must finish every IO and close its handles on both success and
        failure before leaving. This scope cannot authorize background work or
        prove that a callback drained it. Qualifications require explicit close.
        """
        with self._operation():
            if not self._maintenance or self._state is not _State.OCCUPIED:
                raise RuntimeError("mutation requires occupied maintenance domains")
            try:
                _revalidate(self._native, self._bindings)
                self._check_records(
                    _MUTATION_INDEX,
                    _MUTATION_GATE_SUFFIX,
                    {},
                    "unfinished mutation prevents data admission",
                )
                yield
                _revalidate(self._native, self._bindings)
            except BaseException as error:
                self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
                _cleanup(self._native, [], error)

    def covers_directory(self, root: str, role: DirectoryRole = DirectoryRole.PRIVATE) -> bool:
        """Check physical ancestry under occupied maintenance, without extending it."""
        with self._operation():
            if not self._maintenance or self._state is not _State.OCCUPIED:
                raise RuntimeError("directory coverage requires occupied maintenance")
            pins: list[object] = []
            try:
                _revalidate(self._native, self._bindings)
                pin = pin_directory(self._native, root, False, role)
                pins.append(pin)
                candidate = _binding(self._native, pin, root, role)
                covered = any(
                    binding.identity in (candidate.identity, *candidate.ancestors)
                    for binding in self._bindings
                    if binding.path in self._readers
                )
                _revalidate(self._native, self._bindings)
                _release(self._native, pins)
                return covered
            except BaseException as error:
                self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
                try:
                    _cleanup(self._native, [pins], error)
                except DomainReleaseError:
                    self._state = _State.UNCERTAIN
                    raise

    @contextmanager
    def descendants(
        self, roots: Sequence[str], *, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> Iterator[DataInspection]:
        """Inspect descendants while their exclusive ancestor remains qualified."""
        with self._operation():
            if not self._maintenance or self._state is not _State.OCCUPIED:
                raise RuntimeError("descendant inspection requires exclusive qualification")
            pins: list[object] = []
            try:
                _revalidate(self._native, self._bindings)
                selected = {
                    binding.identity for binding in self._bindings if binding.path in self._readers
                }
                bindings = []
                for root in roots:
                    pin = pin_directory(self._native, root, False, role)
                    pins.append(pin)
                    binding = _binding(self._native, pin, root, role)
                    if not selected.intersection((binding.identity, *binding.ancestors)):
                        raise DomainChangedError("inspection escaped exclusive directory")
                    bindings.append(binding)
                with pinned_inspection(self._native, bindings) as view:
                    yield view
                _revalidate(self._native, self._bindings)
            except BaseException as error:
                self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
                try:
                    _cleanup(self._native, [pins], error)
                except DomainReleaseError:
                    self._state = _State.UNCERTAIN
                    raise
            try:
                _release(self._native, pins)
            except DomainReleaseError:
                self._state = _State.UNCERTAIN
                raise

    def inspection_view(self) -> DataInspection:
        with self._operation():
            if self._state is not _State.OCCUPIED:
                raise RuntimeError("inspection view requires occupied admission")
            return _InspectionView(self)

    def _project_failure(self, error: BaseException) -> None:
        self._state = _State.UNCERTAIN

    def project_inspection(self, roots: Sequence[str]) -> AbstractContextManager[DataInspection]:
        with self._operation():
            if self._state is not _State.OCCUPIED:
                raise RuntimeError("project inspection requires occupied admission")
            return _project_inspection(
                self._native, self._readers, tuple(self._bindings), roots, self._project_failure
            )

    def locator_hint(
        self, root: str, role: DirectoryRole = DirectoryRole.PRIVATE
    ) -> DirectoryLocator:
        with self._operation():
            if self._state is not _State.OCCUPIED:
                raise RuntimeError("locator discovery requires occupied admission")
            try:
                _revalidate(self._native, self._bindings)
                value = directory_locator(self._native, root, role)
                _revalidate(self._native, self._bindings)
                return value
            except BaseException as error:
                self._state = _State.UNCERTAIN if _uncertain(error) else _State.FAILED
                _cleanup(self._native, [], error)

    def directory_entries(self, root: str, max_entries: int) -> tuple[tuple[str, bool], ...]:
        with self.inspection(root):
            return self._native.directory_entries(self._readers[root], max_entries)

    def entry_kind(self, root: str, name: str) -> str | None:
        with self.inspection(root):
            return self._native.entry_kind(self._readers[root], name)

    def directory_path(self, root: str) -> str:
        with self.inspection(root):
            return self._native.directory_path(self._readers[root])

    def directory_metadata(self, root: str) -> dict[str, int | str | None]:
        with self.inspection(root):
            return self._native.directory_metadata(self._readers[root])

    def batch_inspection(self) -> AbstractContextManager[DataInspection]:
        return _batch_inspection(self, self._native, self._readers, tuple(self._bindings))

    def read(self, root: str, name: str, max_bytes: int) -> bytes | None:
        with self.inspection(root):
            return self._native.read_at(self._readers[root], name, max_bytes)

    def snapshots(self, root: str, names: Sequence[str], max_bytes: int) -> dict[str, bytes | None]:
        with self.inspection(root):
            return _snapshots(self._native, self._readers[root], names, max_bytes)

    def admit(self) -> None:
        with self._operation():
            if self._maintenance or self._state is not _State.OCCUPIED:
                raise RuntimeError("only an occupied writer can open admission")
            self._state = _State.FAILED
            try:
                _revalidate(self._native, self._bindings)
                self._check_records(
                    _MUTATION_INDEX,
                    _MUTATION_GATE_SUFFIX,
                    {},
                    "unfinished mutation prevents data admission",
                )
                _revalidate(self._native, self._bindings)
                _release(self._native, self._admission)
                self._state = _State.ADMITTED
            except BaseException as error:
                if _uncertain(error):
                    self._state = _State.UNCERTAIN
                raise

    def close(self) -> None:
        with self._operation():
            if self._state is _State.CLOSED:
                raise RuntimeError("domains already closed")
            if self._state is _State.UNCERTAIN:
                raise DomainReleaseError("uncertain domain release requires process exit")
            self._state = _State.CLOSED
            try:
                _cleanup(
                    self._native, [self._pins, self._occupancy, self._admission, self._coordination]
                )
            except DomainReleaseError:
                self._state = _State.UNCERTAIN
                raise


def _check_index_records(
    native: DomainNative,
    coordinator_handle: object,
    bindings: Sequence[DirectoryBinding],
    plan: Sequence[tuple[str, str]],
    index_name: str,
    gate_suffix: str,
    owned: dict[str, bytes],
    message: str,
) -> None:
    """Read blockers under their namespace gates while activity is retained."""
    # This scan reads only coordinator-owned metadata, never business roots.
    # Validate the complete root set at the transaction boundaries; validate the
    # coordinator and each actual index around their IO. Reopening every business
    # root for every ancestor index makes admission quadratic in the root count.
    _revalidate(native, bindings)
    coordinator = bindings[0]
    for identity, mode in plan:
        encoded = identity.replace(":", "-")
        gates: list[object] = []
        pins: list[object] = []
        try:
            gates.append(native.acquire_at(coordinator_handle, encoded + gate_suffix, False))
            _revalidate(native, (coordinator,))
            groups = (
                (_FAMILY_SELF, _FAMILY_DESCENDANTS)
                if mode in {"exclusive", "shared"}
                else (_FAMILY_SELF,)
            )
            for group in groups:
                path = os.path.join(coordinator.path, index_name, encoded, group)
                try:
                    pin = native.pin(path, False)
                except BaseException as error:
                    if getattr(error, "code", None) != "ERR_LEASE_MISSING":
                        raise
                    _revalidate(native, (coordinator,))
                    continue
                pins.append(pin)
                binding = _binding(native, pin, path)
                if coordinator.identity not in binding.ancestors:
                    raise DomainChangedError("family index escaped its retained coordinator")
                expected = (coordinator, binding)
                _revalidate(native, expected)
                records = native.list_records(pin, _FAMILY_MAX_ENTRIES, _FAMILY_MAX_BYTES)
                _revalidate(native, expected)
                if any(
                    name not in owned or owned[name] != payload for name, payload in records.items()
                ):
                    raise DomainBusyError(message)
            _revalidate(native, (coordinator,))
        except BaseException as error:
            _cleanup(native, [pins, gates], error)
        _cleanup(native, [pins, gates])

    _revalidate(native, bindings)


def create_directory(
    native: DomainNative,
    coordinator_path: str,
    parent_path: str,
    name: str,
    *,
    role: DirectoryRole = DirectoryRole.PRIVATE,
) -> str:
    """Create one child while holding sorted intent qualification on its parent."""
    with _create_directory(
        native, coordinator_path, parent_path, name, exclusive=False, role=role
    ) as identity:
        return identity


@contextmanager
def _create_directory(
    native: DomainNative,
    coordinator_path: str,
    parent_path: str,
    name: str,
    *,
    exclusive: bool,
    expected_parent: str | None = None,
    role: DirectoryRole = DirectoryRole.PRIVATE,
) -> Iterator[str]:
    pins: list[object] = []
    coordination: list[object] = []
    admission: list[object] = []
    occupancy: list[object] = []
    try:
        coordinator = native.pin(coordinator_path, False)
        coordination.append(coordinator)
        parent = pin_directory(native, parent_path, False, role)
        pins.append(parent)
        coordinator_binding = _binding(native, coordinator, coordinator_path)
        parent_binding = _binding(native, parent, parent_path, role)
        if expected_parent is not None and parent_binding.identity != expected_parent:
            raise DomainChangedError("creation parent differs from its retained qualification")
        bindings = [coordinator_binding, parent_binding]
        plan = tuple(
            (identity, "intent")
            for identity in sorted({parent_binding.identity, *parent_binding.ancestors})
        )
        admission = _acquire(native, coordinator, plan, "admission")
        _revalidate(native, bindings)
        occupancy = _acquire(native, coordinator, plan, "occupancy")
        _revalidate(native, bindings)
        # Parent is selected for blocker lookup, although namespace creation
        # retains IS activity rather than a whole-directory business writer.
        records_plan = tuple(
            (identity, "shared" if identity == parent_binding.identity else "intent")
            for identity, _mode in plan
        )
        _check_index_records(
            native,
            coordinator,
            bindings,
            records_plan,
            _MUTATION_INDEX,
            _MUTATION_GATE_SUFFIX,
            {},
            "unfinished mutation prevents directory creation",
        )
        _revalidate(native, bindings)
        identity = native.create_child(parent, name, exclusive=exclusive)
        _revalidate(native, bindings)
        child_path = os.path.join(parent_path, name)
        child = pin_directory(native, child_path, False, role)
        pins.append(child)
        selected = _binding(native, child, child_path, role)
        if selected.identity != identity:
            raise DomainChangedError("created directory was replaced")
        if identity in {coordinator_binding.identity, *coordinator_binding.ancestors}:
            raise ValueError("coordination directory must remain outside every data root")
        _revalidate(native, [*bindings, selected])
        yield identity
        _revalidate(native, [*bindings, selected])
    except BaseException as error:
        _cleanup(native, [pins, occupancy, admission, coordination], error)
    _cleanup(native, [pins, occupancy, admission, coordination])


@contextmanager
def created_directory(
    native: DomainNative,
    coordinator_path: str,
    parent_path: str,
    name: str,
    *,
    expected_parent: str | None = None,
    role: DirectoryRole = DirectoryRole.PRIVATE,
) -> Iterator[Domains]:
    """Qualify only a newly created child while retaining existing sibling writers."""
    with _create_directory(
        native,
        coordinator_path,
        parent_path,
        name,
        exclusive=True,
        expected_parent=expected_parent,
        role=role,
    ) as identity:
        root = os.path.join(parent_path, name)
        domains = Domains(
            native,
            coordinator_path,
            (root,),
            maintenance=True,
            _created=_CreatedRoot(root, identity),
            roles={root: role},
        )
        try:
            domains.occupy()
            yield domains
        except BaseException as error:
            if _uncertain(error) or isinstance(error, BaseExceptionGroup):
                domains._state = _State.UNCERTAIN
            raise
        finally:
            domains.close()


def ensure_directories(
    native: DomainNative,
    coordinator_path: str,
    roots: Sequence[str],
    *,
    roles: Mapping[str, DirectoryRole] | None = None,
) -> None:
    """Prepare structure only; callers must resample and qualify all final roots."""
    if not isinstance(roots, Sequence) or isinstance(roots, (str, bytes)) or not roots:
        raise TypeError("directory preparation requires nonempty roots")
    selected_roles = {path: DirectoryRole(role) for path, role in (roles or {}).items()}
    if set(selected_roles) - set(roots):
        raise ValueError("roles require selected roots")
    planned: list[tuple[str, int]] = []
    for root in roots:
        if not isinstance(root, str) or "\0" in root or not os.path.isabs(root):
            raise ValueError("directory preparation requires absolute paths")
        drive, tail = os.path.splitdrive(root)
        components = re.split(r"[\\/]" if os.name == "nt" else "/", tail[1:])
        if root != drive + tail[:1] and any(
            part in {"", ".", ".."}
            or (os.name == "nt" and (":" in part or part.endswith((".", " "))))
            for part in components
        ):
            raise ValueError("directory preparation rejects ambiguous path components")
        planned.append((root, len(components)))
    guardian = directory_guardian()
    if guardian is not None:
        guardian.request(
            "extend",
            [
                {
                    "path": root,
                    "create": True,
                    "role": selected_roles.get(root, DirectoryRole.PRIVATE).value,
                }
                for root, _ in planned
            ],
        )
        return
    for root, limit in planned:
        role = selected_roles.get(root, DirectoryRole.PRIVATE)
        for _ in range(limit + 1):
            ancestor = root
            child = ""
            while True:
                try:
                    pin = pin_directory(native, ancestor, False, role)
                except BaseException as error:
                    if getattr(error, "code", None) != "ERR_LEASE_MISSING":
                        _cleanup(native, [], error)
                    parent = os.path.dirname(ancestor)
                    if parent == ancestor:
                        raise
                    child, ancestor = os.path.basename(ancestor), parent
                    continue
                _release(native, [pin])
                break
            if ancestor == root:
                break
            create_directory(native, coordinator_path, ancestor, child, role=role)
        else:
            raise DomainChangedError("directory structure changed during preparation")


class DomainOwner:
    """Stable process owner while a drained transaction replaces its directory set."""

    def __init__(self, domains: Domains) -> None:
        self._domains: Domains | None = domains
        self._additional: list[Domains] = []

    def retain(self, domains: Domains) -> None:
        if self._domains is None:
            raise DomainReleaseError("storage qualification is unavailable")
        if (
            domains is self._domains
            or domains in self._additional
            or domains._state is not _State.ADMITTED
        ):
            raise ValueError("only a new admitted qualification may be retained")
        self._additional.append(domains)

    def release(self, domains: Domains) -> None:
        """Release one unpublished addition; uncertain close retains ownership."""
        if domains not in self._additional:
            raise ValueError("only an owned additional qualification may be released")
        domains.close()
        self._additional.remove(domains)

    def directory_identity(self, root: str) -> str:
        if self._domains is None:
            raise DomainReleaseError("storage qualification is unavailable")
        identities = {
            identity
            for domains in (self._domains, *self._additional)
            if (identity := domains.retained_identity(root)) is not None
        }
        if len(identities) != 1:
            raise DomainChangedError("directory must have one retained physical identity")
        return identities.pop()

    def close(self) -> None:
        if self._domains is None:
            raise DomainReleaseError("storage qualification is unavailable")
        while self._additional:
            self._additional[-1].close()
            self._additional.pop()
        self._domains.close()
        self._domains = None

    def install(self, domains: Domains) -> None:
        if self._domains is not None:
            raise RuntimeError("previous storage qualification has not been released")
        self._domains = domains
