"""Bounded, immutable result capture across natural browser navigations."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from time import monotonic

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from providers import SearchProvider, SearchSnapshot

MILLISECONDS_PER_SECOND = 1_000
STABILITY_REQUIRED_SAMPLES = 2
STABILITY_INTERVAL_MS = 250
NAVIGATION_CONTEXT_ERRORS = (
    "Execution context was destroyed",
    "Cannot find context with specified id",
)


class ResultPolicy(str, Enum):
    STANDARD = "standard"
    VISIBLE_SNAPSHOT = "visible-snapshot"
    RESOURCE_SESSION = "resource-session"


class CaptureTimeout(PlaywrightTimeoutError):
    def __init__(self, snapshot: SearchSnapshot | None, samples: int) -> None:
        super().__init__("Visible search snapshot did not become ready in time.")
        self.diagnostics = {
            "policy": ResultPolicy.VISIBLE_SNAPSHOT.value,
            "samples": samples,
            "readiness": dict(snapshot.readiness) if snapshot else None,
        }


@dataclass(frozen=True)
class CapturedResult:
    snapshot: SearchSnapshot
    samples: int
    document_changes: int
    elapsed_ms: int
    render_actions: int = 0

    def diagnostics(self) -> dict[str, object]:
        return {
            "policy": ResultPolicy.VISIBLE_SNAPSHOT.value,
            "document_id": self.snapshot.document_id,
            "samples": self.samples,
            "stable_samples": STABILITY_REQUIRED_SAMPLES,
            "document_changes": self.document_changes,
            "elapsed_ms": self.elapsed_ms,
            "readiness": dict(self.snapshot.readiness),
            "render_actions": self.render_actions,
        }


def remaining_ms(deadline: float) -> int:
    remaining = round((deadline - monotonic()) * MILLISECONDS_PER_SECOND)
    if remaining <= 0:
        raise PlaywrightTimeoutError("Visible search snapshot did not become ready in time.")
    return remaining


def capture(
    page: Page, provider: SearchProvider, query: str, limit: int, *, deadline: float
) -> CapturedResult:
    started = monotonic()
    previous: SearchSnapshot | None = None
    document_id: float | None = None
    samples = document_changes = stable_samples = 0
    revealed: set[tuple[float, int]] = set()
    while True:
        try:
            remaining_ms(deadline)
        except PlaywrightTimeoutError as exc:
            raise CaptureTimeout(previous, samples) from exc
        try:
            snapshot = provider.snapshot(page, query, limit)
            rendered = False
            if not snapshot.challenged and snapshot.render_target is not None:
                target = (snapshot.document_id, snapshot.render_target)
                if target not in revealed:
                    provider.reveal(page, snapshot.render_target, remaining_ms(deadline))
                    revealed.add(target)
                    rendered = True
        except PlaywrightError as exc:
            if not any(marker in str(exc) for marker in NAVIGATION_CONTEXT_ERRORS):
                raise
            previous = None
            stable_samples = 0
        else:
            samples += 1
            if document_id is not None and document_id != snapshot.document_id:
                document_changes += 1
            document_id = snapshot.document_id
            if snapshot.challenged:
                return CapturedResult(
                    snapshot,
                    samples,
                    document_changes,
                    round((monotonic() - started) * MILLISECONDS_PER_SECOND),
                    len(revealed),
                )
            if snapshot.ready and not rendered:
                stable_samples = (
                    stable_samples + 1
                    if previous is not None and snapshot.signature == previous.signature
                    else 1
                )
                if stable_samples >= STABILITY_REQUIRED_SAMPLES:
                    return CapturedResult(
                        snapshot,
                        samples,
                        document_changes,
                        round((monotonic() - started) * MILLISECONDS_PER_SECOND),
                        len(revealed),
                    )
            else:
                stable_samples = 0
            previous = snapshot
        page.wait_for_timeout(
            min(
                STABILITY_INTERVAL_MS,
                max(0, round((deadline - monotonic()) * MILLISECONDS_PER_SECOND)),
            )
        )
