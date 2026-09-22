"""Desktop 开发动态端口的 loopback CORS 契约。"""

# 测试隔离必须先于首方模块导入。
# pylint: disable=wrong-import-position

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

_HOME = Path(tempfile.mkdtemp(prefix="scholarseed-cors-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

from tests._isolate import isolate_research_db  # noqa: E402

_RESEARCH_DB = isolate_research_db()

from service.bootstrap import create_app  # noqa: E402

LOOPBACK_ORIGINS = (
    "http://localhost:43127",
    "http://127.0.0.1:43128",
)
REJECTED_ORIGINS = (
    "http://localhost.example:43127",
    "https://localhost:43127",
)
ALLOW_ORIGIN_HEADER = "access-control-allow-origin"
PREFLIGHT_HEADERS = {"access-control-request-method": "GET"}


def _preflight(client: TestClient, origin: str):
    return client.options(
        "/api/healthz",
        headers={"origin": origin, **PREFLIGHT_HEADERS},
    )


def main() -> int:
    app = create_app(cwd=_HOME, cases_root=_HOME / "cases", auth=False)
    with TestClient(app) as client:
        for origin in LOOPBACK_ORIGINS:
            response = _preflight(client, origin)
            if response.status_code != 200 or response.headers.get(ALLOW_ORIGIN_HEADER) != origin:
                print(f"FAIL: loopback origin was not allowed: {origin}")
                return 1
        for origin in REJECTED_ORIGINS:
            response = _preflight(client, origin)
            if ALLOW_ORIGIN_HEADER in response.headers:
                print(f"FAIL: non-loopback origin was allowed: {origin}")
                return 1
    print("contract_cors: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
