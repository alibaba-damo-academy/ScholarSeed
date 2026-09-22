"""Import a personal library from Zotero Desktop's loopback Local API."""

from __future__ import annotations

import json
import os
import re
import stat
from collections.abc import Callable
from dataclasses import dataclass, replace
from hashlib import sha256
from pathlib import PurePath
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, url2pathname, urlopen

from service.literature.persistence.files import LiteratureFileBatch, managed_object
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import (
    AttachmentFile,
    FulltextStatus,
    LiteratureItem,
    PublicationType,
)
from service.literature.service.metadata import ParsedRecord, to_item
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.pdf import PdfDocumentError, pdf_document_info
from service.platform.storage import NOFOLLOW, NONBLOCK, open_parent

ZOTERO_ORIGIN = "http://127.0.0.1:23119"
ZOTERO_API_ROOT = f"{ZOTERO_ORIGIN}/api/users/0"
ZOTERO_API_VERSION = "3"
ZOTERO_VERSION_HEADER = "Zotero-API-Version"
ZOTERO_TOTAL_HEADER = "Total-Results"
ZOTERO_LOCAL_API_DISABLED_TEXT = b"Local API is not enabled"
ZOTERO_FILE_SCHEME = "file"
ZOTERO_FILE_HOSTS = {None, "", "localhost"}
ZOTERO_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
ZOTERO_PAGE_SIZE = 100
ZOTERO_TIMEOUT_SECONDS = 15
ZOTERO_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
ZOTERO_MAX_PDF_BYTES = 512 * 1024 * 1024
PDF_CONTENT_TYPE = "application/pdf"
PDF_SUFFIX = ".pdf"
PDF_FILETYPE = "pdf"
UNTITLED = "未命名条目"
LIBRARY_KEY = "__library__"
ZOTERO_LIBRARY_KEY = LIBRARY_KEY
INVALID_FILENAME = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._ -]+")
YEAR_PATTERN = re.compile(r"(19|20)\d{2}")
ITEM_TYPE_MAP = {
    "journalArticle": PublicationType.ARTICLE,
    "book": PublicationType.BOOK,
    "bookSection": PublicationType.INCOLLECTION,
    "conferencePaper": PublicationType.INPROCEEDINGS,
    "thesis": PublicationType.PHDTHESIS,
    "report": PublicationType.TECHREPORT,
    "manuscript": PublicationType.UNPUBLISHED,
}


class ZoteroImportError(Exception):
    """Stable failure raised by the Zotero Desktop integration."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ZoteroPreview:
    items: int
    pdfs: int
    collections: int
    library: dict[str, Any]
    unfiled: dict[str, int]
    revision: str


@dataclass(frozen=True)
class ZoteroImportResult:
    items: tuple[LiteratureItem, ...]
    pdfs: int
    collections: int = 0


def _request(path: str, query: dict[str, str | int] | None = None) -> Request:
    suffix = f"?{urlencode(query)}" if query else ""
    return Request(
        f"{ZOTERO_API_ROOT}/{path}{suffix}",
        headers={ZOTERO_VERSION_HEADER: ZOTERO_API_VERSION},
    )


def _read(request: Request, limit: int) -> tuple[bytes, Any]:
    try:
        with urlopen(request, timeout=ZOTERO_TIMEOUT_SECONDS) as response:
            payload = response.read(limit + 1)
            if len(payload) > limit:
                raise ZoteroImportError("ZOTERO_RESPONSE_TOO_LARGE")
            return payload, response.headers
    except ZoteroImportError:
        raise
    except HTTPError as error:
        location = error.headers.get("Location", "")
        if error.code in ZOTERO_REDIRECT_STATUSES and location:
            return _read_local_redirect(location, limit), error.headers
        if error.code == 403 and ZOTERO_LOCAL_API_DISABLED_TEXT in error.read(
            ZOTERO_MAX_RESPONSE_BYTES
        ):
            raise ZoteroImportError("ZOTERO_LOCAL_API_DISABLED") from error
        raise ZoteroImportError("ZOTERO_API_ERROR") from error
    except (TimeoutError, URLError) as error:
        raise ZoteroImportError("ZOTERO_UNAVAILABLE") from error


def _read_local_redirect(location: str, limit: int) -> bytes:
    """Read the file redirect emitted by Zotero's loopback attachment endpoint."""

    parsed = urlparse(location)
    if parsed.scheme != ZOTERO_FILE_SCHEME or parsed.hostname not in ZOTERO_FILE_HOSTS:
        raise ZoteroImportError("ZOTERO_API_ERROR")
    path = url2pathname(parsed.path)
    descriptor = -1
    directory = None
    try:
        directory, name = open_parent(path)
        descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ZoteroImportError("ZOTERO_INVALID_PDF")
        if metadata.st_size > limit:
            raise ZoteroImportError("ZOTERO_RESPONSE_TOO_LARGE")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            payload = handle.read(limit + 1)
        if len(payload) > limit:
            raise ZoteroImportError("ZOTERO_RESPONSE_TOO_LARGE")
        return payload
    except ZoteroImportError:
        raise
    except OSError as error:
        raise ZoteroImportError("ZOTERO_INVALID_PDF") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if directory is not None:
            directory.close()


def _json_page(path: str, start: int) -> tuple[list[dict[str, Any]], int]:
    payload, headers = _read(
        _request(path, {"format": "json", "limit": ZOTERO_PAGE_SIZE, "start": start}),
        ZOTERO_MAX_RESPONSE_BYTES,
    )
    try:
        decoded = json.loads(payload)
        if not isinstance(decoded, list) or any(not isinstance(item, dict) for item in decoded):
            raise ValueError("invalid Zotero response")
        total = int(headers.get(ZOTERO_TOTAL_HEADER, len(decoded)))
    except (UnicodeDecodeError, ValueError, TypeError) as error:
        raise ZoteroImportError("ZOTERO_INVALID_RESPONSE") from error
    return decoded, total


def _all(path: str) -> tuple[dict[str, Any], ...]:
    rows: list[dict[str, Any]] = []
    start = 0
    while True:
        page, total = _json_page(path, start)
        rows.extend(page)
        start += len(page)
        if not page or start >= total:
            return tuple(rows)


def _data(row: dict[str, Any]) -> dict[str, Any]:
    value = row.get("data")
    if not isinstance(value, dict):
        raise ZoteroImportError("ZOTERO_INVALID_RESPONSE")
    return value


def _creators(data: dict[str, Any]) -> str:
    creators = data.get("creators", ())
    if not isinstance(creators, list):
        return ""
    names: list[str] = []
    for creator in creators:
        if not isinstance(creator, dict):
            continue
        name = str(creator.get("name") or "").strip()
        if not name:
            name = " ".join(
                part
                for part in (
                    str(creator.get("firstName") or "").strip(),
                    str(creator.get("lastName") or "").strip(),
                )
                if part
            )
        if name:
            names.append(name)
    return ", ".join(names)


def _year(value: object) -> int | None:
    match = YEAR_PATTERN.search(str(value or ""))
    return int(match.group(0)) if match else None


def _collections(rows: tuple[dict[str, Any], ...]) -> dict[str, tuple[str, str | None]]:
    result: dict[str, tuple[str, str | None]] = {}
    for row in rows:
        data = _data(row)
        key = str(data.get("key") or row.get("key") or "").strip()
        name = str(data.get("name") or "").strip()
        if key and name:
            parent = str(data.get("parentCollection") or "").strip() or None
            result[key] = (name, parent)
    return result


def _item(data: dict[str, Any], collections: dict[str, tuple[str, str | None]]) -> LiteratureItem:
    title = str(data.get("title") or "").strip() or UNTITLED
    parsed = ParsedRecord(
        title=title,
        authors=_creators(data),
        journal=str(
            data.get("publicationTitle")
            or data.get("bookTitle")
            or data.get("proceedingsTitle")
            or ""
        ).strip(),
        year=_year(data.get("date")),
        doi=str(data.get("DOI") or "").strip(),
        abstract=str(data.get("abstractNote") or "").strip(),
        keywords=(),
    )
    result = to_item(parsed, fulltext=FulltextStatus.NONE)
    collection_names = tuple(
        collections[key][0]
        for key in data.get("collections", ())
        if isinstance(key, str) and key in collections
    )
    return replace(
        result,
        item_type=str(data.get("itemType") or "document"),
        pubtype=ITEM_TYPE_MAP.get(str(data.get("itemType") or ""), PublicationType.MISC),
        url=str(data.get("url") or "").strip(),
        volume=str(data.get("volume") or "").strip(),
        number=str(data.get("issue") or "").strip(),
        pages=str(data.get("pages") or "").strip(),
        publisher=str(data.get("publisher") or "").strip(),
        collections=collection_names,
        collection=collection_names[0] if collection_names else "",
    )


def _pdf_attachments(rows: tuple[dict[str, Any], ...]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        data = _data(row)
        if (
            data.get("itemType") == "attachment"
            and data.get("contentType") == PDF_CONTENT_TYPE
            and isinstance(data.get("parentItem"), str)
        ):
            result.setdefault(str(data["parentItem"]), data)
    return result


def _tree(
    collections: dict[str, tuple[str, str | None]], rows: tuple[dict[str, Any], ...]
) -> tuple[tuple[dict[str, Any], ...], int]:
    direct: dict[str, set[str]] = {key: set() for key in collections}
    unfiled = 0
    for row in rows:
        data = _data(row)
        if data.get("itemType") in {"attachment", "note", "annotation"}:
            continue
        key = str(data.get("key") or row.get("key") or "")
        assigned = [value for value in data.get("collections", ()) if value in collections]
        if not assigned:
            unfiled += 1
        for collection_key in assigned:
            direct[collection_key].add(key)
    children: dict[str | None, list[str]] = {}
    for key, (_name, parent) in collections.items():
        if parent is not None and parent not in collections:
            raise ZoteroImportError("ZOTERO_INVALID_RESPONSE")
        children.setdefault(parent, []).append(key)
    visiting: set[str] = set()

    def node(key: str) -> tuple[dict[str, Any], set[str]]:
        if key in visiting:
            raise ZoteroImportError("ZOTERO_INVALID_RESPONSE")
        visiting.add(key)
        descendants = set(direct[key])
        child_nodes = []
        for child in sorted(
            children.get(key, ()), key=lambda value: (collections[value][0], value)
        ):
            child_node, child_items = node(child)
            child_nodes.append(child_node)
            descendants.update(child_items)
        visiting.remove(key)
        return (
            {
                "key": key,
                "name": collections[key][0],
                "parent_key": collections[key][1],
                "direct_item_count": len(direct[key]),
                "subtree_item_count": len(descendants),
                "children": child_nodes,
            },
            descendants,
        )

    roots = tuple(
        node(key)[0]
        for key in sorted(children.get(None, ()), key=lambda value: (collections[value][0], value))
    )
    if sum(1 for _key in collections) != sum_nodes(roots):
        raise ZoteroImportError("ZOTERO_INVALID_RESPONSE")
    return roots, unfiled


def sum_nodes(nodes: tuple[dict[str, Any], ...] | list[dict[str, Any]]) -> int:
    return sum(1 + sum_nodes(node["children"]) for node in nodes)


def _revision(rows: tuple[dict[str, Any], ...], collection_rows: tuple[dict[str, Any], ...]) -> str:
    return sha256(
        json.dumps((rows, collection_rows), sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:16]


def preview_zotero() -> ZoteroPreview:
    rows = _all("items")
    collection_rows = _all("collections")
    collections = _collections(collection_rows)
    tree, unfiled = _tree(collections, rows)
    item_count = sum(
        1 for row in rows if _data(row).get("itemType") not in {"attachment", "note", "annotation"}
    )
    return ZoteroPreview(
        items=item_count,
        pdfs=len(_pdf_attachments(rows)),
        collections=len(collections),
        library={
            "key": LIBRARY_KEY,
            "name": "My Library",
            "direct_item_count": unfiled,
            "subtree_item_count": item_count,
            "children": tree,
        },
        unfiled={"count": unfiled},
        revision=_revision(rows, collection_rows),
    )


def _filename(data: dict[str, Any], item: LiteratureItem) -> str:
    """Build the attachment's display name.

    落盘名由 ``managed_object`` 负责, 带 id / md5 / uuid, 用户永远看不到它; 这里
    只产出附件列表里给人读的那个名字, 因此不再往前面拼一串 id —— 那看起来就像
    一个哈希, 正是"命名是一个 hash 值"这个抱怨的来源。
    """
    raw = str(data.get("filename") or f"{item.title}{PDF_SUFFIX}")
    stem = INVALID_FILENAME.sub("_", PurePath(raw).stem).strip(" ._") or item.id
    return f"{stem}{PDF_SUFFIX}"


def _download_pdf(key: str) -> bytes:
    payload, _ = _read(_request(f"items/{key}/file"), ZOTERO_MAX_PDF_BYTES)
    try:
        if pdf_document_info(payload).page_count < 1:
            raise ZoteroImportError("ZOTERO_INVALID_PDF")
    except PdfDocumentError as error:
        raise ZoteroImportError("ZOTERO_INVALID_PDF") from error
    return payload


def import_zotero(
    progress: Callable[[int, int], None] | None = None,
    *,
    project_id: str = "",
    target_collection_id: str = "",
    selected_collection_keys: tuple[str, ...] | None = None,
    selection: tuple[tuple[str, bool], ...] = (),
    include_unfiled: bool = True,
    import_collections: bool = True,
    preview_revision: str = "",
) -> ZoteroImportResult:
    """Import the selected Zotero scope into the caller's current landing point.

    ``target_collection_id`` 是用户当前正看着的分类: 导入的 Zotero 分类树挂在它
    下面, 没被任何 Zotero 分类收下的条目直接落进它。空串表示落在作用域根部,
    与引入落点之前的行为一致。
    """

    rows = _all("items")
    collection_rows = _all("collections")
    if preview_revision and preview_revision != _revision(rows, collection_rows):
        raise ZoteroImportError("ZOTERO_LIBRARY_CHANGED")
    collection_names = _collections(collection_rows)
    selected = set(
        collection_names if selected_collection_keys is None else selected_collection_keys
    )
    if selection:
        directives = dict(selection)
        library_selected = directives.pop(LIBRARY_KEY, False)
        if set(directives) - collection_names.keys():
            raise ZoteroImportError("ZOTERO_INVALID_SELECTION")
        selected.clear()

        def select(key: str, inherited: bool) -> None:
            current = directives.get(key, inherited)
            if current:
                selected.add(key)
            for child, (_name, parent) in collection_names.items():
                if parent == key:
                    select(child, current)

        for key, (_name, parent) in collection_names.items():
            if parent is None:
                select(key, library_selected)
    if selected - collection_names.keys():
        raise ZoteroImportError("ZOTERO_INVALID_SELECTION")
    attachments = _pdf_attachments(rows)
    source_items: list[tuple[str, LiteratureItem]] = []
    for row in rows:
        data = _data(row)
        if data.get("itemType") in {"attachment", "note", "annotation"}:
            continue
        key = str(data.get("key") or row.get("key") or "")
        memberships = tuple(
            value
            for value in data.get("collections", ())
            if isinstance(value, str) and value in collection_names
        )
        admitted_by_selection = bool(selected.intersection(memberships)) or (
            include_unfiled and not memberships
        )
        if key and admitted_by_selection:
            item = _item(data, collection_names)
            source_items.append((key, item))
    if not source_items:
        raise ZoteroImportError("ZOTERO_LIBRARY_EMPTY")

    total = len(source_items)
    copied = 0
    admitted: list[LiteratureItem] = []
    admitted_attachments: list[AttachmentFile] = []
    item_memberships: list[tuple[str, str]] = []
    with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
        for index, (key, item) in enumerate(source_items, start=1):
            attachment = attachments.get(key)
            if attachment is not None:
                attachment_key = str(attachment.get("key") or "")
                if attachment_key:
                    try:
                        payload = _download_pdf(attachment_key)
                    except ZoteroImportError:
                        payload = b""
                    if payload:
                        # Zotero 的字节在这里被真正拷进文献库自己的托管目录, 而且
                        # 每条文献拷自己的一份: 落盘名带 item.id, 展示名留在附件行
                        # 里。于是删附件一定能连文件一起删, 同一份 PDF 被两条文献
                        # 导入也互不牵连, 不需要任何跨条目的引用计数。
                        published = managed_object(item.id, payload, PDF_SUFFIX)
                        destination = batch.stage(published.name, payload)
                        admitted_attachments.append(
                            AttachmentFile(
                                literature_id=item.id,
                                path=str(destination),
                                name=_filename(attachment, item),
                                revision=published.revision,
                            )
                        )
                        copied += 1
            admitted.append(item)
            if import_collections:
                source_data = next(
                    _data(row)
                    for row in rows
                    if str(_data(row).get("key") or row.get("key") or "") == key
                )
                item_memberships.extend(
                    (collection_key, item.id)
                    for collection_key in source_data.get("collections", ())
                    if collection_key in selected
                )
            if progress is not None:
                progress(index, total)
        required = set(selected)
        if import_collections:
            for key in tuple(required):
                parent = collection_names[key][1]
                while parent is not None:
                    required.add(parent)
                    parent = collection_names[parent][1]
        ordered: list[tuple[str, str, str | None]] = []
        pending = set(required if import_collections else ())
        while pending:
            ready = sorted(key for key in pending if collection_names[key][1] not in pending)
            if not ready:
                raise ZoteroImportError("ZOTERO_INVALID_RESPONSE")
            for key in ready:
                name, parent = collection_names[key]
                ordered.append((key, name, parent))
                pending.remove(key)
        repository = LiteratureRepository()
        saved = batch.commit(
            tuple(admitted),
            lambda values: repository.save_external_tree(
                values,
                tuple(ordered),
                tuple(item_memberships),
                tuple(admitted_attachments),
                project_id=project_id,
                target_collection_id=target_collection_id,
            ),
        )
    return ZoteroImportResult(saved, copied, len(ordered))
