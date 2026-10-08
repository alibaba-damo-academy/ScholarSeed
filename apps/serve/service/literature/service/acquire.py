"""Acquisition-side PEP: download authorized full texts into the managed store.

The only product channel that fetches open-access bytes for a precise search
(proposal 116 G1). Authorization is checked by the caller for the whole batch
before any outbound request leaves; download failures stay explicit per paper.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from service.literature.persistence import fulltexts
from service.literature.persistence.files import LiteratureFileBatch, managed_object
from service.literature.persistence.store import connect
from service.literature.service.arxiv import ArxivDownloadError, fetch_arxiv_pdf
from service.literature.service.fulltext import FulltextDownloadError, fetch_doi_pdf
from service.literature.service.fulltexts import PAPER_REF_PREFIX
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


@dataclass(frozen=True)
class AcquireOutcome:
    papers: tuple[AcquiredPaper, ...]
    failures: tuple[AcquireFailure, ...]

    @property
    def refs(self) -> tuple[str, ...]:
        return tuple(paper.ref for paper in self.papers)

    @property
    def downloaded(self) -> int:
        return len(self.papers)

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
                }
                for paper in self.papers
            ],
            "manifest": {
                "selected": len(self.papers) + len(self.failures),
                "downloaded": self.downloaded,
                "failed": len(self.failures),
                "skipped": 0,
            },
            "failures": [
                {"paper_id": f.paper_id, "code": f.code, "reason": f.reason} for f in self.failures
            ],
        }


def fetch_fulltext_bytes(
    paper: AcquirePaper, *, transport: httpx.BaseTransport | None = None
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


def acquire_fulltexts(
    papers: tuple[AcquirePaper, ...],
    *,
    transport: httpx.BaseTransport | None = None,
) -> AcquireOutcome:
    """Fetch, stage and publish one batch; callers require authorization first."""

    staged: list[_Staged] = []
    failures: list[AcquireFailure] = []
    with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
        for paper in papers:
            try:
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
            managed = managed_object(paper.paper_id, payload, PDF_SUFFIX)
            batch.stage(managed.name, payload)
            staged.append(_Staged(paper, source_kind, managed.name, managed.revision))

        def publish() -> None:
            with connect() as connection:
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
                        ),
                    )

        if staged:
            batch.commit_operation(publish)
    return AcquireOutcome(
        papers=tuple(
            AcquiredPaper(
                paper_id=entry.paper.paper_id,
                ref=PAPER_REF_PREFIX + entry.paper.paper_id,
                revision=entry.revision,
                source_kind=entry.source_kind,
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
