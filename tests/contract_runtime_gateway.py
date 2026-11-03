"""Contract gate for the public Runtime Gateway ABI and provider catalog."""

from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
    StorageRoot,
)
from scholarseed_runtime.gateway.binding import RuntimeBindingError, validate_binding
from scholarseed_runtime.gateway.catalog import RuntimeCatalog, RuntimeCatalogError
from service.chat.runtime.selection import RuntimeDiscovery, RuntimeGateway, RuntimeGatewayError

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

    def storage_roots(self, inspection=None) -> tuple[StorageRoot, ...]:
        return ()

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
    with tempfile.TemporaryDirectory(prefix="runtime-roots-") as directory:
        root = Path(directory).resolve() / "outside-product-home"
        with patch.dict(os.environ, {"SCHOLARSEED_CODEX_HOME": str(root)}):
            check(
                "entry point declares external storage",
                catalog.storage_roots(("codex",)) == (StorageRoot(root, create=True),),
            )
            check("storage discovery does not prepare directories", not root.exists())


def test_storage_declarations() -> None:
    provider = ContractProvider("contract")
    catalog = RuntimeCatalog((provider,))
    check("stateless declaration is explicit", catalog.storage_roots(("contract",)) == ())
    for failure in (ValueError("private config value"), PermissionError("private path")):
        with patch.object(provider, "storage_roots", side_effect=failure):
            try:
                catalog.storage_roots(("contract",))
            except RuntimeCatalogError as error:
                check(
                    "storage discovery failure remains a catalog failure",
                    error.__cause__ is failure
                    and "private" not in str(error)
                    and "storage discovery failed" in str(error),
                )
            else:
                check("storage discovery failure remains a catalog failure", False)
    for value in (
        None,
        [],
        ("/data",),
        (Path.cwd(),),
        (StorageRoot(Path("relative"), create=True),),
        (StorageRoot(Path.cwd() / ".." / "data", create=True),),
        (StorageRoot(Path.cwd(), create=1),),
        (StorageRoot(Path.cwd(), create=None),),
        (StorageRoot("/data", create=True),),
    ):
        with patch.object(provider, "storage_roots", return_value=value):
            rejected = False
            try:
                catalog.storage_roots(("contract",))
            except RuntimeCatalogError:
                rejected = True
            check(f"invalid storage declaration rejected: {value!r}", rejected)
    with patch.object(provider, "storage_roots", None):
        rejected = False
        try:
            catalog.storage_roots(("contract",))
        except RuntimeCatalogError:
            rejected = True
        check("missing declaration is not empty storage", rejected)
    shared = Path.cwd() / "shared"
    other = ContractProvider("other")
    combined = RuntimeCatalog((provider, other))
    for allow_first, allow_second in ((True, True), (True, False), (False, True), (False, False)):
        with (
            patch.object(
                provider, "storage_roots", return_value=(StorageRoot(shared, allow_first),)
            ),
            patch.object(other, "storage_roots", return_value=(StorageRoot(shared, allow_second),)),
        ):
            check(
                f"shared creation requires every owner: {allow_first}/{allow_second}",
                combined.storage_roots(("other", "contract"))
                == (StorageRoot(shared, allow_first and allow_second),),
            )
    calls = []

    def declare():
        calls.append("storage")
        return (StorageRoot(Path.cwd(), create=False),)

    def configure(_configuration):
        calls.append("configure")
        return CommandReceipt("configure", CommandState.APPLIED)

    with (
        patch.object(RuntimeCatalog, "discover", return_value=catalog),
        patch("service.chat.runtime.selection.enabled_runtimes", return_value=("contract",)),
        patch(
            "service.chat.runtime.selection.registrations",
            return_value={"contract": SimpleNamespace(settings={})},
        ),
        patch("service.chat.runtime.selection.resolve_runtime_id", return_value="contract"),
        patch.object(provider, "storage_roots", side_effect=declare),
        patch.object(provider, "configure", side_effect=configure, create=True),
    ):
        discovery = RuntimeDiscovery.discover()
        check("discovery does not configure providers", calls == ["storage"])
        gateway = discovery.configure()
        check(
            "product collects and revalidates storage around configuration",
            calls == ["storage", "storage", "configure", "storage"],
        )
        check("configured gateway reuses discovered provider", gateway.provider() is provider)
        check(
            "product retains declared roots",
            gateway.storage_roots == (StorageRoot(Path.cwd(), create=False),),
        )
        calls.clear()
        with patch.object(provider, "storage_roots", return_value=None):
            rejected = False
            try:
                RuntimeGateway.discover()
            except RuntimeGatewayError:
                rejected = True
            check("invalid inventory prevents provider configuration", rejected and not calls)
        calls.clear()
        with patch.object(
            provider, "storage_roots", return_value=(StorageRoot(Path.cwd(), create=True),)
        ):
            rejected = False
            try:
                discovery.configure()
            except RuntimeGatewayError:
                rejected = True
            check("changed preparation policy rejects before configuration", rejected and not calls)
        with patch.object(
            provider,
            "storage_roots",
            return_value=(StorageRoot(Path.cwd() / "changed", create=False),),
        ):
            rejected = False
            try:
                discovery.configure()
            except RuntimeGatewayError:
                rejected = True
            check("changed roots reject before configuration", rejected and not calls)
        with patch.object(
            provider,
            "storage_roots",
            side_effect=[
                (StorageRoot(Path.cwd(), create=False),),
                (StorageRoot(Path.cwd() / "changed", create=False),),
            ],
        ):
            rejected = False
            try:
                discovery.configure()
            except RuntimeGatewayError:
                rejected = True
            check("configuration cannot silently change roots", rejected and calls == ["configure"])


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


def test_storage_source_observations() -> None:
    root = Path.cwd()
    declared = (StorageRoot(root, create=False),)
    provider = ContractProvider("contract")
    catalog = RuntimeCatalog((provider,))
    escaped = []
    payloads = [b"first"]
    qualified = True
    reads = []

    def read(path, name, maximum):
        reads.append((path, name, maximum))
        return payloads.pop(0) if len(payloads) > 1 else payloads[0]

    host = SimpleNamespace(selected=lambda path: qualified and path == str(root), read=read)

    def declaration(inspection):
        escaped.append(inspection)
        inspection.read(str(root), "config.toml", 1024)
        return declared

    with patch.object(provider, "storage_roots", side_effect=declaration):
        before = catalog.inspect_storage(("contract",), host)
        payloads[:] = [b"other"]
        after = catalog.inspect_storage(("contract",), host)
        check(
            "same roots and equal-size changed configuration produce distinct snapshots",
            before.roots == after.roots == declared
            and before.sources != after.sources
            and before.sources[0].size == after.sources[0].size,
        )
        payloads[:] = [None]
        missing = catalog.inspect_storage(("contract",), host)
        payloads[:] = [b""]
        empty = catalog.inspect_storage(("contract",), host)
        check(
            "absent and empty configuration are distinct observations",
            missing.sources[0].digest is None
            and empty.sources[0].digest is not None
            and missing.sources[0].size == empty.sources[0].size == 0,
        )
        qualified = False
        count = len(reads)
        try:
            catalog.inspect_storage(("contract",), host)
        except RuntimeCatalogError:
            check("unqualified source never reaches host read", len(reads) == count)
        else:
            check("unqualified source never reaches host read", False)

    qualified = True

    def repeated(inspection):
        escaped.append(inspection)
        inspection.read(str(root), "config.toml", 1024)
        inspection.read(str(root), "config.toml", 1024)
        return declared

    for values, should_reject in (([b"same", b"same"], False), ([b"old", b"new"], True)):
        payloads[:] = values
        with patch.object(provider, "storage_roots", side_effect=repeated):
            rejected = False
            try:
                observed = catalog.inspect_storage(("contract",), host)
                check("repeated identical source appears once", len(observed.sources) == 1)
            except RuntimeCatalogError:
                rejected = True
            check(
                "source stability is required throughout one discovery", rejected == should_reject
            )
    for view in escaped:
        try:
            view.read(str(root), "config.toml", 1024)
        except RuntimeError:
            check("discovery view expires on success and failure", True)
        else:
            check("discovery view expires on success and failure", False)
    check("host qualification remains owned by its caller", host.selected(str(root)))


def main() -> int:
    test_frozen_contracts()
    test_session_skill_root_contract()
    test_catalog()
    test_installed_entry_point()
    test_storage_declarations()
    test_storage_source_observations()
    test_product_binding_selection()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
