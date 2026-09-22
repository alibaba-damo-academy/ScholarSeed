"""会话技能凭据契约 —— SCHOLARSEED_API_KEY 的签发、复用、降级与注入路径。

证:
1. **签发走槽位端点**: 向 /api/account/api-keys/session 带全局 slot 取回 key。
   account 复用可解密的活跃行，冷启动不轮换。
2. **权威取回**: 开会话一次 POST，无 GET 预校验；ensure 可离线复用。
3. **降级不阻塞**: 未配地址 / 未登录 / 上游不可达 / 签发被拒一律返回空 dict。
4. **用户 env 优先**: os.environ 已有非空同名值时不注入 (子进程本来就继承它, 且空 env
   digest 才能与控制面共用同一个 App Server host)。
5. **注入路径**: LiveSessionService 只把不透明 secret 引用交给 Runtime Gateway；
   明文由 invocation-scoped port 在 adapter 接纳会话时解析，不进入 intent 或持久化。

跑法: uv run python -m apps.serve.tests.contract_skill_credentials
"""

# 隔离必须先于 first-party import 落地 —— 路径常量在 import 期即求值。
# pylint: disable=wrong-import-position

from __future__ import annotations

import asyncio
import os
import tempfile

os.environ["SCHOLARSEED_HOME"] = tempfile.mkdtemp(prefix="skill-cred-home-")

from typing import Any  # noqa: E402

import httpx  # noqa: E402

from service.chat.runtime.secrets import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    _launch_secret_contract,
)
from service.identity.service.account_token import AccountTokenHolder  # noqa: E402
from service.identity.service.skill_credentials import (  # noqa: E402
    GLOBAL_SLOT,
    KEY_NAME,
    SKILL_API_KEY_ENV,
    SLOT_KEY_PATH,
    SkillCredentialService,
    skill_credentials_from_env,
)

PASS = 0
FAIL = 0

OWN_NAME = KEY_NAME
BASE_URL = "http://account.test"
USER = "user-1"
CREDENTIAL = "jwt-of-user-1"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


class _Response:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        if self._payload is _UNPARSEABLE:
            raise ValueError("not json")
        return self._payload


_UNPARSEABLE = object()


class _Account:
    """记账用的假 httpx.Client：只认槽位签发与机器面两条路。"""

    def __init__(
        self,
        *,
        issue: Any = None,
        issue_status: int = 200,
        fail: bool = False,
    ) -> None:
        self.calls: list[tuple[str, str, dict[str, Any] | None, str]] = []
        self._issue = {
            "key_id": "k-new",
            "name": OWN_NAME,
            "managed": True,
            "token": "ssk-fresh",
        }
        if issue is not None:
            self._issue = issue
        self._issue_status = issue_status
        self._fail = fail

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
    ) -> _Response:
        self.calls.append((method, url, json, (headers or {}).get("Authorization", "")))
        if self._fail:
            raise httpx.ConnectError("account unreachable")
        return _Response(self._issue_status, self._issue)

    def issued(self) -> list[dict[str, Any] | None]:
        return [body for method, url, body, _auth in self.calls if url.endswith(SLOT_KEY_PATH)]

    def verified(self) -> int:
        return sum(method == "GET" for method, _url, _body, _auth in self.calls)


def _service(client: _Account, *, base_url: str = BASE_URL, environ: Any = None) -> Any:
    service = SkillCredentialService(
        base_url,
        client=client,  # type: ignore[arg-type]
        environ={} if environ is None else environ,
    )
    service.bind_identity(_identity, lambda _owner: CREDENTIAL)
    return service


def _identity(credential: str) -> dict[str, str] | None:
    return {"user_id": USER} if credential == CREDENTIAL else None


def test_issue_on_slot() -> None:
    print("[1] 按全局槽位取回凭据")
    client = _Account()
    service = _service(client)
    env = asyncio.run(service.environment(USER, CREDENTIAL))
    check("注入 SCHOLARSEED_API_KEY", env == {SKILL_API_KEY_ENV: "ssk-fresh"}, str(env))
    check(
        "请求带全局 slot 与自解释名字",
        client.issued() == [{"slot": GLOBAL_SLOT, "name": OWN_NAME}],
        str(client.issued()),
    )
    check(
        "不再对既有 key 做列表/吊销（那是槽位端点的职责）",
        all(method == "POST" for method, _u, _b, _a in client.calls),
        str(client.calls),
    )
    check(
        "用户 JWT 以 Bearer 透传给账号服务",
        all(auth == f"Bearer {CREDENTIAL}" for _m, _u, _b, auth in client.calls),
        str(client.calls),
    )


def test_authoritative_retrieval() -> None:
    print("[2] 每次开会话一次 POST，重启复用，远端轮换后获取新凭据")
    client = _Account()
    service = _service(client)
    first = asyncio.run(service.environment(USER, CREDENTIAL))
    second = asyncio.run(service.environment(USER, CREDENTIAL))
    restarted = asyncio.run(_service(client).environment(USER, CREDENTIAL))
    check(
        "多个实例拿到同一把",
        first == second == restarted == {SKILL_API_KEY_ENV: "ssk-fresh"},
    )
    check("每次开会话一次 POST", len(client.issued()) == 3 and client.verified() == 0)
    client._issue = {"key_id": "k2", "token": "ssk-second"}
    changed = asyncio.run(service.environment(USER, CREDENTIAL))
    check(
        "远端轮换后开会话更新缓存",
        changed == {SKILL_API_KEY_ENV: "ssk-second"}
        and service.cached_environment(USER) == changed,
    )
    client._fail = True
    check(
        "权威取回失败清掉旧缓存",
        asyncio.run(service.environment(USER, CREDENTIAL)) == {}
        and service.cached_environment(USER) == {},
    )


def test_degrades_without_blocking() -> None:
    print("[3] 拿不到就降级成不注入")
    unreachable = _Account(fail=True)
    check(
        "账号服务不可达 → 空 dict",
        asyncio.run(_service(unreachable).environment(USER, CREDENTIAL)) == {},
    )
    rejected = _Account(issue_status=400, issue={"code": "invalid_api_key_slot"})
    check(
        "签发被拒 → 空 dict",
        asyncio.run(_service(rejected).environment(USER, CREDENTIAL)) == {},
    )
    tokenless = _Account(issue={"key_id": "k-new", "name": OWN_NAME})
    check(
        "响应无 token 字段 → 空 dict",
        asyncio.run(_service(tokenless).environment(USER, CREDENTIAL)) == {},
    )
    unconfigured = _Account()
    check(
        "未配账号服务地址 → 空 dict 且不出网",
        asyncio.run(_service(unconfigured, base_url="").environment(USER, CREDENTIAL)) == {}
        and not unconfigured.calls,
    )
    anonymous = _Account()
    check(
        "未登录 (无凭据) → 空 dict 且不出网",
        asyncio.run(_service(anonymous).environment(USER, "")) == {} and not anonymous.calls,
    )
    check(
        "未配地址时 configured() 为 False",
        not _service(_Account(), base_url="").configured(),
    )


def test_inherited_env_wins() -> None:
    print("[4] 用户自己 export 的同名变量优先")
    client = _Account()
    service = _service(client, environ={SKILL_API_KEY_ENV: "ssk-user-own"})
    env = asyncio.run(service.environment(USER, CREDENTIAL))
    check("登录后显式投影继承值", env == {SKILL_API_KEY_ENV: "ssk-user-own"}, str(env))
    check("不向账号服务签发", not client.calls, str(client.calls))


def test_display_name() -> None:
    print("[5] 工厂不依赖 home 或主机名，全局固定展示名")
    for home in ("/fixture/home-a", "/fixture/home-b"):
        service = skill_credentials_from_env({"SCHOLARSEED_HOME": home})
        check("未配地址不参与", not service.configured())
    client = _Account()
    asyncio.run(_service(client).environment(USER, CREDENTIAL))
    check("slot 与名称固定", client.issued() == [{"slot": GLOBAL_SLOT, "name": KEY_NAME}])


def test_session_uses_opaque_launch_secret_contract() -> None:
    print("[6] 会话凭据通过不透明 Runtime Gateway secret contract")
    environment = {SKILL_API_KEY_ENV: "ssk-fresh"}
    intent, port = _launch_secret_contract(environment)
    empty_intent, empty_port = _launch_secret_contract({})
    assert port is not None
    binding = intent.bindings[0]
    material = asyncio.run(port.resolve(binding.secret_ref))
    check(
        "intent 只携带目标名与不透明引用",
        binding.name == SKILL_API_KEY_ENV
        and binding.secret_ref != environment[SKILL_API_KEY_ENV]
        and environment[SKILL_API_KEY_ENV] not in repr(intent),
        repr(intent),
    )
    check(
        "明文只由 invocation-scoped port 解析",
        material.value == environment[SKILL_API_KEY_ENV],
    )
    check(
        "无产品凭据时不创建 resolver",
        empty_intent.bindings == () and empty_port is None,
    )


def test_cached_environment_is_offline() -> None:
    print("[7] cached_environment 纯内存：不出网、不签发")
    client = _Account()
    service = _service(client)
    check("没签发过时为空", not service.cached_environment(USER))
    asyncio.run(service.environment(USER, CREDENTIAL))
    calls = len(client.calls)
    check(
        "签发过后返回同一把",
        service.cached_environment(USER) == {SKILL_API_KEY_ENV: "ssk-fresh"},
        str(service.cached_environment(USER)),
    )
    check("取它不产生任何请求（挂在每个 turn 前的判定）", len(client.calls) == calls)
    inherited = _service(_Account(), environ={SKILL_API_KEY_ENV: "ssk-user-own"})
    check(
        "登录后显式投影继承值",
        inherited.cached_environment(USER) == {SKILL_API_KEY_ENV: "ssk-user-own"},
    )


def test_revocation() -> None:
    holder = AccountTokenHolder()
    holder.remember(USER, "fixture.account.token")
    holder.forget(USER)
    holder.remember(USER, "fixture.account.token")
    check("迟到请求不能重记已登出的 token", holder.current(USER) == "")
    holder.remember(USER, "fixture.new.token")
    check("重新登录的新 token 可用", holder.current(USER) == "fixture.new.token")
    client = _Account()
    service = _service(client, environ={SKILL_API_KEY_ENV: "ssk-parent"})
    active = {USER: CREDENTIAL}
    service.bind_identity(
        lambda token: _identity(token) if active else None,
        lambda owner: active.get(owner, ""),
    )
    check("登录态允许受管凭据", bool(asyncio.run(service.admission_environment(USER))))
    revision = service.revision
    active.clear()
    service.forget(USER)
    check("撤权修订不含秘密且递增", service.revision > revision)
    check("访客不能继承父平台凭据", asyncio.run(service.admission_environment(USER)) == {})
    check("旧凭据无法从 ensure 复活", asyncio.run(service.ensure(USER, CREDENTIAL)) == {})
    intent, _port = _launch_secret_contract({})
    check("空环境仍显式删除平台键", SKILL_API_KEY_ENV in intent.remove_environment)

    async def during_issue() -> None:
        issued = asyncio.Event()
        release = asyncio.Event()
        service = _service(_Account())
        loop = asyncio.get_running_loop()
        original = service._issue_slot

        def delayed(credential: str) -> str:
            loop.call_soon_threadsafe(issued.set)
            asyncio.run_coroutine_threadsafe(release.wait(), loop).result()
            return original(credential)

        service._issue_slot = delayed
        task = asyncio.create_task(service.environment(USER, CREDENTIAL))
        await issued.wait()
        service.forget(USER)
        release.set()
        check(
            "签发期间登出不恢复缓存",
            await task == {} and service.cached_environment(USER) == {},
        )

    asyncio.run(during_issue())


def test_refresh_forces_reissue() -> None:
    print("[8] refresh 强制重签（账号页轮换后的即时对齐前提）")
    client = _Account(issue={"key_id": "k1", "token": "ssk-first"})
    service = _service(client)
    asyncio.run(service.environment(USER, CREDENTIAL))
    client._issue = {"key_id": "k2", "token": "ssk-second"}  # pylint: disable=protected-access
    env = asyncio.run(service.refresh(USER, CREDENTIAL))
    check("拿到新的一把", env == {SKILL_API_KEY_ENV: "ssk-second"}, str(env))
    check(
        "缓存已更新",
        service.cached_environment(USER) == {SKILL_API_KEY_ENV: "ssk-second"},
    )
    check(
        "全程没校验过（首次签发无缓存可验，轮换后那把必然已死）",
        client.verified() == 0,
        str(client.calls),
    )
    check("签发过两次", len(client.issued()) == 2, str(client.issued()))
    failing = _Account(issue_status=400, issue={"code": "invalid_api_key_slot"})
    broken = _service(failing)
    asyncio.run(broken.environment(USER, CREDENTIAL))
    check(
        "重签失败则清掉缓存（不留一把状态未知的凭据）",
        asyncio.run(broken.refresh(USER, CREDENTIAL)) == {} and not broken.cached_environment(USER),
    )


def test_ensure_only_fills_the_hole() -> None:
    print("[9] ensure 语义：缺则签发，有则沿用，既不校验也不清缓存")
    client = _Account(issue={"key_id": "k1", "token": "ssk-first"})
    service = _service(client)
    first = asyncio.run(service.ensure(USER, CREDENTIAL))
    check("一把都没有时签发一把", first == {SKILL_API_KEY_ENV: "ssk-first"}, str(first))
    # 换掉签发响应：若第二次仍走签发，就会拿到 ssk-second —— 那正是「登录即轮换」的表现
    client._issue = {"key_id": "k2", "token": "ssk-second"}  # pylint: disable=protected-access
    again = asyncio.run(service.ensure(USER, CREDENTIAL))
    check(
        "再次调用沿用原来那把（不轮换，正在跑的会话不受影响）",
        again == {SKILL_API_KEY_ENV: "ssk-first"},
        str(again),
    )
    check("只签发过一次", len(client.issued()) == 1, str(client.issued()))
    # 沿用这条路不该出网: 它只是「让设置页看得到这一行」, 不是判断缓存那把还活不活。
    check("沿用时一次机器面校验都不打", client.verified() == 0, str(client.verified()))

    # 关键不变量: ensure 是后台调用, 绝不能让现状变差。校验一次就意味着「账号服务恰好抖了
    # 一下」会清空缓存, 而缓存一空, 活着的会话下一个 turn 就被对齐成「无凭据」且不会自愈。
    client._fail = True  # pylint: disable=protected-access
    offline = asyncio.run(service.ensure(USER, CREDENTIAL))
    check(
        "账号服务不可达时照旧沿用（不出网也就不会清缓存）",
        offline == {SKILL_API_KEY_ENV: "ssk-first"},
        str(offline),
    )
    check(
        "缓存仍在（否则活着的会话会被对齐成无凭据）",
        service.cached_environment(USER) == {SKILL_API_KEY_ENV: "ssk-first"},
        str(service.cached_environment(USER)),
    )


def main() -> int:
    test_issue_on_slot()
    test_authoritative_retrieval()
    test_degrades_without_blocking()
    test_inherited_env_wins()
    test_display_name()
    test_session_uses_opaque_launch_secret_contract()
    test_cached_environment_is_offline()
    test_refresh_forces_reissue()
    test_ensure_only_fills_the_hole()
    test_revocation()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
