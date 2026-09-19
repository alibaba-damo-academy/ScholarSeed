"""Problem-report intake that forwards to Damoclaw-Server."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from starlette.status import (
    HTTP_404_NOT_FOUND,
    HTTP_422_UNPROCESSABLE_CONTENT,
    HTTP_503_SERVICE_UNAVAILABLE,
)

from damoatrace.recording.diagnostics import DIAGNOSTIC_MEDIA_TYPE
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.service.diagnostics import DIAGNOSTIC_FILENAME, export_diagnostics
from service.chat.service.feedback import (
    MAX_IMAGE_SIZE,
    MAX_IMAGES,
    MAX_IMAGES_TOTAL_SIZE,
    MAX_RECORDING_REPORT_SIZE,
    FeedbackImage,
    FeedbackService,
    FeedbackSubmission,
    FeedbackValidationError,
)
from service.identity.service.skill_credentials import (
    SKILL_API_KEY_ENV,
    SkillCredentialService,
)
from service.identity.utils import bearer_or_cookie, request_owner_id, request_user_id

logger = logging.getLogger(__name__)

DEFAULT_IMAGE_MEDIA_TYPE = "application/octet-stream"
UNSPECIFIED_IMAGE_NAME = "screenshot.png"
RECORDING_REPORT_MEDIA_TYPE = "application/json"
RECORDING_REPORT_SCHEMA_VERSION = 1
# 上游按 IP 限频, 超限是最可能被用户撞上的一种失败, 原样透出状态码让前端能给出
# 「稍后再试」而不是笼统的「提交失败」。
UPSTREAM_RATE_LIMITED = 429


def _total_exceeded_detail() -> str:
    """One wording for the aggregate cap, so route and service can't drift."""

    return f"images exceed {MAX_IMAGES_TOTAL_SIZE // (1024 * 1024)}MB in total"


def mount_feedback_routes(
    app: FastAPI,
    *,
    feedback: FeedbackService,
    catalog: SessionCatalogStore,
    credentials: SkillCredentialService,
) -> None:
    """Expose the desktop feedback submit endpoint."""

    @app.get("/api/serve/sessions/{session_id}/diagnostics")
    async def download_diagnostics(session_id: str, request: Request) -> Response:
        try:
            bundle = await asyncio.to_thread(
                export_diagnostics,
                catalog,
                session_id=session_id,
                principal=SessionPrincipal(user_id=request_owner_id(request)),
            )
        except SessionAccessError as error:
            raise HTTPException(HTTP_404_NOT_FOUND, "session not found") from error
        except ValueError as error:
            raise HTTPException(HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error
        except OSError as error:
            raise HTTPException(HTTP_503_SERVICE_UNAVAILABLE, "trace export unavailable") from error
        return Response(
            bundle,
            media_type=DIAGNOSTIC_MEDIA_TYPE,
            headers={
                "Content-Disposition": f'attachment; filename="{DIAGNOSTIC_FILENAME}"',
                "Cache-Control": "no-store",
            },
        )

    def resolve_vendor_thread(session_id: str, owner: str) -> str:
        """Map the active product session to its Codex thread id.

        必须校归属: session_id 是前端传的, 不校就等于让任何登录用户填别人的
        会话 id, 把别人的对话打进自己的反馈包里上传。查不到或无权寻址则
        当作「无活跃会话」处理 —— 不报错, 但也不收任何对话数据。

        判定必须委派 catalog.require —— 它是归属的唯一真源, 且随归属轴退化。手写比较
        record.principal_id 会绕过轴: machine 轴下调用方的归属身份是机器级常量, 而
        principal_id 记的是建会话的真实账号, 两者永不相等, 于是每次都静默丢掉会话数据。
        """

        if not session_id:
            return ""
        record = catalog.get(session_id)
        if record is None:
            logger.info("feedback: unknown session_id, conversation set skipped")
            return ""
        try:
            catalog.require(session_id, SessionPrincipal(user_id=owner))
        except SessionAccessError:
            logger.warning("feedback: session_id not owned by caller, conversation set skipped")
            return ""
        return str(getattr(record, "vendor_thread_id", "") or "")

    @app.post("/api/serve/feedback")
    async def submit_feedback(
        request: Request,
        description: str = Form(""),
        email: str = Form(""),
        include_logs: bool = Form(False),
        include_trace: bool = Form(False),
        session_id: str = Form(""),
        images: list[UploadFile] = File(default_factory=list),
        recording_report: UploadFile | None = File(None),
    ) -> dict:
        if len(images) > MAX_IMAGES:
            raise HTTPException(422, f"at most {MAX_IMAGES} images")
        # 归属身份 (谁能引用这个 session_id) 与真实账号身份 (拿谁的凭据、上报给谁) 是两件
        # 事: 归属可能被收敛到机器级, 混用会让凭据腿静默用错身份。
        owner_id = request_owner_id(request)
        actor_id = request_user_id(request)
        attachments: list[FeedbackImage] = []
        # 总量在边读边累加时就卡, 而不是先把 5 张全读进内存再回头判定 —— 否则
        # 拒绝之前已经把 100MB 吃进去了, 闸也就白卡了。峰值因此收在总量+一张。
        total = 0
        for upload in images:
            declared = upload.size if isinstance(upload.size, int) else None
            if declared is not None and total + declared > MAX_IMAGES_TOTAL_SIZE:
                raise HTTPException(422, _total_exceeded_detail())
            data = await upload.read()
            if not data:
                continue
            if len(data) > MAX_IMAGE_SIZE:
                raise HTTPException(422, f"image {upload.filename} exceeds 20MB")
            total += len(data)
            # declared 只是提前量, 不可信; 读完后的真实长度才是判定依据。
            if total > MAX_IMAGES_TOTAL_SIZE:
                raise HTTPException(422, _total_exceeded_detail())
            attachments.append(
                FeedbackImage(
                    filename=upload.filename or UNSPECIFIED_IMAGE_NAME,
                    content_type=upload.content_type or DEFAULT_IMAGE_MEDIA_TYPE,
                    data=data,
                )
            )

        report_bytes = b""
        if recording_report is not None:
            declared = recording_report.size if isinstance(recording_report.size, int) else None
            if declared is not None and declared > MAX_RECORDING_REPORT_SIZE:
                raise HTTPException(422, "recording report exceeds 2MB")
            content_type = str(recording_report.content_type or "").split(";", 1)[0].strip().lower()
            if content_type != RECORDING_REPORT_MEDIA_TYPE:
                raise HTTPException(422, "recording report must be application/json")
            report_bytes = await recording_report.read(MAX_RECORDING_REPORT_SIZE + 1)
            if len(report_bytes) > MAX_RECORDING_REPORT_SIZE:
                raise HTTPException(422, "recording report exceeds 2MB")
            try:
                report_payload = json.loads(report_bytes)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise HTTPException(422, "recording report must contain valid JSON") from error
            if (
                not isinstance(report_payload, dict)
                or report_payload.get("schemaVersion") != RECORDING_REPORT_SCHEMA_VERSION
            ):
                raise HTTPException(422, "recording report schema is unsupported")

        # 复用替登录用户备好的那把 ssk- API key（skill 也用它）。上游账号服务的机器面
        # 只认 API key、拒用户 JWT —— 用户 JWT 是全权限凭据, 一个只需要「这是谁」的
        # 服务不该拿到。ensure 缓存命中就沿用、没有就签一把; 拿不到 (未登录/未配账号
        # 服务) 就返回空, 反馈照收、只是落成匿名。
        credential_env = await credentials.ensure(actor_id, bearer_or_cookie(request))
        api_key = credential_env.get(SKILL_API_KEY_ENV, "")

        submission = FeedbackSubmission(
            description=description,
            # 上报给上游的真实账号身份。上游不收自报身份, 它自己拿下面那把 key 去账号
            # 服务求证 —— 这里给的只是便于对账的声明值。
            user_id=actor_id,
            email=email,
            # 转发 ssk- API key, 让上游能自己求证归属 —— serve 说「我验过了」在那一跳不作数。
            api_key=api_key,
            include_logs=include_logs,
            # trace 是用户的研究内容, 只有 include_logs 同时成立才有意义 ——
            # 单独勾 trace 不该悄悄触发一次日志打包。
            include_trace=include_trace and include_logs,
            session_id=session_id,
            vendor_thread_id=resolve_vendor_thread(session_id, owner_id),
            images=tuple(attachments),
            recording_report=report_bytes,
        )
        try:
            # submit 是同步的 (zip 打包 + 阻塞 httpx): 一个 40MB 的日志包上传要好几秒,
            # 留在 event loop 里会把整个 serve 卡住 —— 包括正在流式输出的会话。
            result = await asyncio.to_thread(feedback.submit, submission)
        except FeedbackValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
        if not result.ok:
            status = result.status_code if result.status_code == UPSTREAM_RATE_LIMITED else 502
            raise HTTPException(status, result.error or "feedback upstream unavailable")
        logger.info(
            "feedback forwarded id=%s images=%d bundle_bytes=%d",
            result.feedback_id,
            len(attachments),
            result.bundle_bytes,
        )
        return {"ok": True, "id": result.feedback_id, "bundle_bytes": result.bundle_bytes}


__all__ = ["mount_feedback_routes"]
