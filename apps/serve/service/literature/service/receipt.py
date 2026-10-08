"""Serve-computed confirmation of what one turn may read (proposal 116 G1).

The run directory is writable by the model, so a skill cannot vouch for its own
authorization. This module recomputes the effective grant from the durable HIL
decision plus the managed-object map every time it is asked, and reports which
authorized refs already have bytes behind them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from service.assistant.service.authorization import FulltextAuthorizer
from service.literature.persistence import fulltexts
from service.literature.service.fulltexts import PAPER_REF_PREFIX

RECEIPT_AUTHORIZED = "authorized"
RECEIPT_REJECTED = "rejected"
RECEIPT_PENDING = "pending"


@dataclass(frozen=True)
class ReceiptPaper:
    paper_id: str
    title: str
    revision: str
    source_kind: str


@dataclass(frozen=True)
class FulltextReceipt:
    run: str
    authorization_type: str
    disposition: str
    scope_digest: str
    question_id: str
    issued_at: str
    refs: tuple[str, ...]
    papers: tuple[ReceiptPaper, ...]

    def payload(self) -> dict[str, object]:
        return {
            "ok": True,
            "run": self.run,
            "authorization_type": self.authorization_type,
            "disposition": self.disposition,
            "scope_digest": self.scope_digest,
            "question_id": self.question_id,
            "issued_at": self.issued_at,
            "refs": list(self.refs),
            "papers": [
                {
                    "paper_id": paper.paper_id,
                    "title": paper.title,
                    "revision": paper.revision,
                    "source_kind": paper.source_kind,
                }
                for paper in self.papers
            ],
        }


def issued_at() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def issue_receipt(
    authorizer: FulltextAuthorizer,
    *,
    run: str,
    session_id: str,
    snapshot_id: str,
    turn_id: str,
    authorization_type: str,
    client_turn_id: str = "",
) -> FulltextReceipt:
    """Recompute this turn's effective full-text scope; never read a skill artifact."""

    authorizations = authorizer.turn_scope(
        session_id=session_id,
        snapshot_id=snapshot_id,
        turn_id=turn_id,
        authorization_type=authorization_type,
        client_turn_id=client_turn_id,
    )
    refs: list[str] = []
    source = None
    for authorization in authorizations:
        granted = authorizer.granted_refs(authorization)
        if not granted:
            continue
        source = source or authorization
        refs.extend(ref for ref in granted if ref not in refs)
    if refs:
        disposition = RECEIPT_AUTHORIZED
    elif any(authorizer.decided(authorization) for authorization in authorizations):
        disposition = RECEIPT_REJECTED
    else:
        disposition = RECEIPT_PENDING
    papers = []
    for ref in refs:
        if not ref.startswith(PAPER_REF_PREFIX):
            continue
        managed = fulltexts.find_fulltext_object(ref[len(PAPER_REF_PREFIX) :])
        if managed is None:
            continue
        papers.append(
            ReceiptPaper(
                paper_id=managed.paper_id,
                title=managed.title,
                revision=managed.revision,
                source_kind=managed.source_kind,
            )
        )
    return FulltextReceipt(
        run=run,
        authorization_type=authorization_type,
        disposition=disposition,
        scope_digest=source.scope_digest if source else "",
        question_id=source.question_id if source else "",
        issued_at=issued_at(),
        refs=tuple(refs),
        papers=tuple(papers),
    )


__all__ = [
    "RECEIPT_AUTHORIZED",
    "RECEIPT_PENDING",
    "RECEIPT_REJECTED",
    "FulltextReceipt",
    "ReceiptPaper",
    "issue_receipt",
]
