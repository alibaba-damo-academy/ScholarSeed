"""Product subscription connections, authorization and private model routing."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Mapping

import httpx

from scholarseed_runtime.contract.model import ModelCredential, ModelWireProtocol
from service.chat.service.completions import (
    CompletionBridge,
    CompletionCredentialError,
    CompletionRegistration,
)
from service.settings.authorization import BrowserAuthorization
from service.settings.connections import (
    ENABLED_KEY,
    MODEL_ID_KEY,
    OAUTH_PROVIDER_KEY,
    OPENAI_PROVIDER,
    SELECTED_MODELS_KEY,
    ModelProfileStore,
    UnknownProfileError,
    is_oauth_connection,
)
from service.settings.credentials import CredentialState, ModelCredentialStore
from service.settings.oauth import (
    OAUTH_HTTP_TIMEOUT_SECONDS,
    OAUTH_PROVIDERS,
    OAuthCredentials,
    OAuthFailure,
    OAuthProtocol,
)

SUBSCRIPTION_BILLING = "subscription"
SUBSCRIPTION_MODELS_COMPATIBILITY_VERSION = "0.147.0"
ACCOUNT_HEADER = "ChatGPT-Account-Id"
ORIGINATOR_HEADER = "originator"
PRODUCT_ORIGINATOR = "scholarseed_desktop"
MODEL_VISIBILITY_LIST = "list"
SUBSCRIPTION_TRUST_ENV = True
#: 传输层失败日志里错误详情的截断长度。
TRANSPORT_ERROR_DETAIL_LIMIT = 200
LOGGER = logging.getLogger(__name__)
RESPONSE_ITEM_REFERENCE = "item_reference"
RESPONSE_ITEM_ID = "id"


class SubscriptionService:
    """Compose the existing profile store, OAuth lifecycle and completion bridge."""

    def __init__(
        self,
        profiles: ModelProfileStore,
        credentials: ModelCredentialStore,
        bridge: CompletionBridge,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.profiles = profiles
        self.credentials = credentials
        self.bridge = bridge
        self.client = client or httpx.AsyncClient(
            timeout=OAUTH_HTTP_TIMEOUT_SECONDS,
            follow_redirects=False,
            trust_env=SUBSCRIPTION_TRUST_ENV,
        )
        protocols = {
            key: OAuthProtocol(policy, self.client) for key, policy in OAUTH_PROVIDERS.items()
        }
        self.resolvers = {
            key: OAuthCredentials(credentials, protocol) for key, protocol in protocols.items()
        }
        self.authorizations = {
            key: BrowserAuthorization(credentials, protocol) for key, protocol in protocols.items()
        }
        self._closed = False
        self._owner_epochs: dict[str, int] = {}
        self._connection_epochs: dict[tuple[str, str], int] = {}
        self._directories: dict[asyncio.Task, tuple[str, str]] = {}

    def profile(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        if self._closed:
            raise OAuthFailure("oauth_service_closed")
        profile = self.profiles.profile(connection_id, owner_id=owner_id)
        if profile is None or not is_oauth_connection(profile):
            raise UnknownProfileError("OAuth connection is unavailable")
        if profile.get(OAUTH_PROVIDER_KEY) not in OAUTH_PROVIDERS:
            raise OAuthFailure("oauth_provider_unavailable")
        self._owner_epochs.setdefault(owner_id, 0)
        return profile

    def status(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        self.profile(owner_id, connection_id)
        record = self.credentials.read(owner_id, connection_id)
        return {
            "state": record.state.value,
            "account_label": record.tokens.account_label if record.tokens else "",
            "billing": SUBSCRIPTION_BILLING,
        }

    async def login(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        profile = self.profile(owner_id, connection_id)
        if self.credentials.read(owner_id, connection_id).state == CredentialState.CONNECTED:
            raise OAuthFailure("oauth_disconnect_before_login")
        epoch = self._owner_epochs[owner_id]
        generation = self.credentials.read(owner_id, connection_id).generation
        authorization = self.authorizations[profile[OAUTH_PROVIDER_KEY]]
        result = await authorization.start(owner_id, connection_id)
        if (
            self._owner_epochs[owner_id] != epoch
            or self.credentials.read(owner_id, connection_id).generation != generation
            or self.profiles.profile(connection_id, owner_id=owner_id) is None
        ):
            authorization.cancel(owner_id, connection_id, result["transaction_id"])
            raise OAuthFailure("oauth_connection_changed")
        return result

    def login_status(
        self, owner_id: str, connection_id: str, transaction_id: str
    ) -> dict[str, Any]:
        profile = self.profile(owner_id, connection_id)
        return self.authorizations[profile[OAUTH_PROVIDER_KEY]].status(
            owner_id, connection_id, transaction_id
        )

    def cancel_login(self, owner_id: str, connection_id: str, transaction_id: str) -> None:
        profile = self.profile(owner_id, connection_id)
        self.authorizations[profile[OAUTH_PROVIDER_KEY]].cancel(
            owner_id, connection_id, transaction_id
        )

    def disconnect(self, owner_id: str, connection_id: str) -> None:
        profile = self.profile(owner_id, connection_id)
        scope = (owner_id, connection_id)
        self._connection_epochs[scope] = self._connection_epochs.get(scope, 0) + 1
        self._cancel_directories(owner_id, connection_id)
        self.authorizations[profile[OAUTH_PROVIDER_KEY]].cancel_connection(owner_id, connection_id)
        self.credentials.revoke(owner_id, connection_id)
        self.bridge.revoke_connection(owner_id, connection_id)

    async def logout(self, owner_id: str) -> None:
        self._owner_epochs[owner_id] = self._owner_epochs.get(owner_id, 0) + 1
        for profile in self.profiles.list(owner_id=owner_id)["profiles"]:
            if is_oauth_connection(profile):
                self.authorizations[profile[OAUTH_PROVIDER_KEY]].cancel_connection(
                    owner_id, profile["id"]
                )
        self._cancel_directories(owner_id)
        self.bridge.revoke_owner(owner_id)

    async def logout_all(self) -> None:
        for owner_id in tuple(self._owner_epochs):
            await self.logout(owner_id)

    async def resolve(
        self, owner_id: str, connection_id: str, *, require_enabled: bool = True
    ) -> ModelCredential:
        try:
            profile = self.profile(owner_id, connection_id)
            if require_enabled and not profile.get(ENABLED_KEY):
                raise OAuthFailure("oauth_connection_disabled")
            tokens = await self.resolvers[profile[OAUTH_PROVIDER_KEY]].resolve(
                owner_id, connection_id
            )
            # The profile may have been removed or disabled while token rotation ran.
            current = self.profile(owner_id, connection_id)
            if require_enabled and not current.get(ENABLED_KEY):
                raise OAuthFailure("oauth_connection_disabled")
            return ModelCredential(
                api_key=tokens.access_token,
                headers={
                    ACCOUNT_HEADER: tokens.account_id,
                    ORIGINATOR_HEADER: PRODUCT_ORIGINATOR,
                },
            )
        except OAuthFailure as error:
            raise CompletionCredentialError(error.code) from None
        except UnknownProfileError:
            raise CompletionCredentialError("oauth_connection_unavailable") from None

    def _cancel_directories(self, owner_id: str, connection_id: str = "") -> None:
        for task, scope in tuple(self._directories.items()):
            if scope[0] == owner_id and (not connection_id or scope[1] == connection_id):
                if task is not asyncio.current_task():
                    task.cancel()

    async def models(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        self.profile(owner_id, connection_id)
        owner_epoch = self._owner_epochs[owner_id]
        scope = (owner_id, connection_id)
        connection_epoch = self._connection_epochs.get(scope, 0)
        task = asyncio.current_task()
        self._directories[task] = scope
        try:
            result = await self._models(owner_id, connection_id)
            if (
                self._owner_epochs[owner_id] != owner_epoch
                or self._connection_epochs.get(scope, 0) != connection_epoch
                or self.credentials.read(owner_id, connection_id).state != CredentialState.CONNECTED
            ):
                raise OAuthFailure("oauth_connection_changed")
            return result
        finally:
            self._directories.pop(task, None)

    async def _models(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        profile = self.profile(owner_id, connection_id)
        policy = OAUTH_PROVIDERS[profile[OAUTH_PROVIDER_KEY]]
        material = await self.resolve(owner_id, connection_id, require_enabled=False)
        try:
            response = await self.client.get(
                policy.models_endpoint,
                params={"client_version": SUBSCRIPTION_MODELS_COMPATIBILITY_VERSION},
                headers={**material.headers, "Authorization": f"Bearer {material.api_key}"},
            )
        except httpx.HTTPError as error:
            # TLS 信任失败、DNS 失败与超时都归到这一支，只报「不可用」无法区分，
            # 而错误详情正是唯一能分辨它们的字段。上游响应体与请求头不入日志。
            LOGGER.warning(
                "oauth_models_transport_failed endpoint=%s error_class=%s detail=%s",
                policy.models_endpoint,
                type(error).__name__,
                str(error)[:TRANSPORT_ERROR_DETAIL_LIMIT],
            )
            raise OAuthFailure("oauth_models_unavailable") from None
        if not response.is_success:
            LOGGER.warning(
                "oauth_models_rejected endpoint=%s http_status=%s",
                policy.models_endpoint,
                response.status_code,
            )
            raise OAuthFailure("oauth_models_rejected")
        try:
            payload = response.json()
            rows = payload["models"]
            if not isinstance(rows, list):
                raise ValueError()
            models = []
            for row in rows:
                if not isinstance(row, dict) or row.get("visibility") != MODEL_VISIBILITY_LIST:
                    continue
                model_id = row.get("slug")
                if not isinstance(model_id, str) or not model_id:
                    continue
                levels = row.get("supported_reasoning_levels")
                models.append(
                    {
                        "id": model_id,
                        "label": str(row.get("display_name") or model_id),
                        "reasoning_efforts": (
                            [
                                level["effort"]
                                for level in levels
                                if isinstance(level, dict) and isinstance(level.get("effort"), str)
                            ]
                            if isinstance(levels, list)
                            else None
                        ),
                        "reasoning_effort": str(row.get("default_reasoning_level") or ""),
                    }
                )
        except (ValueError, KeyError, TypeError):
            raise OAuthFailure("oauth_models_invalid") from None
        self.profile(owner_id, connection_id)
        return {"ok": True, "models": models, "message": ""}

    async def validate_models(
        self, owner_id: str, connection_id: str, selected: list[dict]
    ) -> None:
        if not selected:
            return
        offered = {
            row[MODEL_ID_KEY] for row in (await self.models(owner_id, connection_id))["models"]
        }
        if any(row[MODEL_ID_KEY] not in offered for row in selected):
            raise OAuthFailure("oauth_model_unavailable")

    def register(
        self,
        owner_id: str,
        connection_id: str,
        model_id: str,
        session_id: str,
        model_routes: Mapping[str, str],
        *,
        reasoning_effort: str | None = None,
    ) -> CompletionRegistration:
        profile = self.profile(owner_id, connection_id)
        if not profile.get(ENABLED_KEY) or model_id not in {
            row[MODEL_ID_KEY] for row in profile[SELECTED_MODELS_KEY]
        }:
            raise OAuthFailure("oauth_model_unavailable")
        if self.credentials.read(owner_id, connection_id).state != CredentialState.CONNECTED:
            raise OAuthFailure("oauth_reauth_required")
        policy = OAUTH_PROVIDERS[profile[OAUTH_PROVIDER_KEY]]

        def request_policy(payload: Mapping[str, Any]) -> dict[str, Any]:
            requested = str(payload.get("model") or "")
            routed = model_routes.get(requested, requested)
            current = self.profile(owner_id, connection_id)
            if routed != model_id or model_id not in {
                row[MODEL_ID_KEY] for row in current[SELECTED_MODELS_KEY]
            }:
                LOGGER.warning(
                    "subscription_model_rejected session_id=%s expected=%s requested=%s",
                    session_id,
                    model_id,
                    requested,
                )
                raise OAuthFailure("oauth_model_unavailable")
            return self.request_policy(payload)

        return self.bridge.register(
            endpoint=policy.responses_endpoint,
            responses_endpoint=policy.responses_endpoint,
            api_key="",
            wire_protocol=ModelWireProtocol.RESPONSES,
            owner_id=owner_id,
            connection_id=connection_id,
            session_id=session_id,
            credential_resolver=self.resolve,
            request_policy=request_policy,
            model_routes=model_routes,
            trust_env=SUBSCRIPTION_TRUST_ENV,
            reasoning_effort=reasoning_effort,
            provider=OPENAI_PROVIDER,
        )

    @staticmethod
    def request_policy(payload: Mapping[str, Any]) -> dict[str, Any]:
        # Preserve tool/reasoning items exactly; subscription calls must not persist
        # responses upstream. Streaming is supplied by the runtime's Responses call.
        result = {**payload, "store": False}
        items = payload.get("input")
        if isinstance(items, list):
            # Inline history is self-contained. Provider-generated item IDs are not
            # portable across providers; tool call_id links remain untouched.
            # References are different: their ID is required to resolve the item.
            result["input"] = [
                (
                    {key: value for key, value in item.items() if key != RESPONSE_ITEM_ID}
                    if isinstance(item, Mapping) and item.get("type") != RESPONSE_ITEM_REFERENCE
                    else item
                )
                for item in items
            ]
        return result

    async def close(self) -> None:
        self._closed = True
        directories = tuple(self._directories)
        for task in directories:
            task.cancel()
        await asyncio.gather(*directories, return_exceptions=True)
        for authorization in self.authorizations.values():
            await authorization.close()
        await self.bridge.close()
        for resolver in self.resolvers.values():
            await resolver.close()
        await self.client.aclose()
