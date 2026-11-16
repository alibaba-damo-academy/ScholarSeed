"""Project bibliography projected to the search contract; no catalogue mutation."""

from __future__ import annotations

import asyncio
import re
import unicodedata
from collections import deque
from typing import Any

from service.literature.schema import LiteratureItem
from service.literature.service.bibliography import (
    ARXIV,
    DOI,
    NETWORK_FAILED,
    BibliographyError,
    fetch_bibliography,
)
from service.literature.service.identity import identity_chain
from service.literature.service.openalex import search_by_title

METADATA_CONCURRENCY = 4
METADATA_REQUEST_SECONDS = 10.0
METADATA_TOTAL_SECONDS = 30.0
METADATA_ATTEMPTS = 2
METADATA_RETRY_DELAY_SECONDS = 0.25
TITLE_QUERY = "title"
METADATA_IDENTITY_CONFLICT = "identity_conflict"
#: 行内标识符的读取口径 (维度, 字段名); 维度选择、身份比对与摘要备用链共用同一份。
ROW_IDENTIFIER_FIELDS = ((DOI, "doi"), (ARXIV, "arxiv_id"))
EMPTY_VALUES = {
    "",
    "n/a",
    "na",
    "none",
    "null",
    "unknown",
    "anonymous",
    "unknown author",
    "unknown authors",
    "no authors",
    "暂无作者",
    "未知",
    "佚名",
    "not available",
    "not found",
    "未找到信息",
    "无作者",
    "no author",
    "not provided",
}
ABSTRACT_PLACEHOLDERS = {
    "no abstract",
    "no abstract available",
    "abstract unavailable",
    "abstract not available",
    "无摘要",
    "暂无摘要",
}
PREVIEW_KINDS = {"local_pdf_excerpt", "saved_l1_excerpt"}
NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}
OPTIONAL_FIELDS = ("volume", "number", "pages", "publisher", "address", "isbn", "citation_key")
FIELD_ALIASES = {"arxiv": "arxiv_id", "publication": "venue", "published_date": "publication_date"}
COMPLETION_FIELDS = (
    "title",
    "authors",
    "year",
    "abstract",
    "doi",
    "arxiv_id",
    "venue",
    "url",
    "publication_date",
    *OPTIONAL_FIELDS,
)


def _text(value: object) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _present(value: object) -> bool:
    return bool(_text(value)) and _text(value).casefold().strip(". ") not in EMPTY_VALUES


def _name_groups(value: str, separators: str) -> list[str] | None:
    groups, start, depth = [], 0, 0
    for index, char in enumerate(value):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth < 0:
                return None
        elif char in separators and depth == 0:
            groups.append(value[start:index])
            start = index + 1
    if depth:
        return None
    groups.append(value[start:])
    return [_text(name) for name in groups if _present(name) and any(c.isalpha() for c in name)]


def structured_authors(value: str) -> list[str] | str:
    """Decode the library's comma display convention, retaining explicit person groups.

    Semicolons/newlines and braced organisations take precedence. A bare surname,
    given-name pair beginning with a single Latin token has no reliable display boundary;
    preserve it for the existing bibliography diagnostic instead of guessing.
    """
    if not _present(value):
        return []
    explicit = _name_groups(value, ";；\n")
    if explicit is None:
        return value
    if len(explicit) > 1:
        return explicit
    names = _name_groups(value, ",")
    if names is None:
        return value
    if any(name.casefold().strip(". ") in NAME_SUFFIXES for name in names):
        return value
    if len(names) == 2 and re.fullmatch(r"[A-Za-zÀ-ž.'’-]+", names[0]):
        return value
    return names


def _authors_metadata(authors: list[str] | str, display: str) -> dict:
    return {
        "raw": authors,
        "display": display,
        "format": "structured" if isinstance(authors, list) else "display_text",
        "source": "project_library",
        "encoding": "library_display/v1",
    }


def _aliases(row: dict) -> None:
    row["external_ids"] = {
        key: row[field] for key, field in (("DOI", "doi"), ("ArXiv", "arxiv_id")) if row.get(field)
    }
    for target, source in (
        ("journal_name", "venue"),
        ("journal_volume", "volume"),
        ("journal_pages", "pages"),
    ):
        if row.get(source):
            row[target] = row[source]


def candidate_metadata(item: LiteratureItem) -> dict:
    authors = structured_authors(item.authors)
    year = item.year
    if not _valid_year(year) and re.match(r"^[1-9]\d{3}(?:-|$)", item.published_date):
        year = int(item.published_date[:4])
    row = {
        "title": item.title,
        "authors": authors,
        "author_metadata": _authors_metadata(authors, item.authors),
        "year": year,
        "abstract": item.abstract,
        "doi": item.doi,
        "arxiv_id": item.arxiv,
        "venue": item.journal or item.venue,
        "url": item.url,
        "publication_date": item.published_date,
        "publication_types": [item.pubtype.value],
        "bib_type": item.pubtype.value,
    }
    row.update({field: getattr(item, field) for field in OPTIONAL_FIELDS if getattr(item, field)})
    _aliases(row)
    return row


def _valid_year(value: object) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool)) and 1000 <= value <= 9999


def _abstract(value: object) -> bool:
    return (
        _present(value)
        and _text(value).casefold().strip(". ") not in ABSTRACT_PLACEHOLDERS
        and any(char.isalpha() for char in _text(value))
        and not _text(value).endswith(("...", "…", "[truncated]", "[TRUNCATED]"))
    )


def missing_fields(row: dict) -> list[str]:
    missing = []
    if not _present(row.get("title")):
        missing.append("title")
    authors = row.get("authors")
    if not authors or (isinstance(authors, str) and not _present(authors)):
        missing.append("authors")
    if not _valid_year(row.get("year")):
        missing.append("year")
    preview = row.get("selection_evidence") or {}
    if not _abstract(row.get("abstract")) and preview.get("kind") not in PREVIEW_KINDS:
        missing.append("abstract")
    return missing


def _identity(value: object, kind: str) -> str:
    text = _text(value).casefold()
    if kind == DOI:
        return re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", text)
    return re.sub(r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:\s*)", "", text).removesuffix(".pdf")


def _title(value: object) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", _text(value)).casefold() if c.isalnum())


def _matches(row: dict, fields: dict, dimension: str) -> bool:
    for kind, field in ROW_IDENTIFIER_FIELDS:
        left, right = _identity(row.get(field), kind), _identity(fields.get(field), kind)
        if left and right and left != right:
            # An unspecified arXiv version may be completed; two explicit versions may not.
            if kind != ARXIV or re.sub(r"v\d+$", "", left) != re.sub(r"v\d+$", "", right):
                return False
            if re.search(r"v\d+$", left) and re.search(r"v\d+$", right):
                return False
    if dimension == TITLE_QUERY:
        return bool(
            _title(row.get("title")) == _title(fields.get("title"))
            and (
                not _valid_year(row.get("year"))
                or not _valid_year(fields.get("year"))
                or row["year"] == fields["year"]
            )
        )
    # The identifier endpoint is authoritative, but a conflicting nonempty title
    # must not silently enrich a different edition or a wrongly labelled record.
    return not _present(row.get("title")) or _title(row["title"]) == _title(fields.get("title"))


def row_alternates(row: dict, dimension: str) -> dict[str, str]:
    """同一篇论文的其他已知标识符, 作为摘要补充腿的备用来源。

    与维度选择同一口径: 先过 ``_present`` 滤掉 ``n/a`` 这类占位值, 再归一化。
    """

    return {
        kind: identity
        for kind, field in ROW_IDENTIFIER_FIELDS
        if kind != dimension
        and _present(row.get(field))
        and (identity := _identity(row.get(field), kind))
    }


async def complete_metadata(
    rows: list[dict], *, selected: bool = False, total_seconds: float = METADATA_TOTAL_SECONDS
) -> None:
    """Fill necessary gaps once per task snapshot, with bounded anonymous I/O.

    No model, database write, selection or ranking. Failed matches remain visible
    to the unchanged search eligibility rules. Cancellation propagates to clients.
    """
    pending = deque(row for row in rows if missing_fields(row))
    deadline = asyncio.get_running_loop().time() + min(total_seconds, METADATA_TOTAL_SECONDS)

    async def worker() -> None:
        while pending:
            row = pending.popleft()
            missing = missing_fields(row)
            state: dict[str, Any] = {
                "status": "unavailable",
                "missing_fields": missing,
                "filled_fields": [],
            }
            row["metadata_completion"] = state
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                state["reason"] = "budget_exhausted"
                continue
            dimension, query = next(
                (
                    (kind, _identity(row.get(field), kind))
                    for kind, field in ROW_IDENTIFIER_FIELDS
                    if _present(row.get(field))
                ),
                (TITLE_QUERY, _text(row.get("title")) if _present(row.get("title")) else ""),
            )
            if not query:
                state["reason"] = "identifier_and_title_missing"
                continue
            state.update(source=dimension, query=query)
            request_deadline = min(
                deadline, asyncio.get_running_loop().time() + METADATA_REQUEST_SECONDS
            )
            abstract_diagnostics: dict[str, object] = {}
            response = None
            for attempt in range(METADATA_ATTEMPTS):
                timeout = request_deadline - asyncio.get_running_loop().time()
                if timeout <= 0:
                    break
                state["attempts"] = attempt + 1
                try:
                    async with asyncio.timeout(timeout):
                        response = (
                            await search_by_title(query, timeout=timeout, require_unique=True)
                            if dimension == TITLE_QUERY and selected
                            else (
                                await search_by_title(query, timeout=timeout)
                                if dimension == TITLE_QUERY
                                else await fetch_bibliography(
                                    dimension,
                                    query,
                                    timeout=timeout,
                                    abstract_chain=identity_chain(
                                        dimension, query, row_alternates(row, dimension)
                                    ),
                                    abstract_diagnostics=abstract_diagnostics if selected else None,
                                )
                            )
                        )
                    state.pop("reason", None)
                    break
                except (BibliographyError, TimeoutError) as error:
                    state["reason"] = (
                        error.code if isinstance(error, BibliographyError) else "timeout"
                    )
                    remaining = request_deadline - asyncio.get_running_loop().time()
                    if (
                        not isinstance(error, BibliographyError)
                        or error.code != NETWORK_FAILED
                        or attempt + 1 >= METADATA_ATTEMPTS
                        or remaining <= METADATA_RETRY_DELAY_SECONDS
                    ):
                        break
                    state.setdefault("retry_reasons", []).append(state["reason"])
                    await asyncio.sleep(METADATA_RETRY_DELAY_SECONDS)
            if response is None:
                continue
            raw = response.get("fields")
            if abstract_diagnostics:
                state["abstract_lookup"] = abstract_diagnostics
            if response.get("success") is not True or not isinstance(raw, dict):
                state["reason"] = response.get("reason", "invalid_response")
                continue
            fields = {FIELD_ALIASES.get(key, key): value for key, value in raw.items()}
            if not _matches(row, fields, dimension):
                state["status"] = METADATA_IDENTITY_CONFLICT
                continue
            for field in COMPLETION_FIELDS:
                value = fields.get(field)
                if field not in missing and row.get(field) not in (None, "", []):
                    continue
                if field == "authors":
                    value = structured_authors(value) if isinstance(value, str) else None
                    if not value:
                        continue
                    row["author_metadata"] = {
                        **_authors_metadata(value, fields[field]),
                        "source": dimension,
                        "query": query,
                    }
                elif field == "year":
                    if not _valid_year(value):
                        continue
                elif not (_abstract(value) if field == "abstract" else _present(value)):
                    continue
                row[field] = value
                state["filled_fields"].append(field)
            _aliases(row)
            state["missing_fields"] = missing_fields(row)
            if "abstract" in state["missing_fields"] and abstract_diagnostics.get("reason"):
                state["reason"] = abstract_diagnostics["reason"]
            state["status"] = "partial" if state["missing_fields"] else "completed"

    tasks = [asyncio.create_task(worker()) for _ in range(min(METADATA_CONCURRENCY, len(pending)))]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
