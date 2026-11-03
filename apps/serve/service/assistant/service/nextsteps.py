"""Non-blocking suggestions whose visible text can start a new user turn."""

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

NEXT_STEPS_CARD = "next-steps"
NEXT_STEPS_MIN_OPTIONS = 2
NEXT_STEPS_MAX_OPTIONS = 3
NEXT_STEPS_TITLE_LIMIT = 500
NEXT_STEPS_LABEL_LIMIT = 200
NEXT_STEPS_DESCRIPTION_LIMIT = 2000
NEXT_STEPS_SUBMIT_LIMIT = 100


class NextStepOption(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)

    label: str = Field(min_length=1, max_length=NEXT_STEPS_LABEL_LIMIT)
    description: str = Field(min_length=1, max_length=NEXT_STEPS_DESCRIPTION_LIMIT)


class NextStepsCard(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)

    title: str = Field(min_length=1, max_length=NEXT_STEPS_TITLE_LIMIT)
    options: list[NextStepOption] = Field(
        min_length=NEXT_STEPS_MIN_OPTIONS, max_length=NEXT_STEPS_MAX_OPTIONS
    )
    free_text_label: str = Field(min_length=1, max_length=NEXT_STEPS_LABEL_LIMIT)
    submit_label: str = Field(min_length=1, max_length=NEXT_STEPS_SUBMIT_LIMIT)

    @model_validator(mode="after")
    def unique_labels(self) -> "NextStepsCard":
        if len({option.label for option in self.options}) != len(self.options):
            raise ValueError("next_steps_duplicate_options")
        return self


def validate_next_steps_card(value: Mapping[str, Any]) -> dict[str, Any]:
    return NextStepsCard.model_validate(dict(value)).model_dump()
