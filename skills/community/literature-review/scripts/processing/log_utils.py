"""
日志配置 — setup_logging
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from config import PROJECT_ROOT

# ---- Logging setup (统一写入 workspace/session.log) ----
_SESSION_LOG = str(PROJECT_ROOT / "session.log")


def setup_logging(log_path=_SESSION_LOG):
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        "%(asctime)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root = logging.getLogger()
    root.name = "paper_card"
    root.setLevel(logging.DEBUG)
    root.handlers.clear()
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.DEBUG)
    sh.setFormatter(fmt)
    root.addHandler(sh)
    fh = logging.FileHandler(log_path, mode="a", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    root.addHandler(fh)
    for noisy in ("httpx", "httpcore", "openai", "urllib3", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
