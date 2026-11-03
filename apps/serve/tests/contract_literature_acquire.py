"""Acquisition boundary contract: authorized batches land in managed storage and serve
reports the effective grant (not acceptance)."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

_HOME = tempfile.mkdtemp(prefix="ss-acquire-")
os.environ["SCHOLARSEED_HOME"] = _HOME

import httpx  # noqa: E402  # imports after SCHOLARSEED_HOME isolation on purpose

from service.assistant.service.authorization import (  # noqa: E402
    PRECISE_SEARCH_FULLTEXT,
    FulltextAuthorizer,
)
from service.chat.persistence.catalog import (  # noqa: E402
    HilStatus,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.literature.domain.delivery import AcquisitionScope  # noqa: E402
from service.literature.persistence import fulltexts  # noqa: E402
from service.literature.service.acquire import (  # noqa: E402
    FAILURE_DOWNLOAD,
    FAILURE_UNSUPPORTED,
    AcquirePaper,
    acquire_fulltexts,
)
from service.literature.service.fulltexts import ManagedFulltexts  # noqa: E402
from service.literature.service.outcome import FULLTEXT_TIMEOUT  # noqa: E402
from service.literature.service.receipt import (  # noqa: E402
    RECEIPT_AUTHORIZED,
    RECEIPT_PENDING,
    RECEIPT_REJECTED,
    issue_receipt,
)
from service.paths import SERVICE_LITERATURE_FILES_DIR  # noqa: E402
from service.platform.bridge import (  # noqa: E402
    ACQUIRE_MAX_PAPERS,
    BRIDGE_REQUESTS,
    LITERATURE_ACQUIRE_ROUTE,
    LITERATURE_RECEIPT_ROUTE,
    LiteratureAcquire,
    LiteratureReceipt,
)
from service.platform.context import FulltextTaskContext, ProductTaskType  # noqa: E402

PDF_BYTES = (
    b"%PDF-1.4\n"
    b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
    b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n"
    b"xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n"
    b"0000000052 00000 n \n0000000101 00000 n \n"
    b"trailer << /Size 4 /Root 1 0 R >>\nstartxref\n164\n%%EOF\n"
)


def _transport(fail_after: int | None = None) -> httpx.MockTransport:
    state = {"served": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["served"] += 1
        if fail_after is not None and state["served"] > fail_after:
            return httpx.Response(500, text="upstream down")
        return httpx.Response(200, content=PDF_BYTES)

    return httpx.MockTransport(handler)


def paper(paper_id: str, identifier: str = "2501.00001", kind: str = "arxiv") -> AcquirePaper:
    return AcquirePaper(
        paper_id=paper_id,
        identifier=identifier,
        identifier_kind=kind,
        title=f"Paper {paper_id}",
    )


def task_context(session_id: str, project_id: str = "") -> FulltextTaskContext:
    return FulltextTaskContext(
        owner_id="owner",
        project_id=project_id,
        session_id=session_id,
        workdir=_HOME,
        task_type=ProductTaskType.PRECISE_SEARCH,
        workspace="run1",
        run_id="run1",
    )


class LiteratureAcquireContract(unittest.TestCase):
    def test_registry_exposes_acquire(self) -> None:
        entry = BRIDGE_REQUESTS[("literature", "acquire")]
        model, route = entry.request_type, entry.route
        self.assertIs(model, LiteratureAcquire)
        self.assertEqual(route, LITERATURE_ACQUIRE_ROUTE)

    def test_request_model_bounds(self) -> None:
        with self.assertRaises(ValueError):
            LiteratureAcquire.model_validate(
                {
                    "run": "run1",
                    "papers": [
                        {
                            "paper_id": f"p{i}",
                            "identifier": "2501.0001",
                            "identifier_kind": "arxiv",
                        }
                        for i in range(ACQUIRE_MAX_PAPERS + 1)
                    ],
                }
            )
        with self.assertRaises(ValueError):
            LiteratureAcquire.model_validate(
                {
                    "run": "run1",
                    "papers": [{"paper_id": "p1", "identifier": "x", "identifier_kind": "url"}],
                }
            )

    def test_unsupported_identifier_fails_without_outbound(self) -> None:
        outcome = acquire_fulltexts(
            (paper("p1", identifier="https://example.org/x.pdf", kind="url"),),
            transport=_transport(),
        )
        self.assertEqual(outcome.refs, ())
        self.assertEqual(outcome.downloaded, 0)
        self.assertEqual([f.code for f in outcome.failures], [FAILURE_UNSUPPORTED])

    def test_authorized_batch_stores_managed_bytes(self) -> None:
        context = task_context("acquire-session", "proj")
        outcome = acquire_fulltexts(
            (paper("p1"),),
            transport=_transport(),
            scope=AcquisitionScope(context.session_id, context.project_id, context.workspace),
        )
        self.assertEqual(outcome.refs, ("paper:p1",))
        self.assertEqual(outcome.downloaded, 1)
        self.assertEqual(outcome.failures, ())
        obj = fulltexts.find_fulltext_object("p1")
        self.assertIsNotNone(obj)
        assert obj is not None
        self.assertTrue((SERVICE_LITERATURE_FILES_DIR / obj.object_name).is_file())
        document = ManagedFulltexts().managed_fulltext_document("proj", "p1", task_context=context)
        self.assertIsNotNone(document)
        assert document is not None
        self.assertTrue(document.payload.startswith(b"%PDF"))
        self.assertEqual(document.reference_id, "paper:p1")

    def test_download_failure_stays_explicit(self) -> None:
        outcome = acquire_fulltexts(
            (paper("p2"),),
            transport=_transport(fail_after=0),
        )
        self.assertEqual(outcome.refs, ())
        self.assertEqual(outcome.downloaded, 0)
        self.assertEqual([f.code for f in outcome.failures], [FAILURE_DOWNLOAD])
        self.assertIsNone(fulltexts.find_fulltext_object("p2"))

    def test_timeout_reason_is_preserved_without_publishing_partial_pdf(self) -> None:
        def stalled(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("stalled", request=request)

        outcome = acquire_fulltexts(
            (paper("timeout-paper"),), transport=httpx.MockTransport(stalled)
        )
        payload = outcome.payload()
        self.assertEqual(payload["manifest"]["downloaded"], 0)
        self.assertEqual(payload["manifest"]["failed"], 1)
        self.assertEqual(
            payload["failures"],
            [
                {
                    "paper_id": "timeout-paper",
                    "code": FAILURE_DOWNLOAD,
                    "reason": FULLTEXT_TIMEOUT,
                }
            ],
        )
        self.assertIsNone(fulltexts.find_fulltext_object("timeout-paper"))

    def test_partial_batch_keeps_per_paper_evidence(self) -> None:
        outcome = acquire_fulltexts(
            (paper("p3", identifier="2501.00003"), paper("p4", identifier="2501.00004")),
            transport=_transport(fail_after=1),
        )
        self.assertEqual(outcome.refs, ("paper:p3",))
        self.assertEqual(outcome.downloaded, 1)
        self.assertEqual([f.paper_id for f in outcome.failures], ["p4"])
        payload = outcome.payload()
        self.assertEqual(payload["storage"], "managed")
        self.assertEqual(
            payload["papers"],
            [
                {
                    "paper_id": "p3",
                    "ref": "paper:p3",
                    "revision": outcome.papers[0].revision,
                    "source_kind": "arxiv",
                    "reused": False,
                }
            ],
        )
        manifest = payload["manifest"]
        assert isinstance(manifest, dict)
        self.assertEqual(manifest["downloaded"], 1)
        self.assertEqual(manifest["failed"], 1)


AUTHORIZE = "一键授权"
REJECT = "拒绝"


class LiteratureReceiptContract(unittest.TestCase):
    """The skill's only authorization truth is recomputed by serve on demand."""

    SESSION = "receipt-session"
    SNAPSHOT = "receipt-snapshot"
    TURN = "receipt-turn"
    REFS = ("paper:p1", "paper:p2")

    def setUp(self) -> None:
        self.context = task_context(self.SESSION)

    def _authorizer(self, answer: str | None, values: dict | None = None) -> FulltextAuthorizer:
        holder: dict[str, str] = {}

        def turn_hil(_session_id: str, _turn_id: str) -> list:
            question_id = holder.get("question_id")
            if question_id is None or answer is None:
                return []
            return [
                SimpleNamespace(
                    status=HilStatus.RESOLVED,
                    decision={
                        "answers": {question_id: answer},
                        **({"values": values} if values else {}),
                    },
                    payload={"questions": [{"id": question_id}]},
                )
            ]

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        database = Path(temporary.name) / "sessions.sqlite3"
        catalog = SessionCatalogStore(database)
        catalog.register(
            self.SESSION,
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id=None,
            runtime_workdir=temporary.name,
            project_path=None,
            output_root=str(Path(temporary.name) / "outputs"),
            codex_version="contract",
            model_id="contract",
            policy_id="workspace-write",
            status=SessionStatus.RUNNING,
            title="receipt",
            created_at=1.0,
        )
        authorizer = FulltextAuthorizer(database, SimpleNamespace(turn_hil=turn_hil))
        challenge = authorizer.prepare(
            session_id=self.SESSION,
            snapshot_id=self.SNAPSHOT,
            turn_id=self.TURN,
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            refs=self.REFS,
            task_context=self.context,
        )
        holder["question_id"] = challenge.question_id
        self.challenge = challenge
        return authorizer

    def _receipt(self, authorizer: FulltextAuthorizer):
        return issue_receipt(
            authorizer,
            run="run1",
            session_id=self.SESSION,
            snapshot_id=self.SNAPSHOT,
            turn_id=self.TURN,
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            task_context=self.context,
        )

    def test_registry_exposes_receipt(self) -> None:
        entry = BRIDGE_REQUESTS[("literature", "receipt")]
        model, route = entry.request_type, entry.route
        self.assertIs(model, LiteratureReceipt)
        self.assertEqual(route, LITERATURE_RECEIPT_ROUTE)
        with self.assertRaises(ValueError):
            LiteratureReceipt.model_validate({"run": "run1", "refs": ["paper:p1"]})

    def test_granted_subset_and_managed_bytes_are_reported(self) -> None:
        acquire_fulltexts(
            (paper("p1"),), transport=_transport(), scope=AcquisitionScope(self.SESSION, "", "run1")
        )
        authorizer = self._authorizer(AUTHORIZE, {"selected_paper_ids": ["paper:p1"]})
        payload = self._receipt(authorizer).payload()
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["run"], "run1")
        self.assertEqual(payload["disposition"], RECEIPT_AUTHORIZED)
        self.assertEqual(payload["refs"], ["paper:p1"])
        self.assertEqual(payload["scope_digest"], self.challenge.scope_digest)
        self.assertEqual(payload["question_id"], self.challenge.question_id)
        self.assertTrue(payload["issued_at"])
        papers = payload["papers"]
        assert isinstance(papers, list)
        self.assertEqual([entry["paper_id"] for entry in papers], ["p1"])
        self.assertEqual(papers[0]["source_kind"], "arxiv")
        self.assertTrue(str(papers[0]["revision"]))

    def test_authorized_refs_without_bytes_stay_visible(self) -> None:
        acquire_fulltexts(
            (paper("p1"),), transport=_transport(), scope=AcquisitionScope(self.SESSION, "", "run1")
        )
        authorizer = self._authorizer(AUTHORIZE)
        receipt = self._receipt(authorizer)
        self.assertEqual(receipt.refs, self.REFS)
        self.assertEqual([entry.paper_id for entry in receipt.papers], ["p1"])

    def test_pending_and_rejected_turns_grant_nothing(self) -> None:
        pending = self._receipt(self._authorizer(None))
        self.assertEqual(pending.disposition, RECEIPT_PENDING)
        self.assertEqual(pending.refs, ())
        self.assertEqual(pending.scope_digest, "")
        rejected = self._receipt(self._authorizer(REJECT, {"selected_paper_ids": ["paper:p1"]}))
        self.assertEqual(rejected.disposition, RECEIPT_REJECTED)
        self.assertEqual(rejected.refs, ())
        self.assertEqual(rejected.papers, ())

    def test_malformed_subset_fails_closed(self) -> None:
        authorizer = self._authorizer(AUTHORIZE, {"selected_paper_ids": ["paper:p9"]})
        receipt = self._receipt(authorizer)
        self.assertEqual(receipt.disposition, RECEIPT_REJECTED)
        self.assertEqual(receipt.refs, ())


if __name__ == "__main__":
    unittest.main()
