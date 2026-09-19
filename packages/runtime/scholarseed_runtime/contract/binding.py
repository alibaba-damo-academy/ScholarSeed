"""Durable product-session to external-runtime binding records."""

from __future__ import annotations

from dataclasses import dataclass

from scholarseed_runtime.contract.capability import CapabilitySet


@dataclass(frozen=True)
class RuntimeBinding:
    product_session_id: str
    runtime_id: str
    adapter_version: str
    runtime_version: str
    protocol_version: str
    protocol_schema_hash: str
    opaque_session_ref: str
    capabilities: CapabilitySet
    profile: str = ""


__all__ = ["RuntimeBinding"]
