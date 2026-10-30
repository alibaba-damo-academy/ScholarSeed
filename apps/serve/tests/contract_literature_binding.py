"""Task-bound fulltext contracts using isolated SQLite/files, not product acceptance."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

_HOME = tempfile.mkdtemp(prefix="ss-binding-")
os.environ["SCHOLARSEED_HOME"] = _HOME

import httpx  # noqa: E402 - isolate SCHOLARSEED_HOME before product imports
from pypdf import PdfWriter  # noqa: E402 - isolate SCHOLARSEED_HOME before product imports

from service.assistant.service.authorization import (  # noqa: E402
    AuthorizationState,
    EffectiveFulltextScope,
    FulltextAuthorization,
    FulltextAuthorizer,
    fulltext_binding_scope,
)
from service.literature.domain.delivery import AcquisitionScope  # noqa: E402
from service.literature.persistence import fulltexts  # noqa: E402
from service.literature.persistence.delivery import DELIVERIES_TABLE, DeliveryStore  # noqa: E402
from service.literature.persistence.files import payload_revision  # noqa: E402
from service.literature.persistence.store import connect  # noqa: E402
from service.literature.service.acquire import AcquirePaper, acquire_fulltexts  # noqa: E402
from service.literature.service.fulltexts import ManagedFulltexts  # noqa: E402
from service.literature.service.receipt import issue_receipt  # noqa: E402
from service.literature.service.result import (  # noqa: E402
    AuthorizedFulltext,
    prepare_final_delivery,
)
from service.paths import SERVICE_LITERATURE_FILES_DIR  # noqa: E402
from service.platform.context import FulltextTaskContext, ProductTaskType  # noqa: E402


def pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


PDF_BYTES = pdf_bytes()


class ScopeStub(FulltextAuthorizer):
    """Isolate receipt projection; this double does not validate real authorization."""

    def __init__(self, paper_id: str, allowed: bool = True) -> None:
        self.ref = "paper:" + paper_id
        self.allowed = allowed
        self.context: FulltextTaskContext | None = None

    def effective_scope(self, **kwargs):
        self.context = kwargs["task_context"]
        return EffectiveFulltextScope(
            allowed=(self.ref,) if self.allowed else (),
            denied=() if self.allowed else (self.ref,),
            unknown=(),
            authorizations=(),
        )


class GrantAuthorizerStub(FulltextAuthorizer):
    def __init__(self, records: tuple[SimpleNamespace, ...]):
        self.decisions = {record.authorization_id: record for record in records}
        self.records = tuple(
            FulltextAuthorization(
                authorization_id=record.authorization_id,
                session_id="session",
                snapshot_id="snapshot",
                turn_id="turn",
                authorization_type="research_idea_fulltext",
                refs=record.refs,
                scope_digest="digest",
                question_id="question",
                state=AuthorizationState.PENDING,
                created_at=0,
            )
            for record in records
        )

    def turn_scope(self, **kwargs):
        return self.records

    def decided(self, authorization):
        return self.decisions[authorization.authorization_id].decided

    def granted_refs(self, authorization):
        return self.decisions[authorization.authorization_id].granted


class LiteratureBindingContract(unittest.TestCase):
    def setUp(self) -> None:
        self.token = uuid4().hex
        self.paper = AcquirePaper(self.token, "2501.00001", "arxiv", "Bound paper")
        self.context = FulltextTaskContext(
            owner_id="owner",
            project_id="",
            session_id=self.token,
            workdir=_HOME,
            task_type=ProductTaskType.PRECISE_SEARCH,
            workspace="run-" + self.token,
            run_id=self.token,
        )
        self.store = DeliveryStore()
        self.reader = ManagedFulltexts()

    def acquire(self, context=None, paper=None, payload=PDF_BYTES, transport=None):
        context = context or self.context
        outcome = acquire_fulltexts(
            (paper or self.paper,),
            scope=AcquisitionScope(context.session_id, context.project_id, context.workspace),
            transport=transport
            or httpx.MockTransport(lambda request: httpx.Response(200, content=payload)),
        )
        self.assertEqual(outcome.failures, ())
        self.assertEqual(len(outcome.papers), 1)
        return outcome

    def document(self, context=None):
        context = context or self.context
        return self.reader.managed_fulltext_document(
            context.project_id, self.paper.paper_id, task_context=context
        )

    def receipt(
        self, allowed=True, context=None, *, run: str | None = None, session_id: str | None = None
    ):
        context = context or self.context
        authorizer = ScopeStub(self.paper.paper_id, allowed)
        result = issue_receipt(
            authorizer,
            run=run if run is not None else context.workspace,
            session_id=session_id if session_id is not None else context.session_id,
            snapshot_id="snapshot",
            turn_id="turn",
            authorization_type="precise_search_fulltext",
            task_context=context,
        )
        self.assertEqual(authorizer.context, context)
        return result

    def entry(self):
        return self.store.bindings(
            self.context.session_id, self.context.project_id, self.context.workspace
        )[self.paper.paper_id]

    def test_global_update_does_not_change_read_receipt_or_publication(self) -> None:
        initial = self.acquire()
        other = replace(self.context, session_id="other-" + self.token)
        changed = self.acquire(other, payload=PDF_BYTES + self.token.encode())
        self.assertNotEqual(initial.papers[0].revision, changed.papers[0].revision)
        latest = fulltexts.find_fulltext_object(self.token)
        assert latest is not None
        self.assertEqual(latest.revision, changed.papers[0].revision)
        document = self.document()
        assert document is not None
        self.assertEqual(document.revision, initial.papers[0].revision)
        receipt = self.receipt()
        self.assertEqual(receipt.papers[0].revision, initial.papers[0].revision)
        root = Path(_HOME) / self.token
        run = root / self.context.workspace
        (run / "downloads").mkdir(parents=True)
        paths = {"final_report": "final.md", "paper_summary": "summary.md", "report": "read.md"}
        (run / "state.json").write_text(json.dumps({"status": "COMPLETED", "paths": paths}))
        for name in paths.values():
            (run / name).write_text("# Evidence\n")
        manifest = {
            "papers": [
                {
                    "paper_id": self.token,
                    "status": "downloaded",
                    "storage": "managed",
                    "ref": "paper:" + self.token,
                    "revision": initial.papers[0].revision,
                }
            ]
        }
        (run / "downloads/manifest.json").write_text(json.dumps(manifest))
        prepared = prepare_final_delivery(
            root,
            self.context.workspace,
            authorized=AuthorizedFulltext(
                receipt.refs, {paper.paper_id: paper.revision for paper in receipt.papers}
            ),
        )
        self.assertEqual(len(prepared.artifacts), 3)

    def test_repeated_source_reuses_binding_without_network(self) -> None:
        initial = self.acquire()

        def forbidden(request):
            self.fail("A bound source must not be downloaded again")

        repeated = self.acquire(transport=httpx.MockTransport(forbidden))
        self.assertEqual(repeated.papers[0].revision, initial.papers[0].revision)
        self.assertTrue(repeated.papers[0].reused)
        self.assertEqual(repeated.downloaded, 0)

    def test_different_source_is_explicit_conflict(self) -> None:
        self.acquire()
        with self.assertRaisesRegex(ValueError, "fulltext_binding_conflict"):
            self.acquire(paper=replace(self.paper, identifier="2502.00002"))

    def test_conflicting_record_rolls_back_global_update(self) -> None:
        self.acquire()
        previous = fulltexts.find_fulltext_object(self.token)
        assert previous is not None
        changed = dict(self.entry(), revision=payload_revision(b"changed"))
        with self.assertRaisesRegex(ValueError, "fulltext_binding_conflict"):
            with closing(connect()) as connection, connection:
                fulltexts.record_fulltext_object(
                    connection, replace(previous, revision=changed["revision"])
                )
                self.store.record(
                    connection, self.context.session_id, "", self.context.workspace, [changed], []
                )
        self.assertEqual(fulltexts.find_fulltext_object(self.token), previous)
        self.assertEqual(self.entry()["revision"], previous.revision)

    def test_historical_ambiguous_binding_is_rejected(self) -> None:
        self.acquire()
        with closing(connect()) as connection, connection:
            row = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=?", (self.token,)
            ).fetchone()
            historical = json.loads(row["payload"])
            historical["id"] = uuid4().hex
            historical["papers"][0]["revision"] = payload_revision(b"old version")
            connection.execute(
                f"INSERT INTO {DELIVERIES_TABLE} VALUES(?,?,?,?,?,?,?)",
                (
                    historical["id"],
                    self.token,
                    "",
                    self.context.workspace,
                    json.dumps(historical),
                    0,
                    0,
                ),
            )
        with self.assertRaisesRegex(ValueError, "fulltext_binding_conflict"):
            self.entry()
        with self.assertRaisesRegex(ValueError, "fulltext_binding_conflict"):
            self.document()

    def test_binding_cannot_cross_session_project_or_run(self) -> None:
        self.acquire()
        for field in ("session_id", "project_id", "workspace"):
            with self.subTest(field=field):
                context = replace(self.context, **{field: "different"})
                self.assertIsNone(self.document(context))
                self.assertEqual(self.receipt(context=context).papers, ())

    def test_managed_read_requires_context(self) -> None:
        self.acquire()
        with self.assertRaisesRegex(ValueError, "fulltext_binding_required"):
            self.reader.managed_fulltext_document("", self.token)

    def test_corrupted_object_rejected_by_reader_and_receipt(self) -> None:
        self.acquire()
        (SERVICE_LITERATURE_FILES_DIR / self.entry()["object_name"]).write_bytes(b"tampered")
        for operation in (self.document, self.receipt):
            with self.subTest(operation=operation.__name__):
                with self.assertRaisesRegex(ValueError, "fulltext_binding_integrity_failed"):
                    operation()

    def test_missing_object_never_falls_back_to_latest(self) -> None:
        self.acquire()
        original = SERVICE_LITERATURE_FILES_DIR / self.entry()["object_name"]
        self.acquire(
            replace(self.context, session_id="other-" + self.token),
            payload=PDF_BYTES + self.token.encode(),
        )
        original.unlink()
        for operation in (self.document, self.receipt):
            with self.subTest(operation=operation.__name__):
                with self.assertRaises((ValueError, OSError)):
                    operation()

    def test_denied_scope_has_no_receipt_despite_valid_binding(self) -> None:
        self.acquire()
        receipt = self.receipt(allowed=False)
        self.assertEqual(receipt.refs, ())
        self.assertEqual(receipt.papers, ())
        self.assertEqual(receipt.disposition, "rejected")

    def test_receipt_rejects_mismatched_task_identity(self) -> None:
        self.acquire()
        for override in ({"run": "other"}, {"session_id": "other"}):
            with self.subTest(override=override):
                with self.assertRaises(ValueError):
                    self.receipt(run=override.get("run"), session_id=override.get("session_id"))

    def test_effective_grant_ignores_pending_and_survives_continuation(self) -> None:
        ref = "paper:" + self.token
        records = (
            SimpleNamespace(authorization_id="pending", refs=(ref,), decided=False, granted=()),
            SimpleNamespace(authorization_id="original", refs=(ref,), decided=True, granted=(ref,)),
            SimpleNamespace(authorization_id="older", refs=(ref,), decided=True, granted=(ref,)),
        )
        authorizer = GrantAuthorizerStub(records)
        bindings = []
        for turn_id in ("first-turn", "continuation-turn"):
            scope = authorizer.effective_scope(
                session_id=self.token,
                snapshot_id="snapshot",
                turn_id=turn_id,
                authorization_type="research_idea_fulltext",
            )
            bindings.append(
                fulltext_binding_scope(scope, ref, session_id=self.token, project_id="")
            )
        self.assertEqual(bindings[0], bindings[1])
        self.assertEqual(bindings[0].authorization_id, "original")
        self.assertEqual(bindings[0].workspace, "")

    def test_denied_latest_grant_cannot_fall_back_to_old_allow(self) -> None:
        ref = "paper:" + self.token
        authorizer = GrantAuthorizerStub(
            (
                SimpleNamespace(authorization_id="denied", refs=(ref,), decided=True, granted=()),
                SimpleNamespace(authorization_id="old", refs=(ref,), decided=True, granted=(ref,)),
            )
        )
        scope = authorizer.effective_scope(
            session_id=self.token,
            snapshot_id="snapshot",
            turn_id="turn",
            authorization_type="research_idea_fulltext",
        )
        self.assertNotIn(ref, scope.grants)
        with self.assertRaisesRegex(ValueError, "fulltext_authorization_required"):
            fulltext_binding_scope(scope, ref, session_id=self.token, project_id="")

    def test_verified_nonpersistent_workspace_needs_no_authorization_context(self) -> None:
        binding = fulltext_binding_scope(
            None,
            "paper:" + self.token,
            session_id=self.token,
            project_id="",
            workspace=self.context.workspace,
        )
        self.assertEqual(binding.workspace, self.context.workspace)
        self.assertEqual(binding.authorization_id, "")

    def test_grant_bindings_cross_run_but_not_authorization(self) -> None:
        self.acquire()
        entry = dict(self.entry(), authorization_id="grant-" + self.token)
        for run in ("original", "continuation"):
            with closing(connect()) as connection, connection:
                self.store.record(connection, self.token, "", run, [entry], [])
        granted = self.store.bindings(
            self.token, "", "unrelated", authorization_id=entry["authorization_id"]
        )
        self.assertEqual(granted[self.token]["revision"], entry["revision"])
        self.assertEqual(
            self.store.bindings(self.token, "", "original", authorization_id="other"), {}
        )
        with self.assertRaisesRegex(ValueError, "fulltext_binding_conflict"):
            with closing(connect()) as connection, connection:
                self.store.record(
                    connection, self.token, "", "another-run", [dict(entry, revision="changed")], []
                )

    def test_new_grant_does_not_overwrite_previous_grant_same_run(self) -> None:
        self.acquire()
        entry = self.entry()
        for grant in ("first-grant", "second-grant"):
            with closing(connect()) as connection, connection:
                self.store.record(
                    connection,
                    self.token,
                    "",
                    self.context.workspace,
                    [dict(entry, authorization_id=grant)],
                    [],
                )
        for grant in ("first-grant", "second-grant"):
            self.assertEqual(
                self.store.bindings(self.token, "", "", authorization_id=grant)[self.token][
                    "authorization_id"
                ],
                grant,
            )


if __name__ == "__main__":
    unittest.main()
