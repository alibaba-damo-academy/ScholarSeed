"""Product runtime secrets ownership."""

from __future__ import annotations

import uuid
from hashlib import sha256
from typing import Mapping

from scholarseed_runtime.contract import (
    LaunchSecret,
    LaunchSecretIntent,
    RuntimeSecret,
    RuntimeSecretPort,
)
from service.identity.service.skill_credentials import PLATFORM_ENVIRONMENT_KEYS


class SessionRuntimeSecretPort(RuntimeSecretPort):
    """Invocation-scoped resolver; launch secret values never enter Gateway intents."""

    def __init__(self, values: Mapping[str, RuntimeSecret]) -> None:
        self._values = dict(values)

    async def resolve(self, secret_ref: str) -> RuntimeSecret:
        try:
            return self._values[secret_ref]
        except KeyError as error:
            raise ValueError("runtime secret reference is unavailable") from error


def _launch_secret_contract(
    environment: Mapping[str, str] | None,
) -> tuple[LaunchSecretIntent, RuntimeSecretPort | None]:
    bindings: list[LaunchSecret] = []
    values: dict[str, RuntimeSecret] = {}
    for name, value in sorted(dict(environment or {}).items()):
        secret_ref = uuid.uuid4().hex
        bindings.append(LaunchSecret(name=str(name), secret_ref=secret_ref))
        values[secret_ref] = RuntimeSecret(str(value))
    if not bindings:
        return LaunchSecretIntent(remove_environment=PLATFORM_ENVIRONMENT_KEYS), None
    names = ",".join(binding.name for binding in bindings)
    revision = f"launch-secrets:{sha256(names.encode('utf-8')).hexdigest()}"
    return LaunchSecretIntent(
        bindings=tuple(bindings), revision=revision, remove_environment=PLATFORM_ENVIRONMENT_KEYS
    ), SessionRuntimeSecretPort(values)
