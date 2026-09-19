"""Trace UI server — 本地零依赖 trace 浏览后端 + 单文件 web UI.

设计原则:
- stdlib only (http.server / threading / json), 不引入 FastAPI / uvicorn 等额外进程开销
- 完全被动: 没请求就不干活 (无后台 worker / 不轮询文件)
- idle timeout 自杀 (默认 1800s 无请求即退出), 不长期占资源
- 文件读取按 (path, size) 缓存, append-only jsonl 重读时跳过已读尾部

启动:
    python -m core.trace.server [--port N] [--host 127.0.0.1] [--idle-seconds 1800]

通常由 `veda` 主进程 spawn (见 core/trace/launcher.py); 也可以独立跑.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import signal
import socket
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

from damoatrace.data.store import TraceStore
from damoatrace.evidence.context import context_evidence
from damoatrace.evidence.digest import digest as _digest_text
from damoatrace.evidence.visible import visible_evidence
from damoatrace.paths import (
    TRACE_DIR,
    TRACE_SERVER_PIDFILE,
    TRACE_SERVER_PORTFILE,
    ensure_home,
)
from damoatrace.server.index_html import INDEX_HTML

# 数据与聚合全部来自共享数据层 (proposal 26 §5.1): CLI/HTTP/bench 同源同数
from damoatrace.utils import _parse_since

# ───────────────────────── HTTP handler ─────────────────────────


class _TraceHandler(BaseHTTPRequestHandler):
    server_version = "veda-trace/0.1"

    # 由 server attach 上来
    store: TraceStore
    activity: "Activity"

    def log_message(self, format: str, *args: Any) -> None:
        # 静音访问日志 (默认会打到 stderr, 太吵). 真要 debug 再开.
        pass

    def _send_json(self, code: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, ctype: str, *, filename: Optional[str] = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_export(self, sid: str, fmt: str) -> None:
        """导出 session 的 events. fmt = jsonl | json | bundle (zip)."""
        events = self.store.session_events(sid)
        safe_sid = "".join(c if c.isalnum() or c in "-_" else "_" for c in sid)[:32]
        if fmt == "json":
            body = json.dumps(
                {"session_id": sid, "events": events}, ensure_ascii=False, indent=2, default=str
            ).encode("utf-8")
            self._send_bytes(
                body, "application/json; charset=utf-8", filename=f"trace_{safe_sid}.json"
            )
            return
        if fmt == "bundle":

            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr(
                    f"trace_{safe_sid}/events.jsonl",
                    "\n".join(json.dumps(e, ensure_ascii=False, default=str) for e in events)
                    + "\n",
                )
                tree = self.store.session_tree(sid)
                zf.writestr(
                    f"trace_{safe_sid}/tree.json",
                    json.dumps(tree, ensure_ascii=False, indent=2, default=str),
                )
                usage = self.store.session_usage(sid)
                zf.writestr(
                    f"trace_{safe_sid}/usage.json",
                    json.dumps(usage, ensure_ascii=False, indent=2, default=str),
                )
                # digest.txt — call digest module if available, fallback to skip
                try:
                    all_evs = self.store.all_events()
                    txt = _digest_text(all_evs, sid, include_content=False)
                    zf.writestr(f"trace_{safe_sid}/digest.txt", txt)
                except Exception:  # noqa: BLE001
                    pass
                zf.writestr(
                    f"trace_{safe_sid}/meta.json",
                    json.dumps(
                        {
                            "session_id": sid,
                            "event_count": len(events),
                            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                )
            self._send_bytes(buf.getvalue(), "application/zip", filename=f"trace_{safe_sid}.zip")
            return
        # default: jsonl
        body = (
            "\n".join(json.dumps(e, ensure_ascii=False, default=str) for e in events) + "\n"
        ).encode("utf-8")
        self._send_bytes(
            body, "application/x-ndjson; charset=utf-8", filename=f"trace_{safe_sid}.jsonl"
        )

    def do_GET(self) -> None:  # noqa: N802
        self.activity.touch()
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/", "/ui"):
                self._send_html(INDEX_HTML)
                return
            if path == "/healthz":
                self._send_json(200, {"ok": True})
                return
            if path == "/api/overview":
                self._send_json(200, self.store.overview())
                return
            if path == "/api/logs":
                qs = parse_qs(parsed.query)
                since = None
                if qs.get("since"):
                    since = _parse_since(qs["since"][0])
                self._send_json(
                    200,
                    self.store.logs(
                        q=(qs.get("q") or [""])[0],
                        level=(qs.get("level") or [""])[0],
                        session=(qs.get("session") or [""])[0],
                        since=since,
                        limit=int((qs.get("limit") or ["500"])[0]),
                    ),
                )
                return
            if path == "/api/metrics":
                qs = parse_qs(parsed.query)
                self._send_json(200, self.store.metrics(session=(qs.get("session") or [""])[0]))
                return
            if path == "/api/sessions":
                self._send_json(200, {"sessions": self.store.sessions()})
                return
            if path.startswith("/api/sessions/"):
                rest = path[len("/api/sessions/") :]
                parts = rest.split("/")
                sid = parts[0]
                if len(parts) == 4 and parts[1] == "context" and parts[2] == "items":
                    item = self.store.session_context_item(sid, unquote(parts[3]))
                    if item is None:
                        self._send_json(404, {"error": "context item not found"})
                    else:
                        self._send_json(200, item)
                    return
                if len(parts) == 4 and parts[1] == "context" and parts[2] == "visible":
                    index = self.store.session_visible_index(sid, unquote(parts[3]))
                    if index is None:
                        self._send_json(404, {"error": "visible index not found"})
                    else:
                        self._send_json(200, index)
                    return
                if len(parts) == 3 and parts[1] == "context" and parts[2] == "items":
                    self._send_json(200, self.store.session_context_items(sid))
                    return
                if len(parts) == 3 and parts[1] == "context" and parts[2] == "channels":
                    self._send_json(200, self.store.session_context_channels(sid))
                    return
                if len(parts) == 3 and parts[1] == "context" and parts[2] == "visible":
                    self._send_json(
                        200,
                        visible_evidence(self.store.session_events(sid), session_id=sid),
                    )
                    return
                if len(parts) == 2 and parts[1] == "context":
                    self._send_json(
                        200,
                        context_evidence(self.store.session_events(sid), session_id=sid),
                    )
                    return
                if len(parts) == 2 and parts[1] == "traces":
                    self._send_json(200, {"traces": self.store.session_traces(sid)})
                    return
                if len(parts) == 2 and parts[1] == "events":
                    self._send_json(200, {"events": self.store.session_events(sid)})
                    return
                if len(parts) == 2 and parts[1] == "tree":
                    self._send_json(200, {"tree": self.store.session_tree(sid)})
                    return
                if len(parts) == 2 and parts[1] == "usage":
                    self._send_json(200, {"usage": self.store.session_usage(sid)})
                    return
                if len(parts) == 2 and parts[1] == "export":
                    qs = parse_qs(parsed.query)
                    fmt = (qs.get("format") or ["jsonl"])[0]
                    self._send_export(sid, fmt)
                    return
            self._send_json(404, {"error": "not found", "path": path})
        except Exception as e:  # noqa: BLE001
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})


# ───────────────────────── idle 监控 ─────────────────────────


class Activity:
    """记录最近一次活跃时间. 后台线程定期检查, 超时退出."""

    def __init__(self, idle_seconds: int):
        self.idle_seconds = idle_seconds
        self._last = time.monotonic()
        self._lock = threading.Lock()
        self._stop = threading.Event()

    def touch(self) -> None:
        with self._lock:
            self._last = time.monotonic()

    def idle_for(self) -> float:
        with self._lock:
            return time.monotonic() - self._last

    def watch(self, on_idle) -> None:
        def _loop():
            while not self._stop.wait(timeout=30):
                if self.idle_for() > self.idle_seconds:
                    on_idle()
                    return

        t = threading.Thread(target=_loop, name="trace-idle-watch", daemon=True)
        t.start()

    def stop(self) -> None:
        self._stop.set()


# ───────────────────────── server lifecycle ─────────────────────────


def _free_port(host: str) -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind((host, 0))
    port = s.getsockname()[1]
    s.close()
    return port


def run_server(
    *,
    host: str = "127.0.0.1",
    port: Optional[int] = None,
    trace_dir: Optional[Path] = None,
    idle_seconds: int = 1800,
    write_pidfile: bool = True,
) -> None:
    """启动 server (阻塞). idle_seconds 内无请求自动退出."""
    ensure_home()
    tdir = trace_dir or TRACE_DIR
    tdir.mkdir(parents=True, exist_ok=True)

    if port is None or port == 0:
        port = _free_port(host)

    store = TraceStore(tdir)
    activity = Activity(idle_seconds=idle_seconds)

    handler_cls = type(
        "BoundHandler",
        (_TraceHandler,),
        {"store": store, "activity": activity},
    )
    httpd = ThreadingHTTPServer((host, port), handler_cls)

    def _on_idle():
        try:
            httpd.shutdown()
        except Exception:
            pass

    activity.watch(_on_idle)

    if write_pidfile:
        try:
            TRACE_SERVER_PIDFILE.write_text(str(os.getpid()))
            TRACE_SERVER_PORTFILE.write_text(f"{host}:{port}")
        except OSError:
            pass

    def _term(_signum, _frame):
        # signal handler 跟 serve_forever 同线程; 直接 shutdown 会死锁
        # (shutdown 等 serve_forever 退出, 但 serve_forever 卡在 signal handler).
        # 起 daemon 线程异步 shutdown, handler 立刻返回.
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)

    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        activity.stop()
        httpd.server_close()
        if write_pidfile:
            for p in (TRACE_SERVER_PIDFILE, TRACE_SERVER_PORTFILE):
                try:
                    if p.exists():
                        p.unlink()
                except OSError:
                    pass


# embedded HTML UI 抽到 damoatrace/server/index_html.py (P2-01 拆分超大文件)


# ───────────────────────── CLI ─────────────────────────


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="veda trace UI server")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=0, help="0 = pick a free port (default)")
    p.add_argument("--idle-seconds", type=int, default=1800)
    p.add_argument("--trace-dir", default=None)
    p.add_argument(
        "--no-pidfile", action="store_true", help="do not write pidfile/portfile (for manual runs)"
    )
    args = p.parse_args(argv)
    tdir = Path(args.trace_dir).expanduser() if args.trace_dir else None
    run_server(
        host=args.host,
        port=args.port or None,
        trace_dir=tdir,
        idle_seconds=args.idle_seconds,
        write_pidfile=not args.no_pidfile,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
