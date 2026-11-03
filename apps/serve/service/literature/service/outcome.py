"""Stable full-text acquisition outcomes shared by download legs.

产品口径 (文献详情「获取全文」): 不论走 arXiv 腿还是 DOI 腿, 用户只应看到四种结果, 文案
固定为下面这四对中英文。所以四类结果在这里定义一次, 两条腿共用, 状态分类也只有
``classify_status`` 一个入口 —— 新增一种上游行为是往状态集合里加一个数, 不是各腿各写一套。

* ``FULLTEXT_NOT_FOUND`` —— 未找到全文 / Not found
  非超时传输错误、DNS、连接被断, 上游 404, 以及上游给了回应
  但那不是我们要的全文 (注册库没有 ``primary_location.pdf_url``、其余 4xx/5xx)。
* ``FULLTEXT_NO_ACCESS`` —— 无法访问 / Unable to access
  URL 能访问但拿不到内容: 401/402/403/407/451 这类要求登录或付费的状态; 能下载但拿到的
  不是 PDF (content-type 不是 PDF、正文没有 ``%PDF-`` 魔数、校验不过) —— 出版商把未授权
  请求重定向到文章落地页就是这一类; 以及拿得到但收不进库 (超过 ``MAX_IMPORT_BYTES``)。
* ``FULLTEXT_RATE_LIMITED`` —— 请求被限流 / Rate limited
  429。
* ``FULLTEXT_TIMEOUT`` —— 下载超时，请稍后重试 / Download timed out. Please try again.
  连接、读取停滞或全文总预算到期, 以及上游408/504。

不属于「获取失败」的三类前置问题各自保留原码与 4xx 状态, 不折进上面三类: 标识不合法
(``ARXIV_INVALID`` / ``DOI_INVALID``)、缺标识 (``FULLTEXT_IDENTIFIER_MISSING``)、已经有
主附件 (``ARXIV_ALREADY_ATTACHED``)。
"""

from __future__ import annotations

from service.literature.service.bibliography import (
    HTTP_BAD_REQUEST,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_RATE_LIMITED,
)

FULLTEXT_NOT_FOUND = "FULLTEXT_NOT_FOUND"
FULLTEXT_NO_ACCESS = "FULLTEXT_NO_ACCESS"
FULLTEXT_RATE_LIMITED = "FULLTEXT_RATE_LIMITED"
FULLTEXT_TIMEOUT = "FULLTEXT_TIMEOUT"

FULLTEXT_OUTCOMES = (
    FULLTEXT_NOT_FOUND,
    FULLTEXT_NO_ACCESS,
    FULLTEXT_RATE_LIMITED,
    FULLTEXT_TIMEOUT,
)

HTTP_UNAUTHORIZED = 401
HTTP_PAYMENT_REQUIRED = 402
HTTP_PROXY_AUTH_REQUIRED = 407
HTTP_LEGALLY_UNAVAILABLE = 451
HTTP_REQUEST_TIMEOUT = 408
HTTP_GATEWAY_TIMEOUT = 504
HTTP_SUCCESS_FLOOR = 200
HTTP_SUCCESS_CEILING = 300

# 「要求登录 / 要求付费」的状态: 副本存在但对我们关着门, 用户能行动 (走机构渠道或本地上传)。
ACCESS_DENIED_STATUSES = frozenset(
    {
        HTTP_UNAUTHORIZED,
        HTTP_PAYMENT_REQUIRED,
        HTTP_FORBIDDEN,
        HTTP_PROXY_AUTH_REQUIRED,
        HTTP_LEGALLY_UNAVAILABLE,
    }
)
RATE_LIMITED_STATUSES = frozenset({HTTP_RATE_LIMITED})
TIMEOUT_STATUSES = frozenset({HTTP_REQUEST_TIMEOUT, HTTP_GATEWAY_TIMEOUT})

# 每类结果对应的 HTTP 状态: 404 没找到、403 有但不给、429 限流、504 超时。渲染层靠 code 选文案,
# API 消费方靠状态分流, 两边都不需要再认识具体是哪条腿。
OUTCOME_STATUS = {
    FULLTEXT_NOT_FOUND: HTTP_NOT_FOUND,
    FULLTEXT_NO_ACCESS: HTTP_FORBIDDEN,
    FULLTEXT_RATE_LIMITED: HTTP_RATE_LIMITED,
    FULLTEXT_TIMEOUT: HTTP_GATEWAY_TIMEOUT,
}
# 获取结果之外的码只可能是前置校验问题 (标识无效 / 缺标识), 一律 400。
PRECONDITION_STATUS = HTTP_BAD_REQUEST


def classify_status(status: int) -> str:
    """把一个上游 HTTP 状态折成四类结果之一。

    408/504 是超时，429 是限流, 401/402/403/407/451 是要登录或付费, 其余 (404 与各种 4xx/5xx) 都算
    「没拿到全文」—— 上游 5xx 对用户来说和 404 一样无从行动, 单列一类只会多一句他
    做不了任何事的解释。
    """

    if status in RATE_LIMITED_STATUSES:
        return FULLTEXT_RATE_LIMITED
    if status in TIMEOUT_STATUSES:
        return FULLTEXT_TIMEOUT
    if status in ACCESS_DENIED_STATUSES:
        return FULLTEXT_NO_ACCESS
    return FULLTEXT_NOT_FOUND


def is_success(status: int) -> bool:
    """2xx 才算拿到了东西 (跟随重定向之后仍然如此)。"""

    return HTTP_SUCCESS_FLOOR <= status < HTTP_SUCCESS_CEILING


__all__ = [
    "ACCESS_DENIED_STATUSES",
    "FULLTEXT_NO_ACCESS",
    "FULLTEXT_NOT_FOUND",
    "FULLTEXT_OUTCOMES",
    "FULLTEXT_RATE_LIMITED",
    "FULLTEXT_TIMEOUT",
    "OUTCOME_STATUS",
    "PRECONDITION_STATUS",
    "RATE_LIMITED_STATUSES",
    "classify_status",
    "is_success",
]
