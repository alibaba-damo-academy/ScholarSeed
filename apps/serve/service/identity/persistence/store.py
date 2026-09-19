"""auth.json 共享文件存储 — 原子写入与读-改-写互斥锁。

User records and bearer tokens share auth.json. Unknown historical fields are
preserved by read-modify-write operations.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
from contextlib import contextmanager
from typing import Any, Dict, Iterator

try:  # 跨进程互斥依赖 flock; 无 flock 平台 (Windows) 退化为仅进程内锁
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

from service.paths import AUTH_FILE

_AUTH_LOCK_FILENAME = "auth.lock"
_process_lock = threading.Lock()


@contextmanager
def auth_file_lock() -> Iterator[None]:
    """auth.json 读-改-写互斥: 进程内线程锁 + 跨进程 flock。

    锁加在专用 ``auth.lock`` 上而非 auth.json 自身: ``save_auth_data`` 经
    os.replace 整文件替换, 换 inode 会使数据文件上的 flock 失效; 锁文件
    永不替换, 跨进程互斥才成立。非可重入, 不得嵌套获取。
    """

    with _process_lock:
        lock_path = AUTH_FILE.parent / _AUTH_LOCK_FILENAME
        AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a", encoding="utf-8") as lock_file:
            if fcntl is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def load_auth_data() -> Dict[str, Any]:
    try:
        return json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"users": [], "tokens": []}


def save_auth_data(data: Dict[str, Any]) -> None:
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    # 临时文件名含随机后缀: 并发写不得共用同一 tmp, 否则互相替换丢文件
    tmp = AUTH_FILE.with_suffix(f".{secrets.token_hex(4)}.json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, AUTH_FILE)
    try:
        AUTH_FILE.chmod(0o600)
    except OSError:
        pass


__all__ = ["auth_file_lock", "load_auth_data", "save_auth_data"]
