"""Supported target languages for Assistant translation actions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

TRANSLATION_TARGET_INVALID = "invalid_language_pair"
HAN_TEXT = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0002fa1f]+")
LATIN_WORD = re.compile(r"[A-Za-z]+(?:[-'][A-Za-z]+)*")
TRANSLATION_IDENTIFIER = re.compile(r"https?://\S+|\b10\.\d{4,9}/\S+|\$[^$]+\$", re.I)
TRANSLATION_QUOTATION = re.compile(r"[\"‘“](.*?)[\"’”]|\(([^()]*)\)")
TRANSLATION_CLAUSE = re.compile(r"[.!?;\n]+")
ENGLISH_FUNCTION_WORDS = frozenset(
    (
        "a",
        "an",
        "the",
        "of",
        "for",
        "to",
        "in",
        "on",
        "with",
        "by",
        "and",
        "or",
        "is",
        "are",
        "was",
        "were",
        "this",
        "that",
        "these",
        "those",
        "we",
        "our",
        "from",
        "as",
    )
)
MIN_PROSE_WORDS = 2
PROPER_NAME_CONNECTORS = frozenset(
    ("and", "de", "del", "van", "von", "der", "di", "da", "et", "al")
)


class TranslationScript(str, Enum):
    HAN = "han"
    LATIN = "latin"


@dataclass(frozen=True)
class TranslationTargetSpec:
    code: str
    prompt_name: str
    body_script: TranslationScript | None = None


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
    TranslationTargetSpec(
        TranslationTarget.SIMPLIFIED_CHINESE.value, "Simplified Chinese", TranslationScript.HAN
    ),
    TranslationTargetSpec(
        TranslationTarget.TRADITIONAL_CHINESE.value, "Traditional Chinese", TranslationScript.HAN
    ),
    TranslationTargetSpec(TranslationTarget.ENGLISH.value, "English", TranslationScript.LATIN),
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


def translation_body_mismatch(source: str, translated: str, target: str) -> bool:
    """Reject clear script/prose contradictions, not certify general language identity."""
    policy = translation_target(target).body_script
    source = TRANSLATION_IDENTIFIER.sub("", source)
    translated = TRANSLATION_IDENTIFIER.sub("", translated)

    def prose(text: str) -> bool:
        words = LATIN_WORD.findall(text)
        return len(words) >= MIN_PROSE_WORDS and any(
            (word.casefold() in ENGLISH_FUNCTION_WORDS or not (word.istitle() or word.isupper()))
            and word.casefold() not in PROPER_NAME_CONNECTORS
            for word in words
        )

    if policy is TranslationScript.LATIN:
        retained = (
            set(HAN_TEXT.findall(source))
            if any(word.casefold() in ENGLISH_FUNCTION_WORDS for word in LATIN_WORD.findall(source))
            else set()
        )
        for quotation in TRANSLATION_QUOTATION.finditer(source):
            retained.update(HAN_TEXT.findall(quotation.group()))
        runs = HAN_TEXT.findall(translated)
        return bool(runs) and (not prose(translated) or any(run not in retained for run in runs))
    if policy is TranslationScript.HAN:
        if not HAN_TEXT.search(translated):
            return prose(source)
        unquoted = TRANSLATION_QUOTATION.sub("", translated)
        normalized = " ".join(unquoted.split()).casefold()
        return any(
            prose(clause)
            and any(
                word.casefold() in ENGLISH_FUNCTION_WORDS for word in LATIN_WORD.findall(clause)
            )
            and " ".join(clause.split()).casefold() in normalized
            for clause in TRANSLATION_CLAUSE.split(source)
            if clause.strip() and not HAN_TEXT.search(clause)
        )
    return False


__all__ = [
    "TranslationScript",
    "translation_body_mismatch",
    "TRANSLATION_TARGET_CODES",
    "TRANSLATION_TARGET_INVALID",
    "TRANSLATION_TARGETS",
    "TranslationTarget",
    "TranslationTargetSpec",
    "translation_target",
]
