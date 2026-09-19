"""Compatibility validation for a durable binding and installed provider."""

from __future__ import annotations

from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.runtime import RuntimeDescriptor


class RuntimeBindingError(ValueError):
    """A stored binding cannot be served by the selected provider."""


def validate_binding(binding: RuntimeBinding, descriptor: RuntimeDescriptor) -> None:
    """Reject identity or known protocol drift without interpreting opaque state."""

    if binding.runtime_id != descriptor.runtime_id:
        raise RuntimeBindingError("runtime binding provider identity mismatch")
    if binding.protocol_version and binding.protocol_version != descriptor.protocol_version:
        raise RuntimeBindingError("runtime binding protocol version is incompatible")
    if (
        binding.protocol_schema_hash
        and binding.protocol_schema_hash != descriptor.protocol_schema_hash
    ):
        raise RuntimeBindingError("runtime binding protocol schema is incompatible")
