"""Community identity boundaries, with real routes and file-backed credentials."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

_HOME = Path(tempfile.mkdtemp(prefix="scholarseed-community-auth-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

from service.identity.api.routes import register_auth  # noqa: E402 - isolate product home first
from service.identity.persistence.tokens import issue_token, verify_token  # noqa: E402
from service.identity.persistence.users import create_user, verify_password  # noqa: E402
from service.identity.service.policy import AUTH_MODE_CHOICES, enabled_for_mode  # noqa: E402
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV  # noqa: E402
from service.platform.activity import Activities  # noqa: E402

REMOVED_ROUTES = (
    ("POST", "/api/auth/sso/login"),
    ("GET", "/api/auth/sso/callback"),
    ("GET", "/api/auth/sso/poll-token"),
    ("GET", "/sendBucSSOToken.do"),
)
LEGACY_USER = {
    "user_id": "legacy-user",
    "email": "legacy@example.test",
    "emp_id": "legacy-employee",
    "display_name": "Legacy identity",
    "auth_source": "sso",
}


class CommunityAuthContract(unittest.TestCase):
    def setUp(self) -> None:
        self.authPath = _HOME / "auth.json"
        self.authPath.write_text(
            json.dumps({"users": [LEGACY_USER], "tokens": [], "sso_session": {"retained": True}}),
            encoding="utf-8",
        )
        (_HOME / "config.json").write_text(
            json.dumps({"sso": {"enabled": True, "app_code": "legacy-fixture"}}),
            encoding="utf-8",
        )
        os.environ["SCHOLARSEED_SSO_ENABLED"] = "true"
        os.environ["SCHOLARSEED_SSO_APP_CODE"] = "legacy-fixture"

    def client(self, mode: str) -> TestClient:
        app = FastAPI()
        register_auth(app, enabled=enabled_for_mode(mode, True), mode=mode, activities=Activities())
        return TestClient(app)

    def test_removed_routes_and_ignored_legacy_configuration(self) -> None:
        original = self.authPath.read_bytes()
        for mode in ("off", "local", "auto"):
            with self.subTest(mode=mode), self.client(mode) as client:
                for method, path in REMOVED_ROUTES:
                    self.assertEqual(client.request(method, path).status_code, 404, path)
                status = client.get("/api/auth/status").json()
                self.assertEqual(status["mode"], "off" if mode == "off" else "local")
                self.assertNotIn("sso_login_url", status)
                self.assertNotIn("/api/auth/sso/login", client.app.openapi()["paths"])
        self.assertEqual(self.authPath.read_bytes(), original)

    def test_local_login_preserves_historical_records(self) -> None:
        self.assertIsNone(verify_password(LEGACY_USER["email"], "anything"))
        with self.client("local") as client:
            response = client.post(
                "/api/auth/login", json={"email": LEGACY_USER["email"], "password": "anything"}
            )
            self.assertEqual(response.status_code, 401)
            create_user("local@example.test", "local-password")
            response = client.post(
                "/api/auth/login",
                json={"email": "local@example.test", "password": "local-password"},
            )
            self.assertEqual(response.status_code, 200)
            token = response.json()["token"]
            profile = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
            self.assertEqual(profile.status_code, 200)
            self.assertEqual(profile.json()["email"], "local@example.test")
            self.assertNotIn("emp_id", profile.json())
        saved = json.loads(self.authPath.read_text(encoding="utf-8"))
        self.assertEqual(saved["users"][0], LEGACY_USER)
        self.assertEqual(saved["sso_session"], {"retained": True})

    def test_existing_identity_token_keeps_normal_lifecycle(self) -> None:
        token = issue_token(LEGACY_USER["user_id"])
        identity = verify_token(token)
        self.assertIsNotNone(identity)
        self.assertEqual(identity["user_id"], LEGACY_USER["user_id"])
        self.assertNotIn("emp_id", identity)

    def test_removed_mode_is_rejected_by_cli_environment_and_host_switch(self) -> None:
        self.assertNotIn("sso", AUTH_MODE_CHOICES)
        for invalidMode in ("sso", "invalid-provider"):
            with self.subTest(mode=invalidMode):
                with self.assertRaises(ValueError):
                    enabled_for_mode(invalidMode, False)
                for arguments, environment in (
                    (["--auth-mode", invalidMode], dict(os.environ)),
                    ([], dict(os.environ, SCHOLARSEED_AUTH_MODE=invalidMode)),
                ):
                    result = subprocess.run(
                        [sys.executable, "-m", "service.cli.serve", *arguments],
                        env=environment,
                        capture_output=True,
                        text=True,
                        timeout=30,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn("auth", result.stderr.lower())
        os.environ[HOST_PROCESS_KEY_ENV] = "community-contract-host"
        try:
            with self.client("off") as client:
                response = client.put(
                    "/api/auth/mode",
                    headers={HOST_PROCESS_HEADER: "community-contract-host"},
                    json={"mode": "sso"},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(client.get("/api/auth/status").json()["mode"], "off")
        finally:
            os.environ.pop(HOST_PROCESS_KEY_ENV, None)


if __name__ == "__main__":
    unittest.main()
