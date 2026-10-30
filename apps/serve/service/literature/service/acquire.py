"""Acquisition-side PEP: download authorized full texts into the managed store.

The only product channel that fetches open-access bytes for a precise search
(proposal 116 G1). Authorization is checked by the caller for the whole batch
before any outbound request leaves; download failures stay explicit per paper.
"""

from __future__ import annotations

import logging
from contextlib import closing
from dataclasses import dataclass
from hashlib import sha256

import httpx

from service.literature.domain.delivery import (
    FULLTEXT_BINDING_CONFLICT,
    FULLTEXT_BINDING_INTEGRITY_FAILED,
    AcquisitionScope,
)
from service.literature.persistence import fulltexts
from service.literature.persistence.delivery import DeliveryStore
from service.literature.persistence.files import (
    LiteratureFileBatch,
    managed_object,
    payload_revision,
    read_attachment,
)
from service.literature.persistence.store import connect
from service.literature.service.arxiv import ArxivDownloadError, fetch_arxiv_pdf
from service.literature.service.duplicates import acquired_duplicate
from service.literature.service.fulltext import FulltextDownloadError, fetch_doi_pdf
from service.literature.service.fulltexts import PAPER_REF_PREFIX
from service.literature.service.identity import paper_identity, pinned_source, source_identity
from service.paths import SERVICE_LITERATURE_FILES_DIR

logger = logging.getLogger(__name__)

SOURCE_ARXIV = "arxiv"
SOURCE_DOI = "doi"
PDF_SUFFIX = ".pdf"

FAILURE_UNSUPPORTED = "acquire_identifier_unsupported"
FAILURE_DOWNLOAD = "acquire_download_failed"
REASON_CHARS = 240

DOWNLOAD_ERRORS = (ArxivDownloadError, FulltextDownloadError)


class UnsupportedIdentifierError(RuntimeError):
    """The acquisition policy has no fetch leg for this identifier kind."""


@dataclass(frozen=True)
class AcquirePaper:
    paper_id: str
    identifier: str
    identifier_kind: str
    title: str = ""


@dataclass(frozen=True)
class AcquireFailure:
    paper_id: str
    code: str
    reason: str


@dataclass(frozen=True)
class AcquiredPaper:
    paper_id: str
    ref: str
    revision: str
    source_kind: str
    reused: bool = False
    downloaded: bool = True


@dataclass(frozen=True)
class AcquireOutcome:
    papers: tuple[AcquiredPaper, ...]
    failures: tuple[AcquireFailure, ...]

    @property
    def refs(self) -> tuple[str, ...]:
        return tuple(paper.ref for paper in self.papers)

    @property
    def downloaded(self) -> int:
        return sum(paper.downloaded for paper in self.papers)

    def payload(self) -> dict[str, object]:
        return {
            "ok": True,
            "refs": list(self.refs),
            "storage": "managed",
            "papers": [
                {
                    "paper_id": paper.paper_id,
                    "ref": paper.ref,
                    "revision": paper.revision,
                    "source_kind": paper.source_kind,
                    "reused": paper.reused,
                }
                for paper in self.papers
            ],
            "manifest": {
                "selected": len(self.papers) + len(self.failures),
                "downloaded": self.downloaded,
                "failed": len(self.failures),
                "skipped": sum(not paper.downloaded for paper in self.papers),
                "reused": sum(paper.reused for paper in self.papers),
            },
            "failures": [
                {"paper_id": f.paper_id, "code": f.code, "reason": f.reason} for f in self.failures
            ],
        }


def fetch_fulltext_bytes(
    paper: AcquirePaper, *, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[str, bytes]:
    # ``transport`` exists only for offline contract tests; the product path never
    # passes one, so endpoints stay the validated fixed addresses.
    if paper.identifier_kind == SOURCE_ARXIV:
        return SOURCE_ARXIV, fetch_arxiv_pdf(paper.identifier, transport=transport)[1]
    if paper.identifier_kind == SOURCE_DOI:
        return SOURCE_DOI, fetch_doi_pdf(paper.identifier, transport=transport)[1]
    raise UnsupportedIdentifierError(FAILURE_UNSUPPORTED)


@dataclass(frozen=True)
class _Staged:
    paper: AcquirePaper
    source_kind: str
    object_name: str
    revision: str
    reused: bool = False
    downloaded: bool = True


def acquire_fulltexts(
    papers: tuple[AcquirePaper, ...],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    scope: AcquisitionScope | None = None,
) -> AcquireOutcome:
    """Fetch, stage and publish one batch; callers require authorization first."""

    staged: list[_Staged] = []
    failures: list[AcquireFailure] = []
    bindings = (
        DeliveryStore().bindings(scope.session_id, scope.project_id, scope.run)
        if scope is not None
        else {}
    )
    with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
        for paper in papers:
            authorization_id = scope.authorizations.get(paper.paper_id, "") if scope else ""
            bound = (
                DeliveryStore()
                .bindings(
                    scope.session_id, scope.project_id, scope.run, authorization_id=authorization_id
                )
                .get(paper.paper_id)
                if scope is not None and authorization_id
                else bindings.get(paper.paper_id)
            )
            if bound is not None:
                if source_identity(paper.identifier_kind, paper.identifier) != source_identity(
                    bound["identifier_kind"], bound["identifier"]
                ):
                    raise ValueError(f"{FULLTEXT_BINDING_CONFLICT}: {paper.paper_id}")
                payload = read_attachment(str(SERVICE_LITERATURE_FILES_DIR / bound["object_name"]))
                if payload_revision(payload) != bound["revision"]:
                    raise ValueError(f"{FULLTEXT_BINDING_INTEGRITY_FAILED}: {paper.paper_id}")
                staged.append(
                    _Staged(
                        paper,
                        bound.get("source_kind", bound["identifier_kind"]),
                        bound["object_name"],
                        bound["revision"],
                        True,
                        False,
                    )
                )
                continue
            try:
                descriptor = {
                    "identifier_kind": paper.identifier_kind,
                    "identifier": paper.identifier,
                }
                source = source_identity(paper.identifier_kind, paper.identifier)
                duplicate = next(
                    (
                        entry
                        for entry in staged
                        if source_identity(entry.paper.identifier_kind, entry.paper.identifier)
                        == source
                    ),
                    None,
                )
                if duplicate is not None:
                    staged.append(
                        _Staged(
                            paper,
                            duplicate.source_kind,
                            duplicate.object_name,
                            duplicate.revision,
                            True,
                            False,
                        )
                    )
                    continue
                cached = acquired_duplicate(descriptor) if pinned_source(*source) else None
                if cached is not None:
                    staged.append(
                        _Staged(
                            paper, source[0], cached["object_name"], cached["revision"], True, False
                        )
                    )
                    continue
                source_kind, payload = fetch_fulltext_bytes(paper, transport=transport)
            except UnsupportedIdentifierError as exc:
                failures.append(
                    AcquireFailure(paper.paper_id, FAILURE_UNSUPPORTED, str(exc)[:REASON_CHARS])
                )
                continue
            except Exception as exc:  # noqa: BLE001 - transport/parse legs stay evidence
                logger.warning(
                    "literature_acquire_download_failed paper_id=%s kind=%s error=%s",
                    paper.paper_id,
                    paper.identifier_kind,
                    exc,
                )
                failures.append(
                    AcquireFailure(paper.paper_id, FAILURE_DOWNLOAD, str(exc)[:REASON_CHARS])
                )
                continue
            revision = payload_revision(payload)
            cached = acquired_duplicate(descriptor, revision)
            if cached is not None:
                staged.append(_Staged(paper, source_kind, cached["object_name"], revision, True))
            else:
                managed = managed_object(
                    sha256(paper.paper_id.encode()).hexdigest(), payload, PDF_SUFFIX
                )
                batch.stage(managed.name, payload)
                staged.append(_Staged(paper, source_kind, managed.name, managed.revision))

        def publish() -> None:
            with closing(connect()) as connection, connection:
                fulltexts.ensure_fulltext_schema(connection)
                for entry in staged:
                    fulltexts.record_fulltext_object(
                        connection,
                        fulltexts.FulltextObject(
                            paper_id=entry.paper.paper_id,
                            object_name=entry.object_name,
                            revision=entry.revision,
                            source_kind=entry.source_kind,
                            acquired_at=fulltexts.acquired_at(),
                            title=entry.paper.title,
                            identifier_kind=entry.paper.identifier_kind,
                            identifier=entry.paper.identifier,
                        ),
                    )
                if scope is not None:
                    DeliveryStore().record(
                        connection,
                        scope.session_id,
                        scope.project_id,
                        scope.run,
                        [
                            {
                                "paper_id": entry.paper.paper_id,
                                "title": entry.paper.title,
                                "identifier": entry.paper.identifier,
                                "identifier_kind": entry.paper.identifier_kind,
                                "source_kind": entry.source_kind,
                                "authorization_id": scope.authorizations.get(
                                    entry.paper.paper_id, ""
                                ),
                                "identity": list(
                                    paper_identity(
                                        entry.paper.identifier_kind, entry.paper.identifier
                                    )
                                ),
                                "object_name": entry.object_name,
                                "revision": entry.revision,
                            }
                            for entry in staged
                        ],
                        [
                            {
                                "paper_id": failure.paper_id,
                                "code": failure.code,
                                "reason": failure.reason,
                            }
                            for failure in failures
                        ],
                    )

        if staged:
            batch.commit_operation(publish)
        elif scope is not None:
            publish()
    return AcquireOutcome(
        papers=tuple(
            AcquiredPaper(
                paper_id=entry.paper.paper_id,
                ref=PAPER_REF_PREFIX + entry.paper.paper_id,
                revision=entry.revision,
                source_kind=entry.source_kind,
                reused=entry.reused,
                downloaded=entry.downloaded,
            )
            for entry in staged
        ),
        failures=tuple(failures),
    )


__all__ = [
    "FAILURE_DOWNLOAD",
    "AcquiredPaper",
    "FAILURE_UNSUPPORTED",
    "PDF_SUFFIX",
    "SOURCE_ARXIV",
    "SOURCE_DOI",
    "AcquireFailure",
    "AcquireOutcome",
    "AcquirePaper",
    "acquire_fulltexts",
]
