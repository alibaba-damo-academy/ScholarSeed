"""Pipeline control, error classification, and progress accounting."""
from __future__ import annotations

import asyncio
import signal
import sys
import time
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

from utils import _atomic_write_json


VALID_TYPES = ("method", "benchmark", "survey", "theory")
DELTA_IDEATION_TYPES = ("method", "theory")


class FatalLLMError(Exception):
    """Unrecoverable LLM error (auth/account/request configuration)."""

    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(f"FATAL HTTP {code}: {message}")


class PipelineStoppedError(RuntimeError):
    """Work stopped because another paper tripped the pipeline breaker."""


class LLMCallError(RuntimeError):
    """An LLM call exhausted its script-owned retries."""

    def __init__(self, category: str, where: str, attempts: int, detail: str):
        self.category = category
        self.where = where
        self.attempts = attempts
        self.detail = detail
        super().__init__(
            f"LLM call failed after {attempts} attempts ({where}, category={category}): {detail}"
        )


_FATAL_CODES = {401, 402, 403, 422}


@dataclass(frozen=True)
class ErrorInfo:
    category: str
    status_code: Optional[int] = None
    fatal: bool = False
    retry_after: Optional[float] = None


def _status_code(exc: BaseException) -> Optional[int]:
    code = getattr(exc, "status_code", None)
    if isinstance(code, int):
        return code
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    if isinstance(code, int):
        return code
    text = str(exc)
    for candidate in (401, 402, 403, 422, 429, 500, 502, 503, 504):
        if (
            f" {candidate}" in text
            or f"({candidate})" in text
            or f"code: {candidate}" in text.lower()
        ):
            return candidate
    return None


def _retry_after_seconds(exc: BaseException) -> Optional[float]:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or getattr(exc, "headers", None)
    if not headers:
        return None
    try:
        raw = headers.get("retry-after") or headers.get("Retry-After")
    except AttributeError:
        return None
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        try:
            retry_at = parsedate_to_datetime(str(raw))
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def classify_error(exc: BaseException) -> ErrorInfo:
    """Classify retryable failures without depending on one SDK version."""
    code = _status_code(exc)
    if getattr(exc,'runtime_failure',False):
        return ErrorInfo('runtime_client',status_code=code,fatal=True)
    if code in _FATAL_CODES:
        return ErrorInfo("fatal_http", status_code=code, fatal=True)
    if code == 429:
        return ErrorInfo(
            "rate_limit",
            status_code=code,
            retry_after=_retry_after_seconds(exc),
        )
    if code is not None and code >= 500:
        return ErrorInfo("server", status_code=code)
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return ErrorInfo("timeout")
    if isinstance(exc, ValueError) and "json" in str(exc).lower():
        return ErrorInfo("parse")
    explicit_category = getattr(exc, "category", None)
    if isinstance(explicit_category, str) and explicit_category:
        return ErrorInfo(explicit_category, status_code=code)

    try:
        from openai import APIConnectionError

        if isinstance(exc, APIConnectionError):
            return ErrorInfo("connection")
    except ImportError:
        pass
    try:
        import httpx

        if isinstance(exc, (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError)):
            return ErrorInfo("connection")
    except ImportError:
        pass
    return ErrorInfo("unknown", status_code=code)


def _classify_http_error(exc: BaseException) -> tuple[Optional[int], bool]:
    """Backward-compatible HTTP-only view used by existing callers."""
    info = classify_error(exc)
    return info.status_code, info.fatal


def format_exception(
    exc: BaseException,
    *,
    where: Optional[str] = None,
    attempt: Optional[int] = None,
    timeout: Optional[float] = None,
) -> str:
    """Return a non-empty, operationally useful exception description."""
    info = classify_error(exc)
    detail = str(exc).strip()
    if not detail:
        if info.category == "timeout" and timeout is not None:
            detail = f"operation exceeded {timeout:g}s"
        else:
            detail = repr(exc)
    fields = [f"type={type(exc).__name__}", f"category={info.category}"]
    if info.status_code is not None:
        fields.append(f"status_code={info.status_code}")
    if where:
        fields.append(f"where={where}")
    if attempt is not None:
        fields.append(f"attempt={attempt}")
    if timeout is not None:
        fields.append(f"timeout={timeout:g}s")
    return f"{', '.join(fields)}: {detail[:500]}"


class PipelineStop:
    """Circuit breaker over terminal paper outcomes, not concurrent attempts."""

    def __init__(
        self,
        *,
        window_size: int = 20,
        min_samples: int = 10,
        failure_rate_threshold: float = 0.8,
    ):
        if window_size < 1 or min_samples < 1 or min_samples > window_size:
            raise ValueError("require 1 <= min_samples <= window_size")
        self.window_size = window_size
        self.min_samples = min_samples
        self.failure_rate_threshold = failure_rate_threshold
        self.outcomes: deque[tuple[bool, str]] = deque(maxlen=window_size)
        self.lock = asyncio.Lock()
        self.fatal_reason: Optional[str] = None
        self.stop_event = asyncio.Event()
        self.total_terminal_errors = 0

    async def trigger_fatal(self, exc: BaseException, where: str) -> bool:
        """Stop immediately for unrecoverable HTTP errors."""
        async with self.lock:
            info = classify_error(exc)
            self.fatal_reason = (
                f"fatal HTTP {info.status_code} at {where}: "
                f"{format_exception(exc, where=where)}"
            )
            self.stop_event.set()
        return True

    async def record_paper_success(self, paper_id: str) -> None:
        async with self.lock:
            self.outcomes.append((True, "success"))

    async def record_paper_failure(
        self,
        paper_id: str,
        exc: BaseException,
        *,
        where: str = "paper",
    ) -> bool:
        """Record one terminal paper failure and evaluate the sliding window."""
        async with self.lock:
            info = classify_error(exc)
            category = getattr(exc, "category", None) or info.category
            self.total_terminal_errors += 1
            self.outcomes.append((False, category))
            sample_count = len(self.outcomes)
            if sample_count < self.min_samples:
                return False

            failures = [cat for ok, cat in self.outcomes if not ok]
            failure_rate = len(failures) / sample_count
            dominant_category, dominant_count = Counter(failures).most_common(1)[0]
            same_error_rate = dominant_count / sample_count
            all_failed = len(failures) == sample_count
            sustained_same_error = (
                sample_count == self.window_size
                and failure_rate >= self.failure_rate_threshold
                and same_error_rate >= self.failure_rate_threshold
            )
            if not (all_failed or sustained_same_error):
                return False

            self.fatal_reason = (
                "terminal-paper circuit breaker opened: "
                f"{len(failures)}/{sample_count} recent papers failed; "
                f"dominant_category={dominant_category} "
                f"({dominant_count}/{sample_count}); last_paper={paper_id}; "
                f"last_error={format_exception(exc, where=where)}"
            )
            self.stop_event.set()
            return True

    def should_stop(self) -> bool:
        return self.stop_event.is_set()


class ProgressTracker:
    """Manage processing_progress.json with explicit terminal accounting."""

    def __init__(self, progress_path: str, total: int):
        self.path = progress_path
        self.total = total
        self.processed = 0
        self.failed = 0
        self.skipped = 0
        self.cancelled = 0
        self.failed_papers: list[dict] = []
        self.skipped_papers: list[dict] = []
        self.cancelled_papers: list[dict] = []
        self._finalized_ids: set[str] = set()
        self.started_at = datetime.now().isoformat()
        self._start_time = time.time()
        self._write()

    @property
    def accounted(self) -> int:
        return self.processed + self.failed + self.skipped + self.cancelled

    def is_finalized(self, paper_id: str) -> bool:
        return paper_id in self._finalized_ids

    def _claim(self, paper_id: str) -> bool:
        if paper_id in self._finalized_ids:
            return False
        self._finalized_ids.add(paper_id)
        return True

    def _write(self):
        elapsed = time.time() - self._start_time
        remaining = 0
        if self.processed > 0:
            avg_per_paper = elapsed / self.processed
            remaining = avg_per_paper * max(0, self.total - self.accounted)
        progress = {
            "status": "running",
            "total": self.total,
            "processed": self.processed,
            "failed": self.failed,
            "skipped": self.skipped,
            "cancelled": self.cancelled,
            "accounted": self.accounted,
            "started_at": self.started_at,
            "updated_at": datetime.now().isoformat(),
            "elapsed_sec": round(elapsed, 1),
            "estimated_remaining_sec": round(remaining, 1),
            "failed_papers": self.failed_papers[-20:],
            "skipped_papers": self.skipped_papers[-20:],
            "cancelled_papers": self.cancelled_papers[-20:],
        }
        _atomic_write_json(self.path, progress)

    def record_success(self, paper_id: str):
        if self._claim(paper_id):
            self.processed += 1
            self._write()

    def record_failure(self, paper_id: str, error: str, *, category: str = "unknown"):
        if self._claim(paper_id):
            self.failed += 1
            self.failed_papers.append(
                {"paperId": paper_id, "category": category, "error": error}
            )
            self._write()

    def record_skipped(self, paper_id: str, reason: str):
        if self._claim(paper_id):
            self.skipped += 1
            self.skipped_papers.append({"paperId": paper_id, "reason": reason})
            self._write()

    def record_cancelled(self, paper_id: str, reason: str):
        if self._claim(paper_id):
            self.cancelled += 1
            self.cancelled_papers.append({"paperId": paper_id, "reason": reason})
            self._write()

    def finalize(
        self,
        status: str,
        quality_stats: dict,
        *,
        fatal_reason: Optional[str] = None,
    ):
        if self.accounted != self.total:
            raise RuntimeError(
                "processing accounting invariant violated: "
                f"processed({self.processed}) + failed({self.failed}) + "
                f"skipped({self.skipped}) + cancelled({self.cancelled}) "
                f"!= total({self.total})"
            )
        elapsed = time.time() - self._start_time
        progress = {
            "status": status,
            "total": self.total,
            "processed": self.processed,
            "failed": self.failed,
            "skipped": self.skipped,
            "cancelled": self.cancelled,
            "accounted": self.accounted,
            "started_at": self.started_at,
            "completed_at": datetime.now().isoformat(),
            "elapsed_sec": round(elapsed, 1),
            "failed_papers": self.failed_papers,
            "skipped_papers": self.skipped_papers,
            "cancelled_papers": self.cancelled_papers,
            "quality_stats": quality_stats,
        }
        if fatal_reason:
            progress["fatal_reason"] = fatal_reason
        _atomic_write_json(self.path, progress)


class GracefulShutdown:
    """SIGINT/SIGTERM handler for graceful shutdown."""

    def __init__(self):
        self.should_stop = False
        signal.signal(signal.SIGINT, self._handler)
        signal.signal(signal.SIGTERM, self._handler)

    def _handler(self, signum, frame):
        if self.should_stop:
            sys.exit(1)
        self.should_stop = True
        print(
            "\n[SIGINT] Graceful shutdown requested. Waiting for in-flight tasks...",
            file=sys.stderr,
        )
