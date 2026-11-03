"""Real App Server protocol transport shared by native integration contracts."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

APP_SERVER_TIMEOUT_SECONDS = 15.0
APP_SERVER_CLOSE_SECONDS = 3.0


class AppServer:
    def __init__(
        self,
        executable: str,
        cwd: Path,
        environment: dict[str, str],
        arguments: tuple[str, ...],
    ) -> None:
        self._process = subprocess.Popen(
            [executable, *arguments, "app-server", "--listen", "stdio://"],
            cwd=cwd,
            env={**os.environ, **environment},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self._errors: queue.Queue[str] = queue.Queue()
        self._stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()
        self._request_id = 0

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._request_id += 1
        request_id = self._request_id
        self._write({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + APP_SERVER_TIMEOUT_SECONDS
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Empty()
                payload = self._messages.get(timeout=remaining)
                if payload.get("id") != request_id:
                    continue
                if "error" in payload:
                    raise RuntimeError(json.dumps(payload["error"], ensure_ascii=False))
                return dict(payload.get("result") or {})
        except queue.Empty as error:
            errors = list(self._errors.queue)
            raise RuntimeError(
                "; ".join(errors) or f"App Server request timed out: {method}"
            ) from error

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._write({"method": method, "params": params})

    def close(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
        try:
            self._process.wait(timeout=APP_SERVER_CLOSE_SECONDS)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=APP_SERVER_CLOSE_SECONDS)
        self._stdout_thread.join(timeout=APP_SERVER_CLOSE_SECONDS)
        self._stderr_thread.join(timeout=APP_SERVER_CLOSE_SECONDS)
        for stream in (self._process.stdin, self._process.stdout, self._process.stderr):
            if stream is not None:
                stream.close()

    def _write(self, payload: dict[str, Any]) -> None:
        assert self._process.stdin is not None
        self._process.stdin.write(json.dumps(payload) + "\n")
        self._process.stdin.flush()

    def _read_stdout(self) -> None:
        assert self._process.stdout is not None
        for line in self._process.stdout:
            self._messages.put(json.loads(line))

    def _read_stderr(self) -> None:
        assert self._process.stderr is not None
        for line in self._process.stderr:
            self._errors.put(line.strip())
