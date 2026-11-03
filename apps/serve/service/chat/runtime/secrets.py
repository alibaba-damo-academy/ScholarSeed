"""Product runtime secrets ownership."""

from __future__ import annotations

import os
import uuid
from hashlib import sha256
from pathlib import Path
from typing import Mapping

from scholarseed_runtime.contract import (
    LaunchSecret,
    LaunchSecretIntent,
    LaunchSecretScope,
    RuntimeSecret,
    RuntimeSecretPort,
)
from service.identity.service.skill_credentials import PLATFORM_ENVIRONMENT_KEYS
from service.identity.utils import HOST_PROCESS_KEY_ENV
from service.platform.python import task_environment
from service.platform.vocabulary import (
    BRIDGE_SESSION_ENV,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    INTERNAL_BASE_URL_ENV,
)

BRIDGE_ENVIRONMENT_KEYS = (
    BRIDGE_SESSION_ENV,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    INTERNAL_BASE_URL_ENV,
    HOST_PROCESS_KEY_ENV,
)


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
    *,
    tool_environment: Mapping[str, str] | None = None,
    include_skill_credentials: bool = False,
    execution_environment: Mapping[str, str] | None = None,
    cwd: Path | None = None,
) -> tuple[LaunchSecretIntent, RuntimeSecretPort | None]:
    if cwd is not None:
        removed = {name.upper() for name in (*PLATFORM_ENVIRONMENT_KEYS, *BRIDGE_ENVIRONMENT_KEYS)}
        tool_environment = task_environment(
            cwd,
            {
                **{
                    name: value for name, value in os.environ.items() if name.upper() not in removed
                },
                **dict(environment or {}),
                **dict(tool_environment or {}),
            },
        )
    execution_names = {os.path.normcase(name) for name in execution_environment or ()}
    tool_environment = {
        name: value
        for name, value in (tool_environment or {}).items()
        if os.path.normcase(name) not in execution_names
    }
    bindings: list[LaunchSecret] = []
    values: dict[str, RuntimeSecret] = {}
    skill_environment = dict(tool_environment or {})
    skill_environment.update(
        {
            name: value
            for name, value in dict(environment or {}).items()
            if include_skill_credentials and name in PLATFORM_ENVIRONMENT_KEYS
        }
    )
    for scope, source in (
        (LaunchSecretScope.PROCESS, environment),
        (LaunchSecretScope.TOOL, skill_environment),
    ):
        for name, value in sorted(dict(source or {}).items()):
            secret_ref = uuid.uuid4().hex
            bindings.append(LaunchSecret(name=str(name), secret_ref=secret_ref, scope=scope))
            values[secret_ref] = RuntimeSecret(str(value))
    if not bindings:
        return (
            LaunchSecretIntent(
                remove_environment=(*PLATFORM_ENVIRONMENT_KEYS, *BRIDGE_ENVIRONMENT_KEYS)
            ),
            None,
        )
    names = ",".join(f"{binding.scope.value}:{binding.name}" for binding in bindings)
    revision = f"launch-secrets:{sha256(names.encode('utf-8')).hexdigest()}"
    return LaunchSecretIntent(
        bindings=tuple(bindings),
        revision=revision,
        remove_environment=(*PLATFORM_ENVIRONMENT_KEYS, *BRIDGE_ENVIRONMENT_KEYS),
    ), SessionRuntimeSecretPort(values)
