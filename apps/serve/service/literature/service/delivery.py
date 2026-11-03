from __future__ import annotations

import logging
import secrets
import threading
import time
from contextlib import closing, contextmanager
from pathlib import PurePath
from uuid import uuid4

from service.content.domain.model import ContentError
from service.content.service.export import export_bytes, identical_export, open_export_directory
from service.literature.domain.delivery import (
    DELIVERY_BUSY,
    DELIVERY_NOT_READY,
    DELIVERY_SOURCE_CHANGED,
    DELIVERY_TARGET_CHANGED,
    DELIVERY_TARGET_CONFLICT,
    DELIVERY_TARGET_REQUIRED,
    DELIVERY_TICKET_SECONDS,
    DeliveryChoice,
    DeliveryItemState,
    DeliveryState,
    DeliveryTarget,
    DeliveryVersionChoice,
)
from service.literature.domain.utils import (
    FILENAME_CHARS,
    PDF_SUFFIX,
    delivery_project_id,
    paper_filename,
)
from service.literature.persistence.delivery import DeliveryStore
from service.literature.persistence.files import (
    REVISION_PREFIX,
    is_available_attachment,
    payload_revision,
    read_attachment,
)
from service.literature.persistence.store import LiteratureRepository, connect
from service.literature.service.downloads import DownloadAdmission
from service.literature.service.duplicates import DeliveryDuplicates
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.content import ContentPort, RootKind
from service.platform.storage import DirectoryHandle
from service.resources.domain.model import ResourceLocationRef
from service.resources.service.writer import ResourceWriter

LOGGER = logging.getLogger(__name__)
DIRECTORY_LABEL = "directory"
DIRECTORY_IDENTITY = "directory_identity"
TICKET_BYTES = 32
DELIVERY_SAVE_FAILED = "literature_delivery_save_failed"
DELIVERY_LIBRARY_FAILED = "literature_delivery_library_failed"


class DeliveryService:
    def task_documents(self, session_id: str, project_path: str) -> tuple[dict, ...]:
        project = next(
            (project for project in self._content.projects() if project.root == project_path), None
        )
        if project is None:
            return ()
        documents = {}
        for delivery in self.store.for_session(session_id, project.id):
            for paper in delivery["papers"]:
                name = paper.get("object_name")
                if not name or not is_available_attachment(
                    str(SERVICE_LITERATURE_FILES_DIR / name)
                ):
                    continue
                literature_id = paper.get("literature_id") or ""
                attachment = (
                    self._repository.primary_attachment(literature_id) if literature_id else None
                )
                if attachment is None:
                    attachment = self._repository.project_attachment_revision(
                        project.id, paper["revision"]
                    )
                    literature_id = attachment.literature_id if attachment else ""
                documents[paper["paper_id"]] = {
                    "id": paper["paper_id"],
                    "title": paper["title"],
                    "literature_id": literature_id,
                    "attachment_id": attachment.id if attachment else None,
                }
        return tuple(documents.values())

    def __init__(
        self, content: ContentPort, writer: ResourceWriter, repository: LiteratureRepository
    ):
        self.store = DeliveryStore()
        self._content = content
        self._writer = writer
        self._repository = repository
        self._tickets: dict[str, tuple[str, str, float, DirectoryHandle]] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._saving = threading.Lock()
        self._duplicates = DeliveryDuplicates(content, self.store, self.directory)
        self._guard = threading.Lock()
        self._targets = {
            DeliveryTarget.PROJECT: self._save_project,
            DeliveryTarget.DIRECTORY: self._save_directory,
        }

    def close(self) -> None:
        with self._guard:
            tickets, self._tickets = self._tickets, {}
        for _, _, _, directory in tickets.values():
            directory.close()

    def project_directory(self, project_id: str, parent: str) -> str:
        if not project_id or not any(
            project.id == project_id for project in self._content.projects()
        ):
            raise ValueError(DELIVERY_TARGET_REQUIRED)
        try:
            relative = self._content.within_root(project_id, RootKind.RESOURCES, parent)
            return self._content.resolve(project_id, relative)
        except ContentError as error:
            raise ValueError(DELIVERY_TARGET_CHANGED) from error

    def get(self, session_id: str, delivery_id: str) -> dict:
        value = self.store.get(session_id, delivery_id)
        with self._guard:
            lock = self._locks.get(delivery_id)
            interrupted = value["state"] == DeliveryState.SAVING and not (lock and lock.locked())
        if interrupted:
            value = self.store.update(
                session_id,
                delivery_id,
                lambda current: (
                    current.update(state=DeliveryState.PARTIAL)
                    if current["state"] == DeliveryState.SAVING
                    else None
                ),
            )
        return value

    def public(self, value: dict) -> dict:
        return {
            **{
                key: value[key]
                for key in ("id", "session_id", "project_id", "state", "prompted", "failures")
            },
            "choice": value["choice"],
            "attempt_id": value.get("attempt_id", ""),
            "history": [
                {
                    "attempt_id": attempt["attempt_id"],
                    "choice": attempt["choice"],
                    "state": attempt["state"],
                    "papers": self._public_papers(attempt["papers"]),
                }
                for attempt in value.get("history", [])
            ],
            "papers": self._public_papers(value["papers"]),
        }

    @staticmethod
    def _public_papers(papers: list[dict]) -> list[dict]:
        return [
            {
                **{
                    key: paper[key]
                    for key in (
                        "paper_id",
                        "title",
                        "revision",
                        "saved",
                        "library",
                        "resource_path",
                        "literature_id",
                        "error",
                        "library_error",
                    )
                },
                **{
                    key: paper.get(key, default)
                    for key, default in (
                        ("save_reused", False),
                        ("library_reused", False),
                        ("versions", []),
                    )
                },
            }
            for paper in papers
        ]

    def seal(self, session_id: str, run: str) -> dict:
        value = self.store.by_run(session_id, run)

        def change(current: dict) -> None:
            if current["state"] == DeliveryState.ACQUIRING:
                for paper in current["papers"]:
                    self._payload(paper)
                current["state"] = DeliveryState.PENDING

        return self.store.update(session_id, value["id"], change)

    def prompt(self, session_id: str, delivery_id: str) -> bool:
        claimed = False

        def change(value: dict) -> None:
            nonlocal claimed
            if (
                value["state"] == DeliveryState.PENDING
                and value["papers"]
                and not value["prompted"]
            ):
                value["prompted"] = True
                claimed = True

        self.store.update(session_id, delivery_id, change)
        return claimed

    def cancel(self, session_id: str, delivery_id: str) -> dict:
        def change(value: dict) -> None:
            if value["state"] == DeliveryState.SAVING:
                raise ValueError(DELIVERY_BUSY)
            if value["state"] != DeliveryState.SAVED:
                value["state"] = DeliveryState.CANCELED
            value["prompted"] = True

        return self.store.update(session_id, delivery_id, change)

    def choose_directory(self, session_id: str, delivery_id: str, absolute: str) -> dict:
        value = self.get(session_id, delivery_id)
        if value["state"] in (DeliveryState.ACQUIRING, DeliveryState.SAVING):
            raise ValueError(DELIVERY_NOT_READY)
        directory = open_export_directory(absolute)
        ticket = secrets.token_urlsafe(TICKET_BYTES)
        with self._guard:
            expired = [key for key, entry in self._tickets.items() if entry[2] < time.monotonic()]
            for key in expired:
                self._tickets.pop(key)[3].close()
            self._tickets[ticket] = (
                session_id,
                delivery_id,
                time.monotonic() + DELIVERY_TICKET_SECONDS,
                directory,
            )
        return {"ticket": ticket, "label": str(directory.path)}

    @contextmanager
    def directory(self, session_id: str, delivery_id: str, ticket: str):
        with self._guard:
            entry = self._tickets.get(ticket)
            if (
                entry is None
                or entry[:2] != (session_id, delivery_id)
                or entry[2] < time.monotonic()
            ):
                raise ValueError(DELIVERY_TARGET_REQUIRED)
            yield entry[3]

    def saved_directory(self, value: dict) -> str:
        choice = value["choice"]
        if not choice or not any(
            paper["saved"] == DeliveryItemState.SAVED for paper in value["papers"]
        ):
            raise ValueError(DELIVERY_NOT_READY)
        with closing(open_export_directory(choice[DIRECTORY_LABEL])) as directory:
            if list(directory.identity()) != choice[DIRECTORY_IDENTITY]:
                raise ValueError(DELIVERY_TARGET_CHANGED)
            return str(directory.path)

    def _payload(self, paper: dict) -> bytes:
        payload = read_attachment(str(SERVICE_LITERATURE_FILES_DIR / paper["object_name"]))
        if payload_revision(payload) != paper["revision"]:
            raise ValueError(DELIVERY_SOURCE_CHANGED)
        return payload

    def _save_project(self, value: dict, paper: dict, payload: bytes, choice: dict) -> str:
        asset = self._writer.import_once(
            delivery_project_id(value, choice),
            paper.get("save_operation") or f'{value["id"]}:{paper["paper_id"]}',
            paper["revision"],
            paper_filename(paper),
            payload,
            ResourceLocationRef(choice["parent"], paper_filename(paper)),
        )
        return asset.path

    def _save_directory(self, value: dict, paper: dict, payload: bytes, choice: dict) -> str:
        with self.directory(value["session_id"], value["id"], choice["ticket"]) as directory:
            name = paper_filename(paper)
            if command := choice.get("versions", {}).get(paper["paper_id"]):
                if command == DeliveryVersionChoice.KEEP_BOTH:
                    stem = (
                        PurePath(name)
                        .stem.encode("utf-8")[:FILENAME_CHARS]
                        .decode("utf-8", errors="ignore")
                    )
                    name = f"{stem} [{paper['revision'].removeprefix(REVISION_PREFIX)}]{PDF_SUFFIX}"
            return export_bytes(directory, name, payload, paper["revision"])

    def _admit_library(self, value: dict, paper: dict, payload: bytes, collection: str) -> str:
        with closing(connect()) as connection:
            reused = any(
                entry["revision"] == paper["revision"]
                for entry in self._duplicates.library_candidates(paper, connection)
            )
        receipt = DownloadAdmission(self._repository).admit_payload(
            {**paper, "run": value["run"]},
            payload,
            value["session_id"],
            delivery_project_id(value),
            restore=True,
            collection_id=collection,
        )
        self._record_item(
            value["session_id"],
            value["id"],
            paper["paper_id"],
            {
                "literature_id": receipt.literature_id,
                "library": DeliveryItemState.SAVED,
                "library_error": "",
                "library_reused": reused,
            },
        )
        return receipt.literature_id

    def save(self, session_id: str, delivery_id: str, command: DeliveryChoice) -> dict:
        with self._guard:
            lock = self._locks.setdefault(delivery_id, threading.Lock())
        if not lock.acquire(blocking=False):
            raise ValueError(DELIVERY_BUSY)
        self._saving.acquire()
        try:
            value = self.store.get(session_id, delivery_id)
            if value["state"] == DeliveryState.ACQUIRING or not value["papers"]:
                raise ValueError(DELIVERY_NOT_READY)
            target = DeliveryTarget(command.target)
            choice = command.model_dump()
            if target is DeliveryTarget.PROJECT:
                choice["project_id"] = delivery_project_id(value, choice)
                self.project_directory(choice["project_id"], choice["parent"])
            elif command.project_id:
                raise ValueError(DELIVERY_TARGET_CONFLICT)
            if not set(command.versions).issubset(paper["paper_id"] for paper in value["papers"]):
                raise ValueError(DELIVERY_TARGET_CONFLICT)
            if target is DeliveryTarget.DIRECTORY:
                with self.directory(session_id, delivery_id, command.ticket) as directory:
                    choice[DIRECTORY_LABEL] = str(directory.path)
                    choice[DIRECTORY_IDENTITY] = list(directory.identity())
            value = self.store.begin(session_id, delivery_id, choice)
            for paper in value["papers"]:
                if paper["saved"] == DeliveryItemState.SKIPPED:
                    continue
                if (
                    paper["saved"] == DeliveryItemState.SAVED
                    and self._duplicates.saved_revision({**value, "choice": choice}, paper)
                    != paper["revision"]
                ):
                    paper.update(
                        saved=DeliveryItemState.PENDING,
                        save_reused=False,
                        save_operation=f'{value["id"]}:{paper["paper_id"]}:{uuid4().hex}',
                    )
                    self._record_item(
                        session_id,
                        delivery_id,
                        paper["paper_id"],
                        {
                            "saved": DeliveryItemState.PENDING,
                            "save_reused": False,
                            "save_operation": paper["save_operation"],
                        },
                    )
                if command.add_to_library and paper["library"] == DeliveryItemState.SAVED:
                    with closing(connect()) as connection:
                        valid = any(
                            entry["literature_id"] == paper["literature_id"]
                            and entry["revision"] == paper["revision"]
                            for entry in self._duplicates.library_candidates(paper, connection)
                        )
                    if not valid:
                        paper.update(library=DeliveryItemState.PENDING, library_reused=False)
                        self._record_item(
                            session_id,
                            delivery_id,
                            paper["paper_id"],
                            {"library": DeliveryItemState.PENDING, "library_reused": False},
                        )
                if paper["saved"] == DeliveryItemState.SAVED:
                    self._record_item(
                        session_id, delivery_id, paper["paper_id"], {"save_reused": True}
                    )
                if paper["saved"] == DeliveryItemState.SAVED and (
                    not command.add_to_library
                    or paper["library"] in (DeliveryItemState.SAVED, DeliveryItemState.SKIPPED)
                ):
                    continue
                try:
                    payload = self._payload(paper)
                except (OSError, ValueError):
                    self._record_item(
                        session_id,
                        delivery_id,
                        paper["paper_id"],
                        {
                            "saved": (
                                paper["saved"]
                                if paper["saved"] == DeliveryItemState.SAVED
                                else DeliveryItemState.FAILED
                            ),
                            "error": DELIVERY_SOURCE_CHANGED,
                        },
                    )
                    continue
                versions = self._duplicates.versions(value, paper, choice)
                decision = command.versions.get(paper["paper_id"])
                self._record_item(
                    session_id,
                    delivery_id,
                    paper["paper_id"],
                    {"versions": versions if not decision else []},
                )
                if versions and not decision:
                    continue
                if decision == DeliveryVersionChoice.SKIP:
                    self._record_item(
                        session_id,
                        delivery_id,
                        paper["paper_id"],
                        {
                            "saved": (
                                paper["saved"]
                                if paper["saved"] == DeliveryItemState.SAVED
                                else DeliveryItemState.SKIPPED
                            ),
                            "library": (
                                paper["library"]
                                if paper["library"] == DeliveryItemState.SAVED
                                else DeliveryItemState.SKIPPED
                            ),
                            "error": "",
                            "library_error": "",
                        },
                    )
                    continue
                if paper["saved"] != DeliveryItemState.SAVED:
                    try:
                        if target == DeliveryTarget.PROJECT:
                            duplicate = self._duplicates.project_file(value, payload, choice)
                        else:
                            with self.directory(
                                session_id, delivery_id, command.ticket
                            ) as directory:
                                duplicate = identical_export(directory, payload)
                        location = duplicate or self._targets[target](value, paper, payload, choice)
                        self._record_item(
                            session_id,
                            delivery_id,
                            paper["paper_id"],
                            {
                                "saved": DeliveryItemState.SAVED,
                                "resource_path": location,
                                "error": "",
                                "save_reused": bool(duplicate),
                            },
                        )
                    except (OSError, ValueError, RuntimeError) as error:
                        LOGGER.warning(
                            "literature_delivery_save_failed delivery=%s paper=%s error=%s",
                            delivery_id,
                            paper["paper_id"],
                            error,
                        )
                        self._record_item(
                            session_id,
                            delivery_id,
                            paper["paper_id"],
                            {
                                "saved": DeliveryItemState.FAILED,
                                "error": DELIVERY_SAVE_FAILED,
                            },
                        )
                if command.add_to_library and paper["library"] not in (
                    DeliveryItemState.SAVED,
                    DeliveryItemState.SKIPPED,
                ):
                    try:
                        self._admit_library(value, paper, payload, command.collection_id)
                    except (OSError, ValueError, RuntimeError) as error:
                        LOGGER.warning(
                            "literature_delivery_library_failed delivery=%s paper=%s error=%s",
                            delivery_id,
                            paper["paper_id"],
                            error,
                        )
                        self._record_item(
                            session_id,
                            delivery_id,
                            paper["paper_id"],
                            {
                                "library": DeliveryItemState.FAILED,
                                "library_error": DELIVERY_LIBRARY_FAILED,
                            },
                        )

            def finish(current: dict) -> None:
                complete = all(
                    paper["saved"] == DeliveryItemState.SKIPPED
                    or (
                        paper["saved"] == DeliveryItemState.SAVED
                        and (
                            not command.add_to_library
                            or paper["library"]
                            in (DeliveryItemState.SAVED, DeliveryItemState.SKIPPED)
                        )
                    )
                    for paper in current["papers"]
                )
                current["state"] = DeliveryState.SAVED if complete else DeliveryState.PARTIAL

            return self.store.update(session_id, delivery_id, finish)
        finally:
            self._saving.release()
            lock.release()

    def _record_item(self, session_id: str, delivery_id: str, paper_id: str, fields: dict) -> None:
        def change(value: dict) -> None:
            next(paper for paper in value["papers"] if paper["paper_id"] == paper_id).update(fields)

        self.store.update(session_id, delivery_id, change)
