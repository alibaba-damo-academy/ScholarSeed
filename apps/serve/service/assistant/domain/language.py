"""Supported target languages for Assistant translation actions."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

TRANSLATION_TARGET_INVALID = "invalid_language_pair"


@dataclass(frozen=True)
class TranslationTargetSpec:
    code: str
    prompt_name: str


class TranslationTarget(str, Enum):
    SIMPLIFIED_CHINESE = "zh-CN"
    TRADITIONAL_CHINESE = "zh-TW"
    ENGLISH = "en"
    JAPANESE = "ja"
    KOREAN = "ko"
    FRENCH = "fr"
    GERMAN = "de"
    SPANISH = "es"
    PORTUGUESE = "pt"
    ITALIAN = "it"
    RUSSIAN = "ru"
    ARABIC = "ar"
    HINDI = "hi"
    THAI = "th"
    VIETNAMESE = "vi"
    INDONESIAN = "id"
    TURKISH = "tr"
    DUTCH = "nl"


TRANSLATION_TARGETS = (
    TranslationTargetSpec(TranslationTarget.SIMPLIFIED_CHINESE.value, "Simplified Chinese"),
    TranslationTargetSpec(TranslationTarget.TRADITIONAL_CHINESE.value, "Traditional Chinese"),
    TranslationTargetSpec(TranslationTarget.ENGLISH.value, "English"),
    TranslationTargetSpec(TranslationTarget.JAPANESE.value, "Japanese"),
    TranslationTargetSpec(TranslationTarget.KOREAN.value, "Korean"),
    TranslationTargetSpec(TranslationTarget.FRENCH.value, "French"),
    TranslationTargetSpec(TranslationTarget.GERMAN.value, "German"),
    TranslationTargetSpec(TranslationTarget.SPANISH.value, "Spanish"),
    TranslationTargetSpec(TranslationTarget.PORTUGUESE.value, "Portuguese"),
    TranslationTargetSpec(TranslationTarget.ITALIAN.value, "Italian"),
    TranslationTargetSpec(TranslationTarget.RUSSIAN.value, "Russian"),
    TranslationTargetSpec(TranslationTarget.ARABIC.value, "Arabic"),
    TranslationTargetSpec(TranslationTarget.HINDI.value, "Hindi"),
    TranslationTargetSpec(TranslationTarget.THAI.value, "Thai"),
    TranslationTargetSpec(TranslationTarget.VIETNAMESE.value, "Vietnamese"),
    TranslationTargetSpec(TranslationTarget.INDONESIAN.value, "Indonesian"),
    TranslationTargetSpec(TranslationTarget.TURKISH.value, "Turkish"),
    TranslationTargetSpec(TranslationTarget.DUTCH.value, "Dutch"),
)
TRANSLATION_TARGETS_BY_CODE = {target.code: target for target in TRANSLATION_TARGETS}
TRANSLATION_TARGET_CODES = tuple(TRANSLATION_TARGETS_BY_CODE)


def translation_target(code: str) -> TranslationTargetSpec:
    try:
        return TRANSLATION_TARGETS_BY_CODE[code]
    except KeyError as exc:
        raise ValueError(TRANSLATION_TARGET_INVALID) from exc


__all__ = [
    "TRANSLATION_TARGET_CODES",
    "TRANSLATION_TARGET_INVALID",
    "TRANSLATION_TARGETS",
    "TranslationTarget",
    "TranslationTargetSpec",
    "translation_target",
]
