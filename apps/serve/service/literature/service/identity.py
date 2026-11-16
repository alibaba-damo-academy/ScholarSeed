from __future__ import annotations

import re
from collections.abc import Callable, Mapping

from service.literature.service.arxiv import arxiv_id_from_doi, normalize_arxiv_id
from service.literature.service.fulltext import normalize_doi

SOURCE_ARXIV = "arxiv"
SOURCE_DOI = "doi"
VERSION_SUFFIX = re.compile(r"v\d+$", re.IGNORECASE)
#: 能参与身份链的维度。其他值 (例如标题) 不是标识符, 不进链。
CHAIN_SOURCES = (SOURCE_DOI, SOURCE_ARXIV)


def own_identity(kind: str, identifier: str) -> tuple[str, str]:
    """维度自己的规范形态, **不做** DOI → arXiv 折叠; 非法值照常抛。"""

    if kind == SOURCE_DOI:
        return SOURCE_DOI, normalize_doi(identifier).casefold()
    if kind == SOURCE_ARXIV:
        return SOURCE_ARXIV, normalize_arxiv_id(identifier).casefold()
    return kind, identifier.strip()


def source_identity(kind: str, identifier: str) -> tuple[str, str]:
    source, value = own_identity(kind, identifier)
    if source != SOURCE_DOI:
        return source, value
    arxiv = arxiv_id_from_doi(value)
    if not arxiv:
        return source, value
    return SOURCE_ARXIV, normalize_arxiv_id(arxiv).casefold()


def paper_identity(kind: str, identifier: str) -> tuple[str, str]:
    return version_agnostic(*source_identity(kind, identifier))


def version_agnostic(source: str, value: str) -> tuple[str, str]:
    """已规范的身份 → 去版本号的去重键; arXiv 的 v2 与无版本号是同一篇。"""

    return source, VERSION_SUFFIX.sub("", value) if source == SOURCE_ARXIV else value


def pinned_source(kind: str, identifier: str) -> bool:
    source, value = source_identity(kind, identifier)
    return source == SOURCE_ARXIV and VERSION_SUFFIX.search(value) is not None


def identity_chain(
    kind: str, identifier: str, alternates: Mapping[str, str] | None = None
) -> tuple[tuple[str, str], ...]:
    """一篇论文已知的全部标识 → 有序、去重的规范身份链。

    顺序就是可信度顺序, 调用方按序尝试、拿到结果就停:

    1. 题录维度自己的身份, **不折叠** —— 出版商 DOI 的 Crossref 记录优先于任何预印本来源;
    2. 该标识折叠出来的身份 —— ``10.48550/arXiv.*`` 这种 arXiv 自注册 DOI 里就带着 arXiv 号;
    3. 记录上其他已知标识 (``alternates``) 折叠出来的身份。

    链首恒为题录维度自己, 这是它对调用方的唯一契约: 消费方 (摘要补充腿) 不再自己拼主维度,
    否则同一个 DOI 会因为两处归一化口径不同 (大小写) 被打两次上游。

    去重按 ``version_agnostic``, 所以 ``2401.12345`` 与 ``2401.12345v2`` 只留先出现的那个,
    不会为同一篇论文的摘要打两次上游; 派生出的无版本号形态因此优先于记录里带版本号的形态。

    非法值一律**跳过而不抛**: 这条链是给可选增强用的, 一个脏标识不许把主操作带下水。
    归一化本身会抛 ``ArxivDownloadError`` / ``FulltextDownloadError``, 两者都是 ``ValueError``。
    """

    chain: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def push(candidate: tuple[str, str] | None) -> None:
        if candidate is None:
            return
        source, value = candidate
        if not value or source not in CHAIN_SOURCES:
            return
        key = version_agnostic(source, value)
        if key in seen:
            return
        seen.add(key)
        chain.append((source, value))

    def resolve(resolver: Callable[[str, str], tuple[str, str]], source: str, value: str) -> None:
        text = (value or "").strip()
        if not text or source not in CHAIN_SOURCES:
            return
        try:
            push(resolver(source, text))
        except ValueError:
            return

    resolve(own_identity, kind, identifier)
    resolve(source_identity, kind, identifier)
    for alternate_kind, alternate_value in (alternates or {}).items():
        resolve(source_identity, alternate_kind, alternate_value)
    return tuple(chain)
