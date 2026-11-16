"""Explicit import roots for independently collected Skill tests."""

import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SKILL_ROOT / "lib"), str(SKILL_ROOT / "scripts")]
