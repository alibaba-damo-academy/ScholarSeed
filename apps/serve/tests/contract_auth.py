"""简单认证契约 (scholarseed login / serve --auth): 用户/口令/token 存储 + FastAPI 鉴权面
+ research ledger 多用户归账。

真 FastAPI app (TestClient) + 真文件存储 (隔离 SCHOLARSEED_HOME), 不 mock。
跑法: .venv/bin/python -m tests.contract_auth
"""

# 本文件按测试隔离写法: 先设 SCHOLARSEED_HOME / 隔离 research db, 再 import 首方模块。
# pylint: disable=wrong-import-position

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

_HOME = Path(tempfile.mkdtemp(prefix="rp-auth-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

from tests._isolate import isolate_research_db  # noqa: E402  (隔离先于 first-party import)

_RESEARCH_DB = isolate_research_db()

import service.identity.persistence.tokens as token_store  # noqa: E402
import service.identity.persistence.users as user_store  # noqa: E402
from service.bootstrap import create_app  # noqa: E402
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV  # noqa: E402

PASS, FAIL = 0, 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def test_store() -> None:
    print("[1] 用户/token 文件存储")
    u = user_store.create_user("a@test.dev", "secret1")
    check("create_user 返回 user_id", u["user_id"].startswith("u-"))
    try:
        user_store.create_user("a@test.dev", "secret1")
        check("重复 email 拒绝", False)
    except ValueError:
        check("重复 email 拒绝", True)
    try:
        user_store.create_user("b@test.dev", "123")
        check("短口令拒绝", False)
    except ValueError:
        check("短口令拒绝", True)
    check("口令验证通过", user_store.verify_password("a@test.dev", "secret1") is not None)
    check("错误口令拒绝", user_store.verify_password("a@test.dev", "wrong!") is None)
    raw = (_HOME / "auth.json").read_text()
    check("明文口令不落盘", "secret1" not in raw)
    tok = token_store.issue_token(u["user_id"])
    check("token 验证回 user", (token_store.verify_token(tok) or {}).get("email") == "a@test.dev")
    check("token 明文不落盘", tok not in (_HOME / "auth.json").read_text())
    check("revoke 后失效", token_store.revoke_token(tok) and token_store.verify_token(tok) is None)


def test_http() -> None:
    print("[2] FastAPI 鉴权面 (auth=True)")
    cases = _HOME / "cases"
    cases.mkdir(exist_ok=True)
    app = create_app(cases_root=cases, auth=True)
    c = TestClient(app)

    check("healthz 公开", c.get("/api/healthz").status_code == 200)
    check(
        "status: enabled + 非 bootstrap (已有用户)",
        c.get("/api/auth/status").json().get("enabled") is True
        and c.get("/api/auth/status").json().get("bootstrap") is False,
    )
    check("受保护路由 401", c.get("/api/content/projects").status_code == 401)
    os.environ[HOST_PROCESS_KEY_ENV] = "device-skill-contract-key"
    host_headers = {HOST_PROCESS_HEADER: "device-skill-contract-key"}
    check("技能接口未公开", c.get("/api/capabilities/skills").status_code == 401)
    check(
        "错误设备凭据拒绝",
        c.get("/api/capabilities/skills", headers={HOST_PROCESS_HEADER: "wrong"}).status_code
        == 401,
    )
    check(
        "设备凭据不放开项目接口",
        c.get("/api/content/projects", headers=host_headers).status_code == 401,
    )
    # Invalid upload reaches the real local capability owner, without invoking a model.
    check(
        "设备技能上传无需账号",
        c.post("/api/capabilities/skills/upload", headers=host_headers).status_code == 422,
    )
    check(
        "技能前缀边界不放行",
        c.get("/api/capabilities/skills-other", headers=host_headers).status_code == 401,
    )
    os.environ.pop(HOST_PROCESS_KEY_ENV)
    check(
        "错口令登录 401",
        c.post("/api/auth/login", json={"email": "a@test.dev", "password": "no"}).status_code
        == 401,
    )
    r = c.post("/api/auth/login", json={"email": "a@test.dev", "password": "secret1"})
    check("登录 200 + token", r.status_code == 200 and r.json().get("token"))
    tok = r.json()["token"]
    hdr = {"authorization": f"Bearer {tok}"}
    check("bearer 过鉴权", c.get("/api/content/projects", headers=hdr).status_code == 200)
    check(
        "cookie 过鉴权 (SSE 形态)",
        c.get("/api/content/projects", cookies={"scholarseed_token": tok}).status_code == 200,
    )
    check("me 返回身份", c.get("/api/auth/me", headers=hdr).json().get("email") == "a@test.dev")
    check(
        "匿名注册第二用户 401",
        c.post(
            "/api/auth/register", json={"email": "c@test.dev", "password": "secret2"}
        ).status_code
        == 401,
    )
    check(
        "已登录注册第二用户 200",
        c.post(
            "/api/auth/register", headers=hdr, json={"email": "c@test.dev", "password": "secret2"}
        ).status_code
        == 200,
    )
    # logout
    c.post("/api/auth/logout", headers=hdr)
    check("logout 后 token 失效", c.get("/api/content/projects", headers=hdr).status_code == 401)


def test_disabled() -> None:
    print("[3] auth=False (本地单用户零打扰)")
    cases = _HOME / "cases"
    app = create_app(cases_root=cases, auth=False)
    c = TestClient(app)
    check("无鉴权直通", c.get("/api/content/projects").status_code == 200)
    check(
        "me 报告 anonymous",
        c.get("/api/auth/me").json() == {"user_id": "local", "email": "", "auth": False},
    )
    check("status enabled=False", c.get("/api/auth/status").json()["enabled"] is False)


def test_auto() -> None:
    print("[4] auth=None (auto: 有用户即开)")
    app = create_app(cases_root=_HOME / "cases", auth=None)
    check("已有用户 → 自动开", app.state.auth_enabled is True)


def main() -> int:
    test_store()
    test_http()
    test_disabled()
    test_auto()
    print(f"\ncontract_auth: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
