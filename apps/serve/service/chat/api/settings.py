"""HTTP adapter for chat model and product-setting API groups."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from service.chat.constants import (
    AUTO_REVIEW_CAPABILITY_UNAVAILABLE_ERROR,
    GLOBAL_PERMISSION_MODES,
    INVALID_GLOBAL_PERMISSION_MODE_ERROR,
    RUNTIME_CAPABILITY_UNAVAILABLE,
    WORKFLOW_CAPABILITY_UNAVAILABLE_ERROR,
    WORKSPACE_ROOT_NOT_FOUND_ERROR,
)
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.projection import (
    readiness_payload,
    runtime_capabilities_payload,
    runtime_payload,
)
from service.chat.schema import (
    AutoReviewDefaultRequest,
    ModelApiProbeRequest,
    ModelDefaultRequest,
    ModelVisibilityRequest,
    PermissionModeRequest,
    PersonalApiRequest,
    ProfileEnabledRequest,
    WorkflowDefaultRequest,
    WorkspaceRootRequest,
)
from service.chat.service.models import GATEWAY_CREDENTIAL_REQUIRED_REASON, ModelService
from service.chat.service.settings import SettingsService
from service.chat.service.subscriptions import SubscriptionService
from service.identity.utils import (
    LOCAL_USER_ID,
    request_owner_id,
    request_user_id,
    require_host_process,
)
from service.settings.connections import UnknownProfileError

PROFILE_NOT_FOUND_STATUS = 404
LOGGER = logging.getLogger(__name__)
GATEWAY_GATE_DIAGNOSTIC = "model_catalog_gateway_gate"
PROJECTED_IDENTITY = "projected"
ANONYMOUS_IDENTITY = "anonymous"


def _log_gateway_credential_gate(request: Request, payload: dict) -> None:
    """内置网关模型被置灰时记下判据输入。

    这条链此前完全不可观测：「已登录却仍提示需登录」只能靠猜是没带凭据、凭据被拒，
    还是投影没生效。只记布尔与身份类别，不记凭据、jti 或账号标识。
    """

    rows = payload.get("available_models") or []
    if not any(
        row.get("disabled") and row.get("disabled_reason") == GATEWAY_CREDENTIAL_REQUIRED_REASON
        for row in rows
    ):
        return
    state = request.state
    user_id = str(getattr(state, "user_id", "") or "")
    LOGGER.info(
        "%s credential_present=%s identity_rejected=%s identity=%s",
        GATEWAY_GATE_DIAGNOSTIC,
        bool(getattr(state, "auth_credential_present", False)),
        bool(getattr(state, "auth_identity_rejected", False)),
        ANONYMOUS_IDENTITY if not user_id or user_id == LOCAL_USER_ID else PROJECTED_IDENTITY,
    )


PROFILE_INVALID_STATUS = 422


def _profile_error_status(error: ValueError) -> int:
    """Map a store failure onto its HTTP meaning: missing id vs rejected input."""

    return (
        PROFILE_NOT_FOUND_STATUS
        if isinstance(error, UnknownProfileError)
        else PROFILE_INVALID_STATUS
    )


def mount_setting_routes(
    app: FastAPI,
    *,
    models: ModelService,
    settings: SettingsService,
    runtime: LiveSessionService,
    subscriptions: SubscriptionService | None = None,
) -> None:
    """Mount model selection and global-setting transport endpoints."""

    @app.get("/api/serve/workspace-root")
    def workspace_root() -> dict:
        """项目工作区根: 生效值 + 用户显式设置值。

        两个值都回: 生效值可能来自环境变量或桌面端注入, 设置界面必须能显示
        「你没设过, 当前用的是这个」, 而不是把注入值伪装成用户设置。
        """

        return {
            "root": str(getattr(app.state, "workspace", "")),
            "configured": settings.workspace_root(),
        }

    @app.put("/api/serve/workspace-root")
    def set_workspace_root(request: WorkspaceRootRequest) -> dict:
        """设置新建项目的落地根。已登记项目按各自目录继续, 不被搬动。

        重启后生效: 运行中的 serve 已把根注入 content 与各会话, 就地换根会让
        已开会话与已投影的资料树对不上账。
        """

        raw = request.root.strip()
        if raw:
            target = Path(raw).expanduser()
            if not target.is_dir():
                raise HTTPException(422, WORKSPACE_ROOT_NOT_FOUND_ERROR)
            raw = str(target.resolve())
        configured = settings.set_workspace_root(raw)
        effective = str(getattr(app.state, "workspace", ""))
        return {
            "configured": configured,
            "root": effective,
            "restartRequired": bool(configured) and configured != effective,
        }

    @app.get("/api/serve/models")
    async def model_catalog(request: Request, refresh: bool = False) -> dict:
        payload = await models.catalog(refresh=refresh, user_id=request_user_id(request))
        _log_gateway_credential_gate(request, payload)
        return payload

    @app.post("/api/serve/models/default")
    async def set_default_model(request: ModelDefaultRequest, http_request: Request) -> dict:
        try:
            return await models.select(
                request.model_key, persist=request.persist, user_id=request_user_id(http_request)
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/serve/model-providers")
    def model_providers() -> dict:
        return models.providers()

    @app.get("/api/serve/model-profiles")
    def model_profiles(request: Request) -> dict:
        return models.profiles(user_id=request_user_id(request))

    @app.post("/api/serve/model-profiles/models")
    def model_profile_models(request: ModelApiProbeRequest, http_request: Request) -> dict:
        payload = request.model_dump(exclude={"profile_id"})
        try:
            return models.profile_models(
                payload, request.profile_id, user_id=request_user_id(http_request)
            )
        except ValueError as exc:
            raise HTTPException(PROFILE_INVALID_STATUS, str(exc)) from exc

    @app.post("/api/serve/model-profiles/probe")
    def probe_model_profile_endpoint(request: ModelApiProbeRequest, http_request: Request) -> dict:
        payload = request.model_dump(exclude={"profile_id"})
        try:
            return models.probe_profile(
                payload, request.profile_id, user_id=request_user_id(http_request)
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/serve/model-profiles")
    async def create_model_profile(request: PersonalApiRequest, http_request: Request) -> dict:
        try:
            return await models.save_profile(
                request.model_dump(exclude_unset=True), user_id=request_user_id(http_request)
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.put("/api/serve/model-profiles/{profile_id}")
    async def update_model_profile(
        profile_id: str, request: PersonalApiRequest, http_request: Request
    ) -> dict:
        try:
            return await models.save_profile(
                request.model_dump(exclude_unset=True),
                profile_id,
                user_id=request_user_id(http_request),
            )
        except ValueError as exc:
            raise HTTPException(_profile_error_status(exc), str(exc)) from exc

    @app.post("/api/serve/model-profiles/{profile_id}/enabled")
    async def set_model_profile_enabled(
        profile_id: str, request: ProfileEnabledRequest, http_request: Request
    ) -> dict:
        try:
            return await models.set_profile_enabled(
                profile_id, request.enabled, user_id=request_user_id(http_request)
            )
        except ValueError as exc:
            raise HTTPException(_profile_error_status(exc), str(exc)) from exc

    @app.post("/api/serve/model-profiles/{profile_id}/models/visibility")
    async def set_model_visibility(
        profile_id: str, request: ModelVisibilityRequest, http_request: Request
    ) -> dict:
        try:
            return await models.set_model_hidden(
                profile_id,
                request.model_id,
                request.hidden,
                user_id=request_user_id(http_request),
            )
        except ValueError as exc:
            raise HTTPException(_profile_error_status(exc), str(exc)) from exc

    @app.delete("/api/serve/model-profiles/{profile_id}")
    async def delete_model_profile(profile_id: str, request: Request) -> dict:
        try:
            return await models.delete_profile(profile_id, user_id=request_user_id(request))
        except ValueError as exc:
            raise HTTPException(_profile_error_status(exc), str(exc)) from exc

    def subscription_service() -> SubscriptionService:
        if subscriptions is None:
            raise HTTPException(503, "oauth_service_unavailable")
        return subscriptions

    @app.post("/api/settings/model-connections/{connection_id}/login")
    async def subscription_login(connection_id: str, request: Request) -> dict:
        require_host_process(request)
        try:
            return await subscription_service().login(
                request_owner_id(request), connection_id, user_id=request_user_id(request)
            )
        except ValueError as error:
            raise HTTPException(_profile_error_status(error), str(error)) from error

    @app.get("/api/settings/model-connections/{connection_id}/login/{transaction_id}")
    def subscription_login_status(
        connection_id: str, transaction_id: str, request: Request
    ) -> dict:
        try:
            return subscription_service().login_status(
                request_owner_id(request), connection_id, transaction_id
            )
        except ValueError as error:
            raise HTTPException(_profile_error_status(error), str(error)) from error

    @app.delete("/api/settings/model-connections/{connection_id}/login/{transaction_id}")
    async def subscription_cancel_login(
        connection_id: str, transaction_id: str, request: Request
    ) -> dict:
        try:
            subscription_service().cancel_login(
                request_owner_id(request), connection_id, transaction_id
            )
            return {"ok": True}
        except ValueError as error:
            raise HTTPException(_profile_error_status(error), str(error)) from error

    @app.delete("/api/settings/model-connections/{connection_id}/credentials")
    async def subscription_disconnect(connection_id: str, request: Request) -> dict:
        try:
            subscription_service().disconnect(request_owner_id(request), connection_id)
            return models.profiles(user_id=request_user_id(request))
        except ValueError as error:
            raise HTTPException(_profile_error_status(error), str(error)) from error

    @app.get("/api/settings/model-connections/{connection_id}/models")
    async def subscription_models(connection_id: str, request: Request) -> dict:
        # 配置时刻（用户点「加载模型」）：拉上游并落快照，供读路径直接使用。
        try:
            return await subscription_service().sync_directory(
                request_owner_id(request), connection_id
            )
        except ValueError as error:
            raise HTTPException(_profile_error_status(error), str(error)) from error

    @app.get("/api/serve/usage")
    def usage(session_id: str = "") -> dict:
        return models.usage(session_id)

    @app.get("/api/serve/settings/permission-mode")
    def permission_mode() -> dict:
        return {"mode": settings.permission_mode(), "modes": list(GLOBAL_PERMISSION_MODES)}

    @app.post("/api/serve/settings/permission-mode", response_model=None)
    def set_permission_mode(request: PermissionModeRequest) -> dict | JSONResponse:
        try:
            mode = settings.set_permission_mode(request.mode)
        except ValueError:
            return JSONResponse(
                {
                    "ok": False,
                    "error": INVALID_GLOBAL_PERMISSION_MODE_ERROR,
                    "modes": list(GLOBAL_PERMISSION_MODES),
                },
                status_code=400,
            )
        return {"ok": True, "mode": mode, "modes": list(GLOBAL_PERMISSION_MODES)}

    @app.get("/api/serve/settings/workflow")
    def workflow_default() -> dict:
        return {
            "enabled": False,
            "available": False,
            "error": RUNTIME_CAPABILITY_UNAVAILABLE,
        }

    @app.post("/api/serve/settings/workflow", response_model=None)
    def set_workflow_default(request: WorkflowDefaultRequest) -> dict | JSONResponse:
        _ = request
        return JSONResponse(
            {
                "ok": False,
                "error": WORKFLOW_CAPABILITY_UNAVAILABLE_ERROR,
                "runtime_error": RUNTIME_CAPABILITY_UNAVAILABLE,
            },
            status_code=409,
        )

    @app.get("/api/serve/settings/auto-review")
    def auto_review_default() -> dict:
        return {
            "enabled": False,
            "available": False,
            "error": RUNTIME_CAPABILITY_UNAVAILABLE,
        }

    @app.post("/api/serve/settings/auto-review", response_model=None)
    def set_auto_review_default(request: AutoReviewDefaultRequest) -> dict | JSONResponse:
        _ = request
        return JSONResponse(
            {
                "ok": False,
                "error": AUTO_REVIEW_CAPABILITY_UNAVAILABLE_ERROR,
                "runtime_error": RUNTIME_CAPABILITY_UNAVAILABLE,
            },
            status_code=409,
        )

    async def runtime_setting_payload() -> dict:
        executable = settings.runtime_executable()
        readiness = await runtime.readiness(executable=executable)
        return {
            "runtime_id": runtime.runtime_id,
            "runtime": runtime_payload(version=readiness.version),
            "readiness": readiness_payload(
                readiness,
                configured_executable=executable,
            ),
            "capabilities": runtime_capabilities_payload(runtime.gateway_capabilities),
        }

    @app.get("/api/serve/settings/runtime")
    async def runtime_setting() -> dict:
        return await runtime_setting_payload()
