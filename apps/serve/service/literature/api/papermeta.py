"""单条论文元数据查询 (POST /api/literature/papermeta)。

按 doi > arxiv > title 选唯一来源。DOI/arXiv 匿名获取公开 BibTeX 并返回非空更新字段；
标题搜索才兑换账号凭据、调用 PaperHub 并原样返回 JSON。任何分支失败都不切换来源。

上游只认 API key、不认用户 JWT, 所以凭据兑换必须发生在 serve 这一跳: key 由
``SkillCredentialService`` 按本次请求的**真实账号身份** (``request_user_id``, 不是数据归属
身份) 取回, 只进请求头, 不进 URL、不进日志、不进响应体, 渲染层自始至终拿不到它
(边界见 wiki/architecture/network.md §2.5 与 §6)。

PaperHub 查询恒带 ``limit=1``, 正常只可能是 1 条 (命中) 或 0 条 (没命中)。0 条回 404;
多于 1 条说明上游没遵守 limit, 回 502 而不是替调用方挑一条 —— 挑哪条是调用方的业务
判断 (例如按标题距离择优), 代理不该替它决定。

上游的 429 是唯一需要**保真透传**的失败: 「配额用尽」对用户是可行动的 (换时间/换账号),
和「检索失败」不是一回事, 所以单独折算成 429 + ``PAPER_META_QUOTA_EXHAUSTED``,
其余非 200 一律折叠成 502。
"""

from __future__ import annotations

import logging
import math
import os
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from service.identity.service.skill_credentials import SKILL_API_KEY_ENV, SkillCredentialService
from service.identity.utils import bearer_or_cookie, request_user_id
from service.literature.service.bibliography import (
    ENDPOINTS,
    INVALID_IDENTIFIER,
    NETWORK_FAILED,
    BibliographyError,
    fetch_bibliography,
)

LOGGER = logging.getLogger(__name__)

PREFIX = "/api/literature/papermeta"

# 出网点登记在 wiki/architecture/network.md §2.5; 端点与超时都留 env 覆盖通道 (§7 要求)。
PAPERHUB_BASE_PATH = "/paperhub"
SEARCH_PATH_SUFFIX = "/papersearch"
DEFAULT_SEARCH_URL = (
    f"https://scholarseed.damo.alibaba.com{PAPERHUB_BASE_PATH}{SEARCH_PATH_SUFFIX}/"
)
SEARCH_URL_ENV = "PAPERHUB_SEARCH_URL"
TIMEOUT_ENV = "PAPERHUB_SEARCH_TIMEOUT"
DEFAULT_TIMEOUT_SECONDS = 30.0
TRUSTED_SCHEMES = ("http", "https")
# 覆盖值既可以给完整检索端点, 也可以只给基地址 (技能侧两种写法都出现过), 两种都收下。
SEARCH_BASE_PATHS = ("", PAPERHUB_BASE_PATH)
# 带凭据的请求一律不跟随重定向: 跳转会把 Bearer 头送给未经审核的 origin。
FOLLOW_REDIRECTS = False
TRUST_ENV = True

SINGLE_RESULT_LIMIT = 1
# doi 命中即不再看 arxiv / title; 顺序就是优先级, 不是可选组合。
QUERY_PRECEDENCE = ("doi", "arxiv", "title")

SKILL_CREDENTIALS_STATE = "skill_credentials"
ACCOUNT_TOKENS_STATE = "account_tokens"
AUTHORIZATION_HEADER = "Authorization"
UPSTREAM_SUCCESS_FIELD = "success"
UPSTREAM_DATA_FIELD = "data"
UPSTREAM_HTTP_OK = 200
UPSTREAM_HTTP_TOO_MANY_REQUESTS = 429
QUOTA_EXHAUSTED_STATUS = 429

QUERY_REQUIRED = "PAPER_META_QUERY_REQUIRED"
ENDPOINT_INVALID = "PAPER_META_ENDPOINT_INVALID"
CREDENTIALS_UNAVAILABLE = "PAPER_META_CREDENTIALS_UNAVAILABLE"
KEY_MISSING = "PAPER_META_KEY_MISSING"
NOT_FOUND = "PAPER_META_NOT_FOUND"
AMBIGUOUS = "PAPER_META_AMBIGUOUS"
UPSTREAM_FAILED = "PAPER_META_UPSTREAM_FAILED"
QUOTA_EXHAUSTED = "PAPER_META_QUOTA_EXHAUSTED"

ERROR_MESSAGES = {
    QUERY_REQUIRED: "请至少提供 doi、arxiv、title 中的一项",
    ENDPOINT_INVALID: "PaperHub 检索地址不合法",
    CREDENTIALS_UNAVAILABLE: "技能凭据服务未装配, 无法代理该请求",
    KEY_MISSING: "当前身份没有可用的 SCHOLARSEED_API_KEY, 请先登录账号",
    NOT_FOUND: "没有匹配的文献",
    AMBIGUOUS: "上游返回了多条结果",
    UPSTREAM_FAILED: "元数据接口请求失败或返回无效数据",
    QUOTA_EXHAUSTED: "PaperHub 接口配额已用尽",
    NETWORK_FAILED: "元数据接口网络请求失败",
    INVALID_IDENTIFIER: "DOI 或 arXiv 编号无效",
}


class PaperMetaError(RuntimeError):
    """代理链路上的稳定失败: 一个 code 对一个 HTTP 状态, 调用方按 code 分支。"""

    def __init__(self, code: str, status: int, diagnostic: str = "") -> None:
        super().__init__(diagnostic or code)
        self.code = code
        self.status = status
        # 诊断只放上游状态与形状问题, 绝不放凭据。
        self.diagnostic = diagnostic


class PaperMetaRequest(BaseModel):
    """单条元数据查询: 三个维度按 doi > arxiv > title 取第一个非空值。"""

    doi: str = ""
    arxiv: str = ""
    title: str = ""


def resolve_search_url(environ: Mapping[str, str] | None = None) -> str:
    """解析并校验检索端点; 覆盖值形状不对就明确拒绝, 不静默改写。

    凭据只发给这一个 origin, 所以覆盖通道必须挡住「把 key 送到任意地址」: 要求绝对
    HTTP(S)、不带账号口令、不带 query/fragment, 且路径必须落在 ``/papersearch``。
    """

    source = os.environ if environ is None else environ
    raw = str(source.get(SEARCH_URL_ENV, "") or "").strip() or DEFAULT_SEARCH_URL
    parsed = urlsplit(raw)
    path = parsed.path.rstrip("/")
    if path in SEARCH_BASE_PATHS:
        path = f"{PAPERHUB_BASE_PATH}{SEARCH_PATH_SUFFIX}"
    if (
        parsed.scheme not in TRUSTED_SCHEMES
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not path.endswith(SEARCH_PATH_SUFFIX)
    ):
        raise PaperMetaError(ENDPOINT_INVALID, 500, f"{SEARCH_URL_ENV} is not a trusted endpoint")
    return urlunsplit((parsed.scheme, parsed.netloc, f"{path}/", "", ""))


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


def select_query(doi: str, arxiv: str, title: str) -> dict[str, Any]:
    """按优先级选一个维度, 并恒定带上 limit=1。"""

    for field, value in zip(QUERY_PRECEDENCE, (doi, arxiv, title)):
        text = str(value or "").strip()
        if text:
            return {field: text, "limit": SINGLE_RESULT_LIMIT}
    raise PaperMetaError(QUERY_REQUIRED, 400, "no doi/arxiv/title provided")


async def resolve_api_key(
    request: Request, credentials: SkillCredentialService | None = None
) -> str:
    """按本次请求的真实账号身份兑换托管 key; 兑换不到就明确失败, 不空手打上游。

    身份取 ``request_user_id`` 而非 ``request_owner_id``: machine 归属轴下后者恒为 local,
    用它兑换会把凭据腿静默用错身份 (与 chat/api/feedback.py 同一判据)。请求没带凭据时
    回落到中间件已在内存里捕获的账号 token —— 桌面端 auth-off 就是这种形态。
    """

    service = credentials
    if service is None:
        service = getattr(request.app.state, SKILL_CREDENTIALS_STATE, None)
    if service is None:
        raise PaperMetaError(
            CREDENTIALS_UNAVAILABLE, 503, "skill credential service is not mounted"
        )
    actor_id = request_user_id(request)
    credential = bearer_or_cookie(request)
    if not credential:
        tokens = getattr(request.app.state, ACCOUNT_TOKENS_STATE, None)
        credential = str(tokens.current(actor_id) or "") if tokens is not None else ""
    environment = await service.ensure(actor_id, credential)
    api_key = str(environment.get(SKILL_API_KEY_ENV, "") or "").strip()
    if not api_key:
        raise PaperMetaError(KEY_MISSING, 401, "no managed api key for this identity")
    return api_key


async def fetch_paper_meta(
    query: Mapping[str, Any],
    api_key: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """打一次上游检索并把命中的 payload 原样返回。

    只有「HTTP 200 + success + data 恰好 1 条」才算命中; 其余情况一律折算成稳定 code,
    不把上游的错误形状透给调用方 (成功形状才需要原封不动)。
    """

    url = resolve_search_url(environ)
    headers = {AUTHORIZATION_HEADER: f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(
            timeout=resolve_timeout_seconds(environ),
            follow_redirects=FOLLOW_REDIRECTS,
            trust_env=TRUST_ENV,
            transport=transport,
        ) as client:
            response = await client.post(url, json=dict(query), headers=headers)
    except httpx.HTTPError as error:
        LOGGER.warning("papermeta upstream unreachable: %s", type(error).__name__)
        raise PaperMetaError(UPSTREAM_FAILED, 502, "upstream unreachable") from error

    if response.status_code != UPSTREAM_HTTP_OK:
        if response.status_code == UPSTREAM_HTTP_TOO_MANY_REQUESTS:
            raise PaperMetaError(
                QUOTA_EXHAUSTED, QUOTA_EXHAUSTED_STATUS, "upstream quota exhausted"
            )
        raise PaperMetaError(UPSTREAM_FAILED, 502, f"upstream HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError as error:
        raise PaperMetaError(UPSTREAM_FAILED, 502, "upstream response is not JSON") from error
    if not isinstance(payload, dict):
        raise PaperMetaError(UPSTREAM_FAILED, 502, "upstream response is not an object")
    if payload.get(UPSTREAM_SUCCESS_FIELD) is not True:
        raise PaperMetaError(UPSTREAM_FAILED, 502, "upstream reported failure")
    data = payload.get(UPSTREAM_DATA_FIELD)
    if not isinstance(data, list):
        raise PaperMetaError(UPSTREAM_FAILED, 502, "upstream data is not a list")
    if not data:
        raise PaperMetaError(NOT_FOUND, 404, "upstream returned no match")
    if len(data) > SINGLE_RESULT_LIMIT:
        raise PaperMetaError(AMBIGUOUS, 502, f"upstream returned {len(data)} results")
    return payload


def register_papermeta_routes(
    app: FastAPI,
    *,
    credentials: SkillCredentialService | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
) -> None:
    """挂载代理端点; 三个可选依赖只为测试注入, 产品路径全部走默认解析。"""

    @app.post(PREFIX)
    async def paper_meta(payload: PaperMetaRequest, request: Request) -> dict[str, Any]:
        try:
            query = select_query(payload.doi, payload.arxiv, payload.title)
            dimension = next(field for field in QUERY_PRECEDENCE if field in query)
            if dimension in ENDPOINTS:
                return await fetch_bibliography(
                    dimension,
                    query[dimension],
                    timeout=resolve_timeout_seconds(environ),
                    transport=transport,
                )
            api_key = await resolve_api_key(request, credentials)
            return await fetch_paper_meta(query, api_key, transport=transport, environ=environ)
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
    "fetch_paper_meta",
    "register_papermeta_routes",
    "resolve_api_key",
    "resolve_search_url",
    "select_query",
]
