"""The two bundled skill discovery rules owned by the manual chat mode."""

from functools import cache
from pathlib import Path


@cache
def manual_skill_instructions() -> str:
    path = Path(__file__).with_name("manualSkillInstructions.md")
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"Empty manual skill instructions: {path}")
    return text
