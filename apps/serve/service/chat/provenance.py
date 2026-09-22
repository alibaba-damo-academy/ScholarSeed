"""Secret-free, immutable model identity attached to one product answer."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping

MODEL_RUN_FIELD = "model_run"
PROVIDER_PRESET_ID_FIELD = "provider_preset_id"


@dataclass(frozen=True)
class ModelRun:
    provider_id: str
    provider_label: str
    model_id: str
    actual_model_id: str = ""
    provider_preset_id: str = ""

    def payload(self) -> dict[str, str]:
        return asdict(self)

    @classmethod
    def restore(cls, value: Any) -> ModelRun | None:
        if not isinstance(value, Mapping):
            return None
        fields = {key: str(value.get(key) or "") for key in cls.__dataclass_fields__}
        if not fields["provider_id"] or not fields["model_id"]:
            return None
        return cls(**fields)
