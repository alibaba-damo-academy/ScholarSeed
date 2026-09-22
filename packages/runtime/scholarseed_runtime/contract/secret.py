"""Opaque launch-secret contracts shared by products and runtime adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class RuntimeSecret:
    """Ephemeral secret material that must never enter events or persistence."""

    value: str = field(default="", repr=False)


class RuntimeSecretPort(Protocol):
    """Resolve an opaque secret reference only while admitting a runtime session."""

    async def resolve(self, secret_ref: str) -> RuntimeSecret: ...


@dataclass(frozen=True)
class LaunchSecret:
    """Bind one opaque product secret to a child-process environment name."""

    name: str
    secret_ref: str


@dataclass(frozen=True)
class LaunchSecretIntent:
    """Remove inherited keys before applying explicit secret bindings.

    Names are generic environment keys; business credential policy belongs to the caller.
    Ordinary adapter configuration does not belong here.
    """

    bindings: tuple[LaunchSecret, ...] = ()
    revision: str = ""
    remove_environment: tuple[str, ...] = ()


__all__ = ["LaunchSecret", "LaunchSecretIntent", "RuntimeSecret", "RuntimeSecretPort"]
