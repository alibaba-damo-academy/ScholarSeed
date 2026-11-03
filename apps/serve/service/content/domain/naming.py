"""项目身份与目录名生成 (content 域, 开发 1 拥有)。

项目身份规则与旧目录名兼容工具:

- `project_id` 是 26 位小写 ULID, 且是**唯一**身份键;
- 旧目录名是 `<YYYYMMDD>-<shortid>-<slug>`；新项目由 ProjectRegistry 按名称
  和重名后缀选择目录。目录只在创建时生成一次, 之后**永不**
  跟随改名 —— 改名连带改目录会让已开会话的 cwd、关联登记、外部引用同时失效;
- `shortid` 取 ULID 的**后 8 位** (随机段)。ULID 前 10 位是毫秒时间戳,
  截前 8 位只剩约 256ms 分辨率, 同批创建必撞; 时间序由日期段承担;
- 禁止从目录名反解任何语义: 身份只来自 `project_id`, 位置只来自 `dir_root`,
  时间只来自 `created_at`。本模块只做「生成」, 不提供任何解析函数。
"""

from __future__ import annotations

import hmac
import math
import os
import re
import time
import unicodedata
from pathlib import PureWindowsPath

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

DEFAULT_PROJECT_NAME = "书深默认项目"
PROJECT_DIRECTORY_FALLBACK = "project"
PROJECT_DIRECTORY_FIRST_SUFFIX = 2


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


def planned_project_id(now: float, attempt: str, root: str) -> str:
    """Allocate repeatable ULID entropy within one native update attempt.

    This is registration-time allocation only. Existing identity is always read
    from the catalog; renames and later attempts never recompute it from a path.
    """
    if (
        type(now) not in (int, float)
        or not math.isfinite(now)
        or not 0 < now < (2**48) / 1000
        or not isinstance(attempt, str)
        or re.fullmatch(r"[a-f0-9]{64}", attempt) is None
        or not isinstance(root, str)
        or not root
        or "\0" in root
    ):
        raise ValueError("invalid project identity plan")
    entropy = hmac.digest(
        bytes.fromhex(attempt), b"scholarseed-legacy-project-v1\0" + root.encode("utf-8"), "sha256"
    )[:10]
    return _encode(int(now * 1000), ULID_TIME_CHARS) + _encode(
        int.from_bytes(entropy, "big"), ULID_RANDOM_CHARS
    )


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


def creation_stem(name: str) -> str:
    """Build the shared, cross-platform stem for an automatically created project."""
    stem = slugify(name) or PROJECT_DIRECTORY_FALLBACK
    if PureWindowsPath(stem).is_reserved():
        stem = f"{PROJECT_DIRECTORY_FALLBACK}-{stem}"
    return stem


def creation_name_matches(requested: str, display: str, directory: str) -> bool:
    """Validate generated names while retaining readable pre-change creation journals."""
    normalized = normalize_display_name(requested)
    if not normalized or len(normalized) > DISPLAY_NAME_MAX:
        return False
    if display == normalized:
        return True
    if display != directory:
        return False
    stem = creation_stem(normalized)
    if directory == stem:
        return True
    prefix = f"{stem}-"
    suffix = directory.removeprefix(prefix)
    return (
        directory.startswith(prefix)
        and re.fullmatch(r"[1-9][0-9]*", suffix) is not None
        and len(display) <= DISPLAY_NAME_MAX
        and int(suffix) >= PROJECT_DIRECTORY_FIRST_SUFFIX
    )


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
    "creation_stem",
    "creation_name_matches",
    "directory_name",
    "new_project_id",
    "planned_project_id",
    "normalize_display_name",
    "shortid",
    "slugify",
]
