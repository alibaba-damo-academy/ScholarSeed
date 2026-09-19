"""文献元数据解析 (MVP 0.2)。

本模块解析 `.RIS` 与 `.Bib` 两种题录格式，并转换为 `LiteratureItem`。
PDF 元数据提取统一由 `extractor.py` 负责。

依赖选择: BibTeX/RIS 用手写解析而非引入第三方库。这两种格式在本期只需
读出题录字段 (类型/作者/标题/期刊/年份/DOI/摘要/关键词), 手写解析约
150 行且零新增依赖; 引入 bibtexparser/rispy 会为桌面端安装包增加体积与
供应链面, 收益不成比例。若后续要支持完整 BibTeX 宏展开再替换本模块。
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from service.literature.schema import FulltextStatus, LiteratureItem, new_item_id

#: BibTeX 条目起始, 例如 `@article{key,`。
_BIB_ENTRY = re.compile(r"@(\w+)\s*\{\s*([^,]*),", re.IGNORECASE)
_BIB_NON_RECORD_TYPES = frozenset({"comment", "preamble", "string"})

#: RIS 行格式 `TY  - JOUR`。
_RIS_LINE = re.compile(r"^([A-Z][A-Z0-9])\s{2}-\s?(.*)$")

#: RIS 记录结束标记。
_RIS_END_TAG = "ER"
_RIS_START_TAG = "TY"

#: RIS 作者类标签, 多次出现需累积。
_RIS_AUTHOR_TAGS = frozenset({"AU", "A1", "A2"})

#: RIS → 统一字段名。
_RIS_FIELDS = {
    "TI": "title",
    "T1": "title",
    "JO": "journal",
    "JF": "journal",
    "T2": "journal",
    "PY": "year",
    "Y1": "year",
    "DO": "doi",
    "AB": "abstract",
    "N2": "abstract",
    "KW": "keywords",
}

#: BibTeX → 统一字段名。
_BIB_FIELDS = {
    "title": "title",
    "author": "authors",
    "journal": "journal",
    "booktitle": "journal",
    "year": "year",
    "doi": "doi",
    "eprint": "arxiv",
    "abstract": "abstract",
    "keywords": "keywords",
    "url": "url",
}

#: 作者串接分隔符, 统一成「, 」以便列表列直接展示。
AUTHOR_SEPARATOR = ", "

_YEAR_PATTERN = re.compile(r"(19|20)\d{2}")


@dataclass(frozen=True)
class ParsedRecord:
    """解析出的原始题录字段。尚未定 id 与全文状态。"""

    title: str = ""
    authors: str = ""
    journal: str = ""
    year: int | None = None
    doi: str = ""
    arxiv: str = ""
    abstract: str = ""
    keywords: tuple[str, ...] = ()
    url: str = ""
    bib_type: str = ""
    citation_key: str = ""
    publisher: str = ""
    address: str = ""
    volume: str = ""
    number: str = ""
    pages: str = ""
    isbn: str = ""


def to_item(record: ParsedRecord, *, fulltext: FulltextStatus) -> LiteratureItem:
    """题录 → 落库条目。

    `added_at` 在此处盖时间戳：「最近添加」与默认排序都靠它，如果留给调用方补，
    总会有一条导入路径忘记设，表现为「刚导的文献不在最近添加里」。

    id 由 `new_item_id()` 生成，与题录内容无关：同一条文献重复导入就是两条
    独立记录（proposal 91），不存在"命中既存条目"这回事。
    """

    return LiteratureItem(
        id=new_item_id(),
        title=record.title.strip(),
        authors=record.authors.strip(),
        journal=record.journal.strip(),
        year=record.year,
        fulltext=fulltext,
        tags=record.keywords,
        abstract=record.abstract.strip(),
        doi=record.doi.strip(),
        arxiv=record.arxiv.strip(),
        url=record.url.strip(),
        added_at=time.time(),
    )


def _clean_bib_value(value: str) -> str:
    """去掉 BibTeX 的外层花括号/引号与换行折行。"""

    text = value.strip().rstrip(",").strip()
    while text.startswith("{") and text.endswith("}"):
        text = text[1:-1].strip()
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1].strip()
    return re.sub(r"\s+", " ", text.replace("{", "").replace("}", ""))


def _parse_year(raw: str) -> int | None:
    """从年份字段里取四位年, 取不到返回 None 而不是猜。"""

    match = _YEAR_PATTERN.search(raw)
    return int(match.group(0)) if match else None


def _split_keywords(raw: str) -> tuple[str, ...]:
    """关键词按逗号/分号切分并去空。"""

    parts = re.split(r"[;,]", raw)
    return tuple(part.strip() for part in parts if part.strip())


def _normalize_person(name: str) -> str:
    """`Last, First` → `First Last`。已是自然语序则原样返回。

    BibTeX 与 RIS 都用「姓, 名」书写单个作者。不归一化就直接用
    「, 」拼接的话, 「Ivanova, Elena, Dubois, Marc」会分不出作者边界。
    """

    cleaned = name.strip()
    if "," not in cleaned:
        return cleaned
    last, _, first = cleaned.partition(",")
    return f"{first.strip()} {last.strip()}".strip()


def _normalize_bib_authors(raw: str) -> str:
    """BibTeX 的 `and` 分隔 + `Last, First` 语序 → 「First Last, ...」。"""

    names = [_normalize_person(chunk) for chunk in re.split(r"\s+and\s+", raw)]
    return AUTHOR_SEPARATOR.join(name for name in names if name)


def _bib_fields(body: str) -> dict[str, str]:
    """从一个 BibTeX 条目体里取 `key = value` 对。

    按括号深度切分而非逐行正则: 摘要字段常跨多行且内含逗号, 逐行正则会
    把它截断。
    """

    fields: dict[str, str] = {}
    key = ""
    buffer: list[str] = []
    depth = 0
    in_quotes = False
    reading_key = True
    for char in body:
        if reading_key:
            if char == "=":
                reading_key = False
                buffer = []
            elif char == ",":
                key = ""
            else:
                key += char
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        elif char == '"' and depth == 0:
            in_quotes = not in_quotes
        if char == "," and depth <= 0 and not in_quotes:
            name = key.strip().lower()
            if name:
                fields[name] = _clean_bib_value("".join(buffer))
            key = ""
            buffer = []
            reading_key = True
            continue
        buffer.append(char)
    name = key.strip().lower()
    if name and buffer:
        fields[name] = _clean_bib_value("".join(buffer))
    return fields


def parse_bibtex(text: str) -> tuple[ParsedRecord, ...]:
    """解析 BibTeX 文本, 返回全部题录。"""

    records: list[ParsedRecord] = []
    for match in _BIB_ENTRY.finditer(text):
        if match.group(1).lower() in _BIB_NON_RECORD_TYPES:
            continue
        start = match.end()
        depth = 1
        index = start
        while index < len(text) and depth > 0:
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
            index += 1
        if depth:
            raise ValueError("unterminated BibTeX record")
        fields = _bib_fields(text[start : index - 1])
        mapped: dict[str, str] = {}
        for raw_key, value in fields.items():
            target = _BIB_FIELDS.get(raw_key)
            if target:
                mapped[target] = value
        records.append(
            ParsedRecord(
                title=mapped.get("title", ""),
                authors=_normalize_bib_authors(mapped.get("authors", "")),
                journal=mapped.get("journal", ""),
                year=_parse_year(mapped.get("year", "")),
                doi=mapped.get("doi", ""),
                arxiv=mapped.get("arxiv", ""),
                abstract=mapped.get("abstract", ""),
                keywords=_split_keywords(mapped.get("keywords", "")),
                url=mapped.get("url", ""),
                bib_type=match.group(1).lower(),
                citation_key=match.group(2).strip(),
                publisher=fields.get("publisher", ""),
                address=fields.get("address", ""),
                volume=fields.get("volume", ""),
                number=fields.get("number", ""),
                pages=fields.get("pages", ""),
                isbn=fields.get("isbn", ""),
            )
        )
    return tuple(records)


def parse_ris(text: str) -> tuple[ParsedRecord, ...]:
    """解析 RIS 文本, 返回全部题录。"""

    records: list[ParsedRecord] = []
    current: dict[str, str] = {}
    authors: list[str] = []
    keywords: list[str] = []
    last_field = ""
    record_started = False

    def flush() -> None:
        if current or authors or keywords:
            records.append(
                ParsedRecord(
                    title=current.get("title", ""),
                    authors=AUTHOR_SEPARATOR.join(authors),
                    journal=current.get("journal", ""),
                    year=_parse_year(current.get("year", "")),
                    doi=current.get("doi", ""),
                    abstract=current.get("abstract", ""),
                    keywords=tuple(keywords),
                )
            )

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        match = _RIS_LINE.match(line)
        if not match:
            # RIS 允许字段续行 (缩进无标签), 续到上一个字段尾部。
            if last_field and line.strip():
                current[last_field] = f"{current.get(last_field, '')} {line.strip()}".strip()
            continue
        tag, value = match.group(1), match.group(2).strip()
        if tag == _RIS_START_TAG:
            if record_started or current or authors or keywords:
                raise ValueError("RIS record started before previous record ended")
            record_started = True
            last_field = ""
            continue
        if tag == _RIS_END_TAG:
            flush()
            current, authors, keywords, last_field = {}, [], [], ""
            record_started = False
            continue
        if tag in _RIS_AUTHOR_TAGS:
            if value:
                # RIS 每行一个作者, 且为 `Last, First` 语序。先归一化再拼接,
                # 否则拼出来的串分不出作者边界。
                authors.append(_normalize_person(value))
            last_field = ""
            continue
        field = _RIS_FIELDS.get(tag)
        if field == "keywords":
            if value:
                keywords.append(value)
            last_field = ""
            continue
        if field:
            # 同一字段重复出现时保留首个, 例如 TI/T1 同时存在。
            current.setdefault(field, value)
            last_field = field
    flush()
    return tuple(records)


__all__ = [
    "AUTHOR_SEPARATOR",
    "ParsedRecord",
    "parse_bibtex",
    "parse_ris",
    "to_item",
]
