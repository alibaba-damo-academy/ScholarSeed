"""Store 名义基类 (refact/01 A.6)。

kv + fts 存储原语的 ABC 名义基类; `SqliteFtsStore` 继承它。可注册/可换后端 (registry)。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class Store(ABC):
    """行式 kv + FTS 检索存储的最小名义面。"""

    @abstractmethod
    def upsert(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def search(self, query: str, *, limit: int = 50) -> list[dict[str, Any]]: ...

    @abstractmethod
    def delete(self, row_id: Any) -> bool: ...

    @abstractmethod
    def count(self) -> int: ...

    @abstractmethod
    def close(self) -> None: ...
