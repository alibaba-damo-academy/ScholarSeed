"""单条论文元数据查询 (POST /api/literature/papermeta)。

按 doi > arxiv > title 选唯一维度, 三条腿全部匿名, 任何分支失败都不切换来源:

- ``doi`` / ``arxiv`` 是标识符解析, 取公开 BibTeX (``service/literature/service/bibliography.py``);
- ``title`` 是模糊检索, 走 OpenAlex (``service/literature/service/openalex.py``)。

三腿同形返回 ``{success, fields, bib_type?}``, ``fields`` 的键恒落在
``api/catalogue.py:EDITABLE_FIELDS`` 内且只带真的有值的键, 所以渲染层不必认识任何
上游形状 (出网点登记见 wiki/architecture/network.md §2.5, env 覆盖通道见 §7)。

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
from service.literature.service.openalex import (
    ENDPOINT_INVALID,
    TITLE,
    search_by_title,
)

LOGGER = logging.getLogger(__name__)

PREFIX = "/api/literature/papermeta"

# 超时覆盖通道 (wiki/architecture/network.md §7): 匿名题录检索的两条腿共用一个值,
# 所以名字跟着端点走, 不再挂已经删掉的 PaperHub。
TIMEOUT_ENV = "PAPER_META_TIMEOUT"
DEFAULT_TIMEOUT_SECONDS = 30.0

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
    """单条元数据查询: 三个维度按 doi > arxiv > title 取第一个非空值。"""

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
                    dimension, value, timeout=timeout, transport=transport
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
    "register_papermeta_routes",
    "resolve_timeout_seconds",
    "select_query",
]
