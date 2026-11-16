"""Reuse full text the product or the skill already downloaded; never fetch again.

「这篇已经下载完成了」只有两条腿, 都由 serve 自己核验:

- ``managed``: bridge ``literature/acquire`` 成功时 serve 落进托管存储的字节。真值是
  这次会话在 ``literature_deliveries`` 里的绑定 (paper_id -> object_name/revision),
  且托管目录里那份字节还在。
- ``run``: 技能付费路线自己下载进 run 目录的 PDF。真值是 scoped 读到的真实文件;
  run 内 ``downloads/manifest.json`` 只用来指路 —— 它是模型可写的输入, 不是证据。

加入文献库时两条腿都只经过附件域唯一入口 ``attach_primary_pdf``, 所以既不会产生
第二次网络下载, 也绕不过「已有可用主附件就不许再挂」的不变式。这里读托管字节不再
经过回合内授权机: 调用方是用户在产品界面上的显式加入动作, 而不是模型的一次工具调用,
授权在当初下载那一步已经发生过并留了账。
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import Field

from service.literature.domain.delivery import FULLTEXT_BINDING_INTEGRITY_FAILED, PDF_SUFFIX
from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.persistence.delivery import DeliveryStore
from service.literature.persistence.files import (
    SERVICE_LITERATURE_FILES_DIR,
    is_available_attachment,
    payload_revision,
    read_attachment,
    read_scoped_file,
    scoped_files,
    scoped_modified,
    scoped_parent,
    scoped_relative,
)
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.attachment import (
    AttachedFulltext,
    AttachmentConflictError,
    AttachmentFormatError,
    LiteratureAttachmentContent,
    attach_primary_pdf,
    has_usable_primary,
)
from service.literature.service.result import (
    DOWNLOAD_MANIFEST_FILE,
    DOWNLOADED_STATUS,
    MANAGED_STORAGE,
    PRECISE_RUN_COLLECTION,
    PRECISE_RUN_ROOT,
    SEARCH_FILE_BYTES,
    SEARCH_SHORT,
    SEARCH_STATE_FILE,
    SEARCH_STATUS_PAPERS,
    SearchRecord,
)

HELD_MANAGED: Literal["managed"] = "managed"
HELD_RUN: Literal["run"] = "run"
HeldStorage = Literal["managed", "run"]

HELD_MISSING = "held_fulltext_missing"
HELD_PRESENT = "held_fulltext_present"
HELD_UNREADABLE = "held_fulltext_unreadable"
HELD_ITEM_MISSING = "held_literature_missing"
HELD_UNSUPPORTED = "literature_holdings_unsupported"

#: A run directory name is one path segment; anything else is not a run this product made.
RUN_ID = re.compile(r"[A-Za-z0-9._-]+")
#: The run package may sit at the workdir root or inside a session output directory.
RUN_SEARCH_PREFIXES: tuple[tuple[str, ...], ...] = ((), ("*",), ("*", "*"))
RUN_STATE_FIELDS = (PRECISE_RUN_ROOT, PRECISE_RUN_COLLECTION)

logger = logging.getLogger(__name__)


class HeldPaper(SearchRecord):
    id: str = Field(min_length=1, max_length=SEARCH_SHORT)


class HoldingsRequest(SearchRecord):
    papers: list[HeldPaper] = Field(max_length=SEARCH_STATUS_PAPERS)


class HeldAttachmentPaper(SearchRecord):
    literature_id: str = Field(min_length=1, max_length=SEARCH_SHORT)
    paper_id: str = Field(min_length=1, max_length=SEARCH_SHORT)


class HeldAttachmentRequest(SearchRecord):
    papers: list[HeldAttachmentPaper] = Field(max_length=SEARCH_STATUS_PAPERS)


@dataclass(frozen=True)
class HeldFulltext:
    """One paper's already-downloaded PDF and where serve can read its bytes."""

    paper_id: str
    storage: HeldStorage
    name: str
    revision: str = ""
    object_name: str = ""
    path: str = ""


@dataclass(frozen=True)
class HeldAdmission:
    """What one library item ended up with when its held bytes were admitted."""

    paper_id: str
    literature_id: str
    storage: str
    attached: bool
    fulltext: bool
    code: str

    def payload(self) -> dict[str, Any]:
        return {
            "paper_id": self.paper_id,
            "literature_id": self.literature_id,
            "storage": self.storage,
            "attached": self.attached,
            "fulltext": self.fulltext,
            "code": self.code,
        }


def attachment_name(identifier: str, paper_id: str) -> str:
    """Display name for an admitted PDF; the identifier leg mirrors the download route."""
    stem = (identifier or paper_id).strip().replace("/", "_") or paper_id
    return f"{stem}{PDF_SUFFIX}"


def precise_run(workdir: str | Path, run_id: str) -> str:
    """Locate one run package inside a session workdir; ``""`` when it is not there."""
    if not RUN_ID.fullmatch(run_id or ""):
        return ""
    tail = (*RUN_STATE_FIELDS, run_id, SEARCH_STATE_FILE)
    patterns = tuple("/".join(prefix + tail) for prefix in RUN_SEARCH_PREFIXES)
    for relative, _modified in scoped_files(workdir, patterns):
        try:
            state = json.loads(read_scoped_file(workdir, relative, SEARCH_FILE_BYTES))
        except (OSError, ValueError):
            continue
        if isinstance(state, dict) and str(state.get("run_id") or "") == run_id:
            return scoped_parent(relative)
    return ""


def _managed_holdings(session_id: str, requested: Sequence[str]) -> dict[str, HeldFulltext]:
    """Bytes serve acquired through the bridge for this session and still holds."""
    store = DeliveryStore()
    held: dict[str, HeldFulltext] = {}
    for batch in store.session_batches(session_id):
        papers = batch.get("papers") if isinstance(batch, dict) else None
        if not isinstance(papers, list):
            continue
        for paper in papers:
            if not isinstance(paper, dict):
                continue
            for source in store.sources(paper):
                paper_id = str(source.get("paper_id") or "")
                object_name = str(source.get("object_name") or "")
                revision = str(source.get("revision") or "")
                if paper_id not in requested or paper_id in held:
                    continue
                if not object_name or not revision:
                    continue
                if not is_available_attachment(str(SERVICE_LITERATURE_FILES_DIR / object_name)):
                    continue
                held[paper_id] = HeldFulltext(
                    paper_id=paper_id,
                    storage=HELD_MANAGED,
                    name=attachment_name(str(source.get("identifier") or ""), paper_id),
                    revision=revision,
                    object_name=object_name,
                )
    return held


def _run_holdings(workdir: str | Path, run: str) -> dict[str, HeldFulltext]:
    """PDFs the skill downloaded itself into this run, verified as real files."""
    try:
        manifest = json.loads(
            read_scoped_file(
                workdir, scoped_relative(run, DOWNLOAD_MANIFEST_FILE), SEARCH_FILE_BYTES
            )
        )
    except (OSError, ValueError):
        return {}
    papers = manifest.get("papers") if isinstance(manifest, dict) else None
    if not isinstance(papers, list):
        return {}
    held: dict[str, HeldFulltext] = {}
    for entry in papers:
        if not isinstance(entry, dict) or entry.get("status") != DOWNLOADED_STATUS:
            continue
        # Managed entries are resolved from serve's own ledger, never from this file.
        if entry.get("storage") == MANAGED_STORAGE:
            continue
        paper_id = str(entry.get("paper_id") or "")
        file_path = entry.get("file_path")
        if not paper_id or paper_id in held or not isinstance(file_path, str) or not file_path:
            continue
        try:
            relative = scoped_relative(run, file_path)
        except ValueError:
            continue
        if scoped_modified(workdir, relative, regular=True) is None:
            continue
        held[paper_id] = HeldFulltext(
            paper_id=paper_id,
            storage=HELD_RUN,
            name=PurePosixPath(relative).name,
            path=relative,
        )
    return held


def session_holdings(
    workdir: str | Path, session_id: str, run_id: str, paper_ids: Sequence[str]
) -> dict[str, HeldFulltext]:
    """Which of these papers already have reusable PDF bytes, and where they live."""
    requested = tuple(
        dict.fromkeys(str(paper_id) for paper_id in paper_ids if str(paper_id).strip())
    )
    if not requested:
        return {}
    held = _managed_holdings(session_id, requested)
    run = precise_run(workdir, run_id)
    if run:
        for paper_id, entry in _run_holdings(workdir, run).items():
            if paper_id in requested and paper_id not in held:
                held[paper_id] = entry
    return held


def held_payload(holding: HeldFulltext, workdir: str | Path) -> bytes:
    """The exact bytes serve vouches for; managed bytes must still match their revision."""
    if holding.storage == HELD_MANAGED:
        payload = read_attachment(str(SERVICE_LITERATURE_FILES_DIR / holding.object_name))
        if payload_revision(payload) != holding.revision:
            raise ValueError(f"{FULLTEXT_BINDING_INTEGRITY_FAILED}: {holding.paper_id}")
        return payload
    return read_scoped_file(workdir, holding.path, MAX_IMPORT_BYTES)


def attach_held(
    item: LiteratureItem,
    holding: HeldFulltext,
    workdir: str | Path,
    *,
    repository: LiteratureRepository | None = None,
    pdf_indexes: Any = None,
) -> AttachedFulltext:
    """Admit already-downloaded bytes as this item's primary attachment; no network."""
    attached = attach_primary_pdf(
        item,
        holding.name,
        held_payload(holding, workdir),
        repository=repository,
        pdf_indexes=pdf_indexes,
    )
    LiteratureAttachmentContent(repository).prewarm(
        pdf_indexes, attached.item.id, attached.attachment["id"]
    )
    return attached


def admit_held_fulltexts(
    workdir: str | Path,
    session_id: str,
    run_id: str,
    entries: Sequence[HeldAttachmentPaper],
    *,
    repository: LiteratureRepository | None = None,
    pdf_indexes: Any = None,
) -> tuple[HeldAdmission, ...]:
    """Attach every selected paper's held PDF; a paper without bytes stays metadata-only."""
    store = repository or LiteratureRepository()
    held = session_holdings(workdir, session_id, run_id, [entry.paper_id for entry in entries])
    outcomes: list[HeldAdmission] = []
    for entry in entries:
        paper_id = entry.paper_id
        holding = held.get(paper_id)
        if holding is None:
            outcomes.append(
                HeldAdmission(paper_id, entry.literature_id, "", False, False, HELD_MISSING)
            )
            continue
        item = store.get(entry.literature_id)
        if item is None:
            outcomes.append(
                HeldAdmission(
                    paper_id, entry.literature_id, holding.storage, False, False, HELD_ITEM_MISSING
                )
            )
            continue
        if has_usable_primary(item.id, store):
            outcomes.append(
                HeldAdmission(
                    paper_id, entry.literature_id, holding.storage, False, True, HELD_PRESENT
                )
            )
            continue
        try:
            attach_held(item, holding, workdir, repository=store, pdf_indexes=pdf_indexes)
        except AttachmentConflictError:
            outcomes.append(
                HeldAdmission(
                    paper_id, entry.literature_id, holding.storage, False, True, HELD_PRESENT
                )
            )
        except (AttachmentFormatError, ValueError, OSError) as error:
            code = getattr(error, "code", "") or HELD_UNREADABLE
            logger.warning(
                "literature_held_fulltext_unreadable session_id=%s paper_id=%s storage=%s code=%s",
                session_id,
                paper_id,
                holding.storage,
                code,
            )
            outcomes.append(
                HeldAdmission(
                    paper_id, entry.literature_id, holding.storage, False, False, str(code)
                )
            )
        else:
            outcomes.append(
                HeldAdmission(paper_id, entry.literature_id, holding.storage, True, True, "")
            )
    return tuple(outcomes)


__all__ = [
    "HELD_ITEM_MISSING",
    "HELD_MANAGED",
    "HELD_MISSING",
    "HELD_PRESENT",
    "HELD_RUN",
    "HELD_UNREADABLE",
    "HELD_UNSUPPORTED",
    "HeldAdmission",
    "HeldAttachmentPaper",
    "HeldAttachmentRequest",
    "HeldFulltext",
    "HeldPaper",
    "HoldingsRequest",
    "admit_held_fulltexts",
    "attach_held",
    "held_payload",
    "precise_run",
    "session_holdings",
]
