"""Trace server 启动 helper — idempotent spawn + pidfile + port 发现.

主进程调用 `ensure_running()` 一行确保 server 在跑. 不重复 spawn.
设计要点:
- pidfile 存在 + 进程活着 + /healthz 200 → 当作已在跑, 不动
- 否则 spawn `python -m trace.server`, 重定向 stdout/err 到 log
- 不等 server 就绪, 调用方 (UI) 自己 retry. 这样 0.5-1s 启动不阻塞 veda 主流程
"""

from __future__ import annotations

import gzip
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from damoatrace.paths import (
    TRACE_SERVER_LOG,
    TRACE_SERVER_PIDFILE,
    TRACE_SERVER_PORTFILE,
    ensure_home,
)


@dataclass
class TraceServerInfo:
    pid: int
    host: str
    port: int

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}/"


# 子进程直接持有 log 的 fd (stdout/stderr 重定向), 进程内没有写入点可以插滚动,
# 所以收口点只能是 spawn 前: 超过上限就压成一代 .gz, 最老的一代丢掉。server 空闲即退出,
# 每次重启都会过这道门, 因此文件不会无界增长。
LOG_MAX_BYTES = 50 * 1024 * 1024
LOG_BACKUPS = 3
LOG_BACKUP_SUFFIX = ".gz"


def _generation(index: int) -> tuple[Path, Path]:
    """一代日志的两种形态: 正常是 `.n.gz`, 压缩失败时退化成不压缩的 `.n`。"""
    base = f"{TRACE_SERVER_LOG.name}.{index}"
    return (
        TRACE_SERVER_LOG.with_name(base + LOG_BACKUP_SUFFIX),
        TRACE_SERVER_LOG.with_name(base),
    )


def _rotate_log() -> None:
    """滚动 + 压缩 trace server 日志。任何失败都只是不滚, 绝不拦住 spawn。"""
    try:
        if TRACE_SERVER_LOG.stat().st_size < LOG_MAX_BYTES:
            return
        for oldest in _generation(LOG_BACKUPS):
            oldest.unlink(missing_ok=True)
        for index in range(LOG_BACKUPS - 1, 0, -1):
            for older, newer in zip(_generation(index), _generation(index + 1)):
                if older.exists():
                    older.rename(newer)
        archived, uncompressed = _generation(1)
        try:
            # 先压完再删原文件: 压缩中途失败时日志仍在原处, 不会凭空少一代。
            with TRACE_SERVER_LOG.open("rb") as raw, gzip.open(archived, "wb") as out:
                shutil.copyfileobj(raw, out)
            TRACE_SERVER_LOG.unlink()
        except OSError:
            # 压不动 (磁盘满是现实原因) 就退回不压缩的一代: rename 不额外占空间,
            # 既保住这一代日志, 也不会留下一个每次 spawn 都重压一遍的超限文件。
            archived.unlink(missing_ok=True)
            TRACE_SERVER_LOG.rename(uncompressed)
    except OSError:
        pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False
    return True


def _read_pidfile() -> Optional[int]:
    if not TRACE_SERVER_PIDFILE.exists():
        return None
    try:
        return int(TRACE_SERVER_PIDFILE.read_text().strip())
    except (OSError, ValueError):
        return None


def _read_portfile() -> Optional[tuple[str, int]]:
    if not TRACE_SERVER_PORTFILE.exists():
        return None
    try:
        raw = TRACE_SERVER_PORTFILE.read_text().strip()
        host, port_s = raw.rsplit(":", 1)
        return host, int(port_s)
    except (OSError, ValueError):
        return None


def _port_reachable(host: str, port: int, timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def status() -> Optional[TraceServerInfo]:
    """返回当前 server 信息, 不在跑则 None."""
    pid = _read_pidfile()
    hp = _read_portfile()
    if pid is None or hp is None:
        return None
    if not _pid_alive(pid):
        return None
    host, port = hp
    return TraceServerInfo(pid=pid, host=host, port=port)


def _spawn(idle_seconds: int) -> int:
    """Fork detached `python -m trace.server`. 返回 child pid."""
    ensure_home()
    TRACE_SERVER_LOG.parent.mkdir(parents=True, exist_ok=True)
    _rotate_log()
    log_fp = open(TRACE_SERVER_LOG, "a", buffering=1)
    # 用当前 python (venv 里的) 起 server, 共享同一个 import path
    cmd = [sys.executable, "-m", "damoatrace.server.http", "--idle-seconds", str(idle_seconds)]
    proc = subprocess.Popen(
        cmd,
        stdout=log_fp,
        stderr=log_fp,
        stdin=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,  # 脱离当前 process group
    )
    return proc.pid


def ensure_running(
    *, idle_seconds: int = 1800, wait_ready: float = 0.0
) -> Optional[TraceServerInfo]:
    """如果 server 没跑就 spawn. 已跑直接返回 info.

    wait_ready > 0 时 (秒), 轮询 portfile + reachable; 0 表示不等 (异步启动, 调用方 retry).
    """
    info = status()
    if info is not None and _port_reachable(info.host, info.port):
        return info

    # stale pidfile cleanup
    for p in (TRACE_SERVER_PIDFILE, TRACE_SERVER_PORTFILE):
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass

    try:
        _spawn(idle_seconds=idle_seconds)
    except Exception:  # noqa: BLE001
        return None

    if wait_ready <= 0:
        return None

    deadline = time.monotonic() + wait_ready
    while time.monotonic() < deadline:
        info = status()
        if info and _port_reachable(info.host, info.port):
            return info
        time.sleep(0.05)
    return status()


def stop() -> bool:
    """SIGTERM 关掉 server. 返回是否成功发送."""
    pid = _read_pidfile()
    if pid is None or not _pid_alive(pid):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
        return True
    except OSError:
        return False
