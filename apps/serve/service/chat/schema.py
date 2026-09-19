"""Chat HTTP schemas and stable product vocabulary."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, StrictBool

from scholarseed_runtime.contract import ModelThinking
from service.settings.connections import ModelAuthentication


class ModelDefaultRequest(BaseModel):
    """Persistent model selection used before a live session exists."""

    model_key: str
    persist: bool = True


class PersonalApiModel(BaseModel):
    """One model the user checked on a personal connection."""

    id: str
    label: str = ""
    reasoning_efforts: list[str] | None = None
    context_window: int | None = None
    max_output_tokens: int | None = None
    input_modalities: list[str] | None = None
    # Declared so it round-trips: pydantic drops undeclared fields, and saving a
    # connection resubmits every checked model, so an absent field here would let any
    # unrelated connection edit silently un-hide models the user had hidden.
    hidden: bool = False


class PersonalApiRequest(BaseModel):
    """One user-owned LLM provider profile managed from Desktop settings."""

    preview_name: str = ""
    # Kept for existing clients during the preview-name migration. New UI sends
    # ``preview_name``; the store maps a legacy name only when no new field exists.
    name: str = ""
    # Which endpoint preset this connection came from. Only a declaration: the vendor
    # table lives in the service layer and resolves it to a display name.
    preset_id: str = ""
    authentication: ModelAuthentication = ModelAuthentication.API_KEY
    oauth_provider: str = ""
    provider: str = ""
    # Empty means "take the default"; the store rejects any unknown value rather than
    # falling back, so a typo cannot silently route to the wrong protocol.
    wire_api: str = ""
    base_url: str = ""
    api_key: str | None = None
    selected_models: list[PersonalApiModel] = []
    small_model_name: str = ""
    headers: dict[str, str] | None = None
    image_input: bool = False
    pdf_input: bool = False


class ProfileEnabledRequest(BaseModel):
    """Whether one personal connection's selected models reach the model menu.

    Deliberately its own request rather than a field on the save form: enabling is a
    switch over a stored connection, not one of the connection's parameters.
    """

    enabled: StrictBool


class ModelVisibilityRequest(BaseModel):
    """Whether one selected model of one personal connection reaches the model menu.

    Its own request for the same reason as ``ProfileEnabledRequest``: visibility is a
    switch over a stored connection's model, not one of the connection's parameters.
    The model id travels in the body because vendor ids may contain ``/``.
    """

    model_id: str
    hidden: StrictBool


class ModelApiProbeRequest(PersonalApiRequest):
    """A non-persistent model API probe from the connection editor."""

    profile_id: str = ""


class RewindPromptRequest(BaseModel):
    """Input for silently rewinding a session to one user prompt."""

    anchor: int


class SessionRenameRequest(BaseModel):
    """A user-visible title replacement for one owned session."""

    title: str


class SessionModelRequest(BaseModel):
    """Replace the model binding of one owned idle session."""

    model_id: str
    reasoning_effort: str = ""
    # 开关/预算形态的思考选择，与 ``reasoning_effort`` 互斥：一条坐标到底是哪种形态由能力
    # 声明决定。载荷形状 ``{"enabled": bool}`` / ``{"budget": int}``，缺省即「没选」。
    thinking: dict[str, Any] | None = None


THINKING_ENABLED_KEY = "enabled"
THINKING_BUDGET_KEY = "budget"


def thinking_from_payload(payload: Any) -> ModelThinking | None:
    """HTTP 原始载荷 → ``ModelThinking`` 的唯一转换点。

    值类型不符就抛错，不静默丢掉：一次思考选择只会落在一个形态上，把用户按下去的开关解析成
    「没选」等于让界面与真实出站参数拆开。两个键都没给则归一成 ``None``，与目录里读回的空值
    同值 —— 否则每次准入都会被判定成「选中态与生效态不一致」而反复重发。
    """

    if payload is None:
        return None
    if not isinstance(payload, Mapping):
        raise ValueError("thinking must be an object")
    enabled = payload.get(THINKING_ENABLED_KEY)
    budget = payload.get(THINKING_BUDGET_KEY)
    if enabled is not None and not isinstance(enabled, bool):
        raise ValueError("thinking.enabled must be a boolean")
    if budget is not None and (not isinstance(budget, int) or isinstance(budget, bool)):
        raise ValueError("thinking.budget must be an integer")
    if enabled is None and budget is None:
        return None
    return ModelThinking(enabled=enabled, budget=budget)


class PermissionModeRequest(BaseModel):
    """Unvalidated permission-mode setting supplied by the HTTP client."""

    mode: Any = None


class WorkflowDefaultRequest(BaseModel):
    """Unvalidated workflow-default setting supplied by the HTTP client."""

    enabled: Any = None


class AutoReviewDefaultRequest(BaseModel):
    """Unvalidated automatic-review default supplied by the HTTP client."""

    enabled: Any = None


class WorkspaceRootRequest(BaseModel):
    """Project workspace root supplied by the HTTP client. Empty clears it."""

    root: str = ""


class UploadValidationError(ValueError):
    """The request did not contain a usable uploaded file."""


class UploadLimitError(UploadValidationError):
    """The uploaded file exceeded the route's configured byte limit."""
