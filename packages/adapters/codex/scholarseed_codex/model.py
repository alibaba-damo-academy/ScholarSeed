"""Codex App Server model catalog projected through the surface port."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Mapping

from scholarseed_runtime.contract.inventory import (
    ModelInventory,
    ModelTier,
    ModelView,
    ReasoningEffort,
)

CODEX_MODEL_LIST_METHOD = "model/list"

RequestCallback = Callable[[str, Any], Awaitable[dict[str, Any]]]


class CodexModelControl:
    """Translate the 0.147 model catalog into runtime-neutral records."""

    def __init__(self, *, request: RequestCallback) -> None:
        self._request = request

    async def list_models(
        self,
        *,
        cursor: str = "",
        limit: int = 0,
        include_hidden: bool = False,
    ) -> ModelInventory:
        params: dict[str, Any] = {"includeHidden": include_hidden}
        if cursor:
            params["cursor"] = cursor
        if limit > 0:
            params["limit"] = limit
        result = await self._request(CODEX_MODEL_LIST_METHOD, params)
        return ModelInventory(
            models=tuple(
                self._model_view(row)
                for row in list(result.get("data") or [])
                if isinstance(row, Mapping)
            ),
            next_cursor=str(result.get("nextCursor") or ""),
        )

    @staticmethod
    def _model_view(raw: Mapping[str, Any]) -> ModelView:
        return ModelView(
            model_id=str(raw.get("id") or ""),
            model=str(raw.get("model") or ""),
            display_name=str(raw.get("displayName") or ""),
            description=str(raw.get("description") or ""),
            is_default=bool(raw.get("isDefault")),
            hidden=bool(raw.get("hidden")),
            default_reasoning_effort=str(raw.get("defaultReasoningEffort") or ""),
            input_modalities=tuple(str(row) for row in list(raw.get("inputModalities") or [])),
            supported_reasoning_efforts=tuple(
                ReasoningEffort(
                    value=str(row.get("reasoningEffort") or ""),
                    description=str(row.get("description") or ""),
                )
                for row in list(raw.get("supportedReasoningEfforts") or [])
                if isinstance(row, Mapping)
            ),
            service_tiers=tuple(
                ModelTier(
                    tier_id=str(row.get("id") or ""),
                    name=str(row.get("name") or ""),
                    description=str(row.get("description") or ""),
                )
                for row in list(raw.get("serviceTiers") or [])
                if isinstance(row, Mapping)
            ),
            default_service_tier=str(raw.get("defaultServiceTier") or ""),
            supports_personality=bool(raw.get("supportsPersonality")),
        )


__all__ = ["CodexModelControl"]
