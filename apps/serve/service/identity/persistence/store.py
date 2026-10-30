"""auth.json 共享文件存储 — 原子写入与读-改-写互斥锁。

User records and bearer tokens share auth.json. Unknown historical fields are
preserved by read-modify-write operations.
"""

from __future__ import annotations

import errno
import json
import os
import secrets
import threading
import time
from contextlib import contextmanager
from types import ModuleType
from typing import Any, Dict, Iterator

from service.paths import AUTH_FILE

msvcrt: ModuleType
fcntl: ModuleType
if os.name == "nt":
    import msvcrt
else:
    import fcntl

_AUTH_LOCK_FILENAME = "auth.lock"
AUTH_LOCK_TIMEOUT_SECONDS = 10.0
AUTH_LOCK_RETRY_SECONDS = 0.05
_process_lock = threading.Lock()


@contextmanager
def auth_file_lock() -> Iterator[None]:
    """Serialize auth.json read-modify-write across threads and processes.

    锁加在专用 ``auth.lock`` 上而非 auth.json 自身: ``save_auth_data`` 经
    os.replace 整文件替换, 换 inode 会使数据文件上的 flock 失效; 锁文件
    永不替换, 跨进程互斥才成立。非可重入, 不得嵌套获取。
    """

    with _process_lock:
        lock_path = AUTH_FILE.parent / _AUTH_LOCK_FILENAME
        AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a+b") as lock_file:
            deadline = time.monotonic() + AUTH_LOCK_TIMEOUT_SECONDS
            while True:
                try:
                    if os.name == "nt":
                        os.lseek(lock_file.fileno(), 0, os.SEEK_SET)
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN):
                        raise
                    if time.monotonic() >= deadline:
                        raise TimeoutError("auth transaction is busy") from error
                    time.sleep(AUTH_LOCK_RETRY_SECONDS)
            # Closing this operation's descriptor releases the kernel lock,
            # including when the transaction body raises. Never unlink it.
            yield


def load_auth_data() -> Dict[str, Any]:
    try:
        payload = AUTH_FILE.read_bytes()
    except FileNotFoundError:
        payload = None
    return decode_auth_data(payload)


def decode_auth_data(payload: bytes | None) -> Dict[str, Any]:
    """Decode the identity file or an occupied startup snapshot without writing."""
    if payload is None:
        return {"users": [], "tokens": []}
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("auth_invalid_format") from error
    if not isinstance(data, dict) or any(
        not isinstance(data.get(name), list) or any(not isinstance(row, dict) for row in data[name])
        for name in ("users", "tokens")
    ):
        raise ValueError("auth_invalid_format")
    return data


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


__all__ = ["auth_file_lock", "decode_auth_data", "load_auth_data", "save_auth_data"]
