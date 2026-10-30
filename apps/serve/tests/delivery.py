"""Process-isolated delivery fixture consumed by contract_literature_delivery."""

from __future__ import annotations

import argparse
import errno
import json
import os
import sys
from contextlib import ExitStack
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

import httpx

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.domain.delivery import (
    DELIVERY_NOT_FOUND,
    AcquisitionScope,
    DeliveryChoice,
    DeliveryState,
)
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.acquire import AcquirePaper, acquire_fulltexts
from service.literature.service.delivery import DeliveryService
from service.platform import windows
from service.platform.activity import Activities
from service.platform.content import RootKind
from service.platform.storage import DirectoryHandle
from service.resources.service.writer import ResourceWriter

from .pdf import PageFixture, TextFixture, build_pdf

SESSION_ID = "delivery-session"
RUN_ID = "runs/one"
PAPER_ID = "subfolder"
PAPER_TITLE = "Paper subfolder"
EXPECTED_FILENAME = "Paper subfolder [subfolder].pdf"
PARENT = "papers/theory"
HOME_ENV = "SCHOLARSEED_HOME"
INVALID_WINDOWS_HANDLE = 6


def verify_release(handles: list[DirectoryHandle]) -> int:
    checks = 0
    for handle in handles:
        if not handle.closed:
            raise AssertionError("active directory survived service.close")
        if handle.descriptor is not None:
            try:
                os.fstat(handle.descriptor)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
            else:
                raise AssertionError("native descriptor survived service.close")
            checks += 1
        for native_handle in handle.native_handles:
            try:
                windows.identity(native_handle)
            except OSError as error:
                if getattr(error, "winerror", None) != INVALID_WINDOWS_HANDLE:
                    raise
            else:
                raise AssertionError("native handle survived service.close")
            checks += 1
    if handles and not checks:
        raise AssertionError("no native resource checked")
    return checks


def close_service(
    service: DeliveryService, failure: str, handles: list[DirectoryHandle], evidence: dict
) -> None:
    try:
        if failure != "omitted_close":
            evidence["close_called"] = True
            if failure in ("cleanup", "save_cleanup"):
                original_close = DirectoryHandle.close

                def reject_release(handle: DirectoryHandle) -> None:
                    if handles and handle is handles[0]:
                        raise OSError("injected fixture failure: cleanup")
                    original_close(handle)

                with patch.object(DirectoryHandle, "close", reject_release):
                    service.close()
            else:
                service.close()
        evidence["native_checks"] = verify_release(handles)
    finally:
        for handle in handles:
            if not handle.closed:
                handle.close()
        evidence["native_checks"] = verify_release(handles)
        evidence["released"] = True
        print(json.dumps({"release_proof": evidence}), file=sys.stderr)


def track_directory(
    service: DeliveryService, root: Path, delivery_id: str, handles: list[DirectoryHandle]
) -> None:
    selected = root / "release-probe"
    selected.mkdir(exist_ok=True)
    ticket = service.choose_directory(SESSION_ID, delivery_id, str(selected))["ticket"]
    with service.directory(SESSION_ID, delivery_id, ticket) as handle:
        handle.identity()
        handles.append(handle)


def exercise(root: Path, phase: str, marker: str, receipt: dict, peer: str, failure: str) -> dict:
    if Path(os.environ[HOME_ENV]).resolve() != root / "home":
        raise AssertionError("fixture requires its own pre-import home")
    workspace = root / "workspace"
    workspace.mkdir(exist_ok=True)
    if failure == "setup":
        raise RuntimeError("injected fixture failure: setup")
    catalog = ContentCatalog(root / "catalog.sqlite3")
    content = ContentService(
        ProjectRegistry(str(workspace), catalog), catalog, activities=Activities()
    )
    repository = LiteratureRepository()
    if not Path(repository.database).resolve().is_relative_to(root / "home"):
        raise AssertionError("repository escaped its case home")
    with ExitStack() as resources:
        service = DeliveryService(content, ResourceWriter(content), repository)
        handles: list[DirectoryHandle] = []
        evidence = {
            "pid": os.getpid(),
            "close_called": False,
            "native_checks": 0,
            "released": False,
        }
        resources.callback(close_service, service, failure, handles, evidence)
        if phase == "save":
            if service.store.candidates():
                raise AssertionError("new case inherited delivery state")
            project = content.create_project("Delivery pilot")
            payload = build_pdf(PageFixture(texts=(TextFixture(72, 80, marker),)))
            with httpx.MockTransport(lambda _: httpx.Response(200, content=payload)) as transport:
                acquire_fulltexts(
                    (AcquirePaper(PAPER_ID, "2201.05596", "arxiv", PAPER_TITLE),),
                    scope=AcquisitionScope(SESSION_ID, project.id, RUN_ID),
                    transport=transport,
                )
            if failure == "acquire":
                raise RuntimeError("injected fixture failure: acquire")
            delivery = service.seal(SESSION_ID, RUN_ID)
            track_directory(service, root, delivery["id"], handles)
            value = service.save(
                SESSION_ID,
                delivery["id"],
                DeliveryChoice(target="project", parent=PARENT),
            )
            if failure in ("save", "save_cleanup"):
                raise RuntimeError("injected fixture failure: save")
            receipt = {
                "delivery_id": delivery["id"],
                "project_id": project.id,
                "resource_path": value["papers"][0]["resource_path"],
                "sha256": sha256(payload).hexdigest(),
            }
        value = service.get(SESSION_ID, receipt["delivery_id"])
        if not handles:
            track_directory(service, root, receipt["delivery_id"], handles)
        if value["state"] != DeliveryState.SAVED:
            raise AssertionError("saved state did not survive")
        if value["project_id"] != receipt["project_id"]:
            raise AssertionError("delivery project changed")
        if value["papers"][0]["resource_path"] != receipt["resource_path"]:
            raise AssertionError("saved path changed")
        resource = Path(content.resolve(receipt["project_id"], receipt["resource_path"]))
        if not resource.resolve(strict=True).is_relative_to(workspace):
            raise AssertionError("delivery escaped its case workspace")
        resource_root = content.root(receipt["project_id"], RootKind.RESOURCES)
        expected_parent = Path(content.resolve(receipt["project_id"], resource_root.path)) / PARENT
        if resource.parent != expected_parent or resource.name != EXPECTED_FILENAME:
            raise AssertionError("independent delivery destination mismatch")
        digest = sha256(resource.read_bytes()).hexdigest()
        if digest != receipt["sha256"]:
            raise AssertionError("independent payload digest mismatch")
        if len(service.store.candidates()) != 1:
            raise AssertionError("case contains another delivery")
        peer_rejected = False
        if peer:
            try:
                service.get(SESSION_ID, peer)
            except ValueError as error:
                if str(error) != DELIVERY_NOT_FOUND:
                    raise
                peer_rejected = True
            if not peer_rejected:
                raise AssertionError("another case is visible")
        return {
            **receipt,
            "state": value["state"],
            "filename": resource.name,
            "peer_rejected": peer_rejected,
            "cleanup": evidence,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("phase", choices=("save", "read"))
    parser.add_argument("--marker", type=json.loads)
    parser.add_argument("--receipt", type=json.loads)
    parser.add_argument("--peer", type=json.loads)
    parser.add_argument("--failure", type=json.loads)
    options = parser.parse_args()
    result = exercise(
        options.root.resolve(strict=True),
        options.phase,
        options.marker or "",
        options.receipt or {},
        options.peer or "",
        options.failure or "",
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
