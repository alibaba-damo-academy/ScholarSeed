from __future__ import annotations

import asyncio
import math
import random
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Awaitable, Callable

MIN_INTERVAL = 1.2
RETRY_LIMIT = 2
RETRY_BASE = 2.0
RETRY_JITTER = 0.25
MICROSOFT_CHARACTERS_PER_SECOND = 500.0


class TranslationFailure(ValueError):
    pass


class RateLimited(Exception):
    def __init__(self, retry_after: float = 0.0):
        super().__init__("rate_limited")
        self.retry_after = retry_after


@dataclass(frozen=True)
class RequestPolicy:
    interval: float = MIN_INTERVAL
    characters_per_second: float | None = None


@dataclass
class RetryReport:
    retries: int = 0
    limited: bool = False


@dataclass
class Gate:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    next_request: float = 0.0


def retry_after(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        delay = float(value)
    except ValueError:
        try:
            delay = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            return 0.0
    return max(0.0, delay) if math.isfinite(delay) else 0.0


class Scheduler:
    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
    ):
        self.clock = clock
        self.sleep = sleep
        self.jitter = jitter
        self.gates: dict[str, Gate] = {}

    async def run(
        self,
        provider: str,
        policy: RequestPolicy,
        size: int,
        attempt: int,
        send: Callable[[], Awaitable[str]],
    ) -> str:
        gate = self.gates.setdefault(provider, Gate())
        async with gate.lock:
            delay = gate.next_request - self.clock()
            if delay > 0:
                await self.sleep(delay)
            interval = max(
                policy.interval,
                size / policy.characters_per_second if policy.characters_per_second else 0,
            )
            gate.next_request = self.clock() + interval
            try:
                return await send()
            except RateLimited as error:
                cooldown = max(
                    error.retry_after,
                    RETRY_BASE * (2**attempt) + self.jitter() * RETRY_JITTER,
                )
                gate.next_request = max(gate.next_request, self.clock() + cooldown)
                raise
