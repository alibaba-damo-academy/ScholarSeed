"""运行期 auth-mode 切换面契约（proposal 18）— 常挂中间件 + 不可变 policy 原子替换。

钉死不得回归的边界：
- 启动期矩阵与旧行为逐字节一致（account 匿名 401 / off 匿名 local / status 投影）；
- 切换端点仅受信宿主可达（缺/错 Host-Key 一律 403，fail-closed）；
- 切换即时生效：off 后受保护路由匿名 200、me 回 local；account 后立刻 401；
- 切换不迁移凭据：AccountTokenHolder clear-all、SkillCredentialService 快照清空；
- mode 决议单一函数：off/enforced/auto 三档与启动期共用 enabled_for_mode。

跑法: .venv/bin/python -m tests.contract_auth_policy_switch
"""

# pylint: disable=wrong-import-position  # 隔离 HOME/research db 必须先于 first-party import

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

_HOME = Path(tempfile.mkdtemp(prefix="rp-auth-policy-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

from tests._isolate import isolate_research_db  # noqa: E402

_RESEARCH_DB = isolate_research_db()

from service.identity.api.routes import register_auth  # noqa: E402
from service.identity.service.account import ACCOUNT_BASE_URL_ENV  # noqa: E402
from service.identity.service.account_token import AccountTokenHolder  # noqa: E402
from service.identity.service.policy import (  # noqa: E402
    AUTH_MODE_CHOICES,
    enabled_for_mode,
)
from service.identity.service.skill_credentials import (  # noqa: E402
    SkillCredentialService,
)
from service.identity.utils import HOST_PROCESS_KEY_ENV  # noqa: E402

PASS, FAIL = 0, 0

HOST_KEY = "test-host-key-0123456789"
PROTECTED = "/api/protected"


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def _build_app(*, enabled: bool, mode: str) -> FastAPI:
    # 默认装配（不传 service）：register_auth 会接上 account_trust_from_env() ——
    # status 的 account 投影要求 AccountTrust configured，裸 AuthService() 会落回
    # provider 决议（mode=local），与真实 serve 的装配不一致。
    os.environ[ACCOUNT_BASE_URL_ENV] = "http://127.0.0.1:18799"
    app = FastAPI()
    holder = AccountTokenHolder()
    app.state.account_tokens = holder
    register_auth(app, enabled=enabled, mode=mode, account_tokens=holder)

    @app.get(PROTECTED)
    def protected(request: Request) -> Dict[str, Any]:
        return {"ok": True, "user": getattr(request.state, "user_id", "local")}

    return app


def startup_matrix() -> None:
    print("[1] 启动期矩阵与旧行为一致")
    account_app = _build_app(enabled=True, mode="account")
    client = TestClient(account_app)
    r = client.get(PROTECTED)
    check("account 匿名受保护路由 401", r.status_code == 401, str(r.status_code))
    r = client.get("/api/auth/me")
    check("account 匿名 me 401", r.status_code == 401, str(r.status_code))
    status = client.get("/api/auth/status").json()
    check(
        "status 投影 account/enabled",
        status.get("mode") == "account" and status.get("enabled") is True,
        str(status),
    )

    off_app = _build_app(enabled=False, mode="off")
    off_client = TestClient(off_app)
    r = off_client.get(PROTECTED)
    check("off 匿名受保护路由 200", r.status_code == 200, str(r.status_code))
    me = off_client.get("/api/auth/me").json()
    check("off me 回 local 匿名", me.get("user_id") == "local" and me.get("auth") is False, str(me))
    status = off_client.get("/api/auth/status").json()
    check(
        "status 投影 off/disabled",
        status.get("mode") == "off" and status.get("enabled") is False,
        str(status),
    )
    check(
        "off 模式仍暴露账号服务地址（主动登录拼 URL 用）",
        status.get("account_base_url") == "http://127.0.0.1:18799",
        str(status),
    )


def host_key_gate() -> None:
    print("[2] 切换端点 Host-Key 门禁 fail-closed")
    app = _build_app(enabled=True, mode="account")
    client = TestClient(app)
    os.environ.pop(HOST_PROCESS_KEY_ENV, None)
    r = client.put("/api/auth/mode", json={"mode": "off"})
    check("无 Host-Key env 403", r.status_code == 403, str(r.status_code))
    os.environ[HOST_PROCESS_KEY_ENV] = HOST_KEY
    r = client.put(
        "/api/auth/mode", json={"mode": "off"}, headers={"X-ScholarSeed-Host-Key": "wrong"}
    )
    check("错 Host-Key 403", r.status_code == 403, str(r.status_code))
    r = client.put(
        "/api/auth/mode", json={"mode": "nope"}, headers={"X-ScholarSeed-Host-Key": HOST_KEY}
    )
    check("非法 mode 400", r.status_code == 400, str(r.status_code))


def runtime_switch() -> None:
    print("[3] 运行期切换即时生效 + 凭据不迁移")
    app = _build_app(enabled=True, mode="account")
    holder = app.state.account_tokens
    holder.remember("u-1", "aaa.bbb.ccc")
    check("切换前 holder 有凭据", holder.current("u-1") != "")
    client = TestClient(app)
    os.environ[HOST_PROCESS_KEY_ENV] = HOST_KEY
    headers = {"X-ScholarSeed-Host-Key": HOST_KEY}

    r = client.put("/api/auth/mode", json={"mode": "off"}, headers=headers)
    body = r.json()
    check(
        "切 off 200 且回报 enabled=False/restarted=False",
        r.status_code == 200 and body.get("enabled") is False and body.get("restarted") is False,
        str(body),
    )
    r = client.get(PROTECTED)
    check("切 off 后匿名 200（中间件读 policy）", r.status_code == 200, str(r.status_code))
    me = client.get("/api/auth/me").json()
    check("切 off 后 me 回 local", me.get("user_id") == "local", str(me))
    check("holder 已 clear-all", holder.current("u-1") == "")

    r = client.put("/api/auth/mode", json={"mode": "account"}, headers=headers)
    check("切回 account 200", r.status_code == 200, str(r.status_code))
    r = client.get(PROTECTED)
    check("切回后匿名立刻 401", r.status_code == 401, str(r.status_code))
    status = client.get("/api/auth/status").json()
    check(
        "status 随切换回 account",
        status.get("mode") == "account" and status.get("enabled") is True,
        str(status),
    )


def mode_resolution_single_source() -> None:
    print("[4] mode→enabled 单一决议函数")
    check("off → False", enabled_for_mode("off", True) is False)
    check("account → True（无视 has_users）", enabled_for_mode("account", False) is True)
    check("local → True", enabled_for_mode("local", False) is True)
    check("auto 无用户 → False", enabled_for_mode("auto", False) is False)
    check("auto 有用户 → True", enabled_for_mode("auto", True) is True)
    check("choices 含 account/off/auto", {"account", "off", "auto"} <= set(AUTH_MODE_CHOICES))


def skill_snapshot_clear() -> None:
    print("[5] 技能凭据快照随切换清空")
    service = SkillCredentialService(base_url="http://127.0.0.1:1")
    service._tokens["u-1"] = "ssk-test"  # pylint: disable=protected-access
    revision = service.revision
    service.clear_credentials()
    check(
        "clear_credentials 清空缓存并递增授权修订",
        not service._tokens and service.revision > revision,
        str(service.cached_environment("u-1")),
    )


def main() -> int:
    startup_matrix()
    host_key_gate()
    runtime_switch()
    mode_resolution_single_source()
    skill_snapshot_clear()
    print(f"\ncontract_auth_policy_switch: PASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
