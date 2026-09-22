"""store 内 stdlib-only 纯函数 (L3/L7): sql 标识符白名单、值 coerce、FTS5 MATCH 转义。"""

from __future__ import annotations

import re
from typing import Any, Optional

_TOKEN_RE = re.compile(r"[^\s]+")


def ident(name: str) -> str:
    """白名单标识符 (表/列名), 仅字母数字下划线, 防注入。"""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name or ""):
        raise ValueError(f"unsafe sql identifier: {name!r}")
    return name


def coerce(v: Any) -> Any:
    """FTS5 列只接受 str/bytes/int/float/None; 其余转 str。"""
    if v is None or isinstance(v, (str, bytes, int, float)):
        return v
    return str(v)


def sanitize_match(
    query: str, *, column: Optional[str] = None, prefix: bool = False, match_any: bool = False
) -> str:
    """任意关键词串 → 安全 FTS5 MATCH 表达式 (token 双引号 phrase, AND/OR 连接)。"""
    tokens = _TOKEN_RE.findall(query or "")
    if not tokens:
        return ""
    col_pfx = f"{ident(column)} : " if column else ""
    suffix = "*" if prefix else ""
    terms = [col_pfx + '"' + t.replace('"', '""') + '"' + suffix for t in tokens]
    return (" OR " if match_any else " ").join(terms)
