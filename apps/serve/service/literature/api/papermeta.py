"""单条论文元数据查询 (POST /api/literature/papermeta)。

按 doi > arxiv > title 选唯一维度, 三条腿全部匿名, **题录腿**失败不切换来源:

- ``doi`` / ``arxiv`` 是标识符解析, 取公开 BibTeX (``service/literature/service/bibliography.py``);
- ``title`` 是模糊检索, 走 OpenAlex (``service/literature/service/openalex.py``)。

未被选中的标识符并不作废: 请求里同时带 doi 与 arxiv 时, 题录腿仍只按优先级打一个来源,
而**可选的摘要补充腿**会沿 ``identity_chain`` 依次尝试「题录维度自己 → 该标识折叠出的
arXiv (``10.48550/arXiv.*``) → 记录上另一个标识」。出版商没向 Crossref 存摘要、但论文
在 arXiv 上有预印本时, 摘要因此仍能补上。补充腿只填空, 不覆盖题录腿或 BibTeX 原文已经
给出的摘要; 它拿到的可能是预印本版摘要而非出版本版, 这一点在 network.md 里明写。

三腿同形返回 ``{success, fields, bib_type?}``, ``fields`` 的键恒落在
``api/catalogue.py:EDITABLE_FIELDS`` 内且只带真的有值的键, 所以渲染层不必认识任何
上游形状 (网络与覆盖边界见 docs/architecture/network.md「单条题录查询与覆盖通道」)。

标题腿原本代理 PaperHub: 上游只认 API key、不认用户 JWT, 于是凭据兑换必须发生在 serve
这一跳, 端点也就绑上了登录状态。OpenAlex 是公开端点, 这条腿不再兑换凭据, 整个端点随之
不再依赖账号 —— ``SkillCredentialService`` 装配、``Authorization`` 头与 key 白名单边界
一并删除。「命中即落库」仍然只属于标识符腿; 标题腿恒需人工确认 (见下)。

命中语义: OpenAlex 的 ``title.search`` 是分词 AND 而非短语匹配, 整条标题也可能命中多条
(实测同一标题 count=2), 上游默认已按 ``relevance_score`` 降序, 所以这里取第一条, 而
「是不是同一篇」由渲染层 ``requiresConfirmation('title')`` 弹确认框交给人判断 —— 代理
不替用户认, 也不把多命中当上游违约 (旧 PaperHub 腿的 502 AMBIGUOUS 因此不复存在)。
``meta.count`` 是总命中数而不是返回条数, 0 命中的判据是 ``results`` 为空 → 404。

上游 429 是唯一需要**保真透传**的失败: 「接口限流」对用户是可行动的 (换时间再试), 和
「检索失败」不是一回事, 所以单独折算成 429 + ``PAPER_META_QUOTA_EXHAUSTED``, 其余非
200 一律折叠成 502。
"""

from __future__ import annotations

import logging
import math
import os
from collections.abc import Mapping
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from service.literature.service.bibliography import (
    ARXIV,
    DOI,
    ENDPOINTS,
    INVALID_IDENTIFIER,
    NETWORK_FAILED,
    NOT_FOUND,
    QUOTA_EXHAUSTED,
    UPSTREAM_FAILED,
    BibliographyError,
    fetch_bibliography,
)
from service.literature.service.identity import identity_chain
from service.literature.service.openalex import (
    ENDPOINT_INVALID,
    TITLE,
    search_by_title,
)
from service.literature.service.transport import PLAIN_TOTAL_TIMEOUT_SECONDS

LOGGER = logging.getLogger(__name__)

PREFIX = "/api/literature/papermeta"

# 超时覆盖通道 (docs/architecture/network.md「单条题录查询与覆盖通道」): 匿名题录检索的两条腿共用一个值,
# 所以名字跟着端点走, 不再挂已经删掉的 PaperHub。这里覆盖的是「总」预算; connect/read
# 两个相位由 service/transport.py 的普通数据常量固定, 不接受环境覆盖。
TIMEOUT_ENV = "PAPER_META_TIMEOUT"
DEFAULT_TIMEOUT_SECONDS = PLAIN_TOTAL_TIMEOUT_SECONDS

# doi 命中即不再看 arxiv / title; 顺序就是优先级, 不是可选组合。
QUERY_PRECEDENCE = (DOI, ARXIV, TITLE)

QUERY_REQUIRED = "PAPER_META_QUERY_REQUIRED"
QUOTA_EXHAUSTED_STATUS = 429

ERROR_MESSAGES = {
    QUERY_REQUIRED: "请至少提供 doi、arxiv、title 中的一项",
    ENDPOINT_INVALID: "OpenAlex 检索地址不合法",
    NOT_FOUND: "没有匹配的文献",
    UPSTREAM_FAILED: "元数据接口请求失败或返回无效数据",
    QUOTA_EXHAUSTED: "元数据接口限流，请稍后重试",
    NETWORK_FAILED: "元数据接口网络请求失败",
    INVALID_IDENTIFIER: "DOI 或 arXiv 编号无效",
}


class PaperMetaError(RuntimeError):
    """代理链路上的稳定失败: 一个 code 对一个 HTTP 状态, 调用方按 code 分支。"""

    def __init__(self, code: str, status: int, diagnostic: str = "") -> None:
        super().__init__(diagnostic or code)
        self.code = code
        self.status = status
        self.diagnostic = diagnostic


class PaperMetaRequest(BaseModel):
    """单条元数据查询: 题录腿按 doi > arxiv > title 取第一个非空值。

    未选中的标识符仍然有意义 —— 它们作为摘要补充腿的备用来源一起送进
    ``identity_chain``。只送一个维度的旧调用方行为完全不变。
    """

    doi: str = ""
    arxiv: str = ""
    title: str = ""


def resolve_timeout_seconds(environ: Mapping[str, str] | None = None) -> float:
    """超时同样留覆盖通道; 值不合法就退回默认, 不让一次笔误打死整条腿。"""

    source = os.environ if environ is None else environ
    raw = str(source.get(TIMEOUT_ENV, "") or "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        timeout = float(raw)
    except ValueError:
        LOGGER.warning("papermeta timeout override is not a number; using default")
        return DEFAULT_TIMEOUT_SECONDS
    return timeout if timeout > 0 and math.isfinite(timeout) else DEFAULT_TIMEOUT_SECONDS


def select_query(doi: str, arxiv: str, title: str) -> tuple[str, str]:
    """按优先级选出唯一维度, 返回 ``(dimension, value)``。"""

    for dimension, value in zip(QUERY_PRECEDENCE, (doi, arxiv, title)):
        text = str(value or "").strip()
        if text:
            return dimension, text
    raise PaperMetaError(QUERY_REQUIRED, 400, "no doi/arxiv/title provided")


def abstract_alternates(payload: PaperMetaRequest, dimension: str) -> dict[str, str]:
    """同一篇论文的其他已知**标识符**; title 不是标识符, 不参与摘要补充腿。"""

    known = {DOI: payload.doi, ARXIV: payload.arxiv}
    return {
        kind: text
        for kind, raw in known.items()
        if kind != dimension and (text := str(raw or "").strip())
    }


def register_papermeta_routes(
    app: FastAPI,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
) -> None:
    """挂载端点; 两个可选依赖只为测试注入, 产品路径全部走默认解析。"""

    @app.post(PREFIX)
    async def paper_meta(payload: PaperMetaRequest) -> dict[str, Any]:
        try:
            dimension, value = select_query(payload.doi, payload.arxiv, payload.title)
            timeout = resolve_timeout_seconds(environ)
            if dimension in ENDPOINTS:
                return await fetch_bibliography(
                    dimension,
                    value,
                    timeout=timeout,
                    transport=transport,
                    abstract_chain=identity_chain(
                        dimension, value, abstract_alternates(payload, dimension)
                    ),
                )
            return await search_by_title(
                value, timeout=timeout, transport=transport, environ=environ
            )
        except (PaperMetaError, BibliographyError) as error:
            raise HTTPException(
                error.status,
                {
                    "code": error.code,
                    "message": ERROR_MESSAGES[error.code],
                    "diagnostic": error.diagnostic if isinstance(error, PaperMetaError) else "",
                },
            ) from error


__all__ = [
    "ERROR_MESSAGES",
    "PREFIX",
    "PaperMetaError",
    "PaperMetaRequest",
    "abstract_alternates",
    "register_papermeta_routes",
    "resolve_timeout_seconds",
    "select_query",
]
