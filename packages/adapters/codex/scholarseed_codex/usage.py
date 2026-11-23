"""Account for native spending independently of Codex's successful-context baseline."""

from collections.abc import Mapping

from scholarseed_codex.protocol.session import CodexUsage

USAGE_FIELDS = ("inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens")


def _counts(value: object) -> dict[str, int] | None:
    if not isinstance(value, Mapping):
        return None
    counts: dict[str, int] = {}
    for name in USAGE_FIELDS:
        count = value.get(name, 0)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            return None
        counts[name] = count
    return counts


class UsageAccounting:
    def __init__(self) -> None:
        self.total: dict[str, int] | None = dict.fromkeys(USAGE_FIELDS, 0)

    def resume(self) -> None:
        """The first resumed notification is a baseline, never new spending."""
        self.total = None

    def observe(self, value: Mapping[str, object]) -> CodexUsage | None:
        if "total" not in value:
            counts = _counts(value.get("last"))
            if counts is None:
                return None
        else:
            counts = _counts(value.get("total"))
            if counts is None:
                return None
            previous, self.total = self.total, counts
            if previous is None or any(counts[name] < previous[name] for name in USAGE_FIELDS):
                return None
            counts = {name: counts[name] - previous[name] for name in USAGE_FIELDS}
            if not any(counts.values()):
                return None
        return CodexUsage(
            input_tokens=counts["inputTokens"],
            output_tokens=counts["outputTokens"],
            cache_read_tokens=counts["cachedInputTokens"],
            cache_creation_tokens=counts["cacheWriteInputTokens"],
        )
