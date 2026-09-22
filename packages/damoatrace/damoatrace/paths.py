"""Trace-owned path configuration; embedding products supply their evidence root."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

HOME_ENV = "DAMOATRACE_HOME"
LEDGER_ROOT_ENV = "DAMOATRACE_LEDGER_ROOT"
DEFAULT_HOME_DIRNAME = ".damoatrace"
LOGS_DIRNAME = "logs"
TRACE_DIRNAME = "trace"
APP_DIRNAME = "app"
METRICS_DIRNAME = "metrics"
INDEX_FILENAME = "index.sqlite3"
SERVER_PID_FILENAME = "trace_server.pid"
SERVER_PORT_FILENAME = "trace_server.port"
SERVER_LOG_FILENAME = "trace_server.log"


@dataclass(frozen=True)
class TracePaths:
    home: Path
    trace: Path
    app: Path
    metrics: Path
    ledger_root: Path | None = None

    @classmethod
    def from_home(cls, home: Path, *, ledger_root: Path | None = None) -> "TracePaths":
        root = home.expanduser().resolve()
        logs = root / LOGS_DIRNAME
        return cls(
            root, logs / TRACE_DIRNAME, logs / APP_DIRNAME, logs / METRICS_DIRNAME, ledger_root
        )

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> "TracePaths":
        values = os.environ if environ is None else environ
        configured = values.get(HOME_ENV, "").strip()
        ledger = values.get(LEDGER_ROOT_ENV, "").strip()
        return cls.from_home(
            Path(configured) if configured else Path.home() / DEFAULT_HOME_DIRNAME,
            ledger_root=Path(ledger).expanduser().resolve() if ledger else None,
        )

    @property
    def index(self) -> Path:
        return self.trace / INDEX_FILENAME

    @property
    def server_pid(self) -> Path:
        return self.home / SERVER_PID_FILENAME

    @property
    def server_port(self) -> Path:
        return self.home / SERVER_PORT_FILENAME

    @property
    def server_log(self) -> Path:
        return self.home / LOGS_DIRNAME / SERVER_LOG_FILENAME


# CLI/server process configuration. Store instances may receive different explicit paths.
PATHS = TracePaths.from_environment()
TRACE_DIR = PATHS.trace
APP_LOG_DIR = PATHS.app
METRICS_DIR = PATHS.metrics
TRACE_SERVER_PIDFILE = PATHS.server_pid
TRACE_SERVER_PORTFILE = PATHS.server_port
TRACE_SERVER_LOG = PATHS.server_log


def ensure_home() -> Path:
    PATHS.home.mkdir(parents=True, exist_ok=True)
    return PATHS.home
