"""Contract gate for the public Runtime Gateway ABI and provider catalog."""

from __future__ import annotations

import asyncio
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

from scholarseed_runtime.contract import (
    RUNTIME_ABI_VERSION,
    CapabilitySet,
    CommandReceipt,
    CommandState,
    DeliveryClass,
    InventoryKind,
    InventoryRequest,
    OpenSessionRequest,
    ResumeSessionRequest,
    RuntimeBinding,
    RuntimeDescriptor,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInspectionRequest,
    RuntimeInventory,
    RuntimeReadiness,
    RuntimeStatus,
)
from scholarseed_runtime.gateway.binding import RuntimeBindingError, validate_binding
from scholarseed_runtime.gateway.catalog import RuntimeCatalog, RuntimeCatalogError
from service.chat.runtime.selection import RuntimeGateway, RuntimeGatewayError

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


class ContractProvider:
    def __init__(self, runtime_id: str, *, aliases: tuple[str, ...] = (), abi: str = "") -> None:
        self._descriptor = RuntimeDescriptor(
            runtime_id=runtime_id,
            display_name=runtime_id,
            adapter_version="1",
            runtime_version_range=">=1",
            protocol_version="1",
            protocol_schema_hash="contract",
            capabilities=CapabilitySet(),
            abi_version=abi or RUNTIME_ABI_VERSION,
            aliases=aliases,
        )

    @property
    def descriptor(self) -> RuntimeDescriptor:
        return self._descriptor

    async def probe(self) -> RuntimeReadiness:
        return RuntimeReadiness(self.descriptor.runtime_id, RuntimeStatus.READY, True)

    async def inspect(self, request: RuntimeInspectionRequest) -> RuntimeInventory:
        return RuntimeInventory(
            revision="contract",
            values={kind.value: {"cwd": str(request.cwd)} for kind in request.inventory.kinds},
        )

    async def shutdown(self) -> CommandReceipt:
        return CommandReceipt("shutdown", CommandState.APPLIED)


def test_frozen_contracts() -> None:
    print("== runtime records ==")
    event = RuntimeEvent(
        schema_version=1,
        event_id="event-1",
        runtime_id="contract",
        product_session_id="product-1",
        native_session_id="opaque-1",
        process_generation=1,
        sequence=1,
        kind=RuntimeEventKind.TURN_STARTED,
        delivery=DeliveryClass.MUST_PERSIST,
        observed_at="2026-09-03T00:00:00Z",
    )
    frozen = False
    try:
        event.sequence = 2  # type: ignore[misc]
    except FrozenInstanceError:
        frozen = True
    check("RuntimeEvent is immutable", frozen)
    check("public event kind is vendor neutral", event.kind.value == "turn.started")


def test_session_skill_root_contract() -> None:
    print("== session skill roots ==")
    roots = (Path("/tmp/runtime-skills-bundled"), Path("/tmp/runtime-skills-user"))
    opened = OpenSessionRequest(
        product_session_id="product-1",
        cwd=Path("/tmp/runtime-gateway-contract"),
        skill_roots=roots,
    )
    binding = RuntimeBinding(
        product_session_id="product-1",
        runtime_id="codex",
        adapter_version="1",
        runtime_version="1",
        protocol_version="1",
        protocol_schema_hash="contract",
        opaque_session_ref="opaque-1",
        capabilities=CapabilitySet(),
    )
    resumed = ResumeSessionRequest(
        binding=binding,
        cwd=Path("/tmp/runtime-gateway-contract"),
        skill_roots=roots,
    )
    check(
        "open and resume carry the same immutable skill discovery context",
        opened.skill_roots == roots and resumed.skill_roots == roots,
    )
    check(
        "session skill discovery remains optional for providers without skills",
        OpenSessionRequest("product-2", Path("/tmp/runtime-gateway-contract")).skill_roots == ()
        and ResumeSessionRequest(binding, Path("/tmp/runtime-gateway-contract")).skill_roots == (),
    )
    check(
        "session capability requirements are opt-in",
        OpenSessionRequest("product-3", Path("/tmp/runtime-gateway-contract")).required_capabilities
        == (),
    )


def test_catalog() -> None:
    print("== runtime catalog ==")
    codex = ContractProvider("codex", aliases=("openai-codex",))
    catalog = RuntimeCatalog((codex,))
    check("catalog resolves canonical runtime", catalog.provider("codex") is codex)
    check("catalog resolves declared alias", catalog.provider("openai-codex") is codex)
    check("catalog lists canonical ids only", catalog.runtime_ids() == ("codex",))

    duplicate_failed = False
    try:
        RuntimeCatalog((codex, ContractProvider("other", aliases=("codex",))))
    except RuntimeCatalogError:
        duplicate_failed = True
    check("duplicate id or alias fails closed", duplicate_failed)

    abi_failed = False
    try:
        RuntimeCatalog((ContractProvider("future", abi="999"),))
    except RuntimeCatalogError:
        abi_failed = True
    check("ABI mismatch fails closed", abi_failed)

    readiness = asyncio.run(codex.probe())
    check("provider readiness is typed", readiness.status is RuntimeStatus.READY)


def test_installed_entry_point() -> None:
    print("== installed runtime entry point ==")
    catalog = RuntimeCatalog.discover()
    check("installed Codex adapter is discoverable", "codex" in catalog.runtime_ids())
    descriptor = catalog.provider("codex").descriptor
    check("entry point exposes current ABI", descriptor.abi_version == RUNTIME_ABI_VERSION)
    check("entry point exposes a frozen schema hash", len(descriptor.protocol_schema_hash) == 64)


def test_product_binding_selection() -> None:
    print("== product binding selection ==")
    provider = ContractProvider("codex")
    gateway = RuntimeGateway(RuntimeCatalog((provider,)), "codex")
    binding = RuntimeBinding(
        product_session_id="product-1",
        runtime_id="codex",
        adapter_version="1",
        runtime_version="1",
        protocol_version="1",
        protocol_schema_hash="contract",
        opaque_session_ref="opaque-1",
        capabilities=CapabilitySet(),
    )
    check("new sessions use the declared default", gateway.provider() is provider)
    check("existing sessions select from their binding", gateway.provider_for(binding) is provider)
    for field, value in (
        ("runtime_id", "other"),
        ("protocol_version", "2"),
        ("protocol_schema_hash", "other-schema"),
    ):
        rejected = False
        try:
            validate_binding(replace(binding, **{field: value}), provider.descriptor)
        except RuntimeBindingError:
            rejected = True
        check(f"neutral binding validation rejects {field} drift", rejected)
    incompatible = RuntimeBinding(
        product_session_id="product-1",
        runtime_id="codex",
        adapter_version="1",
        runtime_version="1",
        protocol_version="2",
        protocol_schema_hash="contract",
        opaque_session_ref="opaque-1",
        capabilities=CapabilitySet(),
    )
    failed = False
    try:
        gateway.provider_for(incompatible)
    except RuntimeGatewayError:
        failed = True
    check("incompatible persisted protocol fails closed", failed)

    inspection = asyncio.run(
        gateway.inspect(
            RuntimeInspectionRequest(
                cwd=Path("/tmp/runtime-gateway-contract"),
                inventory=InventoryRequest((InventoryKind.SKILLS,)),
            )
        )
    )
    check(
        "pre-session inventory delegates through the provider ABI",
        inspection.revision == "contract" and "skills" in dict(inspection.values),
    )


def main() -> int:
    test_frozen_contracts()
    test_session_skill_root_contract()
    test_catalog()
    test_installed_entry_point()
    test_product_binding_selection()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
