"""Deterministic download admission contracts; not product acceptance."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

_HOME = tempfile.mkdtemp(prefix="ss-download-admission-")
os.environ["SCHOLARSEED_HOME"] = _HOME

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfWriter  # noqa: E402  # imports after SCHOLARSEED_HOME isolation

from service.chat.persistence.catalog import (  # noqa: E402
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.runtime.live import LiveSession  # noqa: E402
from service.chat.runtime.tools import execute_service_tool  # noqa: E402
from service.chat.service.cards import (  # noqa: E402
    DISPLAY_CARD_CONTINUE_ACTION,
    CardRegistry,
    DisplayCardError,
    normalize_card,
)
from service.chat.service.tasks import (  # noqa: E402
    TASK_ACTIVATION_REQUIRED_ACTION,
    ProductTaskLease,
)
from service.identity.utils import LOCAL_USER_ID  # noqa: E402
from service.literature.api.acquire import register_acquire_routes  # noqa: E402
from service.literature.api.catalogue import register_global_routes  # noqa: E402
from service.literature.api.delivery import register_delivery_routes  # noqa: E402
from service.literature.api.downloads import register_download_routes  # noqa: E402
from service.literature.domain.delivery import AcquisitionScope, DeliveryState  # noqa: E402
from service.literature.persistence import downloads as download_store  # noqa: E402
from service.literature.persistence import fulltexts  # noqa: E402
from service.literature.persistence.delivery import DeliveryStore  # noqa: E402
from service.literature.persistence.files import (  # noqa: E402
    LiteratureFileBatch,
    managed_object,
    payload_revision,
    read_attachment,
)
from service.literature.persistence.store import LiteratureRepository, connect  # noqa: E402
from service.literature.schema import FulltextStatus  # noqa: E402
from service.literature.service.acquire import AcquirePaper, acquire_fulltexts  # noqa: E402
from service.literature.service.downloads import (  # noqa: E402
    DOWNLOADS_CARD,
    DownloadAdmission,
    DownloadCard,
    DownloadEntry,
    DownloadFailure,
    DownloadPaperView,
    download_card_slot,
    download_result_bytes,
    download_result_page,
    prepare_download_scope,
    read_download_manifest,
    summarize_download_card,
    validate_download_card,
)
from service.literature.service.result import SEARCH_SHORT  # noqa: E402
from service.paths import SERVICE_LITERATURE_FILES_DIR  # noqa: E402
from service.platform.activity import Activities, ActivityDomain  # noqa: E402
from service.platform.bridge import (  # noqa: E402
    BRIDGE_REQUESTS,
    LITERATURE_ACQUIRE_ROUTE,
    LITERATURE_DELIVERY_ROUTE,
    LITERATURE_INGEST_ROUTE,
    DisplayCardContent,
    LiteratureAcquire,
    LiteratureIngest,
)
from service.platform.context import ProductTaskType  # noqa: E402
from service.platform.vocabulary import (  # noqa: E402 - requires SCHOLARSEED_HOME isolation
    BRIDGE_MAX_RESPONSE_BYTES,
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
)


def pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class LiteratureDownloadsContract(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.run = self.root / "run"
        self.project = uuid4().hex
        self.projects = {self.project: SimpleNamespace(id=self.project)}
        self.session = uuid4().hex
        self.payload = pdf_bytes()
        self.repository = LiteratureRepository()
        with closing(connect(self.repository.database)) as connection, connection:
            connection.execute("DELETE FROM literature_items")
        self.admission = DownloadAdmission(self.repository)
        papers = [
            {
                "id": f"p{index}",
                "title": f"Paper {index}",
                "authors": ["Researcher"],
                "year": 2025,
                "doi": f"10.1234/p{index}",
                "arxiv_id": f"2501.0000{index + 1}",
                "abstract": "Verified metadata abstract",
                "is_placeholder": False,
            }
            for index in range(5)
        ]
        self.write(
            "state.json",
            {
                "run_id": self.session,
                "search_round": 1,
                "paths": {
                    "latest_metadata": "search/round-001/metadata.json",
                    "latest_search_report": "search/round-001/search_report.md",
                    "selection": "selection.json",
                },
            },
        )
        self.write("intent.json", {"confirmed": True, "research_question": "Research"})
        self.write(
            "search/round-001/metadata.json",
            {
                "run_id": self.session,
                "round": 1,
                "is_placeholder": False,
                "status": "success",
                "papers": papers,
                "warnings": [],
            },
        )
        self.write(
            "selection.json",
            {
                "run_id": self.session,
                "confirmed_by_user": True,
                "selected_paper_ids": [paper["id"] for paper in papers],
                "metadata_path": "search/round-001/metadata.json",
            },
        )
        report = self.run / "search/round-001/search_report.md"
        report.write_text("# Search report", encoding="utf-8")
        self.scope = prepare_download_scope(self.root, "run")
        self.cards = []

        async def display_card(kind, content, **_kwargs):
            self.cards.append((kind, content.data))
            return {"card_id": str(len(self.cards))}

        self.live = SimpleNamespace(
            id=self.session,
            project_id=self.project,
            runtime_workdir=self.root,
            bridge_token="test-token",
            publication_turn_id="turn",
            ledger=SimpleNamespace(active_turn_id="turn"),
            active_task_type="precise_search",
            active_assistant_snapshot_id="snapshot",
            display_card=display_card,
            user_id=LOCAL_USER_ID,
            active_product_turn_id="product-turn",
            product_turn_generation=1,
            current_task=SimpleNamespace(done=lambda: False),
            active_task_lease=ProductTaskLease(
                task_type=ProductTaskType.PRECISE_SEARCH,
                turn_id="product-turn",
                generation=1,
                source="skill_run",
                workspace="run",
                run_id=self.session,
                persistent_run=True,
            ),
        )
        self.sessions = SimpleNamespace(
            bridge_caller=lambda key: self.live if key == self.session else None
        )
        self.authorizer = SimpleNamespace(
            require=lambda **_kwargs: None,
            turn_granted_refs=lambda **request: request["refs"],
        )
        self.activities = Activities()
        self.live.turn_activity = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(self.live.turn_activity.close)
        self.app = FastAPI()
        self.catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        self.catalog.register(
            self.session,
            SessionPrincipal(LOCAL_USER_ID),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root / "outputs"),
            codex_version="contract",
            model_id="contract",
            policy_id="on-request",
            status=SessionStatus.READY,
            title="download contract",
            created_at=1.0,
        )
        register_download_routes(self.app, self.sessions, self.catalog, activities=self.activities)
        register_acquire_routes(
            self.app,
            self.sessions,
            self.authorizer,
            lambda _session_id: self.projects.get(self.live.project_id),
            activities=self.activities,
        )
        self.headers = {BRIDGE_SESSION_HEADER: self.session, BRIDGE_TOKEN_HEADER: "test-token"}

    def write(self, relative: str, value: dict) -> None:
        path = self.run / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def local(self, paper_id: str = "p0", payload: bytes | None = None) -> DownloadEntry:
        relative = f"downloads/papers/{paper_id}.pdf"
        path = self.run / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.payload if payload is None else payload)
        return DownloadEntry(paper_id=paper_id, file_path=relative)

    def admit(self, entry: DownloadEntry):
        return self.admission.admit(self.scope, entry, self.session, self.project)

    def test_batch_membership_is_durable_scoped_and_excludes_shown_papers(self) -> None:
        admitted = [self.admit(self.local(f"p{index}")) for index in range(5)]
        identifiers = download_store.download_literature_ids(
            self.session, self.scope.run, self.project, ("p0", "p1", "p2")
        )
        self.assertEqual(set(identifiers), {paper.literature_id for paper in admitted[3:]})
        for session, run, project in (
            ("other", self.scope.run, self.project),
            (self.session, "other", self.project),
            (self.session, self.scope.run, ""),
        ):
            self.assertEqual(download_store.download_literature_ids(session, run, project), ())
        self.assertEqual(self.repository.filtered_total(ids=identifiers), 2)
        first = self.repository.list(ids=identifiers, limit=1)
        second = self.repository.list(ids=identifiers, limit=1, offset=1)
        self.assertEqual({item.id for item in (*first, *second)}, set(identifiers))
        self.assertEqual(self.repository.filtered_total(ids=()), 0)
        self.assertEqual(self.repository.list(ids=()), ())
        self.assertEqual(self.repository.filtered_total(ids=identifiers, q="Paper 4"), 1)

    def test_batch_http_filter_never_falls_back_to_all(self) -> None:
        for index in range(5):
            self.admission.admit(self.scope, self.local(f"p{index}"), self.session, "")
        self.app.state.session_catalog = self.catalog
        register_global_routes(self.app)
        query = {
            "download_session_id": self.session,
            "download_run": self.scope.run,
            "exclude_paper_id": ["p0", "p1", "p2"],
            "page_size": 1,
        }
        with TestClient(self.app) as client:
            first = client.get("/api/v1/literatures", params=query)
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.json()["total"], 2)
            second = client.get("/api/v1/literatures", params={**query, "page": 2})
            self.assertNotEqual(first.json()["items"][0]["id"], second.json()["items"][0]["id"])
            empty = client.get("/api/v1/literatures", params={**query, "download_run": "unknown"})
            self.assertEqual(empty.json()["items"], [])
            self.assertEqual(empty.json()["total"], 0)
            missing = client.get("/api/v1/literatures", params={"download_run": "run"})
            self.assertEqual(missing.status_code, 400)
            denied = client.get(
                "/api/v1/literatures", params={**query, "download_session_id": "other"}
            )
            self.assertEqual(denied.status_code, 404)
            self.assertEqual(client.get("/api/v1/literatures").json()["total"], 5)

    def test_local_pdf_admits_full_metadata_and_primary_attachment(self) -> None:
        admitted = self.admit(self.local("p4"))
        item = self.repository.get(admitted.literature_id)
        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(item.title, "Paper 4")
        self.assertEqual(item.authors, "Researcher")
        self.assertEqual(item.abstract, "Verified metadata abstract")
        self.assertEqual(item.fulltext, FulltextStatus.READY)
        attachment = self.repository.primary_attachment(item.id)
        assert attachment is not None
        self.assertEqual(attachment.id, admitted.attachment_id)
        self.assertEqual(read_attachment(attachment.path), self.payload)
        self.assertNotEqual(Path(attachment.path), self.run / "downloads/papers/p4.pdf")
        self.assertEqual(
            [value.id for value in self.repository.view(self.project).items], [item.id]
        )

    def test_normalized_metadata_id_preserves_identifiers_and_batch_admission(self) -> None:
        for round_number, raw_id in enumerate((" p0 ", "p0\n", "p" * (SEARCH_SHORT + 1)), start=1):
            with self.subTest(raw_id=raw_id):
                metadata = json.loads((self.run / "search/round-001/metadata.json").read_text())
                metadata["papers"][0]["id"] = raw_id
                metadata["round"] = round_number
                self.write("search/round-001/metadata.json", metadata)
                state = json.loads((self.run / "state.json").read_text())
                state["search_round"] = round_number
                self.write("state.json", state)
                identity = raw_id.strip()[:SEARCH_SHORT]
                selection = json.loads((self.run / "selection.json").read_text())
                selection["selected_paper_ids"][0] = identity
                self.write("selection.json", selection)
                entry = self.local()
                second = self.local("p1")
                self.manifest(
                    [
                        {
                            "paper_id": identity,
                            "status": "downloaded",
                            "file_path": entry.file_path,
                        },
                        {
                            "paper_id": second.paper_id,
                            "status": "downloaded",
                            "file_path": second.file_path,
                        },
                    ]
                )
                with TestClient(self.app, raise_server_exceptions=False) as client:
                    response = client.post(
                        LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
                    )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["ok"])
                self.assertEqual(len(response.json()["papers"]), 2)
                item = self.repository.get(response.json()["papers"][0]["literature_id"])
                self.assertEqual(item.arxiv, metadata["papers"][0]["arxiv_id"])

    def test_inactive_download_task_returns_existing_activation_action(self) -> None:
        self.live.active_task_type = ""
        self.manifest([])
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["action"], TASK_ACTIVATION_REQUIRED_ACTION)
        self.assertTrue(response.json()["recoverable"])

    def test_automatic_admission_does_not_require_a_download_authorizer(self) -> None:
        app = FastAPI()
        register_download_routes(app, self.sessions, self.catalog, activities=self.activities)
        self.manifest([])
        with TestClient(app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(response.json()["papers"], [])
        self.assertNotIn("action", response.json())

    def test_stale_download_turn_is_not_recoverable_by_repeating_the_request(self) -> None:
        self.manifest([])

        def replace_turn(*args):
            self.live.publication_turn_id = "replacement-turn"
            return self.scope

        with (
            patch(
                "service.literature.api.downloads.prepare_download_scope", side_effect=replace_turn
            ),
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["reason"], "download_turn_stale")
        self.assertFalse(response.json()["recoverable"])

    def test_result_retention_preserves_active_cursors_and_removes_expired_snapshots(self) -> None:
        result = {
            "session_id": self.session,
            "project_id": self.project,
            "run": "run",
            "papers": [],
            "failures": [],
        }
        now = time.time()
        with patch("service.literature.persistence.downloads.time.time", return_value=now):
            first = download_store.save_download_result(result)
            second = download_store.save_download_result({**result, "delivery": {"ok": False}})
            self.assertEqual(
                download_store.load_download_result(first, self.session, self.project, "run"),
                result,
            )
            self.assertNotEqual(first, second)
        with patch(
            "service.literature.persistence.downloads.time.time",
            return_value=now + download_store.DOWNLOAD_RESULT_RETENTION_SECONDS,
        ):
            with self.assertRaises(ValueError):
                download_store.load_download_result(first, self.session, self.project, "run")
        with connect(self.repository.database) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM literature_download_result WHERE session_id=?",
                    (self.session,),
                ).fetchone()[0],
                0,
            )

    def test_project_result_cleanup_keeps_other_projects_and_literature_assets(self) -> None:
        admitted = self.admit(self.local())
        result = {
            "session_id": self.session,
            "project_id": self.project,
            "run": "run",
            "papers": [],
            "failures": [],
        }
        receipt = download_store.save_download_result(result)
        other = {**result, "project_id": uuid4().hex}
        other_receipt = download_store.save_download_result(other)
        download_store.prune_download_results(self.project)
        with self.assertRaises(ValueError):
            download_store.load_download_result(receipt, self.session, self.project, "run")
        self.assertEqual(
            download_store.load_download_result(
                other_receipt, self.session, other["project_id"], "run"
            ),
            other,
        )
        self.assertIsNotNone(self.repository.get(admitted.literature_id))
        self.assertEqual(
            read_attachment(
                self.repository.attachment(admitted.literature_id, admitted.attachment_id).path
            ),
            self.payload,
        )

    def test_legacy_result_table_migrates_additively_before_expiry(self) -> None:
        database = self.root / "legacy.sqlite3"
        result = {
            "session_id": self.session,
            "project_id": self.project,
            "run": "run",
            "papers": [],
            "failures": [],
        }
        receipt = "a" * 64
        with connect(database) as connection:
            connection.execute(
                "CREATE TABLE literature_download_result(receipt_id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,run TEXT,payload TEXT,extra TEXT DEFAULT 'keep')"
            )
            connection.execute(
                "INSERT INTO literature_download_result(receipt_id,session_id,project_id,run,payload) VALUES(?,?,?,?,?)",
                (receipt, self.session, self.project, "run", json.dumps(result)),
            )
        now = time.time()
        with (
            patch.object(
                download_store,
                "LiteratureRepository",
                return_value=SimpleNamespace(database=database),
            ),
            patch("service.literature.persistence.downloads.time.time", return_value=now),
        ):
            self.assertEqual(
                download_store.load_download_result(receipt, self.session, self.project, "run"),
                result,
            )
            self.assertEqual(
                download_store.save_download_result({**result, "delivery": {"ok": True}}),
                download_store.save_download_result({**result, "delivery": {"ok": True}}),
            )
        with connect(database) as connection:
            row = connection.execute(
                "SELECT extra,created_at FROM literature_download_result WHERE receipt_id=?",
                (receipt,),
            ).fetchone()
            self.assertEqual(row["extra"], "keep")
            self.assertEqual(row["created_at"], now)

    def test_same_operation_replays_and_another_session_reuses_valid_literature(self) -> None:
        entry = self.local()
        first = self.admit(entry)
        self.assertEqual(self.admit(entry), first)
        second_session = uuid4().hex
        second = self.admission.admit(self.scope, entry, second_session, self.project)
        self.assertEqual(first.literature_id, second.literature_id)
        self.assertEqual(first.attachment_id, second.attachment_id)
        self.assertNotEqual(first.operation_id, second.operation_id)
        self.assertEqual(len(self.repository.view(self.project).items), 1)
        self.assertEqual(
            download_store.read_download_receipt(second.operation_id, second_session), second
        )

    def test_manual_admission_reuses_valid_automatic_item_and_attachment(self) -> None:
        admitted = self.admit(self.local())
        batch = DeliveryStore().by_run(self.session, self.scope.run)
        source = batch["papers"][0]
        restored = self.admission.admit_payload(
            source, self.payload, self.session, self.project, restore=True
        )
        self.assertEqual(restored, admitted)
        self.assertEqual(len(self.repository.view(self.project).items), 1)
        self.assertEqual(
            self.repository.primary_attachment(admitted.literature_id).id, admitted.attachment_id
        )

    def test_manual_restore_preserves_origin_metadata_and_updates_old_operation_receipt(
        self,
    ) -> None:
        metadata = json.loads((self.run / "search/round-001/metadata.json").read_text())
        metadata["papers"][4].update(
            venue="Verified proceedings", url="https://arxiv.org/abs/2501.00005"
        )
        self.write("search/round-001/metadata.json", metadata)
        self.scope = prepare_download_scope(self.root, "run")
        admitted = self.admit(self.local("p4"))
        source = DeliveryStore().by_run(self.session, self.scope.run)["papers"][0]
        self.assertEqual(source["admission_operation"], admitted.operation_id)
        self.repository.delete(admitted.literature_id, confirm=True)
        payload = read_attachment(str(SERVICE_LITERATURE_FILES_DIR / source["object_name"]))
        restored = self.admission.admit_payload(
            source, payload, self.session, self.project, restore=True
        )
        self.assertEqual(restored.operation_id, admitted.operation_id)
        self.assertNotEqual(restored.literature_id, admitted.literature_id)
        item = self.repository.get(restored.literature_id)
        self.assertIsNotNone(item)
        assert item is not None
        expected = metadata["papers"][4]
        self.assertEqual(item.title, expected["title"])
        self.assertEqual(item.authors, "; ".join(expected["authors"]))
        self.assertEqual(item.year, expected["year"])
        self.assertEqual(item.doi, expected["doi"])
        self.assertEqual(item.arxiv, expected["arxiv_id"])
        self.assertEqual(item.abstract, expected["abstract"])
        self.assertEqual(item.venue, expected["venue"])
        self.assertEqual(item.journal, expected["venue"])
        self.assertEqual(item.url, expected["url"])
        self.assertEqual(item.fulltext, FulltextStatus.READY)
        self.assertEqual(
            read_attachment(self.repository.primary_attachment(restored.literature_id).path),
            self.payload,
        )
        self.assertEqual(
            download_store.read_download_receipt(admitted.operation_id, self.session), restored
        )
        self.assertEqual(
            self.admit(DownloadEntry("p4", file_path="downloads/papers/p4.pdf")), restored
        )
        self.assertEqual(len(self.repository.view(self.project).items), 1)

    def test_download_receipt_resolver_rejects_another_session(self) -> None:
        admitted = self.admit(self.local())
        self.assertEqual(
            download_store.read_download_receipt(admitted.operation_id, self.session), admitted
        )
        self.assertIsNone(download_store.read_download_receipt(admitted.operation_id, uuid4().hex))
        self.assertIsNone(download_store.read_download_receipt("missing-operation", self.session))

    def test_local_paper_dl_snapshot_remains_independent_after_library_deletion(self) -> None:
        entry = self.local()
        admitted = self.admit(entry)
        batch = DeliveryStore().by_run(self.session, self.scope.run)
        self.assertEqual(len(batch["papers"]), 1)
        source = batch["papers"][0]
        self.assertEqual(source["paper_id"], entry.paper_id)
        self.assertEqual(source["revision"], payload_revision(self.payload))
        self.assertEqual(source["admission_operation"], admitted.operation_id)
        source_path = SERVICE_LITERATURE_FILES_DIR / source["object_name"]
        attachment = self.repository.primary_attachment(admitted.literature_id)
        self.assertNotEqual(source_path, Path(attachment.path))
        (self.run / entry.file_path).unlink()
        self.repository.delete(admitted.literature_id, confirm=True)
        self.assertEqual(read_attachment(str(source_path)), self.payload)
        self.assertEqual(
            DeliveryStore().get(self.session, batch["id"])["papers"][0]["revision"],
            payload_revision(self.payload),
        )

    def test_repeated_paper_dl_checkpoint_keeps_the_sealed_delivery_batch(self) -> None:
        entry = self.local()
        admitted = self.admit(entry)
        store = DeliveryStore()
        initial = store.by_run(self.session, self.scope.run)
        store.update(
            self.session, initial["id"], lambda value: value.update(state=DeliveryState.PENDING)
        )
        self.assertEqual(self.admit(entry), admitted)
        repeated = store.by_run(self.session, self.scope.run)
        self.assertEqual(repeated["id"], initial["id"])
        self.assertEqual(repeated["state"], DeliveryState.PENDING)
        self.assertEqual(len(repeated["papers"]), 1)
        self.assertEqual(
            len(
                [
                    batch
                    for batch in store.candidates()
                    if batch["session_id"] == self.session and batch["run"] == self.scope.run
                ]
            ),
            1,
        )

    def test_changed_bytes_conflict_without_second_item(self) -> None:
        entry = self.local()
        self.admit(entry)
        (self.run / entry.file_path).write_bytes(self.payload + b"\n")
        with self.assertRaisesRegex(ValueError, "download_admission_conflict"):
            self.admit(entry)
        self.assertEqual(len(self.repository.view(self.project).items), 1)

    def test_invalid_pdf_and_outside_path_do_not_admit(self) -> None:
        with self.assertRaises(ValueError):
            self.admit(self.local(payload=b"<html>login</html>"))
        for path in ("../outside.pdf", str(self.root / "outside.pdf")):
            with self.assertRaises(ValueError):
                self.admit(DownloadEntry(paper_id="p0", file_path=path))
        self.assertEqual(self.repository.view(self.project).items, ())

    def test_symlink_source_is_rejected(self) -> None:
        entry = self.local()
        source = self.run / entry.file_path
        outside = self.root / "outside.pdf"
        outside.write_bytes(self.payload)
        source.unlink()
        source.symlink_to(outside)
        with self.assertRaises((OSError, ValueError)):
            self.admit(entry)
        self.assertEqual(self.repository.view(self.project).items, ())

    def test_managed_source_must_match_revision_and_remains_independent(self) -> None:
        managed = managed_object("p0", self.payload, ".pdf")
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            source = batch.stage(managed.name, self.payload)

            def publish() -> None:
                with connect() as connection:
                    fulltexts.ensure_fulltext_schema(connection)
                    fulltexts.record_fulltext_object(
                        connection,
                        fulltexts.FulltextObject(
                            "p0",
                            managed.name,
                            managed.revision,
                            "doi",
                            1.0,
                        ),
                    )
                    DeliveryStore().record(
                        connection,
                        self.session,
                        self.project,
                        self.scope.run,
                        [
                            {
                                "paper_id": "p0",
                                "title": "Paper 0",
                                "identifier_kind": "doi",
                                "identifier": "10.1234/p0",
                                "identity": ["doi", "10.1234/p0"],
                                "object_name": managed.name,
                                "revision": managed.revision,
                            }
                        ],
                        [],
                    )

            batch.commit_operation(publish)
        with self.assertRaisesRegex(ValueError, "download_source_invalid"):
            self.admit(DownloadEntry("p0", storage="managed", ref="paper:p0", revision="bad"))
        admitted = self.admit(
            DownloadEntry(
                "p0",
                storage="managed",
                ref="paper:p0",
                revision=payload_revision(self.payload),
            )
        )
        attachment = self.repository.attachment(admitted.literature_id, admitted.attachment_id)
        assert attachment is not None
        self.assertNotEqual(attachment.path, source)
        self.repository.delete(admitted.literature_id, confirm=True)
        self.assertTrue(Path(source).is_file())

    def managed(self, payload: bytes | None = None) -> DownloadEntry:
        outcome = acquire_fulltexts(
            (AcquirePaper("p0", "2501.00001", "arxiv", "Paper 0"),),
            scope=AcquisitionScope(self.session, self.project, self.scope.run),
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=payload or self.payload)
            ),
        )
        paper = outcome.papers[0]
        return DownloadEntry("p0", storage="managed", ref=paper.ref, revision=paper.revision)

    def test_managed_acquisition_cannot_be_laundered_across_sessions_or_projects(self) -> None:
        entry = self.managed()
        for session, project in ((uuid4().hex, self.project), (self.session, uuid4().hex)):
            with self.assertRaisesRegex(ValueError, "download_source_invalid"):
                self.admission.admit(self.scope, entry, session, project)
        self.assertEqual(self.repository.view(self.project).items, ())

    def test_managed_acquisition_identity_cannot_be_changed_by_metadata(self) -> None:
        entry = self.managed()
        self.scope.identifiers["p0"]["doi"] = "10.1234/other"
        self.scope.identifiers["p0"]["arxiv_id"] = "2501.00999"
        with self.assertRaisesRegex(ValueError, "download_source_invalid"):
            self.admit(entry)
        self.assertEqual(self.repository.view(self.project).items, ())

    def test_managed_acquisition_uses_frozen_source_not_global_paper_mapping(self) -> None:
        entry = self.managed()
        acquire_fulltexts(
            (AcquirePaper("p0", "2501.00999", "arxiv", "Other paper"),),
            scope=AcquisitionScope(uuid4().hex, self.project, self.scope.run),
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=self.payload + b"\n")
            ),
        )
        receipt = self.admit(entry)
        attachment = self.repository.attachment(receipt.literature_id, receipt.attachment_id)
        self.assertEqual(read_attachment(attachment.path), self.payload)

    def test_managed_retry_conflict_preserves_original_batch_snapshot(self) -> None:
        entry = self.managed()
        self.admit(entry)
        store = DeliveryStore()
        old = store.by_run(self.session, self.scope.run)
        changed = {**old["papers"][0], "revision": payload_revision(self.payload + b"\n")}
        with self.assertRaisesRegex(ValueError, "download_admission_conflict"):
            with closing(connect()) as connection, connection:
                store.record(connection, self.session, self.project, self.scope.run, [changed], [])
        self.assertEqual(store.by_run(self.session, self.scope.run), old)

    def test_managed_acquire_retry_retains_cancelled_batch(self) -> None:
        entry = self.managed()
        self.admit(entry)
        store = DeliveryStore()
        old = store.by_run(self.session, self.scope.run)
        store.update(
            self.session, old["id"], lambda value: value.update(state=DeliveryState.CANCELED)
        )
        self.managed()
        self.admit(entry)
        repeated = store.by_run(self.session, self.scope.run)
        self.assertEqual(repeated["id"], old["id"])
        self.assertEqual(repeated["state"], DeliveryState.CANCELED)

    def test_duplicate_paper_aliases_keep_trusted_acquisition_and_receipts(self) -> None:
        self.scope.identifiers["p1"]["arxiv_id"] = "2501.00001"
        outcome = acquire_fulltexts(
            tuple(
                AcquirePaper(identity, "2501.00001", "arxiv", identity) for identity in ("p0", "p1")
            ),
            scope=AcquisitionScope(self.session, self.project, self.scope.run),
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=self.payload)),
        )
        receipts = [
            self.admit(
                DownloadEntry(
                    paper.paper_id, storage="managed", ref=paper.ref, revision=paper.revision
                )
            )
            for paper in outcome.papers
        ]
        self.assertEqual(receipts[0].literature_id, receipts[1].literature_id)
        store = DeliveryStore()
        self.assertEqual(len(store.by_run(self.session, self.scope.run)["papers"]), 1)
        for receipt in receipts:
            self.assertIsNotNone(store.source(self.session, receipt.operation_id))

    def test_save_card_bridge_finishes_existing_turn_during_maintenance(self) -> None:
        entry = self.managed()
        self.admit(entry)
        value = DeliveryStore().by_run(self.session, self.scope.run)
        service = SimpleNamespace(seal=lambda *_: value, close=lambda: None)
        register_delivery_routes(
            self.app,
            self.sessions,
            self.catalog,
            service,
            lambda _: None,
            activities=self.activities,
        )
        generation = self.activities.begin()
        try:
            with TestClient(self.app) as client:
                response = client.post(
                    LITERATURE_DELIVERY_ROUTE, headers=self.headers, json={"run": self.scope.run}
                )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self.cards[-1][0], "literature-delivery")
        finally:
            self.activities.resume(generation)

    def test_stale_save_card_request_does_not_seal_batch(self) -> None:
        service = SimpleNamespace(
            seal=lambda *_: self.fail("stale request sealed a batch"), close=lambda: None
        )
        register_delivery_routes(
            self.app,
            self.sessions,
            self.catalog,
            service,
            lambda _: None,
            activities=self.activities,
        )

        async def body(_request):
            self.live.publication_turn_id = "replacement"
            return {"run": self.scope.run}

        with patch("starlette.requests.Request.json", body), TestClient(self.app) as client:
            response = client.post(
                LITERATURE_DELIVERY_ROUTE, headers=self.headers, json={"run": self.scope.run}
            )
        self.assertEqual(response.status_code, 403, response.text)

    def test_save_card_limit_retains_batch_and_reports_new_turn_recovery(self) -> None:
        self.admit(self.managed())
        store = DeliveryStore()
        value = store.by_run(self.session, self.scope.run)
        service = SimpleNamespace(seal=lambda *_: value, close=lambda: None)
        register_delivery_routes(
            self.app,
            self.sessions,
            self.catalog,
            service,
            lambda _: None,
            activities=self.activities,
        )

        async def exhausted_card(*_args, **_kwargs):
            raise DisplayCardError("display_card_turn_bytes_exceeded")

        self.live.display_card = exhausted_card
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_DELIVERY_ROUTE, headers=self.headers, json={"run": self.scope.run}
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(
            response.json(),
            {
                "ok": False,
                "error": "display_card_turn_bytes_exceeded",
                "action": DISPLAY_CARD_CONTINUE_ACTION,
            },
        )
        self.assertEqual(store.by_run(self.session, self.scope.run), value)

    def test_receipt_remains_available_when_original_pdf_becomes_supplementary(self) -> None:
        receipt = self.admit(self.local())
        with closing(connect()) as connection, connection:
            connection.execute(
                "UPDATE literature_attachments SET role=? WHERE id=?",
                ("supplementary", receipt.attachment_id),
            )
        self.assertIsNotNone(
            download_store.read_download_receipt(receipt.operation_id, self.session)
        )

    def test_manifest_only_returns_successes_and_rejects_unknown_identity(self) -> None:
        self.write(
            "downloads/manifest.json",
            {
                "run_id": self.session,
                "papers": [
                    {
                        "paper_id": "p0",
                        "status": "downloaded",
                        "file_path": "downloads/papers/p0.pdf",
                    },
                    {"paper_id": "p1", "status": "failed"},
                ],
            },
        )
        self.assertEqual([entry.paper_id for entry in read_download_manifest(self.scope)], ["p0"])
        self.write(
            "downloads/manifest.json",
            {
                "run_id": self.session,
                "papers": [{"paper_id": "unknown", "status": "downloaded"}],
            },
        )
        with self.assertRaises(ValueError):
            read_download_manifest(self.scope)

    def manifest(self, entries: list[dict]) -> None:
        self.write("downloads/manifest.json", {"run_id": self.session, "papers": entries})

    def test_api_authenticates_and_publishes_canonical_fulltext_identity(self) -> None:
        entry = self.local()
        self.manifest(
            [{"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}]
        )
        with TestClient(self.app) as client:
            self.assertEqual(
                client.post(LITERATURE_INGEST_ROUTE, json={"run": "run"}).status_code, 403
            )
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
            replay = client.post(LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["papers"], replay.json()["papers"])
        self.assertEqual(response.json()["project_id"], self.project)
        self.assertEqual(self.cards[0][0], "literature-downloads")
        paper = response.json()["papers"][0]
        attachment = self.repository.attachment(paper["literature_id"], paper["attachment_id"])
        assert attachment is not None
        self.assertEqual(read_attachment(attachment.path), self.payload)

    def test_manifest_selection_is_checked_before_any_pdf_is_admitted(self) -> None:
        entries = [self.local("p0"), self.local("p1")]
        self.manifest(
            [
                {"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}
                for entry in entries
            ]
        )

        manifest = json.loads((self.run / "downloads/manifest.json").read_text())
        manifest["papers"][1]["paper_id"] = "unselected-paper"
        self.write("downloads/manifest.json", manifest)
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.repository.view(self.project).items, ())
        self.assertEqual(self.cards, [])

    def test_ingest_validates_sources_off_loop_without_rechecking_grants(self) -> None:
        entries = [self.local("p0"), self.local("p1")]
        self.manifest(
            [
                {"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}
                for entry in entries
            ]
        )
        self.live.ledger.active_turn_id = "different-ledger-turn"

        def prepare(*args):
            with self.assertRaises(RuntimeError):
                asyncio.get_running_loop()
            self.assertEqual(args, (self.root, "run"))
            return prepare_download_scope(*args)

        with (
            patch(
                "service.literature.api.downloads.prepare_download_scope", side_effect=prepare
            ) as source,
            patch.object(self.authorizer, "turn_granted_refs") as batch,
            patch.object(self.authorizer, "require") as single,
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 200, response.text)
        source.assert_called_once_with(self.root, "run")
        batch.assert_not_called()
        single.assert_not_called()

    def test_ingest_and_cursor_reject_context_changes_during_source_reads(self) -> None:
        entry = self.local()
        self.manifest(
            [{"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}]
        )
        receipt = DownloadCard(
            session_id=self.session,
            project_id=self.project,
            run="run",
            papers=[],
            failures=[
                DownloadFailure(paper_id="p0", code="test-failure"),
                DownloadFailure(paper_id="p1", code="test-failure"),
            ],
        ).model_dump(mode="json")
        receipt_id = download_store.save_download_result(receipt)
        fields = (
            "publication_turn_id",
            "active_assistant_snapshot_id",
            "active_product_turn_id",
            "project_id",
            "active_task_type",
        )
        self.live.active_product_turn_id = "product-turn"
        for cursor in (None, receipt_id + ":1"):
            for field in fields:
                with self.subTest(cursor=cursor, field=field):
                    original = getattr(self.live, field)

                    def replace_context(*args, field=field, cursor=cursor):
                        result = (
                            download_store.load_download_result(*args)
                            if cursor
                            else prepare_download_scope(*args)
                        )
                        setattr(self.live, field, "replacement")
                        return result

                    try:
                        with (
                            patch(
                                "service.literature.api.downloads."
                                + ("load_download_result" if cursor else "prepare_download_scope"),
                                side_effect=replace_context,
                            ),
                            patch(
                                "service.literature.api.downloads.DownloadAdmission.admit"
                            ) as admit,
                            TestClient(self.app) as client,
                        ):
                            response = client.post(
                                LITERATURE_INGEST_ROUTE,
                                headers=self.headers,
                                json={"run": "run", **({"cursor": cursor} if cursor else {})},
                            )
                        self.assertEqual(response.status_code, 400, response.text)
                        self.assertEqual(response.json()["reason"], "download_turn_stale")
                        admit.assert_not_called()
                    finally:
                        setattr(self.live, field, original)

    def test_cancelled_source_query_remains_tracked_until_thread_exits(self) -> None:
        entry = self.local()
        self.manifest(
            [{"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}]
        )
        started, release = threading.Event(), threading.Event()

        def prepare(*args):
            started.set()
            if not release.wait(5):
                raise TimeoutError("source worker was not released")
            return prepare_download_scope(*args)

        async def exercise():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app), base_url="http://test"
            ) as client:
                pending = asyncio.create_task(
                    client.post(LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"})
                )
                try:
                    async with asyncio.timeout(2):
                        while not started.is_set():
                            await asyncio.sleep(0.01)
                    generation = self.activities.begin()
                    self.live.turn_activity.close()
                    pending.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await pending
                    self.assertFalse(self.activities.seal(generation))
                finally:
                    release.set()
                    await asyncio.gather(pending, return_exceptions=True)
                    async with asyncio.timeout(2):
                        while self.activities.snapshot().counts:
                            await asyncio.sleep(0.01)
                self.assertTrue(self.activities.seal(generation))

        with patch("service.literature.api.downloads.prepare_download_scope", side_effect=prepare):
            asyncio.run(exercise())

    def test_automatic_ingest_finishes_original_project_without_late_card(self) -> None:
        entries = [self.local("p0"), self.local("p1")]
        self.manifest(
            [
                {"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}
                for entry in entries
            ]
        )
        admit = DownloadAdmission.admit
        replacement_project = uuid4().hex

        def finish(admission, *args):
            receipt = admit(admission, *args)
            self.live.project_id = replacement_project
            self.live.publication_turn_id = "replacement-turn"
            self.sessions.bridge_caller = lambda _key: None
            return receipt

        with (
            patch.object(DownloadAdmission, "admit", finish),
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(len(response.json()["papers"]), 2)
        self.assertEqual(len(self.repository.view(self.project).items), 2)
        self.assertEqual(self.repository.view(replacement_project).items, ())
        self.assertNotIn("card_id", response.json())
        self.assertEqual(self.cards, [])

    def test_download_copy_reads_all_scoped_historical_receipts_without_writes(self) -> None:
        receipts = [self.admit(self.local(f"p{index}")) for index in range(5)]
        self.repository.delete(receipts[-1].literature_id, confirm=True)
        self.sessions.bridge_caller = lambda _key: None
        self.live.turn_activity.close()
        with TestClient(self.app) as client:
            response = client.get(
                f"/api/sessions/{self.session}/literature/downloads",
                params={"run": self.scope.run, "project_id": self.project},
            )
            wrong_project = client.get(
                f"/api/sessions/{self.session}/literature/downloads",
                params={"run": self.scope.run, "project_id": "other-project"},
            )
            wrong_run = client.get(
                f"/api/sessions/{self.session}/literature/downloads",
                params={"run": "other-run", "project_id": self.project},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["papers"], [receipt.payload() for receipt in receipts])
        self.assertEqual(wrong_project.json()["papers"], [])
        self.assertEqual(wrong_run.json()["papers"], [])
        self.assertIsNone(self.repository.get(receipts[-1].literature_id))
        self.assertEqual(self.cards, [])

    def test_download_copy_is_hidden_from_another_owner_and_maintenance(self) -> None:
        self.admit(self.local())
        with (
            patch("service.literature.api.downloads.request_owner_id", return_value="other-owner"),
            TestClient(self.app) as client,
        ):
            response = client.get(
                f"/api/sessions/{self.session}/literature/downloads",
                params={"run": self.scope.run, "project_id": self.project},
            )
        self.assertEqual(response.status_code, 404)
        generation = self.activities.begin()
        try:
            with TestClient(self.app) as client:
                response = client.get(
                    f"/api/sessions/{self.session}/literature/downloads",
                    params={"run": self.scope.run, "project_id": self.project},
                )
            self.assertEqual(response.status_code, 503)
        finally:
            self.activities.resume(generation)

    def test_download_receipt_reads_current_asset_without_active_task(self) -> None:
        admitted = self.admit(self.local())
        self.sessions.bridge_caller = lambda _key: None
        self.live.active_task_type = ""
        self.live.turn_activity.close()
        with TestClient(self.app) as client:
            response = client.get(
                f"/api/sessions/{self.session}/literature/downloads/{admitted.operation_id}"
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), admitted.payload())
        self.assertEqual(self.catalog.principal(self.session), SessionPrincipal(LOCAL_USER_ID))
        self.assertEqual(self.cards, [])

    def test_download_receipt_is_hidden_from_another_owner(self) -> None:
        admitted = self.admit(self.local())
        with (
            patch("service.literature.api.downloads.request_owner_id", return_value="other-owner"),
            patch("service.literature.api.downloads.read_download_receipt") as read,
            TestClient(self.app) as client,
        ):
            response = client.get(
                f"/api/sessions/{self.session}/literature/downloads/{admitted.operation_id}"
            )
        self.assertEqual(response.status_code, 404)
        read.assert_not_called()

    def test_download_receipt_does_not_restore_deleted_literature(self) -> None:
        admitted = self.admit(self.local())
        self.repository.delete(admitted.literature_id, confirm=True)
        with TestClient(self.app) as client:
            response = client.get(
                f"/api/sessions/{self.session}/literature/downloads/{admitted.operation_id}"
            )
        self.assertEqual(response.status_code, 404)
        self.assertIsNone(self.repository.get(admitted.literature_id))
        self.assertEqual(self.repository.view(self.project).items, ())
        self.assertEqual(self.cards, [])

    def test_download_receipt_read_is_rejected_during_maintenance(self) -> None:
        admitted = self.admit(self.local())
        generation = self.activities.begin()
        try:
            with (
                patch("service.literature.api.downloads.read_download_receipt") as read,
                TestClient(self.app) as client,
            ):
                response = client.get(
                    f"/api/sessions/{self.session}/literature/downloads/{admitted.operation_id}"
                )
            self.assertEqual(response.status_code, 503)
            read.assert_not_called()
        finally:
            self.activities.resume(generation)

    def test_partial_admission_is_not_claimed_as_full_success(self) -> None:
        entries = [self.local("p0"), self.local("p1", b"not a PDF")]
        self.manifest(
            [
                {"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}
                for entry in entries
            ]
        )
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["ok"])
        self.assertEqual(len(response.json()["papers"]), 1)
        self.assertEqual(response.json()["failures"][0]["paper_id"], "p1")

    def test_card_failure_preserves_admission_receipts_and_retry_identity(self) -> None:
        entry = self.local()
        self.manifest(
            [{"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}]
        )

        async def fail_card(*_args, **_kwargs):
            raise DisplayCardError("display_card_turn_bytes_exceeded")

        original_display = self.live.display_card
        self.live.display_card = fail_card
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
            self.live.display_card = original_display
            replay = client.post(LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(
            response.json()["delivery"],
            {
                "ok": False,
                "error": "display_card_turn_bytes_exceeded",
                "action": DISPLAY_CARD_CONTINUE_ACTION,
            },
        )
        self.assertEqual(response.json()["papers"], replay.json()["papers"])
        self.assertTrue(replay.json()["delivery"]["ok"])
        self.assertEqual(len(self.repository.view(self.project).items), 1)

    def test_large_card_summary_preserves_full_receipts_and_exact_counts(self) -> None:
        card = DownloadCard(
            session_id=self.session,
            run="📚" * 4096,
            project_id=self.project,
            papers=[
                DownloadPaperView(
                    paper_id=f"p{index}",
                    literature_id=f"lit{index}",
                    attachment_id=f"att{index}",
                    title="📚" * 2000,
                    revision=payload_revision(self.payload),
                )
                for index in range(1000)
            ],
            failures=[
                DownloadFailure(paper_id=f"failed{index}", code="reason" * 1000)
                for index in range(1000)
            ],
        )
        summary = summarize_download_card(card)
        registry = CardRegistry()
        registry.register(DOWNLOADS_CARD, validate_download_card, direct=False)
        normalize_card(
            self.root,
            registry,
            DOWNLOADS_CARD,
            DisplayCardContent(data=summary.model_dump(mode="json")),
        )
        self.assertEqual(len(summary.papers) + summary.omitted_papers, 1000)
        self.assertEqual(len(summary.failures) + summary.omitted_failures, 1000)
        self.assertEqual(summary.papers[0], card.papers[0])
        self.assertEqual(len(card.papers), 1000)
        self.assertEqual(card.failures[0].code, "reason" * 1000)

    def test_empty_ingest_has_no_card_and_no_false_delivery_error(self) -> None:
        self.manifest([])
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertTrue(response.json()["ok"])
        self.assertTrue(response.json()["delivery"]["ok"])
        self.assertEqual(response.json()["papers"], [])
        self.assertEqual(self.cards, [])

    def test_card_io_failure_does_not_discard_saved_papers(self) -> None:
        entry = self.local()
        self.manifest(
            [{"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}]
        )

        async def fail_card(*_args, **_kwargs):
            raise OSError("storage unavailable")

        self.live.display_card = fail_card
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(len(response.json()["papers"]), 1)
        self.assertEqual(response.json()["delivery"]["error"], "download_card_unavailable")

    def test_ingest_response_is_complete_while_card_is_bounded(self) -> None:
        entries = [self.local(f"p{index}") for index in range(5)]
        self.manifest(
            [
                {"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}
                for entry in entries
            ]
        )
        with TestClient(self.app) as client:
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        self.assertEqual(len(response.json()["papers"]), 5)
        projected = self.cards[-1][1]
        self.assertLess(len(projected["papers"]), 5)
        self.assertEqual(len(projected["papers"]) + projected["omitted_papers"], 5)

    def test_native_bridge_pages_large_receipts_without_repeating_admission(self) -> None:
        metadata = json.loads((self.run / "search/round-001/metadata.json").read_text())
        template = metadata["papers"][0]
        metadata["papers"] = [
            {
                **template,
                "id": f"p{index}",
                "title": "📚" * 2000,
                "doi": f"10.1234/page{index}",
                "arxiv_id": f"2501.{index:05d}",
            }
            for index in range(30)
        ]
        self.write("search/round-001/metadata.json", metadata)
        selection = json.loads((self.run / "selection.json").read_text())
        selection["selected_paper_ids"] = [paper["id"] for paper in metadata["papers"]]
        self.write("selection.json", selection)
        entries = [self.local(f"p{index}") for index in range(30)]
        self.manifest(
            [
                {"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}
                for entry in entries
            ]
        )
        original_client = httpx.AsyncClient

        def bridge_client(**_kwargs):
            return original_client(transport=httpx.ASGITransport(app=self.app))

        async def invoke(request):
            with (
                patch("service.chat.runtime.tools.httpx.AsyncClient", side_effect=bridge_client),
                patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://localhost"}),
            ):
                return await execute_service_tool(
                    {"capability": "literature", "operation": "ingest", "request": request},
                    token=self.live.bridge_token,
                    session_id=self.session,
                    local_socket=None,
                )

        result = asyncio.run(invoke({"run": "run"}))
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["total_papers"], 30)
        self.assertEqual(len(self.repository.view(self.project).items), 30)
        received = list(result["papers"])
        first_cursor = result["next_cursor"]
        self.assertTrue(first_cursor)
        for entry in entries:
            (self.run / entry.file_path).unlink()
        while result.get("next_cursor"):
            result = asyncio.run(invoke({"run": "run", "cursor": result["next_cursor"]}))
            self.assertTrue(result["ok"], result)
            self.assertLessEqual(
                len(json.dumps(result, ensure_ascii=False).encode()), BRIDGE_MAX_RESPONSE_BYTES
            )
            received.extend(result["papers"])
        self.assertEqual(len(received), 30)
        self.assertEqual(len({paper["literature_id"] for paper in received}), 30)
        self.assertEqual(len(self.cards), 1)
        replay = asyncio.run(invoke({"run": "run", "cursor": first_cursor}))
        self.assertTrue(replay["ok"])
        with patch.object(self.authorizer, "turn_granted_refs", return_value=()):
            continued = asyncio.run(invoke({"run": "run", "cursor": first_cursor}))
        self.assertTrue(continued["ok"])
        denied = asyncio.run(invoke({"run": "other-run", "cursor": first_cursor}))
        self.assertFalse(denied["ok"])
        self.live.project_id = "other-project"
        denied = asyncio.run(invoke({"run": "run", "cursor": first_cursor}))
        self.assertFalse(denied["ok"])

    def test_receipt_pages_preserve_all_successes_failures_and_unicode(self) -> None:
        result = DownloadCard(
            session_id=self.session,
            run="📚" * 4096,
            project_id=self.project,
            papers=[
                DownloadPaperView(
                    paper_id=f"p{index}",
                    literature_id=f"lit{index}",
                    attachment_id=f"att{index}",
                    title="📚" * 2000,
                    revision=payload_revision(self.payload),
                )
                for index in range(1000)
            ],
            failures=[
                DownloadFailure(paper_id=f"failed{index}", code="reason" * 1000)
                for index in range(1000)
            ],
        ).model_dump(mode="json")
        result.update(
            {"ok": False, "delivery": {"ok": False, "error": "display_card_turn_bytes_exceeded"}}
        )
        offset = 0
        papers = []
        failures = []
        while True:
            page = download_result_page(result, "a" * 64, offset, BRIDGE_MAX_RESPONSE_BYTES)
            self.assertLessEqual(len(download_result_bytes(page)), BRIDGE_MAX_RESPONSE_BYTES)
            self.assertFalse(page["ok"])
            self.assertFalse(page["delivery"]["ok"])
            self.assertEqual(page["total_papers"], 1000)
            self.assertEqual(page["total_failures"], 1000)
            papers.extend(page["papers"])
            failures.extend(page["failures"])
            if page["next_cursor"] is None:
                break
            offset = int(page["next_cursor"].split(":")[1])
        self.assertEqual(papers, result["papers"])
        self.assertEqual(failures, result["failures"])

    def test_receipt_page_matches_full_serialization_at_byte_boundaries(self) -> None:
        result = {
            "ok": False,
            "schema_version": "1.0",
            "session_id": self.session,
            "run": '路径/"\\\n',
            "project_id": self.project,
            "papers": [{"paper_id": f"p{index}", "title": '📚"\\\n'} for index in range(12)],
            "failures": [{"paper_id": f"f{index}", "code": "失败\t"} for index in range(12)],
            "omitted_papers": 0,
            "omitted_failures": 0,
            "delivery": {"ok": False, "error": "unavailable"},
        }
        entries = [("papers", paper) for paper in result["papers"]]
        entries.extend(("failures", failure) for failure in result["failures"])
        for receipt_id in ("a" * 64, ""):
            for offset in (0, 8, 9, 11, 12, len(entries) - 1):
                candidates = []
                page = {
                    key: value
                    for key, value in result.items()
                    if key not in ("papers", "failures", "omitted_papers", "omitted_failures")
                }
                page.update(
                    papers=[],
                    failures=[],
                    next_cursor=None,
                    total_papers=len(result["papers"]),
                    total_failures=len(result["failures"]),
                )
                for index in range(offset, len(entries)):
                    kind, entry = entries[index]
                    page = {
                        **page,
                        kind: [*page[kind], entry],
                        "next_cursor": (
                            f"{receipt_id}:{index + 1}"
                            if receipt_id and index + 1 < len(entries)
                            else None
                        ),
                    }
                    candidates.append(page)
                for boundary in candidates:
                    for delta in (-1, 0, 1):
                        byte_limit = len(download_result_bytes(boundary)) + delta
                        expected = None
                        for candidate in candidates:
                            if len(download_result_bytes(candidate)) > byte_limit:
                                break
                            expected = candidate
                        with self.subTest(receipt_id=receipt_id, offset=offset, limit=byte_limit):
                            if expected is None:
                                with self.assertRaisesRegex(
                                    ValueError, "download_receipt_entry_too_large"
                                ):
                                    download_result_page(result, receipt_id, offset, byte_limit)
                            else:
                                actual = download_result_page(
                                    result, receipt_id, offset, byte_limit
                                )
                                self.assertEqual(actual, expected)
                                self.assertLessEqual(len(download_result_bytes(actual)), byte_limit)

    def test_receipt_page_does_not_reserialize_accumulated_entries(self) -> None:
        result = {
            "ok": True,
            "session_id": self.session,
            "run": "run",
            "project_id": self.project,
            "papers": [{"paper_id": f"p{index}"} for index in range(1000)],
            "failures": [],
        }
        serialized_page_lengths = []

        def serialize(value: dict) -> bytes:
            if "papers" in value:
                serialized_page_lengths.append(len(value["papers"]) + len(value["failures"]))
            return download_result_bytes(value)

        with patch(
            "service.literature.service.downloads.download_result_bytes", side_effect=serialize
        ):
            page = download_result_page(result, "a" * 64, 0, BRIDGE_MAX_RESPONSE_BYTES)
        self.assertEqual(page["papers"], result["papers"])
        self.assertEqual(serialized_page_lengths, [0])

    def test_receipt_storage_failure_keeps_saved_outcome_in_bounded_response(self) -> None:
        metadata = json.loads((self.run / "search/round-001/metadata.json").read_text())
        metadata["papers"] = [{**paper, "title": "📚" * 2000} for paper in metadata["papers"]]
        self.write("search/round-001/metadata.json", metadata)
        entries = [self.local(f"p{index}") for index in range(5)]
        self.manifest(
            [
                {"paper_id": entry.paper_id, "status": "downloaded", "file_path": entry.file_path}
                for entry in entries
            ]
        )
        with (
            patch("service.literature.api.downloads.BRIDGE_MAX_RESPONSE_BYTES", 20_000),
            patch(
                "service.literature.api.downloads.save_download_result",
                side_effect=sqlite3.OperationalError("locked"),
            ),
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
        result = response.json()
        self.assertTrue(result["ok"])
        self.assertEqual(result["total_papers"], 5)
        self.assertLessEqual(len(response.content), 20_000)
        self.assertEqual(
            result["receipt_delivery"], {"ok": False, "error": "download_receipt_unavailable"}
        )
        self.assertEqual(len(self.repository.view(self.project).items), 5)

    def test_invalid_receipt_cursors_do_not_write_literature(self) -> None:
        for cursor in ("invalid", "a" * 64 + ":0", "a" * 64 + ":-1", "a" * 64 + ":999999"):
            with TestClient(self.app) as client:
                result = client.post(
                    LITERATURE_INGEST_ROUTE,
                    headers=self.headers,
                    json={"run": "run", "cursor": cursor},
                )
            self.assertFalse(result.json()["ok"])
        self.assertEqual(len(self.repository.view(self.project).items), 0)

    def test_acquire_admits_automatically_without_waiting_for_manifest(self) -> None:
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, content=self.payload))

        def acquire(papers, **kwargs):
            return acquire_fulltexts(papers, transport=transport, **kwargs)

        with (
            patch.object(self.activities, "to_thread", wraps=self.activities.to_thread) as worker,
            patch("service.literature.api.acquire.acquire_fulltexts", side_effect=acquire),
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_ACQUIRE_ROUTE,
                headers=self.headers,
                json={
                    "run": "run",
                    "papers": [
                        {"paper_id": "p4", "identifier": "2501.00005", "identifier_kind": "arxiv"}
                    ],
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["admission"]["ok"])
        self.assertEqual(response.json()["admission"]["papers"][0]["title"], "Paper 4")
        self.assertEqual(len(self.repository.view(self.project).items), 1)
        self.assertFalse((self.run / "downloads/manifest.json").exists())
        self.assertEqual(worker.await_count, 3)
        self.assertTrue(
            all(call.args[0] == ActivityDomain.BRIDGE for call in worker.await_args_list)
        )
        self.assertEqual(self.activities.snapshot().counts, {ActivityDomain.TURN.value: 1})

    def test_global_acquire_admits_once_without_project_membership(self) -> None:
        self.live.project_id = ""
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, content=self.payload))

        def acquire(papers, **kwargs):
            return acquire_fulltexts(papers, transport=transport, **kwargs)

        admitted = []
        with (
            patch("service.literature.api.acquire.acquire_fulltexts", side_effect=acquire),
            TestClient(self.app) as client,
        ):
            for _attempt in range(2):
                response = client.post(
                    LITERATURE_ACQUIRE_ROUTE,
                    headers=self.headers,
                    json={
                        "run": "run",
                        "papers": [
                            {
                                "paper_id": "p4",
                                "identifier": "2501.00005",
                                "identifier_kind": "arxiv",
                            }
                        ],
                    },
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["admission"]["ok"])
                self.assertEqual(response.json()["admission"]["project_id"], "")
                admitted.append(response.json()["admission"]["papers"][0])
        self.assertEqual(admitted[0]["literature_id"], admitted[1]["literature_id"])
        self.assertEqual(admitted[0]["attachment_id"], admitted[1]["attachment_id"])
        literature_id = admitted[0]["literature_id"]
        item = self.repository.get(literature_id)
        self.assertEqual(item.title, "Paper 4")
        self.assertEqual(item.authors, "Researcher")
        self.assertEqual(item.abstract, "Verified metadata abstract")
        self.assertEqual(item.fulltext, FulltextStatus.READY)
        self.assertEqual(self.repository.projects(literature_id), ())
        self.assertEqual([item.id for item in self.repository.view().items], [literature_id])
        self.assertEqual(self.repository.view(self.project).items, ())
        attachment = self.repository.primary_attachment(literature_id)
        self.assertEqual(read_attachment(attachment.path), self.payload)
        batch = DeliveryStore().by_run(self.session, "run")
        self.assertEqual(batch["project_id"], "")
        self.assertEqual(len(batch["papers"]), 1)
        with self.assertRaises(ValueError):
            DeliveryStore().get(uuid4().hex, batch["id"])

    def test_global_acquire_still_requires_fulltext_authorization(self) -> None:
        self.live.project_id = ""
        with (
            patch.object(self.authorizer, "require", side_effect=ValueError("not_granted")),
            patch("service.literature.api.acquire.acquire_fulltexts") as acquire,
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_ACQUIRE_ROUTE,
                headers=self.headers,
                json={
                    "run": "run",
                    "papers": [
                        {"paper_id": "p4", "identifier": "2501.00005", "identifier_kind": "arxiv"}
                    ],
                },
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "fulltext_authorization_required")
        acquire.assert_not_called()
        self.assertEqual(self.repository.view().items, ())

    def test_acquire_does_not_fall_back_to_global_for_missing_bound_project(self) -> None:
        self.projects.clear()
        with (
            patch("service.literature.api.acquire.acquire_fulltexts") as acquire,
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_ACQUIRE_ROUTE,
                headers=self.headers,
                json={
                    "run": "run",
                    "papers": [
                        {"paper_id": "p4", "identifier": "2501.00005", "identifier_kind": "arxiv"}
                    ],
                },
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "fulltext_acquisition_project_required")
        acquire.assert_not_called()
        self.assertEqual(self.repository.view().items, ())

    def test_acquire_rejects_identifier_outside_bound_metadata_before_download(self) -> None:
        with (
            patch("service.literature.api.acquire.acquire_fulltexts") as acquire,
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_ACQUIRE_ROUTE,
                headers=self.headers,
                json={
                    "run": "run",
                    "papers": [
                        {
                            "paper_id": "p4",
                            "identifier": "10.1234/another",
                            "identifier_kind": "doi",
                        }
                    ],
                },
            )
        self.assertEqual(response.status_code, 400)
        acquire.assert_not_called()

    def test_acquire_does_not_borrow_a_new_turn_after_preparation(self) -> None:
        def prepare(*_args):
            self.live.publication_turn_id = "replacement-turn"
            self.live.ledger.active_turn_id = "replacement-turn"
            self.live.active_assistant_snapshot_id = "replacement-snapshot"
            return self.scope

        with (
            patch.dict(
                "service.literature.api.acquire.DOWNLOAD_SCOPE_PREPARERS",
                {"precise_search": prepare},
            ),
            patch("service.literature.api.acquire.acquire_fulltexts") as acquire,
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_ACQUIRE_ROUTE,
                headers=self.headers,
                json={
                    "run": "run",
                    "papers": [
                        {"paper_id": "p0", "identifier": "2501.00001", "identifier_kind": "arxiv"}
                    ],
                },
            )
        self.assertEqual(response.status_code, 400)
        acquire.assert_not_called()

    def test_acquire_preserves_other_authorized_task_acquisition(self) -> None:
        self.live.active_task_type = "research_idea"
        self.authorizer.effective_scope = lambda **kwargs: SimpleNamespace(
            allowed=("paper:other",), grants={"paper:other": "idea-grant"}
        )
        self.live.ledger.active_turn_id = "different-ledger-turn"
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, content=self.payload))

        def acquire(papers, **kwargs):
            return acquire_fulltexts(papers, transport=transport, **kwargs)

        with (
            patch.object(self.authorizer, "require") as require,
            patch("service.literature.api.acquire.acquire_fulltexts", side_effect=acquire),
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_ACQUIRE_ROUTE,
                headers=self.headers,
                json={
                    "run": "other-owner-run",
                    "papers": [
                        {
                            "paper_id": "other",
                            "identifier": "1706.03762",
                            "identifier_kind": "arxiv",
                        }
                    ],
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["refs"], ["paper:other"])
        self.assertNotIn("admission", response.json())
        self.assertEqual(require.call_args.kwargs["turn_id"], self.live.publication_turn_id)

    def test_acquire_rejects_replaced_turn_after_request_parsing(self) -> None:
        validate = LiteratureAcquire.model_validate

        def parse(value):
            self.live.publication_turn_id = "replacement-turn"
            self.live.ledger.active_turn_id = "replacement-turn"
            self.live.active_assistant_snapshot_id = "replacement-snapshot"
            self.live.active_product_turn_id = "replacement-product-turn"
            return validate(value)

        for task_type in ("precise_search", "research_idea", "literature_review"):
            with self.subTest(task_type=task_type):
                self.live.active_task_type = task_type
                self.live.publication_turn_id = "turn"
                self.live.ledger.active_turn_id = "turn"
                self.live.active_assistant_snapshot_id = "snapshot"
                self.live.active_product_turn_id = "product-turn"
                with (
                    patch.object(LiteratureAcquire, "model_validate", side_effect=parse),
                    patch.object(self.authorizer, "require") as require,
                    patch("service.literature.api.acquire.acquire_fulltexts") as acquire,
                    TestClient(self.app) as client,
                ):
                    response = client.post(
                        LITERATURE_ACQUIRE_ROUTE,
                        headers=self.headers,
                        json={
                            "run": "other-owner-run",
                            "papers": [
                                {
                                    "paper_id": "other",
                                    "identifier": "1706.03762",
                                    "identifier_kind": "arxiv",
                                }
                            ],
                        },
                    )
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(response.json()["error"], "bridge_access_denied")
                require.assert_not_called()
                acquire.assert_not_called()

    def test_successful_acquire_admits_to_original_project_after_turn_finishes(self) -> None:
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, content=self.payload))
        replacement_project = uuid4().hex

        def acquire(papers, **kwargs):
            outcome = acquire_fulltexts(papers, transport=transport, **kwargs)
            self.live.project_id = replacement_project
            self.live.publication_turn_id = "replacement-turn"
            self.live.ledger.active_turn_id = "replacement-turn"
            self.sessions.bridge_caller = lambda _key: None
            return outcome

        with (
            patch("service.literature.api.acquire.acquire_fulltexts", side_effect=acquire),
            TestClient(self.app) as client,
        ):
            response = client.post(
                LITERATURE_ACQUIRE_ROUTE,
                headers=self.headers,
                json={
                    "run": "run",
                    "papers": [
                        {"paper_id": "p0", "identifier": "2501.00001", "identifier_kind": "arxiv"}
                    ],
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["admission"]["ok"])
        self.assertEqual(response.json()["admission"]["project_id"], self.project)
        self.assertEqual(len(self.repository.view(self.project).items), 1)
        self.assertEqual(self.repository.view(replacement_project).items, ())
        self.assertEqual(self.cards, [])

    def test_three_acquire_batches_reserve_card_budget_for_one_manifest_delivery(self) -> None:
        registry = CardRegistry()
        registry.register(
            DOWNLOADS_CARD, validate_download_card, direct=False, slot=download_card_slot
        )
        self.live._cards = registry
        database = self.root / "events.sqlite3"
        catalog = SessionCatalogStore(database)
        catalog.register(
            self.session,
            SessionPrincipal("contract-owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root / "outputs"),
            codex_version="contract",
            model_id="contract",
            policy_id="on-request",
            status=SessionStatus.READY,
            title="download contract",
            created_at=1.0,
        )
        self.live._events = ProductEventStore(database)
        self.live.runtime_id = "codex"
        self.live.vendor_thread_id = "thread"
        self.live._trace_and_broadcast = lambda _record: None
        self.live.component_for = AsyncMock(return_value=None)
        self.live._publish_card = LiveSession._publish_card.__get__(self.live, LiveSession)

        async def display(kind, content, **kwargs):
            return await LiveSession.display_card(self.live, kind, content, **kwargs)

        self.live.display_card = display
        for index in range(2):
            asyncio.run(
                display(
                    DOWNLOADS_CARD,
                    DisplayCardContent(
                        data={
                            "session_id": self.session,
                            "run": f"previous-{index}",
                            "project_id": self.project,
                            "papers": [],
                            "failures": [],
                        }
                    ),
                    turn_id="turn",
                )
            )
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, content=self.payload))

        def acquire(papers, **kwargs):
            return acquire_fulltexts(papers, transport=transport, **kwargs)

        entries = []
        with (
            patch("service.literature.api.acquire.acquire_fulltexts", side_effect=acquire),
            TestClient(self.app) as client,
        ):
            for index in range(3):
                response = client.post(
                    LITERATURE_ACQUIRE_ROUTE,
                    headers=self.headers,
                    json={
                        "run": "run",
                        "papers": [
                            {
                                "paper_id": f"p{index}",
                                "identifier": f"2501.0000{index + 1}",
                                "identifier_kind": "arxiv",
                            }
                        ],
                    },
                )
                self.assertTrue(response.json()["admission"]["ok"], response.text)
                entries.extend(
                    {**paper, "status": "downloaded", "storage": "managed"}
                    for paper in response.json()["papers"]
                )
            self.manifest(entries)
            response = client.post(
                LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
            )
            replay = client.post(LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"})
        self.assertTrue(response.json()["ok"], response.text)
        self.assertTrue(replay.json()["ok"], replay.text)
        self.assertEqual(len(response.json()["papers"]), 3)
        self.assertEqual(len(self.live._events.replay(self.session)), 3)
        self.assertEqual(len(self.repository.view(self.project).items), 3)

        with TestClient(self.app) as client:
            for paper_id in ("p3", "p4"):
                entry = self.local(paper_id)
                entries.append(
                    {"paper_id": paper_id, "status": "downloaded", "file_path": entry.file_path}
                )
                self.manifest(entries)
                response = client.post(
                    LITERATURE_INGEST_ROUTE, headers=self.headers, json={"run": "run"}
                )
                self.assertTrue(response.json()["ok"], response.text)
        self.assertEqual(len(response.json()["papers"]), 5)
        self.assertEqual(len(self.live._events.replay(self.session)), 5)
        self.assertEqual(len(self.repository.view(self.project).items), 5)

    def test_database_failure_rolls_back_library_but_preserves_download_snapshot(self) -> None:
        before = set(SERVICE_LITERATURE_FILES_DIR.glob("*"))
        with patch.object(
            self.repository, "add_attachment", side_effect=RuntimeError("database failed")
        ):
            with self.assertRaisesRegex(RuntimeError, "database failed"):
                self.admit(self.local())
        self.assertEqual(self.repository.view(self.project).items, ())
        batch = DeliveryStore().by_run(self.session, self.scope.run)
        self.assertEqual(len(batch["papers"]), 1)
        source = batch["papers"][0]
        self.assertEqual(source["paper_id"], "p0")
        self.assertEqual(source["metadata"]["abstract"], "Verified metadata abstract")
        source_path = SERVICE_LITERATURE_FILES_DIR / source["object_name"]
        self.assertEqual(read_attachment(str(source_path)), self.payload)
        self.assertEqual(set(SERVICE_LITERATURE_FILES_DIR.glob("*")), before | {source_path})
        admitted = self.admission.admit_payload(
            source, self.payload, self.session, self.project, restore=True
        )
        self.assertEqual(len(self.repository.view(self.project).items), 1)
        self.assertEqual(
            download_store.read_download_receipt(admitted.operation_id, self.session), admitted
        )

    def test_deleted_admission_is_not_silently_recreated(self) -> None:
        entry = self.local()
        admitted = self.admit(entry)
        self.repository.delete(admitted.literature_id, confirm=True)
        with self.assertRaisesRegex(ValueError, "download_admission_unavailable"):
            self.admit(entry)
        self.assertEqual(self.repository.view(self.project).items, ())

    def test_ingest_registry_does_not_accept_project_or_absolute_path_fields(self) -> None:
        self.assertIs(BRIDGE_REQUESTS[("literature", "ingest")].request_type, LiteratureIngest)
        with self.assertRaises(ValueError):
            LiteratureIngest.model_validate({"run": "run", "project_id": "another-project"})


if __name__ == "__main__":
    unittest.main()
