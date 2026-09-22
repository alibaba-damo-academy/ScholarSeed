"""全局搜索 (MVP 0.2)。

全局搜索聚合资料、文献与对话三个领域。资料与文献使用各自已落盘的数据源；
对话通过 chat 域公开的项目搜索接口接入，搜索聚合层不直接读取会话存储。

放在 `service/platform/` 而非某个域内: 它跨域聚合, 不属于资料库也不属于
文献库; 新增可搜索域 = 往 `_PROVIDERS` 注册一个提供者, 不改路由。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request

from service.content.domain.model import ContentError
from service.identity.utils import request_owner_id
from service.literature.persistence.store import load_library
from service.literature.service.catalog import ListQuery, apply_query
from service.platform.content import ResourceReveal

SEARCH_ROUTE_PREFIX = "/api/search"

#: 每个域回给面板的命中窗口。
#:
#: PRD「结果数量与展开」要求前端按 3 条起、每次「查看更多」追加最多 10 条地逐页
#: 展开, 直到该组全部展示完 —— 所以窗口必须明显大于首屏, 否则「查看更多」翻两下
#: 就没东西了。取与资料域自身的扫描上限同量级, 让平台层不再成为额外的截断源;
#: 超出窗口的部分只体现在计数与 `truncated` 上, 不无限拉长响应体。
MAX_HITS_PER_DOMAIN = 80


class SearchDomain(str, Enum):
    """可搜索的域。"""

    RESOURCE = "resource"
    LITERATURE = "literature"
    SESSION = "session"


@dataclass(frozen=True)
class SearchHit:
    """一条跨域命中。前端按 domain 决定点击后打开什么。"""

    domain: str
    #: 域内标识: 资料是相对路径, 文献是条目 id。
    id: str
    title: str
    subtitle: str = ""
    reveal: ResourceReveal | None = None
    locator: dict[str, Any] | None = None


@dataclass(frozen=True)
class DomainHits:
    """一个域的命中窗口 + 计数 (PRD「结果组织」19: 分组分别统计合并后的结果数量)。

    `total` 是该组匹配的对象总数, `truncated` 为真表示磁盘/库里可能还有更多 ——
    此时前端要把计数显示成「N+」, 不能把 `total` 当成精确值。
    """

    hits: tuple[SearchHit, ...]
    total: int
    truncated: bool = False


def _window(hits: Sequence[SearchHit], known_total: int, *, capped: bool) -> DomainHits:
    """把域内命中切成响应窗口, 并如实合并两处截断: 域自身的与平台窗口的。"""

    return DomainHits(
        hits=tuple(hits[:MAX_HITS_PER_DOMAIN]),
        total=known_total,
        truncated=capped or known_total > MAX_HITS_PER_DOMAIN,
    )


def _resource_hits(content: Any, project_id: str, query: str) -> DomainHits:
    """资料命中。正文命中时把片段放进副标题, 让用户知道为什么命中。"""

    found = content.search(project_id, query)
    return _window(
        [
            SearchHit(
                domain=SearchDomain.RESOURCE.value,
                id=hit.path,
                title=hit.name,
                subtitle=hit.snippet or hit.path,
                reveal=hit.reveal,
            )
            for hit in found.hits
        ],
        len(found.hits),
        capped=found.truncated,
    )


def _literature_hits(content: Any, project_id: str, query: str) -> DomainHits:
    """文献命中。复用文献库自己的筛选函数, 不另写一套匹配规则。"""

    view = load_library(project_id)
    matched = apply_query(view.items, ListQuery(search=query))
    return _window(
        [
            SearchHit(
                domain=SearchDomain.LITERATURE.value,
                id=item.id,
                title=item.title,
                subtitle=" · ".join(part for part in (item.authors, str(item.year or "")) if part),
            )
            for item in matched
        ],
        # apply_query 不截断, 因此这里的匹配数是精确的。
        len(matched),
        capped=False,
    )


async def _session_hits(request: Request, project_root: str, query: str) -> DomainHits:
    """Search product-visible sessions in the current project."""

    sessions = getattr(request.app.state, "session_service", None)
    if sessions is None:
        return DomainHits(hits=(), total=0)
    result = await sessions.search_project(
        project_root,
        request_owner_id(request),
        query,
        MAX_HITS_PER_DOMAIN,
    )
    hits = []
    for session in result.get("sessions", []):
        match = session.get("match") or {}
        locator = {
            "turn_id": match.get("turn_id"),
            "item_id": match.get("item_id"),
            "role": match.get("role"),
            "count": match.get("count", 0),
        }
        hits.append(
            SearchHit(
                domain=SearchDomain.SESSION.value,
                id=str(session.get("session_id") or ""),
                title=str(session.get("title") or "未命名对话"),
                subtitle=str(match.get("excerpt") or "标题命中"),
                locator=locator,
            )
        )
    return _window(hits, int(result.get("total", len(hits))), capped=False)


#: 域 → 命中提供者。新增可搜索域在此注册即可。
#: 提供者收 (content 端口, project_id, 关键词): 聚合层不持有绝对路径, 各域读
#: 文件都经 Port —— 全局搜索会递归读目录与正文, 是最不该有第二条读文件通道的地方。
_PROVIDERS: dict[SearchDomain, Callable[[Any, str, str], DomainHits]] = {
    SearchDomain.RESOURCE: _resource_hits,
    SearchDomain.LITERATURE: _literature_hits,
}


def _scope(request: Request, project: str | None) -> tuple[Any, str]:
    """(content 端口, 项目 id)。本层既不解析项目根, 也不碰绝对路径。

    此前这里写的是 `Path(project).expanduser()`，直接接受客户端传来的任意
    绝对路径。全局搜索会递归读目录与文件正文，因此那个参数等于允许任意
    本机目录被扫并回报命中内容 —— 比单纯的路径越界更严重。
    """

    content = getattr(request.app.state, "content", None)
    if content is None:
        raise HTTPException(status_code=503, detail="content_unavailable")
    try:
        return content, content.project(project).id
    except ContentError as exc:
        raise HTTPException(status_code=400, detail=exc.code) from exc


def register_search_routes(app: FastAPI) -> None:
    """把全局搜索路由挂到应用上。"""

    @app.get(SEARCH_ROUTE_PREFIX)
    async def global_search(  # type: ignore[unused-ignore]
        request: Request,
        q: str = Query(...),
        project: str | None = Query(default=None),
    ) -> dict:
        """全局搜索 (PRD「全局搜索」)。空查询返回空结果而不是全量。"""

        needle = q.strip()
        if not needle:
            return {"query": q, "hits": [], "groups": {}}
        content, project_id = _scope(request, project)
        project_root = content.project(project_id).root
        hits: list[SearchHit] = []
        groups: dict[str, dict[str, Any]] = {}
        for domain, provider in _PROVIDERS.items():
            found = provider(content, project_id, needle)
            hits.extend(found.hits)
            groups[domain.value] = {"total": found.total, "truncated": found.truncated}
        sessions = await _session_hits(request, project_root, needle)
        hits.extend(sessions.hits)
        groups[SearchDomain.SESSION.value] = {
            "total": sessions.total,
            "truncated": sessions.truncated,
        }
        return {
            "query": needle,
            "hits": [
                {
                    "domain": hit.domain,
                    "id": hit.id,
                    "title": hit.title,
                    "subtitle": hit.subtitle,
                    "reveal": asdict(hit.reveal) if hit.reveal is not None else None,
                    "locator": hit.locator,
                }
                for hit in hits
            ],
            "groups": groups,
        }


__all__ = [
    "SEARCH_ROUTE_PREFIX",
    "DomainHits",
    "SearchDomain",
    "SearchHit",
    "register_search_routes",
]
