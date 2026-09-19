"""Historical duration estimates for long-running skill turns."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from statistics import median
from typing import Mapping

from service.chat.constants import (
    PRODUCT_EVENT_SKILL_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
)
from service.chat.persistence.events import ProductEventRecord, ProductEventStore

ESTIMATE_EVENT_SCAN_LIMIT = 20_000
ESTIMATE_SAMPLE_LIMIT = 20
ESTIMATE_MINIMUM_SECONDS = 60
ESTIMATE_MAXIMUM_SECONDS = 6 * 60 * 60
ESTIMATE_SINGLE_LOW_FACTOR = 0.75
ESTIMATE_SINGLE_HIGH_FACTOR = 1.35
ESTIMATE_FEW_LOW_FACTOR = 0.85
ESTIMATE_FEW_HIGH_FACTOR = 1.15
ESTIMATE_CONFIDENCE_MEDIUM_SAMPLES = 4
ESTIMATE_CONFIDENCE_HIGH_SAMPLES = 8
ESTIMATE_MINIMUM_SPREAD_SECONDS = 5 * 60
SLR_CODEX_BASELINE_LOWER_SECONDS = 30 * 60
SLR_CODEX_BASELINE_UPPER_SECONDS = 45 * 60
TERMINAL_EVENT_KINDS = (PRODUCT_EVENT_TURN_COMPLETED,)


@dataclass(frozen=True)
class SkillDurationEstimate:
    """A robust wall-clock range backed by completed product turns."""

    lower_seconds: int
    upper_seconds: int
    sample_count: int
    confidence: str
    basis: str = "historical_skill_turns"

    def payload(self) -> dict[str, int | str]:
        return asdict(self)


DEFAULT_ESTIMATE_POLICIES: Mapping[str, SkillDurationEstimate] = {
    "literature-review": SkillDurationEstimate(
        lower_seconds=SLR_CODEX_BASELINE_LOWER_SECONDS,
        upper_seconds=SLR_CODEX_BASELINE_UPPER_SECONDS,
        sample_count=0,
        confidence="low",
        basis="product_baseline",
    )
}


def _skill_name(event: ProductEventRecord) -> str:
    return str(event.payload.get("skill") or "").strip()


def _turn_key(event: ProductEventRecord) -> tuple[str, str] | None:
    turn_id = str(event.vendor_turn_id or "").strip()
    return (event.session_id, turn_id) if turn_id else None


def _bounded_duration(started_at: float, completed_at: float) -> int | None:
    duration = round(completed_at - started_at)
    if duration < ESTIMATE_MINIMUM_SECONDS or duration > ESTIMATE_MAXIMUM_SECONDS:
        return None
    return duration


def _samples(
    events: tuple[ProductEventRecord, ...],
    skill: str,
    excluded_session_id: str,
) -> list[int]:
    starts: dict[tuple[str, str], float] = {}
    samples: list[int] = []
    for event in events:
        key = _turn_key(event)
        if key is None or event.session_id == excluded_session_id:
            continue
        if event.kind == PRODUCT_EVENT_SKILL_STARTED and _skill_name(event) == skill:
            starts.setdefault(key, event.created_at)
            continue
        if event.kind not in TERMINAL_EVENT_KINDS or key not in starts:
            continue
        duration = _bounded_duration(starts.pop(key), event.created_at)
        if duration is not None:
            samples.append(duration)
    return samples[-ESTIMATE_SAMPLE_LIMIT:]


def _range(samples: list[int]) -> tuple[int, int]:
    ordered = sorted(samples)
    center = int(median(ordered))
    if len(ordered) == 1:
        lower = round(center * ESTIMATE_SINGLE_LOW_FACTOR)
        upper = round(center * ESTIMATE_SINGLE_HIGH_FACTOR)
    elif len(ordered) < ESTIMATE_CONFIDENCE_MEDIUM_SAMPLES:
        lower = round(ordered[0] * ESTIMATE_FEW_LOW_FACTOR)
        upper = round(ordered[-1] * ESTIMATE_FEW_HIGH_FACTOR)
    else:
        lower = ordered[(len(ordered) - 1) // 4]
        upper = ordered[((len(ordered) - 1) * 3) // 4]
    if upper - lower < ESTIMATE_MINIMUM_SPREAD_SECONDS:
        half_spread = ESTIMATE_MINIMUM_SPREAD_SECONDS // 2
        lower = max(ESTIMATE_MINIMUM_SECONDS, center - half_spread)
        upper = center + half_spread
    return lower, upper


class SkillDurationEstimator:
    """Estimate a skill turn without inspecting prompts or skill-owned artifacts."""

    def __init__(
        self,
        events: ProductEventStore,
        policies: Mapping[str, SkillDurationEstimate] = DEFAULT_ESTIMATE_POLICIES,
    ) -> None:
        self._events = events
        self._policies = policies

    def estimate(
        self,
        skill: str,
        *,
        excluded_session_id: str = "",
    ) -> SkillDurationEstimate | None:
        normalized_skill = skill.strip()
        if not normalized_skill:
            return None
        events = self._events.recent_kinds(
            (PRODUCT_EVENT_SKILL_STARTED, *TERMINAL_EVENT_KINDS),
            limit=ESTIMATE_EVENT_SCAN_LIMIT,
        )
        samples = _samples(events, normalized_skill, excluded_session_id)
        if not samples:
            return self._policies.get(normalized_skill)
        lower, upper = _range(samples)
        count = len(samples)
        policy = self._policies.get(normalized_skill)
        if policy is not None and count < ESTIMATE_CONFIDENCE_MEDIUM_SAMPLES:
            lower = min(lower, policy.lower_seconds)
            upper = max(upper, policy.upper_seconds)
        confidence = (
            "high"
            if count >= ESTIMATE_CONFIDENCE_HIGH_SAMPLES
            else "medium" if count >= ESTIMATE_CONFIDENCE_MEDIUM_SAMPLES else "low"
        )
        return SkillDurationEstimate(lower, upper, count, confidence)
