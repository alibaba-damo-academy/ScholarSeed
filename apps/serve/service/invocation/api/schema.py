"""Validated HTTP input for isolated single-turn invocations."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from service.assistant.service.actions import ONE_SHOT_MAXIMUM_INPUT_CHARS
from service.invocation.service.model import (
    DEFAULT_INVOCATION_EXECUTION,
    InvocationCommand,
    InvocationExecution,
    InvocationSandbox,
    InvocationSearchMode,
    InvocationSkill,
)
from service.settings.capabilities import REASONING_EFFORT_LEVELS

SKILL_ID_MAX_CHARS = 256
SKILL_PROFILE_MAX_CHARS = 64
SKILL_PROFILE_PATTERN = r"^[a-z][a-z0-9-]*$"
SERVICE_TIER_MAX_CHARS = 64


class SkillSelector(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, max_length=SKILL_ID_MAX_CHARS)
    profile: str | None = Field(
        default=None,
        min_length=1,
        max_length=SKILL_PROFILE_MAX_CHARS,
        pattern=SKILL_PROFILE_PATTERN,
    )


class ExecutionOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    web_search: StrictBool | InvocationSearchMode = DEFAULT_INVOCATION_EXECUTION.web_search
    sandbox: InvocationSandbox = DEFAULT_INVOCATION_EXECUTION.sandbox
    network_access: StrictBool = DEFAULT_INVOCATION_EXECUTION.network_access
    reasoning_effort: str | None = DEFAULT_INVOCATION_EXECUTION.reasoning_effort
    service_tier: str = Field(
        default=DEFAULT_INVOCATION_EXECUTION.service_tier,
        max_length=SERVICE_TIER_MAX_CHARS,
    )

    @model_validator(mode="after")
    def validate_network_access(self) -> "ExecutionOptions":
        if self.sandbox is InvocationSandbox.READ_ONLY and self.network_access:
            raise ValueError("read-only sandbox requires network_access=false")
        if self.sandbox is InvocationSandbox.DANGER_FULL_ACCESS and not self.network_access:
            raise ValueError("danger-full-access sandbox requires network_access=true")
        return self

    @model_validator(mode="after")
    def validate_reasoning_effort(self) -> "ExecutionOptions":
        """档位取值只认能力层那一份全集；某条模型更窄的集合由坐标校验兜住。"""
        if self.reasoning_effort is None:
            return self
        effort = str(self.reasoning_effort).strip().lower()
        if effort not in REASONING_EFFORT_LEVELS:
            raise ValueError(
                f"reasoning_effort must be one of: {', '.join(REASONING_EFFORT_LEVELS)}"
            )
        self.reasoning_effort = effort
        return self

    def command(self) -> InvocationExecution:
        return InvocationExecution(
            web_search=self.web_search,
            sandbox=self.sandbox,
            network_access=self.network_access,
            reasoning_effort=self.reasoning_effort,
            service_tier=self.service_tier,
        )


class InvocationStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    prompt: str = Field(min_length=1, max_length=ONE_SHOT_MAXIMUM_INPUT_CHARS)
    skill: SkillSelector | None = None
    developer_prompt: bool = True
    execution: ExecutionOptions = Field(default_factory=ExecutionOptions)

    def command(self) -> InvocationCommand:
        return InvocationCommand(
            prompt=self.prompt,
            skill=(
                InvocationSkill(id=self.skill.id, profile=self.skill.profile)
                if self.skill is not None
                else None
            ),
            developer_prompt=self.developer_prompt,
            execution=self.execution.command(),
        )


class InteractionResponseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    decision: str = Field(min_length=1, max_length=128)
    values: dict = Field(default_factory=dict)


__all__ = [
    "InteractionResponseRequest",
    "ExecutionOptions",
    "InvocationStartRequest",
    "SkillSelector",
]
