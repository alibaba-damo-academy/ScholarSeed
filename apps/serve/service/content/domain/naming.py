"""项目身份与目录名生成 (content 域, 开发 1 拥有)。

proposal 47 §5.2 定死的规则:

- `project_id` 是 26 位小写 ULID, 且是**唯一**身份键;
- 目录名是 `<YYYYMMDD>-<shortid>-<slug>`, 只在创建时生成一次, 之后**永不**
  跟随改名 —— 改名连带改目录会让已开会话的 cwd、关联登记、外部引用同时失效;
- `shortid` 取 ULID 的**后 8 位** (随机段)。ULID 前 10 位是毫秒时间戳,
  截前 8 位只剩约 256ms 分辨率, 同批创建必撞; 时间序由日期段承担;
- 禁止从目录名反解任何语义: 身份只来自 `project_id`, 位置只来自 `dir_root`,
  时间只来自 `created_at`。本模块只做「生成」, 不提供任何解析函数。
"""

from __future__ import annotations

import os
import time
import unicodedata

#: Crockford base32 字母表 (ULID 规范)。去掉了 I/L/O/U, 避免手抄歧义。
CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

#: ULID 总长度与两段的长度。
ULID_LENGTH = 26
ULID_TIME_CHARS = 10
ULID_RANDOM_CHARS = 16

#: 目录名里可读短标识的长度 (取 ULID 尾部, 40 bit 随机)。
SHORTID_LENGTH = 8

#: 目录名 slug 的字符上限。
SLUG_MAX_CHARS = 24

#: 目录名分段连接符, 同时也是 slug 内唯一保留的标点。
NAME_SEPARATOR = "-"

#: 日期段格式。仅作可读装饰与排序, 权威时间是 `projects.created_at`。
DATE_FORMAT = "%Y%m%d"

#: 显示名长度上限 (PRD「新建项目」: 项目名称最长 100 个字符)。
DISPLAY_NAME_MAX = 100


def _encode(value: int, length: int) -> str:
    """整数 → 定长 Crockford base32。"""

    digits = []
    for _ in range(length):
        digits.append(CROCKFORD_ALPHABET[value & 0x1F])
        value >>= 5
    return "".join(reversed(digits))


def new_project_id(now: float | None = None) -> str:
    """生成一个小写 ULID。

    自己实现而不引依赖: 规则就是「48 位毫秒时间戳 + 80 位随机」两段定长编码,
    为 26 个字符引入一个第三方包不划算。
    """

    milliseconds = int((time.time() if now is None else now) * 1000)
    randomness = int.from_bytes(os.urandom(10), "big")
    return _encode(milliseconds, ULID_TIME_CHARS) + _encode(randomness, ULID_RANDOM_CHARS)


def shortid(project_id: str) -> str:
    """取身份键尾部的随机段作为目录名里的短标识。"""

    return project_id[-SHORTID_LENGTH:]


def slugify(display_name: str) -> str:
    """显示名 → 目录名可用的 slug。

    保留 Unicode 字母与数字 (按字符类别判定, 不分书写系统: 中文项目名不该
    被清成空串), 其余一律替换为连字符, 再压缩、去首尾、截断。
    截断后丢掉尾部残留的组合字符, 避免把一个字拆成半个。
    """

    normalized = unicodedata.normalize("NFC", display_name.strip())
    kept: list[str] = []
    for char in normalized:
        category = unicodedata.category(char)
        if category[0] in {"L", "N", "M"} or char == NAME_SEPARATOR:
            kept.append(char)
            continue
        kept.append(NAME_SEPARATOR)
    collapsed: list[str] = []
    for char in kept:
        if char == NAME_SEPARATOR and (not collapsed or collapsed[-1] == NAME_SEPARATOR):
            continue
        collapsed.append(char)
    truncated = collapsed[:SLUG_MAX_CHARS]
    while truncated and (
        truncated[-1] == NAME_SEPARATOR or unicodedata.category(truncated[-1])[0] == "M"
    ):
        truncated.pop()
    return "".join(truncated)


def directory_name(project_id: str, display_name: str, created_at: float) -> str:
    """项目目录名。slug 清洗后为空时退化为 `<日期>-<shortid>`, 不补占位。"""

    date_segment = time.strftime(DATE_FORMAT, time.localtime(created_at))
    slug = slugify(display_name)
    stem = f"{date_segment}{NAME_SEPARATOR}{shortid(project_id)}"
    return f"{stem}{NAME_SEPARATOR}{slug}" if slug else stem


def normalize_display_name(value: object) -> str:
    """归一显示名: NFC + 去首尾空格。

    **不截断**。空名与超长名都是请求错误, 由调用方判定并转成域错误 ——
    静默截断会让用户输入 100 字得到 64 字项目名却收不到任何提示。
    """

    return unicodedata.normalize("NFC", str(value or "").strip())


__all__ = [
    "DISPLAY_NAME_MAX",
    "SHORTID_LENGTH",
    "SLUG_MAX_CHARS",
    "ULID_LENGTH",
    "directory_name",
    "new_project_id",
    "normalize_display_name",
    "shortid",
    "slugify",
]
