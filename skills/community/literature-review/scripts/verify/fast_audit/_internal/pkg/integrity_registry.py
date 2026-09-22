"""VerifiedRegistry — number whitelist for fabrication detection (local copy)."""

import math
from typing import Iterable


_YEAR_RANGE = set(range(1990, 2030))
_COMMON_BATCH_SIZES = {8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096}
_COMMON_LEARNING_RATES = {
    0.1, 0.01, 0.001, 0.0001, 0.00001,
    1e-3, 1e-4, 1e-5, 2e-4, 2e-5, 3e-4, 3e-5, 5e-4, 5e-5,
}
_COMMON_CONSTANTS = {0.9, 0.99, 0.999, 0.9999, 0.05, 0.01, 0.001,
                     0.5, 1.0, 2.0, 3.0, 5.0, 10.0}
_MAX_SMALL_INT = 20


class VerifiedRegistry:
    def __init__(self):
        self._values: set[float] = set()
        self._condition_names: set[str] = set()
        self._always_allowed: set[float] = self._build_always_allowed()

    @staticmethod
    def _build_always_allowed() -> set[float]:
        allowed: set[float] = set()
        allowed.update(float(y) for y in _YEAR_RANGE)
        allowed.update(float(b) for b in _COMMON_BATCH_SIZES)
        allowed.update(_COMMON_LEARNING_RATES)
        allowed.update(_COMMON_CONSTANTS)
        allowed.update(float(i) for i in range(0, _MAX_SMALL_INT + 1))
        return allowed

    @property
    def values(self) -> set[float]:
        return self._values

    @property
    def condition_names(self) -> set[str]:
        return self._condition_names

    def register(self, value: float):
        if not math.isfinite(value):
            return
        self._values.add(value)
        for decimals in range(1, 5):
            self._values.add(round(value, decimals))
        if 0.0 < value <= 1.0:
            pct = value * 100.0
            self._values.add(pct)
            for d in range(1, 5):
                self._values.add(round(pct, d))
        elif 1.0 < value <= 100.0:
            frac = value / 100.0
            self._values.add(frac)
            for d in range(1, 5):
                self._values.add(round(frac, d))

    def register_condition(self, name: str):
        self._condition_names.add(name)

    def register_many(self, values: Iterable[float]):
        for v in values:
            self.register(v)

    def is_verified(self, num: float, tolerance: float = 0.01) -> bool:
        if num in self._always_allowed:
            return True
        if num == int(num) and 0 <= num <= _MAX_SMALL_INT:
            return True
        if num in self._values:
            return True
        for v in self._values:
            if v == 0:
                continue
            if abs(num - v) / abs(v) <= tolerance:
                return True
            if abs(num / 100.0 - v) / abs(v) <= tolerance:
                return True
            if abs(num - v * 100.0) / abs(v * 100.0) <= tolerance:
                return True
        return False

    def is_known_condition(self, name: str) -> bool:
        return name in self._condition_names

    @classmethod
    def from_dict(cls, data: dict) -> "VerifiedRegistry":
        reg = cls()
        cls._extract_values(data, reg)
        return reg

    @classmethod
    def _extract_values(cls, obj, reg: "VerifiedRegistry", key_path: str = ""):
        if isinstance(obj, (int, float)):
            if math.isfinite(obj):
                reg.register(float(obj))
        elif isinstance(obj, dict):
            if key_path.endswith("conditions") or key_path.endswith("condition_summaries"):
                for k in obj:
                    reg.register_condition(k)
            for k, v in obj.items():
                cls._extract_values(v, reg, f"{key_path}.{k}")
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                cls._extract_values(item, reg, key_path)

    def to_dict(self) -> dict:
        return {
            "values": sorted(self._values),
            "values_count": len(self._values),
            "condition_names": sorted(self._condition_names),
        }
