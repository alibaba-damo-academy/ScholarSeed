from __future__ import annotations

import asyncio
import json
import threading
import time
import unittest

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI

from service.identity.api.routes import register_auth
from service.identity.persistence.tokens import TokenRepository
from service.identity.persistence.users import UserRepository
from service.identity.service.account import JWKS_PATH, REVOCATIONS_PATH, AccountTrust
from service.identity.service.account_token import AccountTokenHolder
from service.identity.service.auth import AuthService
from service.identity.service.skill_credentials import SKILL_API_KEY_ENV, SkillCredentialService
from service.platform.activity import Activities

USER = "generation-user"
FIRST = "first.payload.signature"
SECOND = "second.payload.signature"
GATE_TIMEOUT = 5


class EmptyTokens(TokenRepository):
    def verify(self, _token: str):
        return None

    def revoke(self, _token: str) -> bool:
        return False


class EmptyUsers(UserRepository):
    def has_users(self) -> bool:
        return False


class GatedAuth(AuthService):
    def __init__(self, trust: AccountTrust, held_call: int) -> None:
        super().__init__(account=trust, users=EmptyUsers(), tokens=EmptyTokens(), providers=())
        self.held_call = held_call
        self.first = ""
        self.calls = 0
        self.started = threading.Event()
        self.release = threading.Event()

    def identity(self, credential: str):
        verified = super().identity(credential)
        if credential == self.first:
            self.calls += 1
            if self.calls == self.held_call:
                self.started.set()
                if not self.release.wait(GATE_TIMEOUT):
                    raise TimeoutError("identity gate not released")
        return verified


def http_fixture(held_call: int):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
    public.update({"kid": "generation-key", "alg": "RS256", "use": "sig"})
    issued = int(time.time())

    def token(identifier: str):
        return jwt.encode(
            {"sub": USER, "typ": "user", "exp": issued + 3600, "jti": identifier},
            private,
            algorithm="RS256",
            headers={"kid": public["kid"]},
        )

    first, second = token("first"), token("second")

    def transport(request: httpx.Request):
        if request.url.path == JWKS_PATH:
            return httpx.Response(200, json={"keys": [public]})
        if request.url.path == REVOCATIONS_PATH:
            return httpx.Response(200, json={"revocations": [], "count": 0})
        return httpx.Response(200, json={"token": "ssk-new"})

    upstream = httpx.Client(transport=httpx.MockTransport(transport))
    activities = Activities()
    trust = AccountTrust("https://account.test", client=upstream, activities=activities)
    auth = GatedAuth(trust, held_call)
    auth.first = first
    holder = AccountTokenHolder()
    skills = SkillCredentialService(
        "https://account.test", client=upstream, environ={}, activities=activities
    )
    callbacks = []

    async def on_logout(owner: str):
        callbacks.append(owner)

    app = FastAPI()
    app.state.skill_credentials = skills
    register_auth(
        app,
        activities=activities,
        enabled=False,
        mode="off",
        service=auth,
        account_tokens=holder,
        on_logout=on_logout,
    )

    @app.get("/api/probe")
    async def probe():
        return {"ok": True}

    return app, auth, holder, skills, first, second, upstream, callbacks


class AuthRouteGenerationTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_logout_identity_await_windows_preserve_new_credential(self) -> None:
        for held_call in (1, 2):
            app, auth, holder, skills, first, second, upstream, callbacks = http_fixture(held_call)
            holder.remember(USER, first)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://serve.test"
            ) as client:
                logout = asyncio.create_task(
                    client.post("/api/auth/logout", headers={"Authorization": f"Bearer {first}"})
                )
                self.assertTrue(await asyncio.to_thread(auth.started.wait, GATE_TIMEOUT))
                self.assertEqual(
                    (
                        await client.get(
                            "/api/probe", headers={"Authorization": f"Bearer {second}"}
                        )
                    ).status_code,
                    200,
                )
                await skills.ensure(USER, second)
                holder_before, skill_before = getattr(holder, "revision", 0), skills.revision
                auth.release.set()
                self.assertEqual((await logout).json(), {"ok": False})
                self.assertEqual(holder.current(USER), second)
                self.assertEqual(getattr(holder, "revision", 0), holder_before)
                self.assertEqual(skills.revision, skill_before)
                self.assertEqual(skills.cached_environment(USER)[SKILL_API_KEY_ENV], "ssk-new")
                self.assertEqual(callbacks, [])
                await client.get("/api/probe", headers={"Authorization": f"Bearer {first}"})
                self.assertEqual(holder.current(USER), second)
                self.assertEqual(getattr(holder, "revision", 0), holder_before)
            upstream.close()

    async def test_absent_logout_does_not_remember_and_old_request_cannot_restore(self) -> None:
        app, _auth, holder, skills, first, _second, upstream, callbacks = http_fixture(0)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://serve.test"
        ) as client:
            before = getattr(holder, "revision", 0), skills.revision
            self.assertEqual(
                (
                    await client.post(
                        "/api/auth/logout", headers={"Authorization": f"Bearer {first}"}
                    )
                ).json(),
                {"ok": False},
            )
            self.assertEqual(holder.current(USER), "")
            self.assertEqual((getattr(holder, "revision", 0), skills.revision), before)
            await client.get("/api/probe", headers={"Authorization": f"Bearer {first}"})
            self.assertEqual(holder.current(USER), "")
            self.assertEqual(callbacks, [])
        upstream.close()


class CredentialGenerationTests(unittest.TestCase):
    def test_old_skill_request_does_not_clear_new_cache(self) -> None:
        holder = AccountTokenHolder()
        holder.remember(USER, SECOND)
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(200, json={"token": "ssk-new"})
            )
        )
        service = SkillCredentialService(
            "https://account.test", client=client, environ={}, activities=Activities()
        )
        service.bind_identity(lambda _credential: {"user_id": USER}, holder.current)
        asyncio.run(service.ensure(USER, SECOND))
        before = service.revision
        self.assertEqual(asyncio.run(service.ensure(USER, FIRST)), {})
        self.assertEqual(service.revision, before)
        self.assertEqual(service.cached_environment(USER)[SKILL_API_KEY_ENV], "ssk-new")
        client.close()

    def test_old_logout_tombstones_only_its_credential(self) -> None:
        holder = AccountTokenHolder()
        holder.remember(USER, SECOND)
        self.assertTrue(hasattr(holder, "forget_if_current"), "conditional holder cleanup missing")
        before = holder.revision
        self.assertEqual(holder.forget_if_current(USER, FIRST), "stale")
        holder.remember(USER, FIRST)
        self.assertEqual(holder.current(USER), SECOND)
        self.assertEqual(holder.revision, before)

    def test_absent_logout_still_blocks_later_old_projection(self) -> None:
        holder = AccountTokenHolder()
        self.assertTrue(hasattr(holder, "forget_if_current"), "absent credential tombstone missing")
        self.assertEqual(holder.forget_if_current(USER, FIRST), "absent")
        holder.remember(USER, FIRST)
        self.assertEqual(holder.current(USER), "")

    def test_projection_validated_before_new_login_cannot_overwrite_it(self) -> None:
        holder = AccountTokenHolder()
        self.assertTrue(hasattr(holder, "remember_if_unchanged"), "projection fence missing")
        before = holder.revision
        holder.remember(USER, SECOND)
        self.assertFalse(holder.remember_if_unchanged(USER, FIRST, before))
        self.assertEqual(holder.current(USER), SECOND)


if __name__ == "__main__":
    unittest.main()
