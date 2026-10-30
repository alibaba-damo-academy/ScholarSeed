"""Identity writes retain admitted work through cancellation and serialize cleanup."""

from __future__ import annotations

import asyncio
import os
import threading
import unittest
from unittest.mock import Mock, patch

import httpx

from service.identity.api.routes import register_auth
from service.identity.providers.local import LocalAuthProvider
from service.identity.service.auth import AuthService
from service.identity.service.policy import current_policy
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV
from service.platform.activity import Activities
from service.platform.http_activity import ServeApplication


class IdentityWritesContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.activities = Activities()
        self.app = ServeApplication(activities=self.activities)
        self.started = threading.Event()
        self.release = threading.Event()
        self.cleaning = asyncio.Event()
        self.finish_cleanup = asyncio.Event()
        self.cleanup_failure = False
        self.user = {"user_id": "fixture-user", "email": "fixture@example.test"}
        self.users = Mock()
        self.users.has_users.return_value = False
        self.users.create.return_value = self.user
        self.users.verify_password.return_value = self.user
        self.tokens = Mock()
        self.tokens.verify.side_effect = lambda token: self.user if token == "fixture" else None
        self.tokens.issue.return_value = "fixture-issued-token"
        self.tokens.revoke.return_value = True
        self.holder = Mock()
        self.skills = Mock()
        self.app.state.skill_credentials = self.skills
        self.auth = AuthService(
            users=self.users, tokens=self.tokens, providers=(LocalAuthProvider(),)
        )

        async def cleanup(*_args):
            self.cleaning.set()
            await self.finish_cleanup.wait()
            if self.cleanup_failure:
                raise RuntimeError("fixture cleanup failed")

        register_auth(
            self.app,
            activities=self.activities,
            enabled=False,
            service=self.auth,
            account_tokens=self.holder,
            on_logout=cleanup,
            on_auth_disabled=cleanup,
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://fixture"
        )
        self.host = patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "fixture-host-key"})
        self.host.start()

    async def asyncTearDown(self) -> None:
        self.release.set()
        self.finish_cleanup.set()
        await self.wait_for(lambda: not self.activities.snapshot().counts)
        await self.client.aclose()
        self.host.stop()

    async def wait_for(self, predicate) -> None:
        async with asyncio.timeout(5):
            while not predicate():
                await asyncio.sleep(0.01)

    def blocked_user(self, *_args):
        self.started.set()
        if not self.release.wait(6):
            raise TimeoutError("test did not release identity write")
        return self.user

    async def test_all_new_identity_writes_reject_maintenance(self) -> None:
        generation = self.activities.begin()
        for method, path, body in (
            (
                "POST",
                "/api/auth/register",
                {"email": "fixture@example.test", "password": "password"},
            ),
            ("POST", "/api/auth/login", {"email": "fixture@example.test", "password": "password"}),
            ("POST", "/api/auth/logout", {}),
            ("PUT", "/api/auth/mode", {"mode": "account"}),
        ):
            with self.subTest(path=path):
                response = await self.client.request(
                    method, path, json=body, headers={HOST_PROCESS_HEADER: "fixture-host-key"}
                )
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"detail": "update_maintenance"})
        self.users.create.assert_not_called()
        self.users.verify_password.assert_not_called()
        self.tokens.issue.assert_not_called()
        self.tokens.revoke.assert_not_called()
        self.assertFalse(self.cleaning.is_set())
        self.assertFalse(current_policy(self.app).enabled)
        self.assertTrue(self.activities.seal(generation))

    async def cancelled_password_work(self, operation: str) -> None:
        target = self.users.create if operation == "register" else self.users.verify_password
        target.side_effect = self.blocked_user
        task = asyncio.create_task(
            self.client.post(
                f"/api/auth/{operation}",
                json={"email": "fixture@example.test", "password": "password"},
            )
        )
        try:
            await self.wait_for(self.started.is_set)
            generation = self.activities.begin()
            task.cancel()
            await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.sleep(0.01)
            self.assertGreaterEqual(self.activities.snapshot().counts.get("credential", 0), 1)
            self.assertFalse(self.activities.seal(generation))
        finally:
            self.release.set()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
        await self.wait_for(lambda: not self.activities.snapshot().counts)
        target.assert_called_once()
        if operation == "login":
            self.tokens.issue.assert_called_once_with("fixture-user")
        self.assertTrue(self.activities.seal(generation))

    async def test_cancelled_login_keeps_password_and_token_work_owned(self) -> None:
        await self.cancelled_password_work("login")

    async def test_cancelled_registration_keeps_user_write_owned(self) -> None:
        await self.cancelled_password_work("register")

    async def cancelled_cleanup(self, mode: bool) -> None:
        task = asyncio.create_task(
            self.client.put(
                "/api/auth/mode",
                json={"mode": "off"},
                headers={HOST_PROCESS_HEADER: "fixture-host-key"},
            )
            if mode
            else self.client.post("/api/auth/logout", headers={"Authorization": "Bearer fixture"})
        )
        try:
            await asyncio.wait_for(self.cleaning.wait(), 3)
            generation = self.activities.begin()
            task.cancel()
            await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.sleep(0.01)
            self.assertFalse(self.activities.seal(generation))
            self.assertGreaterEqual(self.activities.snapshot().counts.get("credential", 0), 1)
        finally:
            self.finish_cleanup.set()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
        await self.wait_for(lambda: not self.activities.snapshot().counts)
        if mode:
            self.holder.clear_all.assert_called_once()
            self.skills.clear_credentials.assert_called_once()
        else:
            self.tokens.revoke.assert_called_once_with("fixture")
            self.holder.forget.assert_not_called()
            self.holder.forget_if_current.assert_not_called()
            self.skills.forget.assert_not_called()
            self.skills.forget_if_current.assert_not_called()
        self.assertTrue(self.activities.seal(generation))

    async def test_cancelled_logout_finishes_all_credential_cleanup(self) -> None:
        await self.cancelled_cleanup(False)

    async def test_cancelled_mode_switch_finishes_all_credential_cleanup(self) -> None:
        await self.cancelled_cleanup(True)

    async def test_concurrent_mode_change_waits_for_previous_cleanup(self) -> None:
        headers = {HOST_PROCESS_HEADER: "fixture-host-key"}
        first = asyncio.create_task(
            self.client.put("/api/auth/mode", json={"mode": "off"}, headers=headers)
        )
        second = None
        try:
            await asyncio.wait_for(self.cleaning.wait(), 3)
            second = asyncio.create_task(
                self.client.put("/api/auth/mode", json={"mode": "account"}, headers=headers)
            )
            await self.wait_for(lambda: self.activities.snapshot().counts.get("credential", 0) >= 4)
            self.assertFalse(current_policy(self.app).enabled)
            self.assertFalse(second.done())
            self.finish_cleanup.set()
            results = await asyncio.wait_for(asyncio.gather(first, second), 5)
            self.assertEqual([row.status_code for row in results], [200, 200])
            self.assertTrue(current_policy(self.app).enabled)
            self.holder.clear_all.assert_called_once()
        finally:
            self.finish_cleanup.set()
            await asyncio.gather(*([first, second] if second else [first]), return_exceptions=True)

    async def test_failed_logout_callback_still_clears_credentials(self) -> None:
        self.cleanup_failure = True
        self.finish_cleanup.set()
        with self.assertRaisesRegex(RuntimeError, "fixture cleanup failed"):
            await self.client.post("/api/auth/logout", headers={"Authorization": "Bearer fixture"})
        self.holder.forget.assert_not_called()
        self.holder.forget_if_current.assert_not_called()
        self.skills.forget.assert_not_called()
        self.skills.forget_if_current.assert_not_called()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_failed_mode_callback_still_clears_credentials(self) -> None:
        self.cleanup_failure = True
        self.finish_cleanup.set()
        with self.assertRaisesRegex(RuntimeError, "fixture cleanup failed"):
            await self.client.put(
                "/api/auth/mode",
                json={"mode": "off"},
                headers={HOST_PROCESS_HEADER: "fixture-host-key"},
            )
        self.holder.clear_all.assert_called_once()
        self.skills.clear_credentials.assert_called_once()
        self.assertFalse(current_policy(self.app).enabled)
        self.assertEqual(self.activities.snapshot().counts, {})


if __name__ == "__main__":
    unittest.main()
