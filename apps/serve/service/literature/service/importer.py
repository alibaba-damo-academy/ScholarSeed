"""Literature admission: parse a complete batch before materializing exact bytes."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, replace
from hashlib import sha256
from uuid import uuid4

from service.content.domain.model import ContentError
from service.literature.domain.model import (
    IMPORT_CONFLICT,
    MAX_BATCH_RECORDS,
    MAX_IMPORT_BYTES,
)
from service.literature.persistence.imports import ImportReceipt, LiteratureImports
from service.literature.schema import (
    UNFILED_COLLECTION,
    FulltextStatus,
    ImportSource,
    LiteratureItem,
)
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata
from service.literature.service.metadata import (
    ParsedRecord,
    parse_bibtex,
    parse_ris,
    to_item,
)
from service.platform.content import ContentPort, ImportSourceContent
from service.platform.pdf import PdfDocumentError, PdfPasswordError, pdf_document_info

#: BibTeX 文件扩展名。
BIB_SUFFIXES = frozenset({".bib", ".bibtex"})

#: RIS 文件扩展名。
RIS_SUFFIXES = frozenset({".ris"})

#: PDF 扩展名。
PDF_SUFFIXES = frozenset({".pdf"})

MAX_BIBLIOGRAPHY_BYTES = 2 * 1024 * 1024
PDF_FILETYPE = "pdf"
INVALID_PDF = "invalid_pdf"
ENCRYPTED_PDF = "encrypted_pdf"
TOO_MANY_RECORDS = "too_many_records"


class LiteratureImportError(Exception):
    """导入失败。`code` 作为 HTTP detail 回给前端。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ImportOutcome:
    """一次导入的结果。"""

    items: tuple[LiteratureItem, ...]
    #: 解析出但缺标题、被丢弃的条数, 显式回报而不是静默吞掉。
    skipped: int = 0


def _suffix(name: str) -> str:
    """文件名 → 小写扩展名。用字符串取而不用 `Path`: 本域不碰路径对象。"""

    _, _, tail = name.rpartition(".")
    return f".{tail.lower()}" if tail and tail != name else ""


@dataclass(frozen=True)
class LiteratureParser:
    parse: Callable[[bytes, str], tuple[ParsedRecord, ...]]
    fulltext: FulltextStatus


def _text(raw: bytes) -> str:
    if len(raw) > MAX_BIBLIOGRAPHY_BYTES:
        raise LiteratureImportError("file_too_large")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise LiteratureImportError("not_text_file") from error


def _bib(raw: bytes, name: str) -> tuple[ParsedRecord, ...]:
    try:
        return parse_bibtex(_text(raw))
    except ValueError as error:
        raise LiteratureImportError("invalid_bibtex") from error


def _ris(raw: bytes, name: str) -> tuple[ParsedRecord, ...]:
    try:
        return parse_ris(_text(raw))
    except ValueError as error:
        raise LiteratureImportError("invalid_ris") from error


def _pdf(raw: bytes, name: str) -> tuple[ParsedRecord, ...]:
    try:
        if pdf_document_info(raw).page_count < 1:
            raise LiteratureImportError(INVALID_PDF)
    except PdfPasswordError as error:
        raise LiteratureImportError(ENCRYPTED_PDF) from error
    except PdfDocumentError as error:
        raise LiteratureImportError(INVALID_PDF) from error
    try:
        metadata = extract_pdf_metadata(raw)
    except InvalidPdfError as error:
        raise LiteratureImportError(INVALID_PDF) from error
    return (
        ParsedRecord(
            title=metadata.title or name[: -len(_suffix(name))],
            authors=metadata.author,
            arxiv=metadata.arxiv,
            doi=metadata.doi,
        ),
    )


PARSERS = {
    **{suffix: LiteratureParser(_bib, FulltextStatus.NONE) for suffix in BIB_SUFFIXES},
    **{suffix: LiteratureParser(_ris, FulltextStatus.NONE) for suffix in RIS_SUFFIXES},
    **{suffix: LiteratureParser(_pdf, FulltextStatus.READY) for suffix in PDF_SUFFIXES},
}


def parse_import(name: str, payload: bytes) -> ImportOutcome:
    """Parse one file without turning embedded keywords into library organization."""
    parser = PARSERS.get(_suffix(name))
    if parser is None:
        raise LiteratureImportError("unsupported_format")
    records = parser.parse(payload, name)
    if len(records) > MAX_BATCH_RECORDS:
        raise LiteratureImportError(TOO_MANY_RECORDS)
    items_list: list[LiteratureItem] = []
    for record in records:
        if not record.title.strip():
            continue
        item = replace(
            to_item(record, fulltext=parser.fulltext),
            tags=(),
            collection="",
            collections=(),
        )
        items_list.append(item)
    items = tuple(items_list)
    if not items:
        raise LiteratureImportError("no_records_parsed")
    return ImportOutcome(items, len(records) - len(items))


@dataclass(frozen=True)
class LiteratureImportPlan:
    operation_id: str
    fingerprint: str
    name: str
    sha256: str
    outcome: ImportOutcome
    collection_id: str = ""


def plan_artifact_import(
    source_key: str,
    name: str,
    payload: bytes,
    operation_id: str | None = None,
    collection: str = "",
    collection_id: str = "",
) -> LiteratureImportPlan:
    """Bind an explicit artifact version and filename, without filesystem writes.

    ``operation_id`` scopes one durable import attempt, not one document: when the
    caller supplies an idempotency key, a retried attempt resumes the same receipt;
    otherwise every call is a fresh attempt that appends new literature rows. The
    fingerprint stays a content digest for link recovery and must not double as the
    operation key, or re-importing an unchanged file would silently replay the old
    receipt instead of adding the literature the user just asked for (proposal 91).
    """
    if len(payload) > MAX_IMPORT_BYTES:
        raise LiteratureImportError("import_too_large")
    digest = sha256(payload).hexdigest()
    collection = collection.strip()
    if collection == UNFILED_COLLECTION:
        collection = ""
    if collection and collection_id:
        raise LiteratureImportError(IMPORT_CONFLICT)
    identity: list[str | dict[str, str]] = [source_key, name, digest]
    if collection:
        identity.append(collection)
    if collection_id:
        identity.append({"collection_id": collection_id})
    fingerprint = sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()
    outcome = parse_import(name, payload)
    return LiteratureImportPlan(
        operation_id or uuid4().hex,
        fingerprint,
        name,
        digest,
        replace(
            outcome, items=tuple(replace(item, collection=collection) for item in outcome.items)
        ),
        collection_id,
    )


def import_from_bytes(
    content: ContentPort,
    project_id: str,
    plan: LiteratureImportPlan,
    name: str,
    payload: bytes,
) -> ImportReceipt:
    """Import a verified publication through the same durable owner as local files."""
    imports = LiteratureImports(content)
    if name != plan.name or sha256(payload).hexdigest() != plan.sha256:
        raise LiteratureImportError(IMPORT_CONFLICT)
    try:
        restored = imports.resume(project_id, plan.operation_id, plan.fingerprint)
        if restored is not None:
            return restored
        if len(payload) > MAX_IMPORT_BYTES:
            raise LiteratureImportError("import_too_large")
        outcome = plan.outcome
        imports.reserve(
            project_id,
            plan.operation_id,
            plan.fingerprint,
            ((ImportSourceContent(name, payload, "application/octet-stream"), outcome.items),),
            outcome.skipped,
            collection_id=plan.collection_id,
        )
        return imports.finish(project_id, plan.operation_id, plan.fingerprint)
    except ContentError as error:
        raise LiteratureImportError(error.code) from error


def import_from_paths(
    content: ContentPort,
    project_id: str,
    sources: tuple[str, ...],
    origin: ImportSource,
    operation_id: str | None = None,
) -> ImportReceipt:
    """从本机路径导入文献。

    覆盖 PRD 的三条 P0 通道:
    - `LOCAL_FILE`: 用户上传本地 PDF 或 BIB/RIS 导出文件;
    - `RESOURCE_MARK`: 资料库里已有的文件标记为文献, 与本地导入同一套抽取;
    - `IDENTIFIER` / `ZOTERO_DIR`: 本期未实现, 显式拒绝。
    """

    if origin in {ImportSource.ZOTERO_DIR, ImportSource.IDENTIFIER}:
        raise LiteratureImportError("unsupported_source")

    if not sources:
        raise LiteratureImportError("sources_required")
    if len(sources) > MAX_BATCH_RECORDS:
        raise LiteratureImportError(TOO_MANY_RECORDS)

    imports = LiteratureImports(content)
    fingerprint = sha256(
        json.dumps([origin.value, sources], ensure_ascii=False).encode()
    ).hexdigest()
    if operation_id is not None:
        if not isinstance(operation_id, str) or not operation_id.strip():
            raise LiteratureImportError("invalid_operation_id")
        try:
            restored = imports.resume(project_id, operation_id, fingerprint)
        except ContentError as error:
            raise LiteratureImportError(error.code) from error
        if restored is not None:
            return restored

    try:
        admitted = []
        total_bytes = 0
        total_records = 0
        for path in sources:
            source = content.read_import_source(project_id, path)
            total_bytes += len(source.content)
            if total_bytes > MAX_IMPORT_BYTES:
                raise LiteratureImportError("import_too_large")
            outcome = parse_import(source.name, source.content)
            total_records += len(outcome.items) + outcome.skipped
            if total_records > MAX_BATCH_RECORDS:
                raise LiteratureImportError(TOO_MANY_RECORDS)
            admitted.append((source, outcome))
        if operation_id is None:
            operation_id = uuid4().hex
        imports.reserve(
            project_id,
            operation_id,
            fingerprint,
            tuple((source, outcome.items) for source, outcome in admitted),
            sum(outcome.skipped for _, outcome in admitted),
        )
        return imports.finish(project_id, operation_id, fingerprint)
    except ContentError as error:
        raise LiteratureImportError(error.code) from error


__all__ = [
    "BIB_SUFFIXES",
    "PDF_SUFFIXES",
    "RIS_SUFFIXES",
    "ImportOutcome",
    "LiteratureImportError",
    "import_from_paths",
    "parse_import",
]
