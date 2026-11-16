"""Canvas publication and user-result contracts, separate from display-only answers."""

from __future__ import annotations

from typing import Any, Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, field_validator

from service.capabilities.service.descriptor import (
    validate_component_schema,
    validate_component_value,
)


class CanvasInteraction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    actions: list[Literal["rollback", "cancel", "submit"]] = Field(min_length=1)
    output_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})

    @field_validator("actions")
    @classmethod
    def terminal_action(cls, actions: list[str]) -> list[str]:
        if len(actions) != len(set(actions)) or not {"submit", "cancel"}.intersection(actions):
            raise ValueError("canvas_terminal_action_required")
        return actions

    @field_validator("output_schema")
    @classmethod
    def output_contract(cls, schema: dict[str, Any]) -> dict[str, Any]:
        return validate_component_schema(schema)


class CanvasDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    format: Literal["openui-lang", "html"]
    version: Literal[1]
    source: str = Field(min_length=1)
    initial_state: dict[str, Any] = Field(default_factory=dict)
    interaction: CanvasInteraction | None = None


def validate_canvas_submission(
    data: Mapping[str, Any], action: str, values: Mapping[str, Any]
) -> None:
    document = CanvasDocument.model_validate(data)
    interaction = document.interaction
    if interaction is None or action not in interaction.actions or action == "rollback":
        raise ValueError("canvas_action_unavailable")
    if action == "submit":
        validate_component_value(interaction.output_schema, values)
