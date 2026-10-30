"""Creation provenance checked against the original plan and occupied native roots."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from service.content.domain.model import (
    MANAGED_LITERATURE_ROOT_RELATIVE,
    MANAGED_RESOURCES_ROOT_RELATIVE,
    PROJECT_STATE_DIRNAME,
    ContentError,
)
from service.content.persistence.catalog import ProjectCreation
from service.paths import PROJECT_CREATION_RECEIPT_FILENAME
from service.platform.domains import DataInspection, DomainChangedError, DomainNative, Domains
from service.platform.storage import DirectoryRole, LeaseError

CREATION_RECEIPT_LIMIT = 1024 * 1024
CREATION_PROVENANCE_REQUIRED = "project_creation_provenance_required"
PROJECT_CREATION_DIRECTORIES = (
    MANAGED_RESOURCES_ROOT_RELATIVE,
    MANAGED_LITERATURE_ROOT_RELATIVE,
    PROJECT_STATE_DIRNAME,
)


@dataclass(frozen=True)
class CreationObservation:
    operation: str
    root: Path
    phase: str
    identity: str | None = None
    receipt: bytes | None = None
    roots: tuple[str, ...] = ()


def observe_project_creations(
    native: DomainNative,
    domains: DataInspection,
    creations: tuple[ProjectCreation, ...],
    workspace: Path,
) -> tuple[CreationObservation, ...]:
    """Observe existing children under the qualified workspace, without repair.

    Only native missing-directory results mean absent. Permission, namespace,
    stream and cleanup failures remain errors; none become a usable empty home.
    Returned paths are discovery inputs, not write or creation permissions.
    """
    observed = []
    for creation in creations:
        candidate = Path(creation.plan.dir_root)
        if candidate.parent != workspace:
            raise DomainChangedError("project creation workspace changed")
        if not domains.selected(str(workspace)):
            observed.append(
                CreationObservation(
                    creation.operation_id, candidate, "unselected", roots=(str(workspace),)
                )
            )
            continue
        expected_parent = domains.directory_identity(str(workspace))
        with domains.inspection(str(workspace)):
            pins = []
            try:
                parent = native.pin(str(workspace), False, DirectoryRole.PROJECT)
                pins.append(parent)
                if native.lineage(parent)[-1] != expected_parent:
                    raise DomainChangedError("creation workspace was replaced")
                try:
                    root = native.pin(str(candidate), False, DirectoryRole.PROJECT)
                except LeaseError as error:
                    if error.code != "ERR_LEASE_MISSING":
                        raise
                    # A recorded identity cannot be recreated: normal recovery
                    # verifies it and defers the operation when its root is gone.
                    phase = "absent" if creation.directory_identity is None else "lost"
                    observed.append(CreationObservation(creation.operation_id, candidate, phase))
                    continue
                pins.append(root)
                identity = native.lineage(root)[-1]
                roots: tuple[str, ...] = (str(candidate),)
                if creation.directory_identity not in (None, identity):
                    observed.append(
                        CreationObservation(
                            creation.operation_id, candidate, "unproven", identity, roots=roots
                        )
                    )
                    continue
                try:
                    state = native.pin(
                        str(candidate / PROJECT_STATE_DIRNAME), False, DirectoryRole.PROJECT
                    )
                except LeaseError as error:
                    if error.code != "ERR_LEASE_MISSING":
                        raise
                    observed.append(
                        CreationObservation(
                            creation.operation_id, candidate, "unproven", identity, roots=roots
                        )
                    )
                    continue
                pins.append(state)
                roots += (str(candidate / PROJECT_STATE_DIRNAME),)
                data = native.read_at(
                    state, PROJECT_CREATION_RECEIPT_FILENAME, CREATION_RECEIPT_LIMIT
                )
                try:
                    verify_project_creation_record(creation, identity, data)
                except ContentError:
                    phase = "unproven"
                else:
                    phase = "verified"
                    # Normal recovery prepares these children before committing
                    # the catalog. Inspect existing children with the same strict
                    # native reader; missing children remain creation work, never
                    # a reason to repair or adopt an existing unsafe directory.
                    for relative in PROJECT_CREATION_DIRECTORIES:
                        if relative == PROJECT_STATE_DIRNAME:
                            continue
                        path = candidate / relative
                        try:
                            child = native.pin(str(path), False, DirectoryRole.PROJECT)
                        except LeaseError as error:
                            if error.code != "ERR_LEASE_MISSING":
                                raise
                        else:
                            pins.append(child)
                            roots += (str(path),)
                observed.append(
                    CreationObservation(
                        creation.operation_id, candidate, phase, identity, data, roots
                    )
                )
            finally:
                # Stop at the first uncertain release, retaining the remaining
                # capabilities for process cleanup; never continue best effort.
                while pins:
                    native.release(pins[-1])
                    pins.pop()
    return tuple(observed)


def _receipt(creation: ProjectCreation, identity: str) -> bytes:
    data = json.dumps(
        {
            "operation": creation.operation_id,
            "owner": creation.owner,
            "project": asdict(creation.plan),
            "nonce": creation.nonce,
            "directory": identity,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(data) > CREATION_RECEIPT_LIMIT:
        raise ContentError(CREATION_PROVENANCE_REQUIRED)
    return data


def _initialize_project_state(
    native: DomainNative,
    creation: ProjectCreation,
    root: object,
    identity: str,
    pins: list[object],
) -> None:
    candidate = Path(creation.plan.dir_root)
    state_identity = native.create_child(root, PROJECT_STATE_DIRNAME, exclusive=True)
    state = native.pin(str(candidate / PROJECT_STATE_DIRNAME), False, DirectoryRole.PROJECT)
    pins.append(state)
    if native.lineage(state)[-1] != state_identity:
        raise DomainChangedError("created project state was replaced")
    native.create_at(state, PROJECT_CREATION_RECEIPT_FILENAME, _receipt(creation, identity))


def prepare_project_creation(
    native: DomainNative, domains: Domains, creation: ProjectCreation, workspace: Path
) -> str:
    """Only a newly created child receives a receipt; no repair of existing entries.

    The caller must persist the plan first. Parent maintenance qualification covers
    its descendants. A crash before receipt publication leaves ambiguous evidence.
    """
    candidate = Path(creation.plan.dir_root)
    if candidate.parent != workspace or creation.directory_identity is not None:
        raise ContentError(CREATION_PROVENANCE_REQUIRED)
    expected_parent = domains.directory_identity(str(workspace))
    with domains.mutation():
        pins: list[object] = []
        try:
            parent = native.pin(str(workspace), False, DirectoryRole.PROJECT)
            pins.append(parent)
            if native.lineage(parent)[-1] != expected_parent:
                raise DomainChangedError("creation workspace was replaced")
            identity = native.create_child(parent, candidate.name, exclusive=True)
            root = native.pin(str(candidate), False, DirectoryRole.PROJECT)
            pins.append(root)
            if native.lineage(root)[-1] != identity:
                raise DomainChangedError("created project was replaced")
            _initialize_project_state(native, creation, root, identity, pins)
            return identity
        finally:
            # Uncertain close stops release, preserving the remaining pins.
            while pins:
                native.release(pins[-1])
                pins.pop()


def initialize_project_creation(
    native: DomainNative, domains: Domains, creation: ProjectCreation
) -> str:
    """Publish provenance only inside this transaction's newly created exclusive root."""
    candidate = Path(creation.plan.dir_root)
    identity = domains.directory_identity(str(candidate))
    pins: list[object] = []
    with domains.mutation():
        try:
            root = native.pin(str(candidate), False, DirectoryRole.PROJECT)
            pins.append(root)
            if native.lineage(root)[-1] != identity:
                raise DomainChangedError("created project was replaced")
            _initialize_project_state(native, creation, root, identity, pins)
            return identity
        finally:
            while pins:
                native.release(pins[-1])
                pins.pop()


def verify_project_creation(
    native: DomainNative, domains: DataInspection, creation: ProjectCreation
) -> str:
    """Read provenance before inspecting databases; this never creates or repairs files."""
    candidate = Path(creation.plan.dir_root)
    identity = domains.directory_identity(str(candidate))
    with domains.inspection(str(candidate)):
        if creation.directory_identity not in (None, identity):
            raise ContentError(CREATION_PROVENANCE_REQUIRED)
        pins: list[object] = []
        try:
            root = native.pin(str(candidate), False, DirectoryRole.PROJECT)
            pins.append(root)
            if native.lineage(root)[-1] != identity:
                raise DomainChangedError("creation candidate was replaced")
            state = native.pin(str(candidate / PROJECT_STATE_DIRNAME), False, DirectoryRole.PROJECT)
            pins.append(state)
            data = native.read_at(state, PROJECT_CREATION_RECEIPT_FILENAME, CREATION_RECEIPT_LIMIT)
            return verify_project_creation_record(creation, identity, data)
        finally:
            while pins:
                native.release(pins[-1])
                pins.pop()


def verify_project_creation_record(
    creation: ProjectCreation, identity: str, data: bytes | None
) -> str:
    """The actual receipt reader, reusable with privately transported observations.

    The caller still owes native directory identity and read qualification. Bytes
    never authorize a path, create a directory or replace the catalog's plan.
    """
    if (
        not isinstance(identity, str)
        or not identity
        or "\0" in identity
        or creation.directory_identity not in (None, identity)
        or data != _receipt(creation, identity)
    ):
        raise ContentError(CREATION_PROVENANCE_REQUIRED)
    return identity
