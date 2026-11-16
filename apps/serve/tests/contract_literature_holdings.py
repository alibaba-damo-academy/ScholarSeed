"""Held-fulltext reuse contracts using isolated SQLite/files, not product acceptance."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

# macOS 的临时目录挂在符号链接 /var 下, 而 scoped 打开一律 O_NOFOLLOW: 先解析成真实
# 路径, 事件库这类要走目录描述符的实现才能在隔离目录里落盘。
_HOME = str(Path(tempfile.mkdtemp(prefix="ss-holdings-")).resolve())
os.environ["SCHOLARSEED_HOME"] = _HOME

import httpx  # noqa: E402 - isolate SCHOLARSEED_HOME before product imports
from fastapi import FastAPI  # noqa: E402  # imports after SCHOLARSEED_HOME isolation on purpose
from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfWriter  # noqa: E402 - isolate SCHOLARSEED_HOME before product imports

from service.chat.constants import PRODUCT_EVENT_DISPLAY_CARD  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.literature.api.result import register_result_routes  # noqa: E402
from service.literature.domain.delivery import AcquisitionScope  # noqa: E402
from service.literature.persistence import fulltexts  # noqa: E402
from service.literature.persistence.store import LiteratureRepository  # noqa: E402
from service.literature.schema import AttachmentRole, LiteratureItem  # noqa: E402
from service.literature.service.acquire import AcquirePaper, acquire_fulltexts  # noqa: E402
from service.literature.service.attachment import ATTACHMENT_TYPE_MISMATCH  # noqa: E402
from service.literature.service.holdings import (  # noqa: E402
    HELD_MANAGED,
    HELD_MISSING,
    HELD_PRESENT,
    HELD_RUN,
    HELD_UNSUPPORTED,
    HeldAttachmentPaper,
    admit_held_fulltexts,
    precise_run,
    session_holdings,
)
from service.literature.service.result import (  # noqa: E402
    AGENTIC_SEARCH_ORIGIN,
    PRECISE_RUN_COLLECTION,
    PRECISE_RUN_ROOT,
    PRECISE_SEARCH_ORIGIN,
    SEARCH_CARD,
)
from service.literature.service.status import ResultStatusService  # noqa: E402
from service.paths import SERVICE_LITERATURE_FILES_DIR  # noqa: E402
from service.platform.activity import Activities  # noqa: E402


def pdf_bytes(marker: str) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_attachment(marker, marker.encode())
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


MANAGED_BYTES = pdf_bytes("managed")
RUN_BYTES = pdf_bytes("run")


class HoldingsFixture(unittest.TestCase):
    """Isolated run package, bridge ledger and library; carries no tests of its own."""

    def setUp(self) -> None:
        self.token = uuid4().hex
        self.session = "session-" + self.token
        self.run_id = "20260101-000000-" + self.token[:6]
        self.root = Path(_HOME) / self.token
        self.run = self.root / PRECISE_RUN_ROOT / PRECISE_RUN_COLLECTION / self.run_id
        (self.run / "downloads" / "papers").mkdir(parents=True)
        (self.run / "state.json").write_text(
            json.dumps({"run_id": self.run_id, "status": "COMPLETED"}), encoding="utf-8"
        )
        self.repository = LiteratureRepository(self.root / "library.sqlite3")

    @property
    def relative_run(self) -> str:
        return f"{PRECISE_RUN_ROOT}/{PRECISE_RUN_COLLECTION}/{self.run_id}"

    def acquire(
        self, paper_id: str, identifier: str = "2501.00001", payload: bytes = MANAGED_BYTES
    ):
        """Run the real bridge acquisition leg against a mocked transport."""
        outcome = acquire_fulltexts(
            (AcquirePaper(paper_id, identifier, "arxiv", "Held paper"),),
            scope=AcquisitionScope(self.session, "", self.relative_run),
            transport=httpx.MockTransport(lambda request: httpx.Response(200, content=payload)),
        )
        self.assertEqual(outcome.failures, ())
        self.assertEqual(len(outcome.papers), 1)
        return outcome.papers[0]

    def write_manifest(self, papers: list[dict]) -> None:
        (self.run / "downloads" / "manifest.json").write_text(
            json.dumps({"schema_version": "1.0", "papers": papers}), encoding="utf-8"
        )

    def holdings(self, *paper_ids: str) -> dict:
        return session_holdings(self.root, self.session, self.run_id, list(paper_ids))


class LiteratureHoldingsContract(HoldingsFixture):
    def test_bridge_acquired_bytes_are_reusable_without_another_download(self) -> None:
        acquired = self.acquire("p-managed")
        held = self.holdings("p-managed", "p-never-acquired")
        self.assertEqual(set(held), {"p-managed"})
        self.assertEqual(held["p-managed"].storage, HELD_MANAGED)
        self.assertEqual(held["p-managed"].revision, acquired.revision)
        self.assertEqual(held["p-managed"].name, "2501.00001.pdf")

    def test_missing_managed_bytes_are_never_reported_as_downloaded(self) -> None:
        self.acquire("p-gone")
        recorded = fulltexts.find_fulltext_object("p-gone")
        assert recorded is not None
        (SERVICE_LITERATURE_FILES_DIR / recorded.object_name).unlink()
        self.assertEqual(self.holdings("p-gone"), {})

    def test_skill_downloaded_run_pdf_counts_as_downloaded(self) -> None:
        relative = "downloads/papers/paid-paper.pdf"
        (self.run / relative).write_bytes(RUN_BYTES)
        self.write_manifest(
            [
                {
                    "paper_id": "p-paid",
                    "status": "downloaded",
                    "storage": "run",
                    "file_path": relative,
                }
            ]
        )
        held = self.holdings("p-paid")
        self.assertEqual(held["p-paid"].storage, HELD_RUN)
        self.assertEqual(held["p-paid"].path, f"{self.relative_run}/{relative}")
        self.assertEqual(held["p-paid"].name, "paid-paper.pdf")

    def test_run_manifest_is_input_not_evidence(self) -> None:
        """A manifest alone proves nothing: missing bytes and unacquired managed entries drop."""
        self.write_manifest(
            [
                {
                    "paper_id": "p-absent",
                    "status": "downloaded",
                    "storage": "run",
                    "file_path": "downloads/papers/absent.pdf",
                },
                {
                    "paper_id": "p-claimed",
                    "status": "downloaded",
                    "storage": "managed",
                    "ref": "paper:p-claimed",
                    "revision": "sha256:" + "0" * 64,
                    "file_path": None,
                },
                {"paper_id": "p-failed", "status": "failed", "file_path": None},
            ]
        )
        self.assertEqual(self.holdings("p-absent", "p-claimed", "p-failed"), {})

    def test_run_package_is_found_at_the_workdir_root_or_a_session_directory(self) -> None:
        self.assertEqual(precise_run(self.root, self.run_id), self.relative_run)
        nested = Path(_HOME) / self.token / "session-output"
        run = nested / PRECISE_RUN_ROOT / PRECISE_RUN_COLLECTION / self.run_id
        (run / "downloads").mkdir(parents=True)
        (run / "state.json").write_text(json.dumps({"run_id": self.run_id}), encoding="utf-8")
        self.assertEqual(
            precise_run(nested, self.run_id),
            f"{PRECISE_RUN_ROOT}/{PRECISE_RUN_COLLECTION}/{self.run_id}",
        )
        self.assertEqual(precise_run(nested, "other-run"), "")
        self.assertEqual(precise_run(nested, "../escape"), "")
        self.assertEqual(precise_run(nested, ""), "")

    def test_admission_attaches_held_bytes_and_reports_fulltext_counts(self) -> None:
        acquired = self.acquire("p-managed")
        self.repository.save(LiteratureItem(id="lib-held", title="Held paper"))
        self.repository.save(LiteratureItem(id="lib-plain", title="Metadata only"))
        outcomes = admit_held_fulltexts(
            self.root,
            self.session,
            self.run_id,
            [
                HeldAttachmentPaper(literature_id="lib-held", paper_id="p-managed"),
                HeldAttachmentPaper(literature_id="lib-plain", paper_id="p-nothing"),
            ],
            repository=self.repository,
        )
        self.assertEqual([outcome.code for outcome in outcomes], ["", HELD_MISSING])
        self.assertEqual([outcome.attached for outcome in outcomes], [True, False])
        self.assertEqual([outcome.fulltext for outcome in outcomes], [True, False])
        self.assertEqual([outcome.storage for outcome in outcomes], [HELD_MANAGED, ""])
        attachment = self.repository.primary_attachment("lib-held")
        assert attachment is not None
        self.assertEqual(attachment.role, AttachmentRole.PRIMARY)
        self.assertEqual(attachment.revision, acquired.revision)
        self.assertEqual(Path(attachment.path).read_bytes(), MANAGED_BYTES)
        self.assertIsNone(self.repository.primary_attachment("lib-plain"))

    def test_admission_is_idempotent_and_never_replaces_a_primary(self) -> None:
        self.acquire("p-managed")
        self.repository.save(LiteratureItem(id="lib-held", title="Held paper"))
        entry = [HeldAttachmentPaper(literature_id="lib-held", paper_id="p-managed")]
        first = admit_held_fulltexts(
            self.root, self.session, self.run_id, entry, repository=self.repository
        )
        again = admit_held_fulltexts(
            self.root, self.session, self.run_id, entry, repository=self.repository
        )
        self.assertEqual(first[0].code, "")
        self.assertEqual(again[0].code, HELD_PRESENT)
        self.assertTrue(again[0].fulltext)
        self.assertFalse(again[0].attached)
        self.assertEqual(len(self.repository.attachments("lib-held")), 1)

    def test_admission_reports_a_missing_library_item_without_touching_others(self) -> None:
        self.acquire("p-managed")
        self.repository.save(LiteratureItem(id="lib-held", title="Held paper"))
        outcomes = admit_held_fulltexts(
            self.root,
            self.session,
            self.run_id,
            [
                HeldAttachmentPaper(literature_id="lib-missing", paper_id="p-managed"),
                HeldAttachmentPaper(literature_id="lib-held", paper_id="p-managed"),
            ],
            repository=self.repository,
        )
        self.assertEqual(outcomes[0].code, "held_literature_missing")
        self.assertFalse(outcomes[0].fulltext)
        self.assertEqual(outcomes[1].code, "")
        self.assertTrue(outcomes[1].fulltext)

    def test_run_pdf_bytes_are_admitted_verbatim(self) -> None:
        relative = "downloads/papers/paid-paper.pdf"
        (self.run / relative).write_bytes(RUN_BYTES)
        self.write_manifest(
            [
                {
                    "paper_id": "p-paid",
                    "status": "downloaded",
                    "storage": "run",
                    "file_path": relative,
                }
            ]
        )
        self.repository.save(LiteratureItem(id="lib-paid", title="Paid paper"))
        outcomes = admit_held_fulltexts(
            self.root,
            self.session,
            self.run_id,
            [HeldAttachmentPaper(literature_id="lib-paid", paper_id="p-paid")],
            repository=self.repository,
        )
        self.assertEqual(outcomes[0].storage, HELD_RUN)
        self.assertTrue(outcomes[0].fulltext)
        attachment = self.repository.primary_attachment("lib-paid")
        assert attachment is not None
        self.assertEqual(attachment.name, "paid-paper.pdf")
        self.assertEqual(Path(attachment.path).read_bytes(), RUN_BYTES)

    def test_a_non_pdf_run_file_is_refused_and_reported(self) -> None:
        relative = "downloads/papers/not-a-pdf.pdf"
        (self.run / relative).write_bytes(b"<html>paywall</html>")
        self.write_manifest(
            [
                {
                    "paper_id": "p-html",
                    "status": "downloaded",
                    "storage": "run",
                    "file_path": relative,
                }
            ]
        )
        self.repository.save(LiteratureItem(id="lib-html", title="Paywall page"))
        outcomes = admit_held_fulltexts(
            self.root,
            self.session,
            self.run_id,
            [HeldAttachmentPaper(literature_id="lib-html", paper_id="p-html")],
            repository=self.repository,
        )
        self.assertFalse(outcomes[0].fulltext)
        self.assertEqual(outcomes[0].code, ATTACHMENT_TYPE_MISMATCH)
        self.assertIsNone(self.repository.primary_attachment("lib-html"))


class LiteratureHoldingsRouteContract(HoldingsFixture):
    """The two product endpoints behind 「元信息和全文」, over the real route wiring."""

    def setUp(self) -> None:
        super().setUp()
        # 路由按会话查账, 所以这一组的 bridge 获取要记在同一个会话号下。
        self.session = "s1"
        self.library = LiteratureRepository()
        self.database = self.root / "sessions.sqlite3"
        catalog = SessionCatalogStore(self.database)
        for session, owner in (("s1", "local"), ("private", "other")):
            catalog.register(
                session,
                SessionPrincipal(owner),
                runtime_id="codex",
                vendor_thread_id=session,
                vendor_session_id=None,
                runtime_workdir=str(self.root),
                project_path=None,
                output_root=str(self.root / "outputs"),
                codex_version="contract",
                model_id="contract",
                policy_id="on-request",
                status=SessionStatus.READY,
                title="contract",
                created_at=1.0,
            )
        events = ProductEventStore(self.database)
        for card_id, origin in (
            ("card", PRECISE_SEARCH_ORIGIN),
            ("agentic", AGENTIC_SEARCH_ORIGIN),
        ):
            events.append(
                session_id="s1",
                runtime_id="codex",
                vendor_thread_id="s1",
                vendor_turn_id="t1",
                vendor_item_id=None,
                kind=PRODUCT_EVENT_DISPLAY_CARD,
                payload={
                    "type": SEARCH_CARD,
                    "card_id": card_id,
                    "content": {
                        "schema_version": "1.0",
                        "session_id": "s1",
                        "run_id": self.run_id,
                        "origin": origin,
                    },
                },
                idempotency_key=card_id,
            )
        app = FastAPI()
        register_result_routes(
            app,
            SimpleNamespace(),
            catalog,
            ResultStatusService(self.library),
            events,
            SimpleNamespace(),
            activities=Activities(),
        )
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def holdings_route(
        self, paper_ids: tuple[str, ...] = (), card: str = "card", session: str = "s1"
    ):
        return self.client.post(
            f"/api/sessions/{session}/literature/results/{card}/fulltext-holdings",
            json={"papers": [{"id": paper_id} for paper_id in paper_ids]},
        )

    def attach_route(self, pairs: list[tuple[str, str]], card: str = "card"):
        return self.client.post(
            f"/api/sessions/s1/literature/results/{card}/attachments/held",
            json={
                "papers": [
                    {"literature_id": literature_id, "paper_id": paper_id}
                    for literature_id, paper_id in pairs
                ]
            },
        )

    def test_holdings_report_both_legs_of_a_precise_card(self) -> None:
        self.acquire("p-managed")
        relative = "downloads/papers/paid-paper.pdf"
        (self.run / relative).write_bytes(RUN_BYTES)
        self.write_manifest(
            [
                {
                    "paper_id": "p-paid",
                    "status": "downloaded",
                    "storage": "run",
                    "file_path": relative,
                }
            ]
        )
        response = self.holdings_route(("p-managed", "p-paid", "p-nothing"))
        self.assertEqual(response.status_code, 200, response.text)
        items = response.json()["items"]
        self.assertEqual(items["p-managed"]["storage"], HELD_MANAGED)
        self.assertEqual(items["p-managed"]["name"], "2501.00001.pdf")
        self.assertEqual(items["p-paid"]["storage"], HELD_RUN)
        self.assertEqual(items["p-paid"]["name"], "paid-paper.pdf")
        self.assertNotIn("p-nothing", items)

    def test_holdings_stay_empty_when_nothing_was_downloaded(self) -> None:
        # 账本按会话累积, 所以这里问一个本组从未获取过的 paper_id。
        response = self.holdings_route((f"p-never-{self.token}",))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"], {})

    def test_holdings_are_refused_outside_a_precise_search_card(self) -> None:
        self.acquire("p-managed")
        foreign = self.holdings_route(("p-managed",), card="agentic")
        self.assertEqual(foreign.status_code, 400, foreign.text)
        self.assertEqual(foreign.json()["detail"], HELD_UNSUPPORTED)
        self.assertEqual(self.holdings_route(card="missing").status_code, 404)
        self.assertEqual(self.holdings_route(session="private").status_code, 404)
        self.assertEqual(self.holdings_route(session="unknown").status_code, 404)

    def test_attach_admits_held_bytes_and_reports_the_fulltext_count(self) -> None:
        # 文献库是模块级共享的, 条目 id 带上本次 token 才不会撞到别的用例。
        held_id, plain_id = f"lib-held-{self.token}", f"lib-plain-{self.token}"
        self.acquire("p-managed")
        self.library.save(LiteratureItem(id=held_id, title="Held paper"))
        self.library.save(LiteratureItem(id=plain_id, title="Metadata only"))
        response = self.attach_route([(held_id, "p-managed"), (plain_id, "p-nothing")])
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["acquired"], 1)
        self.assertEqual(payload["fulltext"], 1)
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(
            [(item["literature_id"], item["code"]) for item in payload["items"]],
            [(held_id, ""), (plain_id, HELD_MISSING)],
        )
        attachment = self.library.primary_attachment(held_id)
        assert attachment is not None
        self.assertEqual(Path(attachment.path).read_bytes(), MANAGED_BYTES)
        self.assertIsNone(self.library.primary_attachment(plain_id))

    def test_attach_never_downloads_and_never_replaces_a_primary(self) -> None:
        held_id = f"lib-held-{self.token}"
        self.acquire("p-managed")
        self.library.save(LiteratureItem(id=held_id, title="Held paper"))
        first = self.attach_route([(held_id, "p-managed")])
        again = self.attach_route([(held_id, "p-managed")])
        self.assertEqual(first.json()["acquired"], 1)
        self.assertEqual(again.json()["acquired"], 0)
        self.assertEqual(again.json()["fulltext"], 1)
        self.assertEqual(again.json()["failed"], 0)
        self.assertEqual(again.json()["items"][0]["code"], HELD_PRESENT)
        self.assertEqual(len(self.library.attachments(held_id)), 1)


if __name__ == "__main__":
    unittest.main()
