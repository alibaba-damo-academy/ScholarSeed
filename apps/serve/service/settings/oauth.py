"""Product-owned OAuth protocol and per-request credential lifecycle.

Provider configuration is trusted product data, never a renderer-supplied URL.
The coordinator owns refresh: adapters receive only local model-bridge access.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import math
import secrets
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Any, Mapping
from urllib.parse import urlencode

import httpx
import jwt

from service.platform.activity import Activities, ActivityDomain
from service.settings.credentials import (
    CredentialBusyError,
    CredentialConflictError,
    CredentialState,
    ModelCredentialStore,
    OAuthTokens,
)

OAUTH_HTTP_TIMEOUT_SECONDS = 30.0
REFRESH_AHEAD_SECONDS = 60.0
REFRESH_FAILURE_COOLDOWN_SECONDS = 30.0
REFRESH_BUSY_CODE = "oauth_refresh_busy"
PKCE_RANDOM_BYTES = 32
AUTHORIZATION_PATH = "/api/accounts/authorize"
TOKEN_PATH = "/api/accounts/oauth/token"
DISCOVERY_PATH = "/.well-known/openid-configuration"
OAUTH_RESOURCE = "https://api.openai.com/v1"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
DYNAMIC_CLIENT_ID = "dynamic_agent_client"
AGENT_NAME = "scholarseed_desktop"
EMAIL_KEY = "email"
INVALID_GRANT = "invalid_grant"
REGION_UNSUPPORTED = "unsupported_country_region_territory"
TOKEN_ERROR_CODES = {
    INVALID_GRANT: "oauth_reauth_required",
    REGION_UNSUPPORTED: "oauth_region_unsupported",
    "invalid_client": "oauth_client_rejected",
    "access_denied": "oauth_authorization_denied",
    **{
        code: "oauth_reauth_required"
        for code in (
            "invalid_refresh_token",
            "token_expired",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_reused",
        )
    },
}
#: 令牌失效时统一抛出的失败码；前端据此显示「请重新登录」。
REAUTH_REQUIRED_CODE = "oauth_reauth_required"
#: 上游模型/推理端点（区别于 /oauth/token）用 ``{"error": {"code": ...}}`` 表达「令牌已被
#: 吊销/作废」的 401 code。命中即说明本地凭证已被上游提前作废（用户在官网登出、改密码或换
#: 登录方式），必须回写 REAUTH_REQUIRED，而不是当通用失败吞掉。新增厂商吊销码是这里的新数据，
#: 不是调用方的新分支。
TOKEN_REVOKED = "token_revoked"
INVALID_TOKEN = "invalid_token"
UPSTREAM_REVOCATION_CODES = frozenset({TOKEN_REVOKED, INVALID_TOKEN})
logger = logging.getLogger(__name__)


def token_failure(stage: str, status: int, code: str) -> OAuthFailure:
    """Only product-controlled fields may enter authentication diagnostics."""
    logger.warning("oauth_request_failed stage=%s http_status=%s error=%s", stage, status, code)
    return OAuthFailure(code)


def upstream_revocation_code(status_code: int, error_code: str) -> str:
    """Return the canonical code when an upstream response means re-login, else ``""``.

    Data-driven gate shared by the model-catalog and inference paths: only an unauthorized
    status carrying a whitelisted revocation code counts, so transient 5xx, network failures
    and ordinary 4xx are never misread as a revoked login.
    """

    if status_code != HTTPStatus.UNAUTHORIZED:
        return ""
    code = error_code.strip().casefold()
    return code if code in UPSTREAM_REVOCATION_CODES else ""


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

    def authorization_url(
        self,
        redirect_uri: str,
        challenge: str,
        state: str,
        *,
        client_id: str,
        nonce: str,
        host_id: str,
        reconsent: bool = False,
    ) -> str:
        parameters = {
            **self.authorization_parameters,
            "response_type": "code",
            "client_id": client_id or DYNAMIC_CLIENT_ID,
            "nonce": nonce,
            "ext_agent_host_id": host_id,
            "resource": OAUTH_RESOURCE,
            "redirect_uri": redirect_uri,
            "scope": " ".join(self.scopes),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        if not client_id:
            parameters["agent_name_hint"] = AGENT_NAME
        if reconsent:
            parameters["prompt"] = "consent"
        return f"{self.issuer}{AUTHORIZATION_PATH}?{urlencode(parameters)}"


# Public SIWC dynamic registration. Each connection stores its issued client ID.
CHATGPT_PROVIDER = OAuthProvider(
    id="chatgpt",
    label="ChatGPT",
    issuer="https://auth.openai.com",
    client_id=DYNAMIC_CLIENT_ID,
    scopes=("openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE),
    responses_endpoint=f"{OAUTH_RESOURCE}/responses",
    models_endpoint=f"{OAUTH_RESOURCE}/models",
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


class OAuthProtocol:
    """Token exchange using a caller-owned HTTP client and fixed provider policy."""

    def __init__(self, provider: OAuthProvider, client: httpx.AsyncClient) -> None:
        self.provider = provider
        self._client = client

    async def exchange(
        self,
        code: str,
        redirect_uri: str,
        verifier: str,
        *,
        client_id: str,
        nonce: str,
        subject: str = "",
    ) -> OAuthTokens:
        return await self._request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
            client_id=client_id,
            nonce=nonce,
            subject=subject,
        )

    async def refresh(self, previous: OAuthTokens) -> OAuthTokens:
        return await self._request(
            {"grant_type": "refresh_token", "refresh_token": previous.refresh_token},
            previous=previous,
            client_id=previous.client_id,
        )

    async def _request(
        self,
        parameters: Mapping[str, str],
        *,
        client_id: str,
        nonce: str = "",
        subject: str = "",
        previous: OAuthTokens | None = None,
    ) -> OAuthTokens:
        stage = "refresh" if previous is not None else "exchange"
        if not client_id or client_id == DYNAMIC_CLIENT_ID:
            raise OAuthFailure("oauth_client_rejected")
        # Resolve trust material before consuming a code or rotating a refresh
        # token. After the token endpoint succeeds, validation must be local:
        # an identity-service outage must not discard an already rotated token.
        signing_keys = await self._signing_keys()
        try:
            response = await self._client.post(
                f"{self.provider.issuer}{TOKEN_PATH}",
                data={**parameters, "client_id": client_id, "resource": OAUTH_RESOURCE},
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
            if (
                previous is not None
                and response.status_code == HTTPStatus.UNAUTHORIZED
                and not code
            ):
                code = REAUTH_REQUIRED_CODE
            raise token_failure(stage, response.status_code, code or "oauth_exchange_failed")
        access = payload.get("access_token")
        refresh = payload.get("refresh_token")
        # Some providers rotate only when necessary; omission preserves the prior
        # refresh token, whereas a malformed supplied value is an upstream error.
        if refresh is None and previous is not None:
            refresh = previous.refresh_token
        if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
            raise OAuthFailure("oauth_invalid_response")
        raw_id = payload.get("id_token")
        id_claims = self._validate_id(raw_id, client_id, nonce, signing_keys) if raw_id else {}
        if previous is None and not id_claims:
            raise OAuthFailure("oauth_identity_invalid")
        account_id = id_claims.get("sub") or (previous.account_id if previous else "")
        if not account_id or any(character in account_id for character in "\r\n"):
            raise OAuthFailure("oauth_account_unavailable")
        if previous is not None and account_id != previous.account_id:
            raise OAuthFailure("oauth_account_changed")
        if subject and subject != account_id:
            raise OAuthFailure("oauth_account_changed")
        account_label = id_claims.get(EMAIL_KEY)
        if not isinstance(account_label, str):
            account_label = previous.account_label if previous is not None else ""
        now = time.time()
        try:
            expires_in = payload.get("expires_in")
            expiry = now + float(expires_in)
            if not math.isfinite(expiry) or expiry <= now:
                raise ValueError("expired response")
            granted = payload.get("scope")
            if granted is None and previous is not None:
                scopes = previous.scopes
            elif isinstance(granted, str):
                scopes = tuple(granted.split())
            else:
                raise ValueError("missing scopes")
            if (
                not isinstance(payload.get("token_type"), str)
                or payload["token_type"].casefold() != "bearer"
            ):
                raise ValueError("invalid token type")
            return OAuthTokens(
                access,
                refresh,
                expiry,
                account_id,
                account_label,
                client_id,
                raw_id or (previous.id_token if previous else ""),
                scopes,
            )
        except (TypeError, ValueError, KeyError):
            raise OAuthFailure("oauth_invalid_response") from None

    async def _discovery(self) -> dict[str, Any]:
        try:
            response = await self._client.get(
                self.provider.issuer + DISCOVERY_PATH,
                timeout=OAUTH_HTTP_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
            response.raise_for_status()
            document = response.json()
            if document.get("issuer") != self.provider.issuer:
                raise ValueError("issuer mismatch")
            return document
        except (httpx.HTTPError, ValueError, AttributeError):
            raise OAuthFailure("oauth_discovery_unavailable") from None

    async def _signing_keys(self) -> Mapping[str, jwt.PyJWK]:
        document = await self._discovery()
        endpoint = document.get("jwks_uri", "")
        if not isinstance(endpoint, str) or not endpoint.startswith(self.provider.issuer + "/"):
            raise OAuthFailure("oauth_identity_invalid")
        try:
            response = await self._client.get(
                endpoint, timeout=OAUTH_HTTP_TIMEOUT_SECONDS, follow_redirects=False
            )
            response.raise_for_status()
            keys = {}
            for key in response.json()["keys"]:
                if key.get("kty") != "RSA" or key.get("use", "sig") != "sig":
                    continue
                if key.get("alg", "RS256") != "RS256":
                    continue
                kid = key.get("kid")
                if not isinstance(kid, str) or not kid or kid in keys:
                    raise ValueError("invalid signing key identifier")
                keys[kid] = jwt.PyJWK(key, algorithm="RS256")
            if not keys:
                raise ValueError("missing signing keys")
            return keys
        except (httpx.HTTPError, jwt.PyJWTError, ValueError, KeyError, TypeError, AttributeError):
            raise OAuthFailure("oauth_identity_invalid") from None

    def _validate_id(
        self, token: str, client_id: str, nonce: str, signing_keys: Mapping[str, jwt.PyJWK]
    ) -> Mapping[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
            key = signing_keys.get(header.get("kid"))
            if key is None or header.get("alg") != "RS256":
                raise ValueError("invalid signing key")
            claims = jwt.decode(
                token,
                key.key,
                algorithms=["RS256"],
                audience=client_id,
                issuer=self.provider.issuer,
                options={"require": ["sub", "iss", "aud", "exp", "iat"]},
            )
            if not isinstance(claims["sub"], str) or not claims["sub"]:
                raise ValueError("missing subject")
            audience = claims["aud"]
            if (isinstance(audience, list) and len(audience) > 1) or "azp" in claims:
                if claims.get("azp") != client_id:
                    raise ValueError("authorized party mismatch")
            if nonce and not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
                raise ValueError("nonce mismatch")
            return claims
        except (httpx.HTTPError, jwt.PyJWTError, ValueError, KeyError, TypeError, AttributeError):
            raise OAuthFailure("oauth_identity_invalid") from None

    async def revoke(self, tokens: OAuthTokens) -> None:
        document = await self._discovery()
        endpoint = document.get("revocation_endpoint", "")
        if not isinstance(endpoint, str) or not endpoint.startswith(self.provider.issuer + "/"):
            raise OAuthFailure("oauth_revocation_unconfirmed")
        try:
            response = await self._client.post(
                endpoint,
                data={
                    "token": tokens.refresh_token,
                    "token_type_hint": "refresh_token",
                    "client_id": tokens.client_id,
                },
                timeout=OAUTH_HTTP_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
            if response.status_code != HTTPStatus.OK:
                raise OAuthFailure("oauth_revocation_unconfirmed")
        except httpx.HTTPError:
            raise OAuthFailure("oauth_revocation_unconfirmed") from None


class OAuthCredentials:
    """Refresh serialized by connection, revocation fenced by durable generation."""

    def __init__(
        self, store: ModelCredentialStore, protocol: OAuthProtocol, *, activities: Activities
    ) -> None:
        self._activities = activities
        self.store = store
        self.protocol = protocol
        self._resolutions: dict[tuple[str, str], asyncio.Task[OAuthTokens]] = {}
        self._refresh_failures: dict[tuple[str, str], tuple[int, float, str]] = {}
        self._closed = False

    def _resolution(self, owner_id: str, connection_id: str) -> asyncio.Task[OAuthTokens]:
        if self._closed:
            raise OAuthFailure("oauth_service_closed")
        scope = (owner_id, connection_id)
        task = self._resolutions.get(scope)
        if task is None:
            task = self._activities.spawn(
                ActivityDomain.CREDENTIAL, lambda: self._resolve_locked(owner_id, connection_id)
            )
            self._resolutions[scope] = task
            task.add_done_callback(lambda result: self._resolved(scope, result))
        return task

    def _refresh_failure(self, scope: tuple[str, str], generation: int) -> str:
        failure = self._refresh_failures.get(scope)
        if failure is not None:
            failedGeneration, failedAt, code = failure
            if (
                generation == failedGeneration
                and time.monotonic() - failedAt < REFRESH_FAILURE_COOLDOWN_SECONDS
            ):
                return code
            self._refresh_failures.pop(scope, None)
        return ""

    def prefetch(self, owner_id: str, connection_id: str) -> asyncio.Task[OAuthTokens] | None:
        """Schedule service-owned rotation without waiting on issuer availability."""

        if self._closed:
            raise OAuthFailure("oauth_service_closed")
        record = self.store.read(owner_id, connection_id)
        if (
            record.state != CredentialState.CONNECTED
            or record.tokens is None
            or record.tokens.expires_at > time.time() + REFRESH_AHEAD_SECONDS
        ):
            return None
        if self._refresh_failure((owner_id, connection_id), record.generation):
            return None
        return self._resolution(owner_id, connection_id)

    async def resolve(self, owner_id: str, connection_id: str) -> OAuthTokens:
        task = self._resolution(owner_id, connection_id)
        # Stopping a model request must not discard a refresh response after the
        # issuer has rotated its token. The service owns rotation, not its waiter.
        try:
            tokens = await asyncio.shield(task)
        except CredentialBusyError:
            raise OAuthFailure(REFRESH_BUSY_CODE) from None
        record = self.store.read(owner_id, connection_id)
        if (
            record.state != CredentialState.CONNECTED
            or record.tokens != tokens
            or tokens.expires_at <= time.time()
        ):
            raise OAuthFailure("oauth_connection_changed")
        return tokens

    def _resolved(self, scope: tuple[str, str], task: asyncio.Task[OAuthTokens]) -> None:
        if self._resolutions.get(scope) is task:
            self._resolutions.pop(scope, None)
        if not task.cancelled():
            error = task.exception()
            if isinstance(error, (OAuthFailure, CredentialBusyError)):
                failureCode = error.code if isinstance(error, OAuthFailure) else REFRESH_BUSY_CODE
                logger.warning(
                    "oauth_credential_refresh_failed connection=%s code=%s", scope[1], failureCode
                )
            elif error is not None:
                logger.warning(
                    "oauth_credential_refresh_failed connection=%s error_class=%s",
                    scope[1],
                    type(error).__name__,
                )

    async def close(self) -> None:
        self._closed = True
        # HTTP refresh has a bounded timeout. Drain before closing its HTTP client,
        # preserving any rotated credential the issuer has already returned.
        await asyncio.shield(asyncio.gather(*self._resolutions.values(), return_exceptions=True))
        self._refresh_failures.clear()

    async def _resolve_locked(self, owner_id: str, connection_id: str) -> OAuthTokens:
        async with self.store.refresh_lock(owner_id, connection_id):
            record = self.store.read(owner_id, connection_id)
            if record.state != CredentialState.CONNECTED or record.tokens is None:
                raise OAuthFailure("oauth_reauth_required")
            if PLAN_SCOPE not in record.tokens.scopes:
                raise OAuthFailure("oauth_plan_permission_required")
            if record.tokens.expires_at > time.time() + REFRESH_AHEAD_SECONDS:
                self._refresh_failures.pop((owner_id, connection_id), None)
                return record.tokens
            scope = (owner_id, connection_id)
            failureCode = self._refresh_failure(scope, record.generation)
            if failureCode:
                raise OAuthFailure(failureCode)
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
                    self._refresh_failures.pop(scope, None)
                else:
                    self._refresh_failures[scope] = (
                        record.generation,
                        time.monotonic(),
                        error.code,
                    )
                raise
            try:
                self.store.replace(
                    owner_id, connection_id, tokens, expected_generation=record.generation
                )
            except CredentialConflictError:
                # A concurrent disconnect fenced the local write after rotation.
                # End the newly issued renewable session rather than leaking it.
                try:
                    await self.protocol.revoke(tokens)
                except OAuthFailure:
                    logger.warning("oauth_rotated_session_revocation_unconfirmed")
                raise OAuthFailure("oauth_connection_changed") from None
            self._refresh_failures.pop(scope, None)
            return tokens
