"""Product-owned OAuth protocol and per-request credential lifecycle.

Provider configuration is trusted product data, never a renderer-supplied URL.
The coordinator owns refresh: adapters receive only local model-bridge access.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import urlencode

import httpx

from service.settings.credentials import (
    CredentialBusyError,
    CredentialConflictError,
    CredentialState,
    ModelCredentialStore,
    OAuthTokens,
)

OAUTH_HTTP_TIMEOUT_SECONDS = 30.0
REFRESH_AHEAD_SECONDS = 60.0
PKCE_RANDOM_BYTES = 32
JWT_PAYLOAD_INDEX = 1
JWT_PART_COUNT = 3
BASE64_BLOCK_SIZE = 4
AUTHORIZATION_PATH = "/oauth/authorize"
TOKEN_PATH = "/oauth/token"
AUTH_CLAIMS_KEY = "https://api.openai.com/auth"
ACCOUNT_ID_KEY = "chatgpt_account_id"
EMAIL_KEY = "email"
INVALID_GRANT = "invalid_grant"
REGION_UNSUPPORTED = "unsupported_country_region_territory"
TOKEN_ERROR_CODES = {
    INVALID_GRANT: "oauth_reauth_required",
    REGION_UNSUPPORTED: "oauth_region_unsupported",
    "invalid_client": "oauth_client_rejected",
    "access_denied": "oauth_authorization_denied",
}
logger = logging.getLogger(__name__)


def token_failure(stage: str, status: int, code: str) -> OAuthFailure:
    """Only product-controlled fields may enter authentication diagnostics."""
    logger.warning("oauth_request_failed stage=%s http_status=%s error=%s", stage, status, code)
    return OAuthFailure(code)


class OAuthFailure(ValueError):
    """Public, credential-free error. Never carries a raw upstream response."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class OAuthProvider:
    id: str
    label: str
    issuer: str
    client_id: str
    scopes: tuple[str, ...]
    authorization_parameters: Mapping[str, str] = field(default_factory=dict)
    responses_endpoint: str = ""
    models_endpoint: str = ""

    def authorization_url(self, redirect_uri: str, challenge: str, state: str) -> str:
        parameters = {
            **self.authorization_parameters,
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(self.scopes),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        return f"{self.issuer}{AUTHORIZATION_PATH}?{urlencode(parameters)}"


# Public OAuth client registration used by the inspected upstream Codex/OpenCode
# protocol. This is not a client secret. Our product identity remains ScholarSeed.
CHATGPT_PROVIDER = OAuthProvider(
    id="chatgpt",
    label="ChatGPT",
    issuer="https://auth.openai.com",
    client_id="app_EMoamEEZ73f0CkXaXp7hrann",
    scopes=("openid", "profile", "email", "offline_access"),
    responses_endpoint="https://chatgpt.com/backend-api/codex/responses",
    models_endpoint="https://chatgpt.com/backend-api/codex/models",
    authorization_parameters={
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "scholarseed_desktop",
    },
)
OAUTH_PROVIDERS = {CHATGPT_PROVIDER.id: CHATGPT_PROVIDER}


@dataclass(frozen=True)
class PKCE:
    verifier: str = field(repr=False)
    challenge: str


def create_pkce() -> PKCE:
    verifier = secrets.token_urlsafe(PKCE_RANDOM_BYTES)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return PKCE(verifier, challenge)


def _claims(token: Any) -> Mapping[str, Any]:
    """Read display/routing claims only from a token received via the issuer TLS leg.

    These claims do not authenticate a product user or authorize a local request.
    Product ownership comes from the already authenticated Serve principal.
    """

    if not isinstance(token, str):
        return {}
    parts = token.split(".")
    if len(parts) != JWT_PART_COUNT:
        return {}
    payload = parts[JWT_PAYLOAD_INDEX]
    try:
        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % BASE64_BLOCK_SIZE))
        value = json.loads(decoded)
    except (ValueError, UnicodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _account_id(claims: Mapping[str, Any]) -> str:
    nested = claims.get(AUTH_CLAIMS_KEY)
    value = claims.get(ACCOUNT_ID_KEY) or (
        nested.get(ACCOUNT_ID_KEY) if isinstance(nested, dict) else ""
    )
    return value if isinstance(value, str) else ""


class OAuthProtocol:
    """Token exchange using a caller-owned HTTP client and fixed provider policy."""

    def __init__(self, provider: OAuthProvider, client: httpx.AsyncClient) -> None:
        self.provider = provider
        self._client = client

    async def exchange(self, code: str, redirect_uri: str, verifier: str) -> OAuthTokens:
        return await self._request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            }
        )

    async def refresh(self, previous: OAuthTokens) -> OAuthTokens:
        return await self._request(
            {"grant_type": "refresh_token", "refresh_token": previous.refresh_token},
            previous=previous,
        )

    async def _request(
        self, parameters: Mapping[str, str], *, previous: OAuthTokens | None = None
    ) -> OAuthTokens:
        stage = "refresh" if previous is not None else "exchange"
        try:
            response = await self._client.post(
                f"{self.provider.issuer}{TOKEN_PATH}",
                data={**parameters, "client_id": self.provider.client_id},
                timeout=OAUTH_HTTP_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
        except httpx.TimeoutException:
            raise token_failure(stage, 0, "oauth_network_timeout") from None
        except httpx.HTTPError:
            raise token_failure(stage, 0, "oauth_network_unavailable") from None
        try:
            payload = response.json()
        except ValueError:
            raise token_failure(stage, response.status_code, "oauth_invalid_response") from None
        if not isinstance(payload, dict):
            raise token_failure(stage, response.status_code, "oauth_invalid_response")
        if response.is_error or response.is_redirect:
            error = payload.get("error")
            upstream_code = error.get("code") if isinstance(error, dict) else error
            code = TOKEN_ERROR_CODES.get(upstream_code) if isinstance(upstream_code, str) else None
            raise token_failure(stage, response.status_code, code or "oauth_exchange_failed")
        access = payload.get("access_token")
        refresh = payload.get("refresh_token")
        # Some providers rotate only when necessary; omission preserves the prior
        # refresh token, whereas a malformed supplied value is an upstream error.
        if refresh is None and previous is not None:
            refresh = previous.refresh_token
        if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
            raise OAuthFailure("oauth_invalid_response")
        access_claims = _claims(access)
        id_claims = _claims(payload.get("id_token"))
        account_id = _account_id(id_claims) or _account_id(access_claims)
        if not account_id and previous is not None:
            account_id = previous.account_id
        if not account_id or any(character in account_id for character in "\r\n"):
            raise OAuthFailure("oauth_account_unavailable")
        if previous is not None and account_id != previous.account_id:
            raise OAuthFailure("oauth_account_changed")
        account_label = id_claims.get(EMAIL_KEY) or access_claims.get(EMAIL_KEY)
        if not isinstance(account_label, str):
            account_label = previous.account_label if previous is not None else ""
        now = time.time()
        try:
            expires_in = payload.get("expires_in")
            expiry = (
                now + float(expires_in) if expires_in is not None else float(access_claims["exp"])
            )
            if expiry <= now:
                raise ValueError("expired response")
            return OAuthTokens(access, refresh, expiry, account_id, account_label)
        except (TypeError, ValueError, KeyError):
            raise OAuthFailure("oauth_invalid_response") from None


class OAuthCredentials:
    """Refresh serialized by connection, revocation fenced by durable generation."""

    def __init__(self, store: ModelCredentialStore, protocol: OAuthProtocol) -> None:
        self.store = store
        self.protocol = protocol
        self._resolutions: dict[tuple[str, str], asyncio.Task[OAuthTokens]] = {}
        self._closed = False

    async def resolve(self, owner_id: str, connection_id: str) -> OAuthTokens:
        if self._closed:
            raise OAuthFailure("oauth_service_closed")
        scope = (owner_id, connection_id)
        task = self._resolutions.get(scope)
        if task is None:
            task = asyncio.create_task(self._resolve_locked(owner_id, connection_id))
            self._resolutions[scope] = task
            task.add_done_callback(lambda result: self._resolved(scope, result))
        # Stopping a model request must not discard a refresh response after the
        # issuer has rotated its token. The service owns rotation, not its waiter.
        try:
            return await asyncio.shield(task)
        except CredentialBusyError:
            raise OAuthFailure("oauth_refresh_busy") from None

    def _resolved(self, scope: tuple[str, str], task: asyncio.Task[OAuthTokens]) -> None:
        if self._resolutions.get(scope) is task:
            self._resolutions.pop(scope, None)
        if not task.cancelled():
            task.exception()  # Observe failures even when every waiter was cancelled.

    async def close(self) -> None:
        self._closed = True
        # HTTP refresh has a bounded timeout. Drain before closing its HTTP client,
        # preserving any rotated credential the issuer has already returned.
        await asyncio.shield(asyncio.gather(*self._resolutions.values(), return_exceptions=True))

    async def _resolve_locked(self, owner_id: str, connection_id: str) -> OAuthTokens:
        async with self.store.refresh_lock(owner_id, connection_id):
            record = self.store.read(owner_id, connection_id)
            if record.state != CredentialState.CONNECTED or record.tokens is None:
                raise OAuthFailure("oauth_reauth_required")
            if record.tokens.expires_at > time.time() + REFRESH_AHEAD_SECONDS:
                return record.tokens
            try:
                tokens = await self.protocol.refresh(record.tokens)
            except OAuthFailure as error:
                if error.code in ("oauth_reauth_required", "oauth_account_changed"):
                    try:
                        self.store.revoke(
                            owner_id,
                            connection_id,
                            state=CredentialState.REAUTH_REQUIRED,
                            expected_generation=record.generation,
                        )
                    except CredentialConflictError:
                        raise OAuthFailure("oauth_connection_changed") from None
                raise
            try:
                self.store.replace(
                    owner_id, connection_id, tokens, expected_generation=record.generation
                )
            except CredentialConflictError:
                raise OAuthFailure("oauth_connection_changed") from None
            return tokens
