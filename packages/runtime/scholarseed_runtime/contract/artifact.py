"""Product-neutral file declaration contracts; declarations are not publications."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ArtifactRole(str, Enum):
    INTERMEDIATE = "intermediate"
    FINAL = "final"
    SUPPORTING = "supporting"


@dataclass(frozen=True)
class ArtifactDirectiveSpec:
    name: str
    default_role: ArtifactRole = ArtifactRole.INTERMEDIATE


@dataclass(frozen=True)
class ArtifactDeclaration:
    declaration_id: str
    path: str
    role: ArtifactRole
    title: str = ""
    expected_sha256: str = ""
