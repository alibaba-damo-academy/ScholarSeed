"""Contract: the Web product has one LiveSession implementation and one serve route owner.

Run: .venv/bin/python -m tests.contract_product_boundaries
"""

from __future__ import annotations

import inspect
import json
import tempfile
from pathlib import Path

from scholarseed_runtime.gateway.catalog import RuntimeCatalog
from service.bootstrap import create_app
from service.chat.active import RUNTIME_ALLOWED_NETWORK_DOMAINS
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.live import LiveSession

PASS = 0
FAIL = 0

_REMOVED_FILES = (
    "service/serve.py",
    "service/app.py",
    "service/api/auth.py",
    "service/store/users.py",
    "service/chat/routes.py",
    "damoagent/damoagent/surface/session/host.py",
    "damoagent/damoagent/surface/session/runner.py",
    "damoagent/damoagent/surface/session/api.py",
    "damoagent/damoagent/surface/session/port.py",
    "damoagent/damoagent/surface/session/live.py",
    "damoagent/damoagent/surface/session/hooks.py",
    "damoagent/damoagent/surface/protocol/stream.py",
    "damoagent/damoagent/surface/serve.py",
    "damoagent/damoagent/surface/transport/backend.py",
)


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def test_live_session_boundary() -> None:
    print("== single live-session boundary ==")
    source = inspect.getsource(LiveSession)
    check(
        "LiveSession owns one typed RuntimeSession Gateway attachment",
        "self.runtime_session: RuntimeSession | None = None" in source
        and "def attach_gateway(" in source
        and "WorkSession" not in source,
    )
    check(
        "LiveSession publishes to subscribers after durable product-event append",
        "self._events.append(" in source and "self.subscribers" in source,
    )
    check(
        "legacy session implementation files are gone",
        all(not Path(path).exists() for path in _REMOVED_FILES),
        ", ".join(path for path in _REMOVED_FILES if Path(path).exists()),
    )
    check(
        "RuntimeCatalog exposes Codex without native WorkSession",
        "codex" in RuntimeCatalog.discover().runtime_ids()
        and "native" not in RuntimeCatalog.discover().runtime_ids(),
    )
    check("durable replay owner is ProductEventStore", callable(ProductEventStore.replay))


def test_serve_route_owner() -> None:
    print("== current serve route owner ==")
    app = create_app(Path(tempfile.mkdtemp(prefix="live-session-boundary-")))
    # starlette BaseRoute 未声明 path; 本 app 的路由 (Route/Mount) 都带 path。
    paths = {getattr(route, "path", "") for route in app.routes}
    check("new serve owns session open", "/api/serve/sessions/open" in paths, str(paths))
    check(
        "new serve owns SSE events",
        "/api/serve/sessions/{session_id}/events" in paths,
        str(paths),
    )


def test_network_domain_policy() -> None:
    root = Path(__file__).resolve().parents[3]
    source = json.loads((root / "product.json").read_text(encoding="utf-8"))
    packaged = json.loads(
        (root / "apps/desktop/resources/product.json").read_text(encoding="utf-8")
    )
    domains = source["runtimes"]["codex"]["default_permission"]["allowed_network_domains"]
    packaged_domains = packaged["runtimes"]["codex"]["default_permission"][
        "allowed_network_domains"
    ]
    check(
        "product and packaged manifests grant only the exact PaperHub host",
        domains == packaged_domains == ["scholarseed.damo.alibaba.com"]
        and RUNTIME_ALLOWED_NETWORK_DOMAINS == tuple(domains),
    )


def main() -> int:
    test_live_session_boundary()
    test_serve_route_owner()
    test_network_domain_policy()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
