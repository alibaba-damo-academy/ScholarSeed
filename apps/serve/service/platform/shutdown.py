"""Instance-owned shutdown deadline and resource-owner diagnostics."""

from __future__ import annotations

import json
import logging
import math
import os
import time
from contextlib import contextmanager
from enum import StrEnum
from typing import Protocol

DEFAULT_SHUTDOWN_SECONDS = 30.0
logger = logging.getLogger(__name__)


class GracefulTimeout(Protocol):
    """HTTP shutdown accepts the fractional seconds consumed by asyncio.wait."""

    timeout_graceful_shutdown: float | None


class ShutdownStage(StrEnum):
    CONTROL = "parent-control"
    OBSERVERS = "observers"
    HTTP = "http-lifespan"
    STORAGE = "storage"
    DIAGNOSTICS = "diagnostics"
    TURNS = "turns"
    RUNTIME = "runtime"
    SESSIONS = "sessions"
    SKILLS = "skills"
    MODELS = "models"
    SUBSCRIPTIONS = "subscriptions"
    FEEDBACK = "feedback"
    OPERATIONS = "operations"
    ADMISSION = "admission"
    INDEXES = "pdf-indexes"
    LOCAL = "local-listener"
    BROWSER = "browser-routes"
    HISTORY = "browser-history-routes"


class Shutdown:
    def __init__(self, seconds: float = DEFAULT_SHUTDOWN_SECONDS) -> None:
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError("shutdown timeout must be positive and finite")
        self.seconds = seconds
        self.started: float | None = None
        self.deadline: float | None = None

    def start(self, reason: str) -> None:
        if self.started is not None:
            return
        self.started = time.monotonic()
        self.deadline = self.started + self.seconds
        self.event("requested", reason=reason)

    @property
    def remaining(self) -> float:
        return self.seconds if self.deadline is None else max(0.0, self.deadline - time.monotonic())

    def event(self, event: str, *, failed: bool = False, **fields) -> None:
        payload = {
            "event": event,
            "process_id": os.getpid(),
            "budget_ms": round(self.seconds * 1000),
            "elapsed_ms": round((time.monotonic() - self.started) * 1000) if self.started else 0,
            "remaining_ms": round(self.remaining * 1000),
            **fields,
        }
        logger.log(
            logging.ERROR if failed else logging.INFO,
            "serve_shutdown %s",
            json.dumps(payload, sort_keys=True),
        )

    @contextmanager
    def stage(self, stage: str):
        self.start("lifespan")
        started = time.monotonic()
        self.event("stage-start", stage=str(stage))
        try:
            yield
        except BaseException as error:
            self.event(
                "stage-failed",
                failed=True,
                stage=str(stage),
                error_type=type(error).__name__,
                stage_elapsed_ms=round((time.monotonic() - started) * 1000),
            )
            raise
        else:
            self.event(
                "stage-end",
                stage=str(stage),
                stage_elapsed_ms=round((time.monotonic() - started) * 1000),
            )
