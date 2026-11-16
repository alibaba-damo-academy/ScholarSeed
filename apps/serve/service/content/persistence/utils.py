"""Scalar admission shared by persisted content records."""

from __future__ import annotations

import math
from typing import TypeGuard


def finite_number(value: object) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
