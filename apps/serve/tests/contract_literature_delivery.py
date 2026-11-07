from __future__ import annotations

import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_PREVIOUS_HOME = os.environ.get("SCHOLARSEED_HOME")
_HOME = tempfile.TemporaryDirectory(
    prefix="ss-delivery-contract-", dir=Path(tempfile.gettempdir()).resolve()
)
os.environ["SCHOLARSEED_HOME"] = _HOME.name


def cleanup_home() -> None:
    try:
        _HOME.cleanup()
    finally:
        if _PREVIOUS_HOME is None:
            os.environ.pop("SCHOLARSEED_HOME", None)
        else:
            os.environ["SCHOLARSEED_HOME"] = _PREVIOUS_HOME


unittest.addModuleCleanup(cleanup_home)

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402 -- isolated product home before service imports
from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfWriter  # noqa: E402
from pypdf.annotations import Link  # noqa: E402

from service.chat.runtime.secrets import _launch_secret_contract  # noqa: E402
from service.cli.bridge import parser  # noqa: E402
from service.content.persistence.catalog import ContentCatalog  # noqa: E402
from service.content.service.port import ContentService, ProjectRegistry  # noqa: E402
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV  # noqa: E402
from service.literature.api.delivery import register_delivery_routes  # noqa: E402
from service.literature.domain.delivery import AcquisitionScope, DeliveryChoice  # noqa: E402
from service.literature.domain.utils import paper_filename  # noqa: E402
from service.literature.persistence.files import payload_revision  # noqa: E402
from service.literature.persistence.fulltexts import (  # noqa: E402
    find_fulltext_object,
    fulltext_candidates,
)
from service.literature.persistence.store import LiteratureRepository, connect  # noqa: E402
from service.literature.schema import LiteratureItem, LiteratureNote, new_item_id  # noqa: E402
from service.literature.service.acquire import AcquirePaper, acquire_fulltexts  # noqa: E402
from service.literature.service.delivery import DeliveryService  # noqa: E402
from service.literature.service.downloads import DownloadAdmission  # noqa: E402
from service.literature.service.fulltexts import ManagedFulltexts  # noqa: E402
from service.literature.service.identity import paper_identity  # noqa: E402
from service.paths import SERVICE_LITERATURE_FILES_DIR  # noqa: E402
from service.platform.activity import Activities  # noqa: E402
from service.platform.bridge import LiteratureDelivery  # noqa: E402
from service.platform.citations import CitationSourceChanged  # noqa: E402
from service.platform.content import RootKind  # noqa: E402
from service.platform.context import FulltextTaskContext, ProductTaskType  # noqa: E402
from service.resources.service.writer import ResourceWriter, ResourceWriterError  # noqa: E402

from ._directories import directory  # noqa: E402
from .delivery import verify_release  # noqa: E402
from .utils import isolated_case  # noqa: E402


def pdf_bytes(arxiv: str = "") -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    if arxiv:
        writer.add_annotation(
            page_number=0,
            annotation=Link(rect=(0, 0, 100, 20), url="https://arxiv.org/abs/" + arxiv),
        )
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


CLOSED_DATABASE_MESSAGE = "Cannot operate on a closed database."


class DeliveryContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.case_isolation: dict[str, object] = {
            "actualHome": _HOME.name,
            "workspace": str(self.root),
        }
        self.connections = []
        original_connect = sqlite3.connect

        def record_connection(*arguments, **keywords):
            connection = original_connect(*arguments, **keywords)
            self.connections.append(connection)
            return connection

        connection_patch = patch.object(sqlite3, "connect", record_connection)
        connection_patch.start()
        self.addCleanup(connection_patch.stop)
        self.addCleanup(self.verify_connections)
        catalog = ContentCatalog(self.root / "content.sqlite3")
        self.activities = Activities()
        self.content = ContentService(
            ProjectRegistry(str(self.root), catalog), catalog, activities=self.activities
        )
        self.project = self.content.create_project("Delivery")
        self.repository = LiteratureRepository()
        self.case_isolation["actualDB"] = str(self.repository.database)
        self.assertTrue(
            Path(self.repository.database).resolve().is_relative_to(Path(_HOME.name).resolve())
        )
        self.service = DeliveryService(self.content, ResourceWriter(self.content), self.repository)
        self.addCleanup(self.release_service)
        self.session = self.project.id
        self.run = "runs/one"
        self.payload = pdf_bytes()

    def verify_connections(self):
        leaked = []
        failures = []
        for connection in self.connections:
            try:
                _transaction = connection.in_transaction
            except sqlite3.ProgrammingError as error:
                if str(error) != CLOSED_DATABASE_MESSAGE:
                    failures.append(error)
                    leaked.append(connection)
            else:
                leaked.append(connection)
        self.case_isolation["connectionCount"] = len(self.connections)
        self.case_isolation["connectionsClosedBeforeCleanup"] = not leaked
        if leaked:
            failures.append(self.failureException("real SQLite connections survived case cleanup"))
        for connection in leaked:
            try:
                connection.close()
            except BaseException as error:
                failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("SQLite leak and cleanup failures", failures)

    def release_service(self):
        handles = [entry[3] for entry in self.service._tickets.values()]
        failures = []
        try:
            self.service.close()
        except BaseException as error:
            failures.append(error)
        try:
            self.case_isolation["nativeHandleChecks"] = verify_release(handles)
        except BaseException as error:
            failures.append(error)
        for handle in handles:
            if not handle.closed:
                try:
                    handle.close()
                except BaseException as error:
                    failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("service release and cleanup failures", failures)

    def acquire(
        self, identity: str, identifier: str = "2201.05596", project_id: str | None = None
    ) -> str:
        acquire_fulltexts(
            (AcquirePaper(identity, identifier, "arxiv", "Paper " + identity),),
            scope=AcquisitionScope(
                self.session, self.project.id if project_id is None else project_id, self.run
            ),
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=self.payload)),
        )
        return self.service.store.by_run(self.session, self.run)["id"]

    def test_global_delivery_saves_to_selected_projects_without_rebinding(self) -> None:
        delivery_id = self.acquire("selected-target", project_id="")
        self.service.seal(self.session, self.run)
        other = self.content.create_project("Other delivery")
        for project in (self.project, other):
            value = self.service.save(
                self.session,
                delivery_id,
                DeliveryChoice(
                    target="project",
                    project_id=project.id,
                    parent="new-folder",
                    add_to_library=True,
                ),
            )
            self.assertEqual(value["state"], "saved")
            self.assertEqual(value["project_id"], "")
            self.assertEqual(value["choice"]["project_id"], project.id)
            payload, _ = self.content.read_bytes(project.id, value["papers"][0]["resource_path"])
            self.assertEqual(payload, self.payload)
            self.assertIn(project.id, self.repository.projects(value["papers"][0]["literature_id"]))
        self.assertEqual(len(value["history"]), 1)
        self.assertEqual(value["history"][0]["choice"]["project_id"], self.project.id)
        self.assertEqual(
            self.service._duplicates.saved_revision(
                value["history"][0], value["history"][0]["papers"][0]
            ),
            payload_revision(self.payload),
        )
        repeated = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(
                target="project", project_id=other.id, parent="new-folder", add_to_library=True
            ),
        )
        self.assertTrue(repeated["papers"][0]["save_reused"])
        self.assertEqual(
            repeated["papers"][0]["resource_path"], value["papers"][0]["resource_path"]
        )

    def test_global_delivery_rejects_missing_or_unknown_target_before_writing(self) -> None:
        delivery_id = self.acquire("invalid-target", project_id="")
        self.service.seal(self.session, self.run)
        for project_id in ("", "missing-project"):
            with self.assertRaisesRegex(ValueError, "literature_delivery_target_required"):
                self.service.save(
                    self.session,
                    delivery_id,
                    DeliveryChoice(target="project", project_id=project_id),
                )
            self.assertIsNone(self.service.get(self.session, delivery_id)["choice"])

    def test_global_delivery_open_uses_selected_project_and_rejects_removed_target(self) -> None:
        delivery_id = self.acquire("selected-open", project_id="")
        self.service.seal(self.session, self.run)
        self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(target="project", project_id=self.project.id, parent="selected-folder"),
        )
        application = FastAPI()
        source_project = None
        register_delivery_routes(
            application,
            SimpleNamespace(),
            SimpleNamespace(require=lambda *_: None),
            self.service,
            lambda _: source_project,
            activities=self.activities,
        )
        with patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "only-main"}):
            client = TestClient(application)
            route = f"/api/sessions/{self.session}/literature/deliveries/{delivery_id}/open"
            self.assertEqual(client.post(route).status_code, 403)
            response = client.post(route, headers={HOST_PROCESS_HEADER: "only-main"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                response.json()["absolute"],
                self.service.project_directory(self.project.id, "selected-folder"),
            )
            source_project = self.project
            response = client.post(route, headers={HOST_PROCESS_HEADER: "only-main"})
            self.assertEqual(response.status_code, 409)
            source_project = None
            with patch.object(self.content, "projects", return_value=()):
                response = client.post(route, headers={HOST_PROCESS_HEADER: "only-main"})
                self.assertEqual(response.status_code, 409)

    def test_concurrent_batch_append_preserves_all_papers(self) -> None:
        self.acquire("seed", "2201.00001")

        def append(index: int) -> None:
            with closing(connect()) as connection, connection:
                self.service.store.record(
                    connection,
                    self.session,
                    self.project.id,
                    self.run,
                    [
                        {
                            "paper_id": f"paper-{index}",
                            "revision": str(index),
                            "identity": ["doi", f"10.1234/{index}"],
                        }
                    ],
                    [],
                )

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(append, range(24)))
        value = self.service.store.by_run(self.session, self.run)
        self.assertEqual(len(value["papers"]), 25)

    def test_batches_are_scoped_and_prompt_is_durable_once(self) -> None:
        delivery_id = self.acquire("first", "2201.00001")
        self.acquire("second", "2201.00002")
        value = self.service.seal(self.session, self.run)
        self.assertEqual(len(value["papers"]), 2)
        self.assertTrue(self.service.prompt(self.session, delivery_id))
        self.assertFalse(self.service.prompt(self.session, delivery_id))
        self.service.close()
        self.assertFalse(self.service.prompt(self.session, delivery_id))
        with self.assertRaises(ValueError):
            self.service.get("other-session", delivery_id)

    def test_cancel_keeps_acquired_bytes_and_manual_save_works(self) -> None:
        delivery_id = self.acquire("cancel")
        self.service.seal(self.session, self.run)
        self.service.cancel(self.session, delivery_id)
        value = self.service.save(self.session, delivery_id, DeliveryChoice(target="project"))
        self.assertEqual(value["state"], "saved")
        path = self.content.resolve(self.project.id, value["papers"][0]["resource_path"])
        self.assertEqual(Path(path).read_bytes(), self.payload)
        self.assertEqual(
            self.service.project_directory(self.project.id, ""), str(Path(path).parent)
        )

    def test_mixed_paper_ids_remain_readable_and_deliver_to_both_targets(self) -> None:
        identities = ("286790100", "arxiv:2609.10657v1", "289314426")
        for target in ("project", "directory"):
            with self.subTest(target=target):
                self.run = "runs/" + target
                for index, identity in enumerate(identities):
                    delivery_id = self.acquire(identity, f"2609.{index:05d}")
                value = self.service.seal(self.session, self.run)
                self.assertEqual(value["state"], "pending")
                self.assertTrue(self.service.prompt(self.session, delivery_id))
                self.assertEqual([paper["paper_id"] for paper in value["papers"]], list(identities))
                for identity in identities:
                    document = ManagedFulltexts().managed_fulltext_document(
                        self.project.id,
                        identity,
                        task_context=FulltextTaskContext(
                            owner_id="owner",
                            project_id=self.project.id,
                            session_id=self.session,
                            workdir=str(self.root),
                            task_type=ProductTaskType.PRECISE_SEARCH,
                            workspace=value["run"],
                            run_id=value["run"],
                        ),
                    )
                    self.assertEqual(document.reference_id, "paper:" + identity)
                    self.assertEqual(document.payload, self.payload)
                choice = DeliveryChoice(target=target, add_to_library=True)
                if target == "directory":
                    directory = self.root / "chosen"
                    directory.mkdir()
                    selected = self.service.choose_directory(
                        self.session, delivery_id, str(directory)
                    )
                    choice = DeliveryChoice(
                        target=target,
                        ticket=selected["ticket"],
                        add_to_library=True,
                    )
                saved = self.service.save(self.session, delivery_id, choice)
                self.assertEqual(saved["state"], "saved")
                for paper in saved["papers"]:
                    self.assertEqual(paper["saved"], "saved")
                    self.assertEqual(paper["library"], "saved")
                    path = (
                        self.content.resolve(self.project.id, paper["resource_path"])
                        if target == "project"
                        else paper["resource_path"]
                    )
                    self.assertEqual(Path(path).read_bytes(), self.payload)

    def test_managed_citation_reopens_exact_acquisition_without_active_task(self) -> None:
        self.acquire("citation-paper")
        fulltexts = ManagedFulltexts()
        revision = payload_revision(self.payload)
        document = fulltexts.citation_document(
            self.project.id, "citation-paper", session_id=self.session, revision=revision
        )
        self.assertEqual(document.payload, self.payload)
        self.assertEqual(document.session_id, self.session)
        self.assertEqual(document.reference_id, "paper:citation-paper")
        for project_id, session_id, expected_revision in (
            (self.project.id, "another-session", revision),
            ("another-project", self.session, revision),
            (self.project.id, self.session, "sha256:another-version"),
        ):
            with self.subTest(
                project_id=project_id, session_id=session_id, revision=expected_revision
            ):
                self.assertIsNone(
                    fulltexts.citation_document(
                        project_id,
                        "citation-paper",
                        session_id=session_id,
                        revision=expected_revision,
                    )
                )
        Path(document.path).write_bytes(pdf_bytes("2201.05596"))
        with self.assertRaises(CitationSourceChanged):
            fulltexts.citation_document(
                self.project.id, "citation-paper", session_id=self.session, revision=revision
            )

    def test_project_save_and_library_have_independent_owned_pdfs(self) -> None:
        delivery_id = self.acquire("library")
        self.service.seal(self.session, self.run)
        choice = DeliveryChoice(target="project", add_to_library=True)
        value = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(value["state"], "saved")
        item_id = value["papers"][0]["literature_id"]
        with closing(connect()) as connection, connection:
            attachments = connection.execute(
                "SELECT path,role FROM literature_attachments WHERE literature_id=?", (item_id,)
            ).fetchall()
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0]["role"], "primary")
        self.assertEqual(Path(attachments[0]["path"]).read_bytes(), self.payload)

        repeated = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(repeated["papers"][0]["literature_id"], item_id)
        project_pdf = Path(
            self.content.resolve(self.project.id, value["papers"][0]["resource_path"])
        )
        project_pdf.unlink()
        self.assertEqual(Path(attachments[0]["path"]).read_bytes(), self.payload)

    def test_auto_library_and_manual_resource_save_restore_only_when_selected(self) -> None:
        delivery_id = self.acquire("automatic", "2201.07891")
        source = self.service.store.by_run(self.session, self.run)["papers"][0]
        automatic = DownloadAdmission(self.repository).admit_payload(
            {**source, "run": self.run}, self.payload, self.session, self.project.id
        )
        self.service.seal(self.session, self.run)
        saved = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        self.assertEqual(saved["state"], "saved")
        self.assertEqual(saved["papers"][0]["literature_id"], automatic.literature_id)
        self.assertTrue(saved["papers"][0]["library_reused"])
        resource = saved["papers"][0]["resource_path"]
        self.repository.delete(automatic.literature_id, confirm=True)
        skipped = self.service.save(self.session, delivery_id, DeliveryChoice(target="project"))
        self.assertEqual(skipped["state"], "saved")
        self.assertIsNone(self.repository.get(automatic.literature_id))
        restored = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        self.assertEqual(restored["state"], "saved")
        self.assertNotEqual(restored["papers"][0]["literature_id"], automatic.literature_id)
        self.assertEqual(restored["papers"][0]["resource_path"], resource)
        self.assertEqual(
            Path(self.content.resolve(self.project.id, resource)).read_bytes(), self.payload
        )

    def test_project_subfolder_save_is_relative_to_resource_root(self) -> None:
        delivery_id = self.acquire("subfolder")
        self.service.seal(self.session, self.run)
        parent = "papers/theory"
        choice = DeliveryChoice(target="project", parent=parent)
        saved = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(saved["state"], "saved")
        resource_root = self.content.root(self.project.id, RootKind.RESOURCES)
        expected = Path(self.content.resolve(self.project.id, resource_root.path)) / parent
        actual = Path(self.content.resolve(self.project.id, saved["papers"][0]["resource_path"]))
        self.assertEqual(actual.parent, expected)
        self.assertEqual(self.service.project_directory(self.project.id, parent), str(expected))
        self.assertEqual(actual.name, "Paper subfolder [subfolder].pdf")
        self.assertEqual(actual.read_bytes(), self.payload)

    def test_external_save_does_not_write_an_unselected_project_copy(self) -> None:
        delivery_id = self.acquire("external")
        self.service.seal(self.session, self.run)
        target = self.root / "chosen"
        target.mkdir()
        selected = self.service.choose_directory(self.session, delivery_id, str(target))
        value = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(
                target="directory",
                ticket=selected["ticket"],
                add_to_library=True,
            ),
        )
        self.assertEqual(value["state"], "saved")
        self.assertEqual(list(target.glob("*.pdf"))[0].read_bytes(), self.payload)
        self.assertFalse(list(Path(self.project.root).rglob("*.pdf")))
        self.assertFalse(list(target.glob(".scholarseed-export-*")))

    def test_conflict_retains_existing_bytes_and_retries_without_duplicates(self) -> None:
        delivery_id = self.acquire("conflict")
        value = self.service.seal(self.session, self.run)
        target = self.root / "chosen"
        target.mkdir()
        existing = target / paper_filename(value["papers"][0])
        existing.write_bytes(b"user-original")
        selected = self.service.choose_directory(self.session, delivery_id, str(target))
        choice = DeliveryChoice(target="directory", ticket=selected["ticket"])
        failed = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(failed["state"], "partial")
        self.assertEqual(existing.read_bytes(), b"user-original")
        existing.unlink()
        saved = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(saved["state"], "saved")
        self.assertEqual(len(list(target.glob("*.pdf"))), 1)

    def test_library_failure_does_not_undo_saved_file(self) -> None:
        delivery_id = self.acquire("partial")
        self.service.seal(self.session, self.run)
        value = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(
                target="project",
                add_to_library=True,
                collection_id="absent",
            ),
        )
        self.assertEqual(value["state"], "partial")
        self.assertEqual(value["papers"][0]["saved"], "saved")
        self.assertEqual(value["papers"][0]["library"], "failed")

    def test_frozen_object_is_not_replaced_by_latest_paper_mapping(self) -> None:
        delivery_id = self.acquire("frozen")
        first = self.service.seal(self.session, self.run)
        object_name = first["papers"][0]["object_name"]
        self.run = "runs/other"
        self.acquire("frozen")
        self.assertEqual(
            self.service.get(self.session, delivery_id)["papers"][0]["object_name"], object_name
        )
        self.assertEqual(self.service._payload(first["papers"][0]), self.payload)

    def test_native_tickets_are_session_bound_and_restart_requires_selection(self) -> None:
        delivery_id = self.acquire("tickets")
        self.service.seal(self.session, self.run)
        chosen = self.service.choose_directory(self.session, delivery_id, str(self.root))
        with self.assertRaises(ValueError):
            with self.service.directory("different", delivery_id, chosen["ticket"]):
                pass
        self.service.close()
        with self.assertRaises(ValueError):
            with self.service.directory(self.session, delivery_id, chosen["ticket"]):
                pass

    def test_refinement_creates_another_batch_without_mutating_the_saved_batch(self) -> None:
        first_id = self.acquire("first-round")
        first = self.service.seal(self.session, self.run)
        second_id = self.acquire("second-round")
        second = self.service.seal(self.session, self.run)
        self.assertNotEqual(first_id, second_id)
        self.assertEqual(first["papers"][0]["paper_id"], "first-round")
        self.assertEqual(second["papers"][0]["paper_id"], "second-round")
        self.assertEqual(self.service.get(self.session, first_id)["state"], "pending")

    def test_identity_normalizes_aliases_without_merging_versions(self) -> None:
        self.assertEqual(
            paper_identity("arxiv", "https://arxiv.org/pdf/2201.05596v2.pdf"),
            paper_identity("doi", "https://doi.org/10.48550/arXiv.2201.05596"),
        )
        self.assertEqual(
            paper_identity("doi", "doi:10.1000/ABC"),
            paper_identity("doi", "https://doi.org/10.1000/abc"),
        )

    def test_exact_version_cache_is_verified_and_unversioned_still_fetches(self) -> None:
        requests = []
        transport = httpx.MockTransport(
            lambda request: requests.append(request.url)
            or httpx.Response(200, content=self.payload)
        )
        first = AcquirePaper("cache-first", "2201.05596v2", "arxiv", "Cache")
        original = acquire_fulltexts((first,), transport=transport)
        second = acquire_fulltexts(
            (AcquirePaper("cache-alias", "arxiv:2201.05596v2", "arxiv"),), transport=transport
        )
        self.assertEqual(len(requests), 1)
        self.assertEqual(second.payload()["manifest"]["skipped"], 1)
        self.assertTrue(second.papers[0].reused)
        self.assertEqual(second.papers[0].revision, original.papers[0].revision)
        acquire_fulltexts(
            (AcquirePaper("cache-latest", "2201.05596", "arxiv"),), transport=transport
        )
        self.assertEqual(len(requests), 2)
        cached = find_fulltext_object("cache-first")
        assert cached is not None
        (SERVICE_LITERATURE_FILES_DIR / cached.object_name).write_bytes(b"modified")
        restored = acquire_fulltexts((first,), transport=transport)
        self.assertEqual(len(requests), 3)
        self.assertFalse(restored.papers[0].reused)

    def test_cross_batch_duplicate_reuses_file_and_library(self) -> None:
        delivery_id = self.acquire("repeat-first")
        self.service.seal(self.session, self.run)
        choice = DeliveryChoice(target="project", add_to_library=True)
        original = self.service.save(self.session, delivery_id, choice)
        self.session = "another-session"
        delivery_id = self.acquire("repeat-alias")
        self.service.seal(self.session, self.run)
        duplicate = self.service.save(self.session, delivery_id, choice)
        first, second = original["papers"][0], duplicate["papers"][0]
        self.assertEqual(first["resource_path"], second["resource_path"])
        self.assertEqual(first["literature_id"], second["literature_id"])
        self.assertTrue(second["save_reused"])
        self.assertTrue(second["library_reused"])
        with closing(connect()) as connection, connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM literature_attachments WHERE literature_id=?",
                    (first["literature_id"],),
                ).fetchone()[0],
                1,
            )

    def test_one_batch_aliases_download_once_and_deliver_one_paper(self) -> None:
        requests = []
        outcome = acquire_fulltexts(
            (
                AcquirePaper("alias-first", "2201.07777", "arxiv", "First title"),
                AcquirePaper(
                    "alias-second", "https://arxiv.org/abs/2201.07777", "arxiv", "Alternate title"
                ),
            ),
            scope=AcquisitionScope(self.session, self.project.id, self.run),
            transport=httpx.MockTransport(
                lambda request: requests.append(request.url)
                or httpx.Response(200, content=self.payload)
            ),
        )
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(outcome.refs), 2)
        self.assertEqual(outcome.payload()["manifest"]["skipped"], 1)
        sealed = self.service.seal(self.session, self.run)
        self.assertEqual(len(sealed["papers"]), 1)

    def test_existing_renamed_pdf_is_reused_but_can_still_enter_library(self) -> None:
        delivery_id = self.acquire("renamed")
        self.service.seal(self.session, self.run)
        target = self.root / "renamed"
        target.mkdir()
        existing = target / "user-name.pdf"
        existing.write_bytes(self.payload)
        selected = self.service.choose_directory(self.session, delivery_id, str(target))
        saved = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(target="directory", ticket=selected["ticket"], add_to_library=True),
        )
        self.assertEqual(saved["state"], "saved")
        self.assertEqual(saved["papers"][0]["resource_path"], str(existing.resolve()))
        self.assertTrue(saved["papers"][0]["save_reused"])
        self.assertEqual(saved["papers"][0]["library"], "saved")
        self.assertEqual(len(list(target.glob("*.pdf"))), 1)

    def test_missing_saved_file_is_recreated_not_trusted(self) -> None:
        delivery_id = self.acquire("missing")
        self.service.seal(self.session, self.run)
        choice = DeliveryChoice(target="project")
        original = self.service.save(self.session, delivery_id, choice)
        path = Path(self.content.resolve(self.project.id, original["papers"][0]["resource_path"]))
        path.unlink()
        restored = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(restored["state"], "saved")
        self.assertFalse(restored["papers"][0]["save_reused"])
        self.assertEqual(
            Path(
                self.content.resolve(self.project.id, restored["papers"][0]["resource_path"])
            ).read_bytes(),
            self.payload,
        )

    def test_saved_without_library_can_later_admit_without_another_file(self) -> None:
        delivery_id = self.acquire("admit-later", "2201.07780")
        self.service.seal(self.session, self.run)
        original = self.service.save(self.session, delivery_id, DeliveryChoice(target="project"))
        admitted = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        self.assertEqual(admitted["state"], "saved")
        self.assertEqual(
            admitted["papers"][0]["resource_path"], original["papers"][0]["resource_path"]
        )
        self.assertTrue(admitted["papers"][0]["save_reused"])
        self.assertEqual(admitted["papers"][0]["library"], "saved")
        without_library = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project")
        )
        self.assertEqual(without_library["state"], "saved")
        self.assertEqual(without_library["papers"][0]["library"], "pending")
        self.assertIsNotNone(self.repository.get(admitted["papers"][0]["literature_id"]))
        self.assertTrue(without_library["history"][-1]["choice"]["add_to_library"])

    def test_save_attempts_restore_only_the_selected_stages_after_deletion(self) -> None:
        for add_to_library in (True, False):
            for deleted in ("library", "resource"):
                with self.subTest(add_to_library=add_to_library, deleted=deleted):
                    sequence = 77000 + int(add_to_library) * 2 + int(deleted == "resource")
                    identifier = f"2201.{sequence}"
                    self.payload = pdf_bytes(identifier)
                    self.run = f"runs/restore/{add_to_library}/{deleted}"
                    delivery_id = self.acquire(self.run, identifier)
                    self.service.seal(self.session, self.run)
                    original = self.service.save(
                        self.session,
                        delivery_id,
                        DeliveryChoice(target="project", add_to_library=True),
                    )
                    paper = original["papers"][0]
                    path = Path(self.content.resolve(self.project.id, paper["resource_path"]))
                    item_id = paper["literature_id"]
                    self.repository.create_note(item_id, "Preserve user note")
                    previous_item = self.repository.get(item_id)
                    previous_attachment = self.repository.primary_attachment(item_id)
                    if deleted == "library":
                        self.assertTrue(self.repository.delete(item_id)[0])
                    else:
                        path.unlink()
                    saved = self.service.save(
                        self.session,
                        delivery_id,
                        DeliveryChoice(target="project", add_to_library=add_to_library),
                    )
                    self.assertEqual(saved["state"], "saved")
                    self.assertNotEqual(saved["attempt_id"], original["attempt_id"])
                    self.assertEqual(saved["history"][-1]["papers"], original["papers"])
                    self.assertEqual(saved["history"][-1]["choice"], original["choice"])
                    self.assertEqual(saved["papers"][0]["save_reused"], deleted == "library")
                    restored = Path(
                        self.content.resolve(self.project.id, saved["papers"][0]["resource_path"])
                    )
                    self.assertEqual(restored.read_bytes(), self.payload)
                    if add_to_library:
                        admitted_id = saved["papers"][0]["literature_id"]
                        self.assertEqual(saved["papers"][0]["library"], "saved")
                        self.assertEqual(
                            saved["papers"][0]["library_reused"], deleted == "resource"
                        )
                        self.assertEqual(
                            Path(self.repository.primary_attachment(admitted_id).path).read_bytes(),
                            self.payload,
                        )
                        if deleted == "library":
                            self.assertNotEqual(admitted_id, item_id)
                        else:
                            self.assertEqual(admitted_id, item_id)
                    else:
                        self.assertEqual(saved["papers"][0]["library"], "pending")
                        self.assertEqual(saved["papers"][0]["literature_id"], "")
                    if deleted == "resource":
                        self.assertEqual(self.repository.get(item_id), previous_item)
                        self.assertEqual(
                            self.repository.primary_attachment(item_id), previous_attachment
                        )
                    elif not add_to_library:
                        self.assertIsNone(self.repository.get(item_id))

    def test_new_destination_has_independent_receipt_and_preserves_previous_file(self) -> None:
        delivery_id = self.acquire("new-destination", "2201.07784")
        self.service.seal(self.session, self.run)
        original = self.service.save(self.session, delivery_id, DeliveryChoice(target="project"))
        previous_path = Path(
            self.content.resolve(self.project.id, original["papers"][0]["resource_path"])
        )
        changed = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", parent="another")
        )
        current_path = Path(
            self.content.resolve(self.project.id, changed["papers"][0]["resource_path"])
        )
        self.assertEqual(changed["state"], "saved")
        self.assertNotEqual(previous_path, current_path)
        self.assertEqual(previous_path.read_bytes(), self.payload)
        self.assertEqual(current_path.read_bytes(), self.payload)
        self.assertFalse(changed["papers"][0]["save_reused"])
        self.assertEqual(changed["history"][0]["papers"], original["papers"])
        self.assertEqual(changed["history"][0]["attempt_id"], original["attempt_id"])
        published = self.service.public(changed)
        self.assertEqual(published["history"][0]["choice"], original["choice"])
        self.assertNotIn("object_name", published["history"][0]["papers"][0])

    def test_existing_receipt_without_attempt_fields_is_preserved_on_next_save(self) -> None:
        delivery_id = self.acquire("existing-receipt", "2201.07788")
        self.service.seal(self.session, self.run)
        original = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        self.service.store.update(
            self.session,
            delivery_id,
            lambda value: (value.pop("attempt_id"), value.pop("history")),
        )
        saved = self.service.save(self.session, delivery_id, DeliveryChoice(target="project"))
        self.assertEqual(saved["state"], "saved")
        self.assertEqual(saved["history"][0]["papers"], original["papers"])
        self.assertEqual(saved["history"][0]["attempt_id"], delivery_id)
        self.assertTrue(saved["papers"][0]["save_reused"])
        self.assertIsNotNone(self.repository.get(original["papers"][0]["literature_id"]))

    def test_new_admission_restores_project_association_without_duplicating_item(self) -> None:
        delivery_id = self.acquire("restore-association", "2201.07789")
        self.service.seal(self.session, self.run)
        choice = DeliveryChoice(target="project", add_to_library=True)
        original = self.service.save(self.session, delivery_id, choice)
        item_id = original["papers"][0]["literature_id"]
        self.repository.unlink_project((item_id,), self.project.id)
        restored = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(restored["state"], "saved")
        self.assertEqual(restored["papers"][0]["literature_id"], item_id)
        self.assertTrue(restored["papers"][0]["library_reused"])
        with closing(connect()) as connection, connection:
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM literature_projects WHERE literature_id=? AND project_id=?",
                    (item_id, self.project.id),
                ).fetchone()
            )

    def test_history_receipt_still_detects_modified_pdf_without_embedded_identifier(self) -> None:
        delivery_id = self.acquire("history-version", "2201.07785")
        self.service.seal(self.session, self.run)
        original_choice = DeliveryChoice(target="project", parent="original")
        original = self.service.save(self.session, delivery_id, original_choice)
        path = Path(self.content.resolve(self.project.id, original["papers"][0]["resource_path"]))
        modified = self.payload + b"\n% metadata changed\n"
        path.write_bytes(modified)
        self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", parent="another")
        )
        waiting = self.service.save(self.session, delivery_id, original_choice)
        self.assertEqual(waiting["state"], "partial")
        self.assertEqual(waiting["papers"][0]["versions"], [payload_revision(modified)])
        self.assertEqual(path.read_bytes(), modified)

    def test_new_attempt_can_add_collection_to_existing_library_item(self) -> None:
        delivery_id = self.acquire("new-collection", "2201.07786")
        self.service.seal(self.session, self.run)
        original = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        collection = self.repository.create_collection("Selected later", project_id=self.project.id)
        changed = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(target="project", add_to_library=True, collection_id=collection["id"]),
        )
        self.assertEqual(changed["state"], "saved")
        item_id = original["papers"][0]["literature_id"]
        self.assertEqual(changed["papers"][0]["literature_id"], item_id)
        with closing(connect()) as connection, connection:
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM literature_collection_items WHERE collection_id=? AND literature_id=?",
                    (collection["id"], item_id),
                ).fetchone()
            )
        self.assertEqual(changed["history"][0]["choice"]["collection_id"], "")

    def test_metadata_only_item_is_completed_without_losing_notes(self) -> None:
        item = LiteratureItem(
            id=new_item_id(),
            title="Existing metadata",
            arxiv="2201.09998",
            notes=(LiteratureNote(id="note", text="Keep my notes"),),
        )
        self.repository.save(item, self.project.id)
        delivery_id = self.acquire("metadata-only", "2201.09998")
        self.service.seal(self.session, self.run)
        saved = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        candidates = self.repository.get(item.id)
        self.assertEqual(candidates.notes[0].text, "Keep my notes")
        self.assertEqual(candidates.title, "Existing metadata")
        self.assertEqual(saved["papers"][0]["literature_id"], item.id)
        self.assertEqual(
            Path(self.repository.primary_attachment(item.id).path).read_bytes(), self.payload
        )

    def test_changed_saved_file_is_preserved_and_needs_version_choice(self) -> None:
        delivery_id = self.acquire("changed-file")
        self.service.seal(self.session, self.run)
        choice = DeliveryChoice(target="project")
        original = self.service.save(self.session, delivery_id, choice)
        path = Path(self.content.resolve(self.project.id, original["papers"][0]["resource_path"]))
        changed = self.payload + b"\n% user changed\n"
        path.write_bytes(changed)
        waiting = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(waiting["state"], "partial")
        self.assertEqual(waiting["papers"][0]["versions"], [payload_revision(changed)])
        kept = self.service.save(
            self.session,
            delivery_id,
            choice.model_copy(update={"versions": {"changed-file": "keep_both"}}),
        )
        self.assertEqual(kept["state"], "saved")
        self.assertEqual(path.read_bytes(), changed)

    def test_unknown_version_decision_is_rejected_before_writes(self) -> None:
        delivery_id = self.acquire("bound-choice")
        self.service.seal(self.session, self.run)
        with self.assertRaises(ValueError):
            self.service.save(
                self.session,
                delivery_id,
                DeliveryChoice(target="project", versions={"another-paper": "keep_both"}),
            )
        self.assertEqual(self.service.get(self.session, delivery_id)["state"], "pending")

    def test_manual_pdf_identifier_requires_version_confirmation(self) -> None:
        delivery_id = self.acquire("manual-version", "2201.07778")
        self.service.seal(self.session, self.run)
        directory = self.root / "manual"
        directory.mkdir()
        existing = directory / "my-old-version.pdf"
        existing.write_bytes(pdf_bytes("2201.07778v1"))
        selected = self.service.choose_directory(self.session, delivery_id, str(directory))
        waiting = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="directory", ticket=selected["ticket"])
        )
        self.assertEqual(waiting["state"], "partial")
        self.assertTrue(waiting["papers"][0]["versions"])
        self.assertEqual(len(list(directory.glob("*.pdf"))), 1)

    def test_concurrent_batches_reuse_one_file_and_one_library_item(self) -> None:
        batches = []
        for index in range(2):
            self.run = f"concurrent/{index}"
            delivery_id = self.acquire(f"concurrent-{index}", "2201.07779")
            self.service.seal(self.session, self.run)
            batches.append(delivery_id)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    lambda identity: self.service.save(
                        self.session,
                        identity,
                        DeliveryChoice(target="project", add_to_library=True),
                    ),
                    batches,
                )
            )
        self.assertTrue(all(result["state"] == "saved" for result in results))
        self.assertEqual(
            results[0]["papers"][0]["resource_path"], results[1]["papers"][0]["resource_path"]
        )
        self.assertEqual(
            results[0]["papers"][0]["literature_id"], results[1]["papers"][0]["literature_id"]
        )

    def test_exact_target_file_does_not_hide_library_version_conflict(self) -> None:
        delivery_id = self.acquire("library-old", "2201.08888")
        self.service.seal(self.session, self.run)
        first = self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        self.payload += b"\n% newer revision\n"
        delivery_id = self.acquire("library-new", "2201.08888")
        self.service.seal(self.session, self.run)
        root = Path(self.service.project_directory(self.project.id, ""))
        (root / "already-new.pdf").write_bytes(self.payload)
        choice = DeliveryChoice(target="project", add_to_library=True)
        waiting = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(waiting["state"], "partial")
        self.assertTrue(waiting["papers"][0]["versions"])
        kept = self.service.save(
            self.session,
            delivery_id,
            choice.model_copy(update={"versions": {"library-new": "keep_both"}}),
        )
        self.assertTrue(kept["papers"][0]["save_reused"])
        self.assertNotEqual(kept["papers"][0]["literature_id"], first["papers"][0]["literature_id"])

    def test_library_only_version_skip_retains_saved_file(self) -> None:
        delivery_id = self.acquire("library-skip-old", "2201.07781")
        self.service.seal(self.session, self.run)
        self.service.save(
            self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
        )
        self.payload += b"\n% current revision\n"
        delivery_id = self.acquire("library-skip-new", "2201.07781")
        self.service.seal(self.session, self.run)
        original = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(target="project", versions={"library-skip-new": "keep_both"}),
        )
        choice = DeliveryChoice(target="project", add_to_library=True)
        pending = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(pending["state"], "partial")
        self.assertEqual(pending["papers"][0]["saved"], "saved")
        skipped = self.service.save(
            self.session,
            delivery_id,
            choice.model_copy(update={"versions": {"library-skip-new": "skip"}}),
        )
        self.assertEqual(skipped["state"], "saved")
        self.assertEqual(skipped["papers"][0]["saved"], "saved")
        self.assertEqual(skipped["papers"][0]["library"], "skipped")
        self.assertEqual(
            skipped["papers"][0]["resource_path"], original["papers"][0]["resource_path"]
        )
        repeated = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(repeated["state"], "partial")
        self.assertEqual(repeated["papers"][0]["library"], "pending")
        self.assertTrue(repeated["papers"][0]["versions"])
        self.assertEqual(repeated["history"][-1]["papers"][0]["library"], "skipped")

    def test_interrupted_resource_import_resumes_reserved_operation(self) -> None:
        delivery_id = self.acquire("interrupted")
        self.service.seal(self.session, self.run)
        choice = DeliveryChoice(target="project")
        with patch.object(
            self.content, "materialize", side_effect=ResourceWriterError("interrupted")
        ):
            failed = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(failed["state"], "partial")
        resumed = self.service.save(self.session, delivery_id, choice)
        self.assertEqual(resumed["state"], "saved")
        self.assertEqual(resumed["attempt_id"], failed["attempt_id"])
        self.assertNotIn("(2)", resumed["papers"][0]["resource_path"])

    def test_changed_library_choice_preserves_interrupted_file_operation(self) -> None:
        delivery_id = self.acquire("interrupted-admission", "2201.07787")
        self.service.seal(self.session, self.run)
        with patch.object(
            self.content, "materialize", side_effect=ResourceWriterError("interrupted")
        ):
            failed = self.service.save(
                self.session, delivery_id, DeliveryChoice(target="project", add_to_library=True)
            )
        resumed = self.service.save(self.session, delivery_id, DeliveryChoice(target="project"))
        self.assertEqual(resumed["state"], "saved")
        self.assertNotEqual(resumed["attempt_id"], failed["attempt_id"])
        self.assertEqual(
            resumed["papers"][0]["save_operation"], failed["papers"][0]["save_operation"]
        )
        self.assertNotIn("(2)", resumed["papers"][0]["resource_path"])
        self.assertEqual(resumed["papers"][0]["library"], "pending")
        self.assertEqual(resumed["history"][-1]["papers"], failed["papers"])

    def test_version_change_waits_for_choice_then_preserves_both(self) -> None:
        for target in ("project", "directory"):
            with self.subTest(target=target):
                self.run = "version/" + target
                self.payload = pdf_bytes() + target.encode()
                delivery_id = self.acquire("version-first-" + target)
                self.service.seal(self.session, self.run)
                directory = self.root / target
                directory.mkdir()
                choice = DeliveryChoice(target=target)
                if target == "directory":
                    selected = self.service.choose_directory(
                        self.session, delivery_id, str(directory)
                    )
                    choice = DeliveryChoice(target=target, ticket=selected["ticket"])
                first = self.service.save(self.session, delivery_id, choice)
                original = self.payload
                self.payload += b"\n% new revision\n"
                paper_id = "version-next-" + target
                delivery_id = self.acquire(paper_id)
                self.service.seal(self.session, self.run)
                if target == "directory":
                    selected = self.service.choose_directory(
                        self.session, delivery_id, str(directory)
                    )
                    choice = DeliveryChoice(target=target, ticket=selected["ticket"])
                waiting = self.service.save(self.session, delivery_id, choice)
                self.assertEqual(waiting["state"], "partial")
                self.assertEqual(waiting["papers"][0]["versions"], [payload_revision(original)])
                kept = self.service.save(
                    self.session,
                    delivery_id,
                    choice.model_copy(update={"versions": {paper_id: "keep_both"}}),
                )
                self.assertEqual(kept["state"], "saved")
                self.assertNotEqual(
                    first["papers"][0]["resource_path"], kept["papers"][0]["resource_path"]
                )
                first_path = first["papers"][0]["resource_path"]
                if target == "project":
                    first_path = self.content.resolve(self.project.id, first_path)
                self.assertEqual(Path(first_path).read_bytes(), original)

    def test_version_change_can_be_explicitly_skipped_without_writing(self) -> None:
        delivery_id = self.acquire("skip-first")
        self.service.seal(self.session, self.run)
        original = self.service.save(self.session, delivery_id, DeliveryChoice(target="project"))
        self.payload += b"\n% another version\n"
        delivery_id = self.acquire("skip-next")
        self.service.seal(self.session, self.run)
        skipped = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(target="project", versions={"skip-next": "skip"}),
        )
        self.assertEqual(skipped["state"], "saved")
        self.assertEqual(skipped["papers"][0]["saved"], "skipped")
        self.assertEqual(skipped["papers"][0]["resource_path"], "")
        self.assertTrue(
            self.content.exists(self.project.id, original["papers"][0]["resource_path"])
        )

    def test_saved_directory_receipt_survives_restart_without_a_write_ticket(self) -> None:
        delivery_id = self.acquire("receipt")
        self.service.seal(self.session, self.run)
        chosen = self.service.choose_directory(self.session, delivery_id, str(self.root))
        saved = self.service.save(
            self.session,
            delivery_id,
            DeliveryChoice(
                target="directory",
                ticket=chosen["ticket"],
            ),
        )
        self.service.close()
        self.assertEqual(self.service.saved_directory(saved), str(self.root.resolve()))

    def test_external_existing_symlink_and_fifo_are_rejected_without_overwrite(self) -> None:
        for identity, make in (
            ("symlink", lambda target: target.symlink_to(self.root / "source.pdf")),
            # Windows has no filesystem FIFO; a directory exercises rejection
            # of a non-regular destination, alongside a real reparse symlink.
            ("nonregular", Path.mkdir if os.name == "nt" else os.mkfifo),
        ):
            delivery_id = self.acquire(identity)
            value = self.service.seal(self.session, self.run)
            target = self.root / identity
            target.mkdir()
            (self.root / "source.pdf").write_bytes(self.payload)
            make(target / paper_filename(value["papers"][0]))
            chosen = self.service.choose_directory(self.session, delivery_id, str(target))
            saved = self.service.save(
                self.session,
                delivery_id,
                DeliveryChoice(
                    target="directory",
                    ticket=chosen["ticket"],
                ),
            )
            self.assertEqual(saved["state"], "partial")
            self.assertEqual((self.root / "source.pdf").read_bytes(), self.payload)

    def test_bridge_has_no_path_field_and_host_key_is_removed_from_agent(self) -> None:
        with self.assertRaises(ValueError):
            LiteratureDelivery.model_validate({"run": "run", "absolute": str(self.root)})
        intent, _ = _launch_secret_contract(None)
        self.assertIn(HOST_PROCESS_KEY_ENV, intent.remove_environment)
        self.assertEqual(
            parser()
            .parse_args(["literature", "delivery", "--json", '{"run":"runs/one"}'])
            .operation,
            "delivery",
        )

    def test_http_bridge_checkpoint_reaches_session_scoped_handler(self) -> None:
        application = FastAPI()
        register_delivery_routes(
            application,
            SimpleNamespace(bridge_caller=lambda _: None),
            SimpleNamespace(require=lambda *_: None),
            self.service,
            lambda _: self.project,
            activities=self.activities,
        )
        response = TestClient(application).post(
            "/api/internal/bridge/literature/delivery",
            json={"run": self.run},
        )
        self.assertEqual(response.status_code, 403)

    def test_host_only_directory_api_rejects_renderer_path_submission(self) -> None:
        application = FastAPI()
        register_delivery_routes(
            application,
            SimpleNamespace(),
            SimpleNamespace(require=lambda *_: None),
            self.service,
            lambda _: self.project,
            activities=self.activities,
        )
        with patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "only-main"}):
            response = TestClient(application).post(
                f"/api/sessions/{self.session}/literature/deliveries/missing/directory",
                json={"absolute": str(self.root)},
            )
        self.assertEqual(response.status_code, 403)
        with patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "only-main"}):
            response = TestClient(application).post(
                f"/api/sessions/{self.session}/literature/deliveries/missing/save",
                json={"target": "project"},
            )
        self.assertEqual(response.status_code, 403)


class DeliveryIsolationContracts(unittest.TestCase):
    TIMEOUT_SECONDS = 120

    def invoke(self, root: Path, phase: str, **values) -> subprocess.CompletedProcess[str]:
        environment = dict(os.environ)
        environment["SCHOLARSEED_HOME"] = str(root / "home")
        environment["DAMOATRACE_HOME"] = str(root / "trace")
        environment["DAMOATRACE_LEDGER_ROOT"] = str(root / "trace" / "projects")
        serve = Path(__file__).resolve().parents[1]
        environment["PYTHONPATH"] = os.pathsep.join((str(serve), str(serve.parent.parent)))
        arguments = [sys.executable, "-P", "-m", "tests.delivery", str(root), phase]
        for name, value in values.items():
            arguments.extend(("--" + name.replace("_", "-"), json.dumps(value)))
        return subprocess.run(
            arguments,
            cwd=serve,
            env=environment,
            capture_output=True,
            text=True,
            timeout=self.TIMEOUT_SECONDS,
        )

    def successful(self, root: Path, phase: str, **values) -> dict:
        result = self.invoke(root, phase, **values)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_independent_homes_reopen_and_cleanup_with_identical_business_keys(self) -> None:
        with directory("delivery-isolation-") as parent:
            roots = (parent / "first", parent / "second")
            for root in roots:
                root.mkdir()
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [
                    pool.submit(self.successful, root, "save", marker=marker)
                    for root, marker in zip(roots, ("first evidence", "second evidence"))
                ]
                receipts = [future.result() for future in futures]
            self.assertNotEqual(receipts[0]["sha256"], receipts[1]["sha256"])
            for index in (1, 0, 1):
                with self.subTest(home=index):
                    receipt = receipts[index]
                    value = self.successful(
                        roots[index],
                        "read",
                        receipt=receipt,
                        peer=receipts[1 - index]["delivery_id"],
                    )
                    self.assertEqual(value["sha256"], receipt["sha256"])
                    self.assertEqual(value["state"], "saved")
                    self.assertEqual(value["filename"], "Paper subfolder [subfolder].pdf")
                    self.assertTrue(value["peer_rejected"])
                    self.assertTrue(value["cleanup"]["released"])
                    self.assertGreater(value["cleanup"]["native_checks"], 0)
                    self.assertTrue(value["cleanup"]["close_called"])
            incorrect = {**receipts[0], "sha256": "0" * 64}
            rejected = self.invoke(roots[0], "read", receipt=incorrect)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("independent payload digest mismatch", rejected.stderr)
        self.assertFalse(parent.exists())

    def test_injected_failures_release_case_directories(self) -> None:
        for failure in ("setup", "acquire", "save", "cleanup"):
            with self.subTest(failure=failure):
                with directory("delivery-failure-") as root:
                    result = self.invoke(root, "save", marker="failed evidence", failure=failure)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("injected fixture failure: " + failure, result.stderr)
                    self.assertTrue((root / "workspace").is_dir())
                    if failure == "setup":
                        self.assertFalse((root / "home").exists())
                    else:
                        self.assertTrue((root / "home").is_dir())
                self.assertFalse(root.exists())

    def test_missing_close_and_simultaneous_failures_are_detected_before_exit(self) -> None:
        for reject_select in (False, True):
            with self.subTest(reject_select=reject_select):
                with directory("fulltext-close-proof-") as root:
                    connection = sqlite3.connect(root / "fulltexts.sqlite3")
                    failures = []
                    try:
                        connection.row_factory = sqlite3.Row
                        if reject_select:
                            connection.set_authorizer(
                                lambda operation, *_arguments: (
                                    sqlite3.SQLITE_DENY
                                    if operation == sqlite3.SQLITE_SELECT
                                    else sqlite3.SQLITE_OK
                                )
                            )
                        with patch(
                            "service.literature.persistence.fulltexts.connect",
                            return_value=connection,
                        ):
                            if reject_select:
                                with self.assertRaisesRegex(
                                    sqlite3.DatabaseError, "not authorized"
                                ):
                                    fulltext_candidates()
                            else:
                                self.assertEqual(fulltext_candidates(), ())
                        with self.assertRaisesRegex(
                            sqlite3.ProgrammingError, CLOSED_DATABASE_MESSAGE
                        ):
                            _transaction = connection.in_transaction
                    except BaseException as error:
                        failures.append(error)
                    finally:
                        try:
                            connection.close()
                        except BaseException as error:
                            failures.append(error)
                    if len(failures) == 1:
                        raise failures[0]
                    if failures:
                        raise BaseExceptionGroup("fulltext query and cleanup failures", failures)
                self.assertFalse(root.exists())
        for failure, expected in (
            ("omitted_close", "active directory survived service.close"),
            ("save_cleanup", "injected fixture failure: save"),
        ):
            with self.subTest(failure=failure):
                with directory("delivery-close-proof-") as root:
                    result = self.invoke(root, "save", marker="release evidence", failure=failure)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(expected, result.stderr)
                    self.assertIn('"released": true', result.stderr)
                    if failure == "save_cleanup":
                        self.assertIn("injected fixture failure: cleanup", result.stderr)
                self.assertFalse(root.exists())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(
        [
            isolated_case(case, __spec__.name)
            for case in loader.loadTestsFromTestCase(DeliveryContract)
        ]
        + list(loader.loadTestsFromTestCase(DeliveryIsolationContracts))
    )


if __name__ == "__main__":
    unittest.main()
