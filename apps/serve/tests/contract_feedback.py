"""Contract coverage for diagnostic export and standalone Serve feedback forwarding.

反馈上报的三条不变量在这里钉死:
1. 基址与 updater.ts 读同一把 `damoclaw_server_url` (跨语言错配会让两条链路指向不同环境);
2. LLM trace 只在显式授权时才进日志包 (默认打包必须不含用户研究内容);
3. 独立 Serve 提交取权威身份并分类错误；Desktop 诊断导出不创建凭据或提交远端。
"""

from __future__ import annotations

import gzip
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import zipfile
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.session import RuntimeExecutionThread
from service.chat.api.feedback import mount_feedback_routes
from service.chat.persistence.catalog import SessionAccessError
from service.chat.service import feedback as fb
from service.chat.service.update import MIN_BUDGET, collect_update_diagnostics
from service.platform.activity import Activities

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


class _Recorder:
    """Stand in for httpx.Client, capturing exactly one outbound multipart POST."""

    def __init__(self, status_code: int = 200, payload: Any = None) -> None:
        self.status_code = status_code
        self.payload = {"ok": True, "id": "1768629600_a1b2c3d4"} if payload is None else payload
        self.url = ""
        self.data: dict[str, str] = {}
        self.files: list[tuple[str, tuple[str, bytes, str]]] = []
        self.headers: dict[str, str] = {}
        self.calls = 0

    def post(
        self,
        url: str,
        *,
        data: Any = None,
        files: Any = None,
        headers: Any = None,
    ) -> httpx.Response:
        self.calls += 1
        self.url = url
        self.data = dict(data or {})
        self.files = list(files or [])
        self.headers = dict(headers or {})
        return httpx.Response(
            self.status_code,
            content=json.dumps(self.payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            request=httpx.Request("POST", url),
        )

    def close(self) -> None:
        return None


def _service(
    recorder: _Recorder, *, bundle: bytes = b"", environ: Any = None
) -> fb.FeedbackService:
    calls: list[dict[str, Any]] = []

    def builder(
        *,
        include_trace: bool,
        session_id: str = "",
        vendor_thread_id: str = "",
        execution_threads: tuple[RuntimeExecutionThread, ...] = (),
        execution_tree_status: str = "unavailable",
        thread_history: fb.FeedbackThreadHistory | None = None,
        recording_report: bytes = b"",
        renderer_diagnostics: bytes = b"",
        include_diagnostics: bool = True,
    ) -> bytes:
        del execution_threads, execution_tree_status, thread_history
        calls.append(
            {
                "include_trace": include_trace,
                "session_id": session_id,
                "vendor_thread_id": vendor_thread_id,
                "recording_report": recording_report,
                "renderer_diagnostics": renderer_diagnostics,
                "include_diagnostics": include_diagnostics,
            }
        )
        return bundle

    service = fb.FeedbackService(
        base_url="http://damoclaw.invalid",
        client=recorder,
        environ={} if environ is None else environ,
        bundle_builder=builder,
    )
    setattr(service, "_test_bundle_calls", calls)
    return service


def test_base_url_resolution() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        config = Path(tmp) / "config.json"
        config.write_text(json.dumps({"damoclaw_server_url": "http://seeded.invalid/"}), "utf-8")
        check(
            "seeded config.json supplies the base URL",
            fb.resolve_base_url(environ={}, config_path=config) == "http://seeded.invalid",
            fb.resolve_base_url(environ={}, config_path=config),
        )
        # env 覆盖是唯一能在不改打包资产的前提下把客户端指到别的环境的开关。
        check(
            "env override wins over the seeded config",
            fb.resolve_base_url(
                environ={fb.BASE_URL_ENV: "http://override.invalid"},
                config_path=config,
            )
            == "http://override.invalid",
        )
        missing = Path(tmp) / "absent.json"
        check(
            "missing config falls back to the predeployed default",
            fb.resolve_base_url(environ={}, config_path=missing) == fb.DEFAULT_BASE_URL,
        )
        broken = Path(tmp) / "broken.json"
        broken.write_text("not-json", encoding="utf-8")
        check(
            "unparseable config falls back instead of raising",
            fb.resolve_base_url(environ={}, config_path=broken) == fb.DEFAULT_BASE_URL,
        )


def test_trace_is_opt_in() -> None:
    recorder = _Recorder()
    service = _service(recorder, bundle=b"PK-bundle")
    service.submit(
        fb.FeedbackSubmission(description="白屏", include_logs=True, include_trace=False)
    )
    calls = getattr(service, "_test_bundle_calls")
    # 这条断言守的是产品承诺: 不勾授权时, 对话内容 (trace) 不得离开这台机器。
    check(
        "default bundle excludes conversation",
        calls
        == [
            {
                "include_trace": False,
                "session_id": "",
                "vendor_thread_id": "",
                "recording_report": b"",
                "renderer_diagnostics": b"",
                "include_diagnostics": True,
            }
        ],
        str(calls),
    )

    recorder = _Recorder()
    service = _service(recorder, bundle=b"PK-bundle")
    service.submit(
        fb.FeedbackSubmission(
            description="白屏",
            include_logs=True,
            include_trace=True,
            session_id="sess-a",
            vendor_thread_id="thread-a",
        )
    )
    calls = getattr(service, "_test_bundle_calls")
    check(
        "consent forwards the active session ids to the bundler",
        calls
        == [
            {
                "include_trace": True,
                "session_id": "sess-a",
                "vendor_thread_id": "thread-a",
                "recording_report": b"",
                "renderer_diagnostics": b"",
                "include_diagnostics": True,
            }
        ],
        str(calls),
    )

    recorder = _Recorder()
    service = _service(recorder, bundle=b"PK-bundle")
    service.submit(fb.FeedbackSubmission(description="白屏", include_logs=False))
    check(
        "no bundle is built when logs are not attached",
        getattr(service, "_test_bundle_calls") == []
        and not any(name == "logs_bundle" for name, _ in recorder.files),
    )


def test_multipart_shape() -> None:
    recorder = _Recorder()
    service = _service(
        recorder,
        bundle=b"PK-bundle",
        environ={"SCHOLARSEED_APP_VERSION": "v0.1_202608271400"},
    )
    result = service.submit(
        fb.FeedbackSubmission(
            description="  启动白屏  ",
            api_key="ssk-abc123",
            include_logs=True,
            include_trace=True,
            session_id="sess-a",
            images=(fb.FeedbackImage("shot.png", "image/png", b"\x89PNG"),),
        )
    )
    check(
        "submit posts to the documented path", recorder.url.endswith(fb.SUBMIT_PATH), recorder.url
    )
    check("description is trimmed", recorder.data.get("description") == "启动白屏")
    # 归属现在只走 Authorization 头, 转发的是 ssk- API key（账号服务机器面只认它）:
    # 上游不收自报的 user_id。若头丢了, 每条反馈都会静默地落成匿名。
    check(
        "api key is forwarded as a bearer header",
        recorder.headers.get("Authorization") == "Bearer ssk-abc123",
        str(recorder.headers),
    )
    check(
        "self-reported identity is NOT sent as form fields",
        "user_id" not in recorder.data and "phone" not in recorder.data,
        str(recorder.data),
    )
    check(
        "client build metadata travels upstream",
        recorder.data.get("client_version") == "v0.1_202608271400"
        and bool(recorder.data.get("client_platform"))
        and bool(recorder.data.get("client_arch")),
        str(recorder.data),
    )
    # 缺席 ≠ 空串: 空串会在管理台里显示成「填了个空」, 而不是「没填」。
    check(
        "absent email is omitted rather than blank",
        "email" not in recorder.data,
        str(recorder.data),
    )
    names = [name for name, _ in recorder.files]
    check("image is attached as images[]", names.count("images") == 1, str(names))
    check("bundle is attached as logs_bundle", names.count("logs_bundle") == 1, str(names))
    # 固定文件名会让管理台把多条反馈的包下到同一个目录时互相覆盖, 也认不出来源。
    bundle_name = next(meta[0] for name, meta in recorder.files if name == "logs_bundle")
    check(
        "bundle filename carries platform and version instead of a shared constant",
        bundle_name.startswith(fb.BUNDLE_FILENAME_PREFIX)
        and bundle_name.endswith(fb.BUNDLE_FILENAME_SUFFIX)
        and "v0.1_202608271400" in bundle_name
        and fb.client_platform().lower() in bundle_name,
        bundle_name,
    )
    check("feedback id is projected back", result.ok and result.feedback_id.endswith("a1b2c3d4"))

    # 匿名提交不能发一个空的 `Bearer `: 上游会把它当坏凭据记一条 warning, 而这本来
    # 就是合法的未登录反馈。缺席才是「匿名」。
    anonymous = _Recorder()
    _service(anonymous).submit(fb.FeedbackSubmission(description="白屏"))
    check(
        "anonymous submission sends no Authorization header",
        "Authorization" not in anonymous.headers,
        str(anonymous.headers),
    )


def test_recording_report_bundle() -> None:
    report = b'{"schemaVersion":1,"steps":[]}'
    bundle = fb.build_log_bundle(
        include_trace=False,
        include_diagnostics=False,
        recording_report=report,
    )
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        check(
            "recording-only bundle has the fixed report member",
            archive.namelist() == [fb.RECORDING_REPORT_ARCNAME],
            str(archive.namelist()),
        )
        check(
            "recording report contents are preserved",
            archive.read(fb.RECORDING_REPORT_ARCNAME) == report,
        )

    recorder = _Recorder()
    service = _service(recorder, bundle=b"PK-report-bundle")
    result = service.submit(fb.FeedbackSubmission(description="录制问题", recording_report=report))
    calls = getattr(service, "_test_bundle_calls")
    check(
        "recording report builds a bundle without diagnostic logs",
        calls
        == [
            {
                "include_trace": False,
                "session_id": "",
                "vendor_thread_id": "",
                "recording_report": report,
                "renderer_diagnostics": b"",
                "include_diagnostics": False,
            }
        ],
        str(calls),
    )
    check(
        "recording bundle is forwarded through the existing logs field",
        result.ok and any(name == "logs_bundle" for name, _ in recorder.files),
    )


def test_renderer_diagnostics_bundle() -> None:
    diagnostics = b'{"schemaVersion":1,"consoleMessages":[],"networkRequests":[]}'
    bundle = fb.build_log_bundle(
        include_trace=False,
        include_diagnostics=False,
        renderer_diagnostics=diagnostics,
    )
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        check(
            "renderer diagnostics use a dedicated bundle member",
            archive.namelist() == [fb.RENDERER_DIAGNOSTICS_ARCNAME],
            str(archive.namelist()),
        )
        check(
            "renderer diagnostics contents are preserved",
            archive.read(fb.RENDERER_DIAGNOSTICS_ARCNAME) == diagnostics,
        )


def test_recording_report_route() -> None:
    class _Feedback:
        submission: fb.FeedbackSubmission | None = None
        submitted = False

        def build_bundle(self, submission: fb.FeedbackSubmission) -> bytes:
            self.submission = submission
            return fb.build_log_bundle(
                include_trace=False,
                include_diagnostics=False,
                recording_report=submission.recording_report,
            )

        def submit(self, submission: fb.FeedbackSubmission) -> fb.FeedbackResult:
            self.submission = submission
            self.submitted = True
            return fb.FeedbackResult(ok=True, feedback_id="feedback-1")

    class _Catalog:
        def get(self, session_id: str) -> None:
            return None

    class _Credentials:
        calls = 0

        async def ensure(self, user_id: str, token: str) -> dict[str, str]:
            self.calls += 1
            return {}

    app = FastAPI()
    app.state.auth_enabled = False
    app.state.ownership_axis = "machine"
    feedback = _Feedback()
    credentials = _Credentials()
    mount_feedback_routes(
        app,
        activities=Activities(),
        feedback=feedback,  # type: ignore[arg-type]
        catalog=_Catalog(),  # type: ignore[arg-type]
        credentials=credentials,  # type: ignore[arg-type]
    )
    report = b'{"schemaVersion":1}'
    with TestClient(app) as client:
        prepared = client.post(
            "/api/serve/feedback/bundle",
            data={"description": "prepare only", "include_logs": "true"},
            files={"recording_report": ("recording.json", report, "application/json")},
        )
        check(
            "bundle preparation does not submit remotely or issue credentials",
            prepared.status_code == 200 and not feedback.submitted and credentials.calls == 0,
        )
        check(
            "bundle preparation returns private ZIP bytes",
            prepared.headers.get("content-type") == "application/zip"
            and prepared.headers.get("cache-control") == "no-store",
        )
        with zipfile.ZipFile(io.BytesIO(prepared.content)) as archive:
            check(
                "bundle preparation retains the recording report",
                archive.read(fb.RECORDING_REPORT_ARCNAME) == report,
            )
        response = client.post(
            "/api/serve/feedback",
            data={"description": "route report"},
            files={"recording_report": ("recording.json", report, "application/json")},
        )
        check("recording report route accepts JSON", response.status_code == 200, response.text)
        check(
            "recording report route passes exact bytes to the service",
            feedback.submission is not None and feedback.submission.recording_report == report,
        )
        rejected = client.post(
            "/api/serve/feedback",
            data={"description": "bad report"},
            files={"recording_report": ("recording.txt", b"text", "text/plain")},
        )
        check(
            "recording report route rejects non-JSON uploads",
            rejected.status_code == 422,
            rejected.text,
        )
        malformed = client.post(
            "/api/serve/feedback",
            data={"description": "malformed report"},
            files={"recording_report": ("recording.json", b"{", "application/json")},
        )
        check(
            "recording report route rejects malformed JSON",
            malformed.status_code == 422,
            malformed.text,
        )
        unsupported = client.post(
            "/api/serve/feedback",
            data={"description": "unsupported report"},
            files={
                "recording_report": (
                    "recording.json",
                    b'{"schemaVersion":2}',
                    "application/json",
                )
            },
        )
        check(
            "recording report route rejects unsupported schemas",
            unsupported.status_code == 422,
            unsupported.text,
        )
        renderer_response = client.post(
            "/api/serve/feedback",
            data={"description": "renderer diagnostics"},
            files={
                "renderer_diagnostics": (
                    "renderer-diagnostics.json",
                    b'{"schemaVersion":1,"consoleMessages":[],"networkRequests":[]}',
                    "application/json",
                )
            },
        )
        check(
            "renderer diagnostics route accepts JSON",
            renderer_response.status_code == 200,
            renderer_response.text,
        )
        check(
            "renderer diagnostics route passes exact bytes to the service",
            feedback.submission is not None
            and feedback.submission.renderer_diagnostics.startswith(b'{"schemaVersion":1'),
        )


def test_feedback_route_scopes_execution_tree_to_owned_session() -> None:
    class Catalog:
        def get(self, session_id: str) -> Any:
            if session_id in {"owned", "denied"}:
                return SimpleNamespace(vendor_thread_id="root-thread")
            return None

        def require(self, session_id: str, _principal: Any) -> None:
            if session_id == "denied":
                raise SessionAccessError("not owned")

    class Runtime:
        calls: list[str] = []

        async def execution_threads(
            self, session_id: str, *, user_id: str, root_thread_id: str = ""
        ) -> tuple[RuntimeExecutionThread, ...]:
            del root_thread_id
            assert user_id
            self.calls.append(session_id)
            return (RuntimeExecutionThread("child-thread", "root-thread"),)

    class Feedback:
        submissions: list[fb.FeedbackSubmission] = []

        def submit(self, submission: fb.FeedbackSubmission) -> fb.FeedbackResult:
            self.submissions.append(submission)
            return fb.FeedbackResult(ok=True, feedback_id="feedback-1")

    class Credentials:
        async def ensure(self, _user_id: str, _token: str) -> dict[str, str]:
            return {}

    app = FastAPI()
    app.state.auth_enabled = False
    app.state.ownership_axis = "machine"
    runtime = Runtime()
    feedback = Feedback()
    mount_feedback_routes(
        app,
        activities=Activities(),
        feedback=feedback,  # type: ignore[arg-type]
        catalog=Catalog(),  # type: ignore[arg-type]
        credentials=Credentials(),  # type: ignore[arg-type]
        runtime=runtime,  # type: ignore[arg-type]
    )
    with TestClient(app) as client:
        for session_id in ("owned", "denied"):
            response = client.post(
                "/api/serve/feedback",
                data={
                    "description": "trace check",
                    "include_logs": "true",
                    "include_trace": "true",
                    "session_id": session_id,
                },
            )
            check(f"{session_id} feedback submits", response.status_code == 200, response.text)
    check(
        "only the owned session discovers children",
        runtime.calls == ["owned"]
        and feedback.submissions[0].session_id == "owned"
        and len(feedback.submissions[0].execution_threads) == 1,
        str(runtime.calls),
    )
    check(
        "denied session cannot smuggle product trace or child IDs",
        feedback.submissions[1].session_id == ""
        and feedback.submissions[1].vendor_thread_id == ""
        and not feedback.submissions[1].execution_threads,
    )


def test_bundle_filename() -> None:
    """文件名要能区分来源, 且不能把上游的 OSS key 拼歪。"""

    # 传 UTC 时刻, 期望北京时间落名 (10:15Z → 18:15): 这条同时钉住换算真的发生了。
    earlier = fb.bundle_filename(
        platform_name="Darwin",
        version="v0.1_202608271400",
        moment=datetime(2026, 8, 31, 10, 15, 0, tzinfo=timezone.utc),
    )
    later = fb.bundle_filename(
        platform_name="Darwin",
        version="v0.1_202608271400",
        moment=datetime(2026, 8, 31, 10, 15, 1, tzinfo=timezone.utc),
    )
    check(
        "same client at two moments yields two different filenames",
        earlier != later and earlier.endswith("-20260831T181500-cst.zip"),
        f"{earlier} vs {later}",
    )
    # 缺元数据时占位, 不留空段: "scholarseed-logs--" 这种名字读起来像坏了。
    anonymous_build = fb.bundle_filename(moment=datetime(2026, 8, 31, tzinfo=timezone.utc))
    check(
        "missing metadata falls back to a placeholder token",
        f"{fb.BUNDLE_NAME_SEPARATOR}{fb.BUNDLE_NAME_SEPARATOR}" not in anonymous_build
        and anonymous_build.count(fb.BUNDLE_NAME_FALLBACK) == 2,
        anonymous_build,
    )
    # 上游把客户端文件名直接拼进 OSS key (Damoclaw routes/feedback.py), 所以路径分隔符
    # 与空白必须在这一侧就消失, 而不是指望上游清洗。
    dirty = fb.bundle_filename(
        platform_name="../../etc",
        version="v0.1 / beta\\x",
        moment=datetime(2026, 8, 31, tzinfo=timezone.utc),
    )
    check(
        "path separators and spaces never reach the filename",
        not any(bad in dirty for bad in ("/", "\\", " ", "..")),
        dirty,
    )


def test_validation_and_upstream_failures() -> None:
    recorder = _Recorder()
    service = _service(recorder)
    for label, submission in (
        ("blank description is rejected", fb.FeedbackSubmission(description="   ")),
        (
            "over-long description is rejected",
            fb.FeedbackSubmission(description="x" * (fb.DESCRIPTION_MAX + 1)),
        ),
        (
            "too many images are rejected",
            fb.FeedbackSubmission(
                description="ok",
                images=tuple(
                    fb.FeedbackImage(f"{i}.png", "image/png", b"x")
                    for i in range(fb.MAX_IMAGES + 1)
                ),
            ),
        ),
        (
            "oversized image is rejected",
            fb.FeedbackSubmission(
                description="ok",
                images=(fb.FeedbackImage("big.png", "image/png", b"x" * (fb.MAX_IMAGE_SIZE + 1)),),
            ),
        ),
        (
            "oversized recording report is rejected",
            fb.FeedbackSubmission(
                description="ok",
                recording_report=b"x" * (fb.MAX_RECORDING_REPORT_SIZE + 1),
            ),
        ),
    ):
        try:
            service.submit(submission)
        except fb.FeedbackValidationError:
            check(label, True)
        else:
            check(label, False, "no FeedbackValidationError")
    check("rejected submissions never reach the network", recorder.calls == 0, str(recorder.calls))
    _check_aggregate_image_cap()

    limited = _Recorder(status_code=429, payload={"detail": "rate limit exceeded"})
    result = _service(limited).submit(fb.FeedbackSubmission(description="ok"))
    check(
        "upstream rate limit is reported with its status",
        not result.ok and result.status_code == 429 and "rate limit" in result.error,
        f"{result.status_code} {result.error}",
    )

    class _Unreachable(_Recorder):
        def post(
            self,
            url: str,
            *,
            data: Any = None,
            files: Any = None,
            headers: Any = None,
        ) -> httpx.Response:
            raise httpx.ConnectError("no route to host")

    result = _service(_Unreachable()).submit(fb.FeedbackSubmission(description="ok"))
    check(
        "transport failure degrades to a result, not an exception",
        not result.ok and bool(result.error),
    )


def _check_aggregate_image_cap() -> None:
    """单张合法但总量超限必须被拦 (之前 5×20MB 能整体穿过去)。

    把上限调到字节级再断言, 而不是真的搓 60MB 缓冲区: 阀值是模块级常量且在
    调用时读取, 缩小后逻辑路径完全一致。
    """

    original = (fb.MAX_IMAGE_SIZE, fb.MAX_IMAGES_TOTAL_SIZE)
    fb.MAX_IMAGE_SIZE = 10
    fb.MAX_IMAGES_TOTAL_SIZE = 15
    try:
        legal_pair = (
            fb.FeedbackImage("a.png", "image/png", b"x" * 10),
            fb.FeedbackImage("b.png", "image/png", b"x" * 10),
        )
        recorder = _Recorder()
        service = _service(recorder)
        try:
            service.submit(fb.FeedbackSubmission(description="ok", images=legal_pair))
        except fb.FeedbackValidationError as exc:
            check(
                "aggregate cap rejects a legal-per-image set that is too big together",
                "in total" in str(exc),
                str(exc),
            )
        else:
            check(
                "aggregate cap rejects a legal-per-image set that is too big together",
                False,
                "no FeedbackValidationError",
            )
        check("aggregate rejection never reaches the network", recorder.calls == 0)

        # 刚好等于上限要能过, 否则边界上误杀合法提交。
        exact = _Recorder()
        result = _service(exact).submit(
            fb.FeedbackSubmission(
                description="ok",
                images=(
                    fb.FeedbackImage("a.png", "image/png", b"x" * 10),
                    fb.FeedbackImage("b.png", "image/png", b"x" * 5),
                ),
            )
        )
        check("a set exactly at the aggregate cap is accepted", result.ok, result.error)
    finally:
        fb.MAX_IMAGE_SIZE, fb.MAX_IMAGES_TOTAL_SIZE = original

    # 总量闸必须严于「张数×单张上限」, 否则等于没卡。
    check(
        "aggregate cap is tighter than count x per-image cap",
        fb.MAX_IMAGES_TOTAL_SIZE < fb.MAX_IMAGES * fb.MAX_IMAGE_SIZE,
        f"{fb.MAX_IMAGES_TOTAL_SIZE} vs {fb.MAX_IMAGES * fb.MAX_IMAGE_SIZE}",
    )


def _check_bundle_budget_is_hard() -> None:
    """单个超大文件也不能捐破预算, 且截断要留尾巴。

    早先的实现只在追加前查已压字节数, 整份写完才发现超了; backend.log /
    system.log 各自可能 50MB, 压缩率差的内容一条就捐穿 40MB。后果是静默的:
    服务端超 60MB 只跳过日志包并仍返回 ok=true, 用户看到「已收到」。
    """

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        empty = root / "absent"
        # 不可压缩数据 = 最狠的情况: deflate 存不下任何便宜, 输出≈输入。
        hostile = root / "backend.log"
        hostile.write_bytes(os.urandom(4 * 1024 * 1024))

        original = (
            fb.DIAGNOSTIC_SOURCES,
            fb.TRACE_DIR,
            fb.SYSTEM_LOG,
            fb.BACKEND_LOG,
            fb.WINDOW_LOG,
            fb.CODEX_SESSIONS_DIR,
        )
        fb.DIAGNOSTIC_SOURCES = ()
        fb.TRACE_DIR = empty
        fb.CODEX_SESSIONS_DIR = empty
        fb.SYSTEM_LOG = empty / "none.log"
        fb.BACKEND_LOG = hostile
        fb.WINDOW_LOG = empty / "window.log"
        try:
            for budget in (256 * 1024, 1024 * 1024):
                payload = fb.build_log_bundle(include_trace=False, budget=budget)
                check(
                    f"an incompressible single file cannot break a {budget // 1024}KB budget",
                    len(payload) <= budget,
                    f"bundle={len(payload)} budget={budget} over={len(payload) - budget}",
                )

            # 截断要留末尾: 把 tail 上限调小再验, 不必真搓 8MB。
            marked = root / "marked.log"
            marked.write_text("HEAD-OLDEST\n" + "filler\n" * 20000 + "TAIL-NEWEST\n", "utf-8")
            fb.BACKEND_LOG = marked
            tail_original = fb.LOG_TAIL_BYTES
            fb.LOG_TAIL_BYTES = 2048
            try:
                payload = fb.build_log_bundle(include_trace=False, budget=1024 * 1024)
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    body = archive.read("backend/marked.log").decode("utf-8", "replace")
                check(
                    "oversized log keeps its tail, not its head",
                    "TAIL-NEWEST" in body and "HEAD-OLDEST" not in body,
                    f"head={'HEAD-OLDEST' in body} tail={'TAIL-NEWEST' in body}",
                )
            finally:
                fb.LOG_TAIL_BYTES = tail_original
        finally:
            (
                fb.DIAGNOSTIC_SOURCES,
                fb.TRACE_DIR,
                fb.SYSTEM_LOG,
                fb.BACKEND_LOG,
                fb.WINDOW_LOG,
                fb.CODEX_SESSIONS_DIR,
            ) = original


def test_update_log_replaced_by_fifo_does_not_block() -> None:
    if not hasattr(os, "mkfifo"):
        print("  SKIP FIFO rotation race is not available on this platform")
        return
    script = textwrap.dedent(r"""
        import json
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from service.chat.service.update import collect_update_diagnostics

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "update.log"
            target.write_text("old log\n")
            original = Path.lstat
            replaced = False
            def rotate(path, *args, **kwargs):
                global replaced
                observed = original(path, *args, **kwargs)
                if path == target and not replaced:
                    replaced = True
                    path.unlink()
                    os.mkfifo(path)
                return observed
            with patch.object(Path, "lstat", rotate):
                entries = dict(collect_update_diagnostics(target))
            assert replaced
            report = json.loads(entries["feedback/update-collection.json"])
            print(json.dumps(next(item for item in report["sources"] if item["source"] == "update.log")))
        """)
    try:
        result = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True, timeout=5, check=False
        )
    except subprocess.TimeoutExpired:
        check(
            "FIFO replacement cannot block update diagnostics", False, "open blocked for 5 seconds"
        )
        return
    check(
        "FIFO replacement cannot block update diagnostics",
        result.returncode == 0
        and json.loads(result.stdout)["status"] in {"changed", "rejected", "unreadable"},
        result.stderr,
    )


def test_installer_diagnostics_priority() -> None:
    """Keep both installer generations and update evidence before a noisy backend."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        evidence = {
            "update/install.log": b'{"event":"rejected","result":"ready-write-failed"}\n',
            "update/install-prev.log": b'{"event":"start","result":"protocol"}\n',
            "update/update.log": b"installer exited during handshake with code 2\n",
        }
        for name, body in evidence.items():
            (root / Path(name).name).write_bytes(body)
        backend = root / "backend.log"
        backend.write_bytes(os.urandom(256 * 1024))
        with patch.multiple(
            fb,
            create=True,
            UPDATE_LOG=root / "update.log",
            BACKEND_LOG=backend,
            WINDOW_LOG=root / "missing-window.log",
            SYSTEM_LOG=root / "missing-system.log",
            DIAGNOSTIC_SOURCES=(),
        ):
            for budget in (fb.BUNDLE_BUDGET_RESERVE + 64 * 1024, fb.MAX_BUNDLE_SIZE):
                payload = fb.build_log_bundle(include_trace=False, budget=budget)
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    check(
                        f"installer and update evidence survive backend pressure ({budget})",
                        all(
                            name in archive.namelist() and archive.read(name) == body
                            for name, body in evidence.items()
                        ),
                        str(archive.namelist()),
                    )
                check("installer evidence respects bundle budget", len(payload) <= budget)
            check(
                "installer diagnostics require diagnostic consent",
                not _bundle_names(
                    fb.build_log_bundle(include_trace=False, include_diagnostics=False)
                ),
            )
            (root / "install.log").unlink()
            (root / "install-prev.log").unlink()
            names = _bundle_names(fb.build_log_bundle(include_trace=False))
            check(
                "platforms without installer logs still collect update and backend",
                "update/update.log" in names
                and "backend/backend.log" in names
                and "update/install.log" not in names
                and "update/install-prev.log" not in names,
            )


def test_bundle_budget_and_scope() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        app_dir = root / "app"
        trace_dir = root / "trace"
        codex_sessions = root / "codex" / "sessions" / "2026" / "08" / "27"
        app_dir.mkdir()
        trace_dir.mkdir()
        codex_sessions.mkdir(parents=True)
        (app_dir / "2026-08-27.jsonl").write_text('{"event":"boot"}\n', encoding="utf-8")
        system_log = root / "system.log"
        system_log.write_text("boot ok\n", encoding="utf-8")
        # 实时后端日志: Electron 写到家目录 logs/backend.log, 必须被收走。
        backend_log = root / "backend.log"
        backend_log.write_text(
            "parent_control_failed stage=auth_receive exception_type=TimeoutError\nruntime_configuration_failed stage=lease exception_type=RuntimeError\nmcp_projection_failed exception_type=RuntimeError\n",
            encoding="utf-8",
        )
        window_log = root / "window.log"
        window_log.write_text(
            "backend_control event=closed reason=connection_timeout authenticated=false\n",
            encoding="utf-8",
        )
        # 更新链路诊断: 主进程落 logs/update.log (Authenticode STATUS/SUBJECT、计时、
        # 失败分类)。自更新被拦截的工单里, 这是唯一能定论失败类别的证据。
        update_log = root / "update.log"
        installation_events = [
            {
                "phase": "macos-install",
                "event": "step-start",
                "updateId": "attempt-87306807",
                "step": "gatekeeper",
                "application": "source",
                "timeoutMs": 180000,
                "elapsedMs": 76000,
            },
            {
                "phase": "macos-install",
                "event": "cancel-requested",
                "updateId": "attempt-87306807",
                "step": "gatekeeper",
                "stepElapsedMs": 75000,
                "elapsedMs": 151000,
            },
            {
                "phase": "macos-install",
                "event": "preparation-result",
                "updateId": "attempt-87306807",
                "step": "cleanup",
                "result": "cancelled",
                "elapsedMs": 153000,
            },
        ]
        update_log.write_text(
            "[update] Windows Authenticode verdict input: status=NotTrusted\n"
            + "".join(json.dumps(event) + "\n" for event in installation_events),
            encoding="utf-8",
        )

        # 两个会话各自一份 trace + 一份 rollout; 只有 "mine" 那一份得进包。
        (trace_dir / "scholarseed-codex-mine.jsonl").write_text(
            '{"p":"my secret"}\n', encoding="utf-8"
        )
        (trace_dir / "scholarseed-codex-other.jsonl").write_text(
            '{"p":"other"}\n', encoding="utf-8"
        )
        (codex_sessions / "rollout-2026-08-27T10-00-00-thread-mine.jsonl").write_text(
            "{}\n", "utf-8"
        )
        (codex_sessions / "rollout-2026-08-27T09-00-00-thread-other.jsonl").write_text(
            "{}\n", "utf-8"
        )
        # 凭据类文件: 就算落在扫描路径上也必须被拦住。
        (codex_sessions / "auth.json").write_text('{"OPENAI_API_KEY":"sk-live"}', encoding="utf-8")

        original = (
            fb.DIAGNOSTIC_SOURCES,
            fb.TRACE_DIR,
            fb.SYSTEM_LOG,
            fb.BACKEND_LOG,
            fb.WINDOW_LOG,
            fb.UPDATE_LOG,
            fb.CODEX_SESSIONS_DIR,
        )
        fb.DIAGNOSTIC_SOURCES = (("app", app_dir),)
        fb.TRACE_DIR = trace_dir
        fb.SYSTEM_LOG = system_log
        fb.BACKEND_LOG = backend_log
        fb.WINDOW_LOG = window_log
        fb.UPDATE_LOG = update_log
        fb.CODEX_SESSIONS_DIR = codex_sessions.parents[2]
        try:
            names = _bundle_names(fb.build_log_bundle(include_trace=False))
            check(
                "diagnostic bundle carries app logs and the system log",
                any(n.startswith("app/") for n in names)
                and any(n.startswith("system/") for n in names),
                str(names),
            )
            # 这条守的是「默认包里至少有一份当次运行的日志」—— 之前全部源都是
            # 陈旧文件时, 默认反馈包对排障零价值。
            check(
                "live backend.log is in the default diagnostic bundle",
                "backend/backend.log" in names,
                str(names),
            )
            check(
                "desktop lifecycle log is in the default diagnostic bundle",
                "window/window.log" in names,
                str(names),
            )
            check(
                "live update.log is in the default diagnostic bundle",
                "update/update.log" in names,
                str(names),
            )
            recorder = _Recorder()
            result = fb.FeedbackService(client=recorder).submit(
                fb.FeedbackSubmission(description="startup diagnostics", include_logs=True)
            )
            attached = [meta for name, meta in recorder.files if name == "logs_bundle"]
            check(
                "feedback submission attaches the real diagnostic archive",
                result.ok and len(attached) == 1,
            )
            with zipfile.ZipFile(io.BytesIO(attached[0][1])) as submitted:
                check(
                    "submitted archive retains control diagnosis without an active session",
                    "parent_control_failed" in submitted.read("backend/backend.log").decode()
                    and "backend_control" in submitted.read("window/window.log").decode(),
                )
            with zipfile.ZipFile(io.BytesIO(fb.build_log_bundle(include_trace=False))) as archive:
                diagnostic_backend = archive.read("backend/backend.log").decode()
                diagnostic_window = archive.read("window/window.log").decode()
                check(
                    "feedback automatically carries control and MCP diagnostics without trace consent",
                    "parent_control_failed stage=auth_receive" in diagnostic_backend
                    and "runtime_configuration_failed stage=lease" in diagnostic_backend
                    and "mcp_projection_failed" in diagnostic_backend
                    and "backend_control event=closed reason=connection_timeout"
                    in diagnostic_window,
                )
                check(
                    "desktop lifecycle log retains the exit evidence",
                    archive.read("window/window.log") == window_log.read_bytes(),
                )
                check(
                    "feedback ZIP retains macOS installation steps, cancellation and outcome",
                    archive.read("update/update.log") == update_log.read_bytes(),
                )
            check(
                "feedback without diagnostic consent excludes update log",
                "update/update.log"
                not in _bundle_names(
                    fb.build_log_bundle(include_trace=False, include_diagnostics=False)
                ),
            )
            window_log.unlink()
            check(
                "missing desktop lifecycle log does not block feedback",
                "window/window.log" not in _bundle_names(fb.build_log_bundle(include_trace=False)),
            )
            window_log.write_text("backend recovered\n", encoding="utf-8")
            check(
                "diagnostic bundle carries no conversation",
                not any(n.startswith("conversation/") for n in names),
                str(names),
            )

            # 核心断言: 只收被点开的那一个会话, 旁人的会话不能捷带上传。
            names = _bundle_names(
                fb.build_log_bundle(
                    include_trace=True, session_id="mine", vendor_thread_id="thread-mine"
                )
            )
            check(
                "active session trace is included",
                "conversation/scholarseed-codex-mine.jsonl" in names,
                str(names),
            )
            check(
                "active session codex rollout is included",
                any(n.startswith("conversation/rollout-") and "thread-mine" in n for n in names),
                str(names),
            )
            check(
                "another session's trace is NOT included",
                not any("other" in n for n in names),
                str(names),
            )
            check(
                "credential files are never bundled",
                not any("auth.json" in n for n in names),
                str(names),
            )

            # “无会话就不打包”: 即使勾了授权, 没有 session id 也一字对话不收。
            names = _bundle_names(fb.build_log_bundle(include_trace=True))
            check(
                "no active session means no conversation at all",
                not any(n.startswith("conversation/") for n in names),
                str(names),
            )
            check(
                "an unknown session id yields no conversation",
                not any(
                    n.startswith("conversation/")
                    for n in _bundle_names(
                        fb.build_log_bundle(include_trace=True, session_id="ghost")
                    )
                ),
            )
            # budget=0 时首个候选就该停下, 证明预算真的被执行 (而不是只在注释里)。
            check(
                "an exhausted budget stops collection",
                not any(
                    n.startswith("app/")
                    for n in _bundle_names(fb.build_log_bundle(include_trace=True, budget=0))
                ),
            )
        finally:
            (
                fb.DIAGNOSTIC_SOURCES,
                fb.TRACE_DIR,
                fb.SYSTEM_LOG,
                fb.BACKEND_LOG,
                fb.WINDOW_LOG,
                fb.UPDATE_LOG,
                fb.CODEX_SESSIONS_DIR,
            ) = original


def _bundle_names(payload: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.namelist()


def test_subagent_rollouts_are_scoped_and_reported() -> None:
    root_id = "11111111-1111-7111-8111-111111111111"
    child_id = "22222222-2222-7222-8222-222222222222"
    grandchild_id = "33333333-3333-7333-8333-333333333333"
    unrelated_id = "44444444-4444-7444-8444-444444444444"
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        sessions = root / "sessions" / "2026" / "09" / "28"
        sessions.mkdir(parents=True)
        for thread_id in (root_id, child_id, grandchild_id, unrelated_id):
            (sessions / f"rollout-2026-09-28T10-00-00-{thread_id}.jsonl").write_text(
                json.dumps({"thread": thread_id}) + "\n", encoding="utf-8"
            )
        original_sessions = fb.CODEX_SESSIONS_DIR
        fb.CODEX_SESSIONS_DIR = root / "sessions"
        try:
            bundle = fb.build_log_bundle(
                include_trace=True,
                include_diagnostics=False,
                session_id="owned",
                vendor_thread_id=root_id,
                execution_threads=(
                    RuntimeExecutionThread(child_id, root_id),
                    RuntimeExecutionThread(grandchild_id, child_id),
                ),
                execution_tree_status="complete",
            )
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                names = archive.namelist()
                tree = json.loads(archive.read(fb.THREAD_TREE_ARCNAME))
                check(
                    "parent and nested subagent rollouts share one authorized bundle",
                    any(name.endswith(f"{root_id}.jsonl") for name in names)
                    and all(
                        any(
                            name.startswith(f"conversation/subagents/{thread_id}/")
                            for name in names
                        )
                        for thread_id in (child_id, grandchild_id)
                    ),
                    str(names),
                )
                check(
                    "unrelated rollout is excluded",
                    not any(unrelated_id in name for name in names),
                    str(names),
                )
                check(
                    "thread tree points to actual child files and their direct parents",
                    tree["discovery_status"] == "complete"
                    and [(row["thread_id"], row["parent_thread_id"]) for row in tree["threads"]]
                    == [(child_id, root_id), (grandchild_id, child_id)]
                    and all(row["path"] in names for row in tree["threads"]),
                    str(tree),
                )
                check(
                    "child attachment contains its own execution record",
                    all(
                        json.loads(archive.read(row["path"]))["thread"] == row["thread_id"]
                        for row in tree["threads"]
                    ),
                )
            check(
                "without consent no subagent or tree enters the bundle",
                not any(
                    name.startswith("conversation/")
                    for name in _bundle_names(
                        fb.build_log_bundle(
                            include_trace=False,
                            include_diagnostics=False,
                            session_id="owned",
                            vendor_thread_id=root_id,
                            execution_threads=(RuntimeExecutionThread(child_id, root_id),),
                        )
                    )
                ),
            )
            with zipfile.ZipFile(
                io.BytesIO(
                    fb.build_log_bundle(
                        include_trace=True,
                        include_diagnostics=False,
                        session_id="owned",
                        vendor_thread_id=root_id,
                        execution_tree_status="unavailable",
                    )
                )
            ) as archive:
                tree = json.loads(archive.read(fb.THREAD_TREE_ARCNAME))
                check(
                    "unavailable discovery is explicit, not reported as an empty complete tree",
                    tree["discovery_status"] == "unavailable" and tree["threads"] == [],
                )
        finally:
            fb.CODEX_SESSIONS_DIR = original_sessions


def test_historical_roots_are_scoped_and_indexed() -> None:
    roots = tuple(
        f"{digit * 8}-{digit * 4}-7{digit * 3}-8{digit * 3}-{digit * 12}" for digit in "123"
    )
    unrelated = "44444444-4444-7444-8444-444444444444"
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        trace = home / "trace"
        sessions = home / "sessions"
        trace.mkdir()
        sessions.mkdir()
        records = [
            {
                "session_id": "owned",
                "name": fb.TRACE_RUNTIME_BOUND,
                "attributes": {"runtime_id": fb.FEEDBACK_RUNTIME_ID, "vendor_thread_id": thread_id},
            }
            for thread_id in (*roots, roots[0])
        ]
        records.extend(
            [
                {
                    "session_id": "other",
                    "name": fb.TRACE_RUNTIME_BOUND,
                    "attributes": {
                        "runtime_id": fb.FEEDBACK_RUNTIME_ID,
                        "vendor_thread_id": unrelated,
                    },
                },
                {
                    "session_id": "owned",
                    "name": "user.message",
                    "attributes": {
                        "runtime_id": fb.FEEDBACK_RUNTIME_ID,
                        "vendor_thread_id": unrelated,
                    },
                },
            ]
        )
        (trace / "shushen-codex-owned.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
        )
        for thread_id in (*roots, unrelated):
            (sessions / f"rollout-2026-10-13T10-00-00-{thread_id}.jsonl").write_text(
                json.dumps({"thread": thread_id}) + "\n", encoding="utf-8"
            )
        with patch.object(fb, "TRACE_DIR", trace), patch.object(fb, "CODEX_SESSIONS_DIR", sessions):
            history = fb.session_thread_history("owned", roots[-1])
            check(
                "binding history is exact-session, event-scoped and deduplicated",
                history.thread_ids == (roots[-1], *roots[:-1])
                and history.discovery_status == "complete",
                str(history),
            )
            bundle = fb.build_log_bundle(
                include_trace=True,
                include_diagnostics=False,
                session_id="owned",
                vendor_thread_id=roots[-1],
            )
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                tree = json.loads(archive.read(fb.THREAD_TREE_ARCNAME))
                check(
                    "all three roots retain independent rollout files",
                    len(tree["root_threads"]) == 3
                    and all(
                        row["status"] == "included" and row["path"] in archive.namelist()
                        for row in tree["root_threads"]
                    )
                    and not any(unrelated in name for name in archive.namelist()),
                    str(tree),
                )
            archived = fb.build_log_bundle(
                include_trace=True, include_diagnostics=False, session_id="owned"
            )
            with zipfile.ZipFile(io.BytesIO(archived)) as archive:
                tree = json.loads(archive.read(fb.THREAD_TREE_ARCNAME))
                check(
                    "archived session without current binding still includes historical roots",
                    tree["root_thread_id"] == ""
                    and len(tree["root_threads"]) == 3
                    and all(row["status"] == "included" for row in tree["root_threads"]),
                    str(tree),
                )
            (sessions / f"rollout-2026-10-13T10-00-00-{roots[0]}.jsonl").unlink()
            (sessions / f"rollout-2026-10-13T11-00-00-{roots[1]}.jsonl").write_text(
                "{}\n", encoding="utf-8"
            )
            bundle = fb.build_log_bundle(
                include_trace=True,
                include_diagnostics=False,
                session_id="owned",
                vendor_thread_id=roots[-1],
            )
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                rows = json.loads(archive.read(fb.THREAD_TREE_ARCNAME))["root_threads"]
                check(
                    "missing and ambiguous historical roots remain explicit",
                    [row["status"] for row in rows] == ["included", "missing", "ambiguous"]
                    and all(row["path"] is None for row in rows[1:]),
                    str(rows),
                )
            with (trace / "shushen-codex-owned.jsonl").open("a", encoding="utf-8") as source:
                source.write("invalid json\n")
            check(
                "malformed history never claims complete discovery",
                fb.session_thread_history("owned", roots[-1]).discovery_status == "partial",
            )
            check(
                "without conversation consent historical roots are excluded",
                not any(
                    name.startswith("conversation/")
                    for name in _bundle_names(
                        fb.build_log_bundle(
                            include_trace=False,
                            include_diagnostics=False,
                            session_id="owned",
                            vendor_thread_id=roots[-1],
                        )
                    )
                ),
            )


def test_subagent_tail_and_budget_remain_parseable() -> None:
    child_id = "55555555-5555-7555-8555-555555555555"
    with tempfile.TemporaryDirectory() as directory:
        sessions = Path(directory)
        rollout = sessions / f"rollout-2026-09-28T10-00-00-{child_id}.jsonl"
        rollout.write_text(
            "".join(json.dumps({"index": index}) + "\n" for index in range(10)),
            encoding="utf-8",
        )
        original_sessions = fb.CODEX_SESSIONS_DIR
        original_tail = fb.LOG_TAIL_BYTES
        fb.CODEX_SESSIONS_DIR = sessions
        fb.LOG_TAIL_BYTES = 56
        try:
            bundle = fb.build_log_bundle(
                include_trace=True,
                include_diagnostics=False,
                session_id="owned",
                vendor_thread_id="root-thread",
                execution_threads=(RuntimeExecutionThread(child_id, "root-thread"),),
                execution_tree_status="complete",
            )
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                row = json.loads(archive.read(fb.THREAD_TREE_ARCNAME))["threads"][0]
                payload = archive.read(row["path"])
                check(
                    "truncated child rollout retains only complete JSONL records",
                    row["status"] == "truncated"
                    and payload.endswith(b"\n")
                    and all(json.loads(line) for line in payload.splitlines()),
                )
            fb.LOG_TAIL_BYTES = original_tail
            rollout.write_text(json.dumps({"body": "a" * 25_000}) + "\n", encoding="utf-8")
            bundle = fb.build_log_bundle(
                include_trace=True,
                include_diagnostics=False,
                session_id="owned",
                vendor_thread_id="root-thread",
                execution_threads=(RuntimeExecutionThread(child_id, "root-thread"),),
                execution_tree_status="complete",
                budget=fb.THREAD_TREE_MANIFEST_RESERVE + 16_000,
            )
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                row = json.loads(archive.read(fb.THREAD_TREE_ARCNAME))["threads"][0]
                check(
                    "budget exclusion is explicit and does not publish a partial child file",
                    row["status"] == "budget_excluded"
                    and row["path"] is None
                    and not any("subagents/" in name for name in archive.namelist()),
                )
        finally:
            fb.CODEX_SESSIONS_DIR = original_sessions
            fb.LOG_TAIL_BYTES = original_tail


def test_session_error_summary_is_additive() -> None:
    with tempfile.TemporaryDirectory() as directory:
        trace_dir = Path(directory)
        path = trace_dir / "scholarseed-codex-mine.jsonl"
        path.write_text(
            json.dumps(
                {
                    "session_id": "mine",
                    "name": "runtime.incident.detected",
                    "attributes": {
                        "session_id": "mine",
                        "incident_kind": "rpc_rejected",
                        "incident_state": "detected",
                        "provider_error_code": "rate_limit_exceeded",
                        "provider_http_status": 429,
                        "raw_error": "private provider response",
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        previous_trace_dir = fb.TRACE_DIR
        fb.TRACE_DIR = trace_dir
        try:
            original = fb._build_log_bundle_contents(
                include_trace=True, session_id="mine", include_diagnostics=False
            )
            updated = fb.build_log_bundle(
                include_trace=True, session_id="mine", include_diagnostics=False
            )
            with (
                zipfile.ZipFile(io.BytesIO(original)) as before,
                zipfile.ZipFile(io.BytesIO(updated)) as after,
            ):
                check(
                    "session summary only appends one member",
                    after.namelist() == before.namelist() + [fb.SESSION_ERROR_SUMMARY_ARCNAME],
                )
                check(
                    "old bundle members remain byte-identical",
                    all(before.read(name) == after.read(name) for name in before.namelist()),
                )
                summary = after.read(fb.SESSION_ERROR_SUMMARY_ARCNAME)
                check(
                    "summary has safe status but no provider body",
                    b'"http_status":429' in summary
                    and b'"provider_error_code":"rate_limit_exceeded"' in summary
                    and b"private provider response" not in summary,
                )
            check(
                "summary requires conversation consent",
                fb.SESSION_ERROR_SUMMARY_ARCNAME
                not in _bundle_names(
                    fb.build_log_bundle(include_trace=False, include_diagnostics=False)
                ),
            )
            constrained = fb.build_log_bundle(
                include_trace=True,
                session_id="mine",
                include_diagnostics=False,
                budget=len(original),
            )
            expected = fb._build_log_bundle_contents(
                include_trace=True,
                session_id="mine",
                include_diagnostics=False,
                budget=len(original),
            )
            with (
                zipfile.ZipFile(io.BytesIO(expected)) as before,
                zipfile.ZipFile(io.BytesIO(constrained)) as after,
            ):
                check(
                    "limited budget never removes original members",
                    all(
                        name in after.namelist() and before.read(name) == after.read(name)
                        for name in before.namelist()
                    ),
                )
        finally:
            fb.TRACE_DIR = previous_trace_dir


def test_update_evidence() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        update = root / "update.log"
        update.write_text(
            'Authorization: Bearer secret-token\nhttps://user:password@example.com/a?token=secret\n/Users/alice/project C:\\Users\\bob\\project\n{"phase":"prepare","event":"failed","updateId":"attempt-1","nonce":"private"}\n',
            encoding="utf-8",
        )
        (root / "install.log").write_text(
            '{"phase":"installer-ready","updateId":"attempt-1"}\n', encoding="utf-8"
        )
        (root / "components.log").write_text("component cache hit\n", encoding="utf-8")
        with gzip.open(root / "update.log.1.gz", "wb") as rotated:
            rotated.write(b'{"phase":"recover","updateId":"previous-attempt"}\n')
        entries = dict(collect_update_diagnostics(update))
        text = entries["update/update.log"].decode()
        check(
            "update evidence removes credentials and home identities",
            all(
                value not in text
                for value in ("secret-token", "example.com", "alice", "bob", "private")
            ),
            text,
        )
        check(
            "update evidence includes installer components and rotation",
            all(
                name in entries
                for name in (
                    "update/install.log",
                    "update/components.log",
                    "update/update.log.1.gz.txt",
                )
            ),
        )
        report = json.loads(entries["feedback/update-collection.json"])
        check(
            "missing install history is explicit",
            any(
                item["source"] == "install-prev.log" and item["status"] == "missing"
                for item in report["sources"]
            ),
        )
        check(
            "installer evidence correctly describes snapshot",
            any(
                item["source"] == "install.log" and item["kind"] == "snapshot"
                for item in report["sources"]
            ),
        )
        summary = json.loads(entries["feedback/update-summary.json"])
        check(
            "summary correlates events without raw nonce",
            any(event.get("updateId") == "attempt-1" for event in summary["events"])
            and "nonce" not in str(summary),
        )
        update.write_text(
            json.dumps({"password": 'quoted"private', "path": "C:\\Users\\Alice Smith\\cache"})
            + "\nCookie: first=private; second=hidden\n",
            encoding="utf-8",
        )
        text = dict(collect_update_diagnostics(update))["update/update.log"].decode()
        check(
            "escaped secrets and full cookie headers are redacted",
            all(value not in text for value in ("private", "hidden", "Alice", "Smith")),
            text,
        )
        (root / "update.log.2.gz").write_bytes(b"not a gzip archive")
        report = json.loads(
            dict(collect_update_diagnostics(update))["feedback/update-collection.json"]
        )
        check(
            "corrupt archive does not prevent feedback",
            any(
                item["source"] == "update.log.2.gz" and item["status"] == "unreadable"
                for item in report["sources"]
            ),
        )
        (root / "install-prev.log").symlink_to(update)
        report = json.loads(
            dict(collect_update_diagnostics(update))["feedback/update-collection.json"]
        )
        check(
            "symlink diagnostic sources are rejected",
            any(
                item["source"] == "install-prev.log" and item["status"] == "rejected"
                for item in report["sources"]
            ),
        )
        update.write_bytes(b"x" * (3 * 1024 * 1024) + b"\nlast complete event\npartial")
        entries = dict(collect_update_diagnostics(update))
        check(
            "large update tail stays bounded and contains complete lines",
            sum(map(len, entries.values())) <= 2 * 1024 * 1024
            and entries["update/update.log"].endswith(b"last complete event\n"),
        )
        update.write_text('{"phase":"prepare","result":"failed"}\n', encoding="utf-8")
        for budget in (MIN_BUDGET, 32 * 1024, 48 * 1024):
            entries = dict(collect_update_diagnostics(update, budget))
            check(
                f"small update budget retains redacted evidence and reports ({budget})",
                "update/update.log" in entries
                and "feedback/update-collection.json" in entries
                and sum(map(len, entries.values())) <= budget,
            )
        check(
            "undersized updater allocation never falls back to raw",
            not collect_update_diagnostics(update, MIN_BUDGET - 1),
        )
        for name in ("update.log", "install.log", "components.log"):
            (root / name).write_text(
                ("old diagnostic line\n" * 8192)
                + json.dumps({"phase": "prepare", "result": "failed", "updateId": name})
                + "\n",
                encoding="utf-8",
            )
        for budget in (MIN_BUDGET, 32 * 1024, 48 * 1024):
            entries = dict(collect_update_diagnostics(update, budget))
            summary = json.loads(entries["feedback/update-summary.json"])
            check(
                f"oversized details retain each source failure summary ({budget})",
                {event.get("updateId") for event in summary["events"]}
                >= {"update.log", "install.log", "components.log"}
                and "update/update.log" not in entries
                and sum(map(len, entries.values())) <= budget,
            )


def test_update_bundle_single_redacted_owner() -> None:
    """Inspect every ZIP member, including duplicate names that readers mask."""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        secrets = ("secret-update", "secret-install", "secret-previous", "secret-component")
        names = ("update.log", "install.log", "install-prev.log", "components.log")
        for name, secret in zip(names, secrets):
            (root / name).write_text(
                json.dumps({"phase": "prepare", "event": "failed", "password": secret}) + "\n",
                encoding="utf-8",
            )
        backend = root / "backend.log"
        backend.write_bytes(os.urandom(256 * 1024))
        with patch.multiple(
            fb,
            create=True,
            UPDATE_LOG=root / "update.log",
            BACKEND_LOG=backend,
            WINDOW_LOG=root / "missing-window.log",
            SYSTEM_LOG=root / "missing-system.log",
            DIAGNOSTIC_SOURCES=(),
        ):
            for budget in (fb.BUNDLE_BUDGET_RESERVE + 64 * 1024, fb.MAX_BUNDLE_SIZE):
                payload = fb.build_log_bundle(include_trace=False, budget=budget)
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    members = archive.namelist()
                    check(
                        "final feedback ZIP has unique member names",
                        len(members) == len(set(members)),
                    )
                    check(
                        "final feedback ZIP has only collector-owned update sources",
                        all("update/" + name in members for name in names)
                        and not any(name.startswith("install/") for name in members),
                        str(members),
                    )
                    contents = b"\n".join(archive.read(info) for info in archive.infolist())
                    check(
                        "every final ZIP member excludes updater secrets",
                        all(secret.encode() not in contents for secret in secrets),
                    )
                    check("final redacted ZIP respects budget", len(payload) <= budget)
            # The collector's no-follow rejection cannot be bypassed by a later
            # generic log source which follows the same path.
            previous = root / "install-prev.log"
            previous.unlink()
            foreign = root / "foreign"
            foreign.write_text("foreign-update-secret\n", encoding="utf-8")
            previous.symlink_to(foreign)
            with zipfile.ZipFile(io.BytesIO(fb.build_log_bundle(include_trace=False))) as archive:
                contents = b"\n".join(archive.read(info) for info in archive.infolist())
                check(
                    "final ZIP cannot bypass rejected updater symlink",
                    b"foreign-update-secret" not in contents,
                )
            check(
                "final updater collection requires log consent",
                not _bundle_names(
                    fb.build_log_bundle(include_trace=False, include_diagnostics=False)
                ),
            )


def test_update_bundle_real_http_submission() -> None:
    """Send the actual builder's multipart body over loopback and inspect reception."""
    received: list[dict[str, bytes]] = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["Content-Length"]))
            message = BytesParser(policy=email_policy).parsebytes(
                ("Content-Type: " + self.headers["Content-Type"] + "\r\n\r\n").encode() + body
            )
            fields = {
                part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
                for part in message.iter_parts()
            }
            received.append(fields)
            reply = b'{"ok":true,"id":"local-feedback-contract"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    with (
        tempfile.TemporaryDirectory() as directory,
        HTTPServer(("127.0.0.1", 0), Receiver) as server,
    ):
        root = Path(directory)
        update = root / "update.log"
        update.write_text(
            '{"phase":"prepare","result":"failed","nonce":"upload-secret"}\n', encoding="utf-8"
        )
        (root / "native-update.log").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "phase": "native-diagnostics",
                    "event": "snapshot",
                    "result": "disconnected",
                    "diagnosticRevision": 7,
                    "lastSyncedAt": "2026-09-30T12:00:00Z",
                }
            )
            + "\n"
            + json.dumps(
                {
                    "schemaVersion": 1,
                    "sequence": 7,
                    "session": "42.1790000000000000000",
                    "phase": "gc",
                    "event": "collected",
                    "result": "partial",
                    "errorCode": "collection_budget",
                    "reclaimedBytes": 123,
                    "removedFiles": 2,
                    "nonce": "native-secret",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        thread = Thread(target=server.serve_forever)
        thread.start()
        service = fb.FeedbackService(base_url=f"http://127.0.0.1:{server.server_port}", environ={})
        try:
            with patch.multiple(
                fb,
                UPDATE_LOG=update,
                WINDOW_LOG=root / "missing-window.log",
                BACKEND_LOG=root / "missing-backend.log",
                SYSTEM_LOG=root / "missing-system.log",
                DIAGNOSTIC_SOURCES=(),
            ):
                result = service.submit(
                    fb.FeedbackSubmission(description="local contract", include_logs=True)
                )
                check(
                    "real HTTP feedback receives built log attachment",
                    result.ok and "logs_bundle" in received[0],
                )
                with zipfile.ZipFile(io.BytesIO(received[0]["logs_bundle"])) as archive:
                    check(
                        "received multipart ZIP keeps one sanitized update log",
                        archive.namelist().count("update/update.log") == 1
                        and b"upload-secret" not in archive.read("update/update.log"),
                    )
                    check(
                        "received native diagnostics preserve stale status and partial cleanup counts",
                        archive.namelist().count("update/native-update.log") == 1
                        and b"native-secret" not in archive.read("update/native-update.log")
                        and any(
                            event.get("result") == "disconnected"
                            and event.get("diagnosticRevision") == 7
                            for event in json.loads(archive.read("feedback/update-summary.json"))[
                                "events"
                            ]
                        )
                        and any(
                            event.get("removedFiles") == 2 and event.get("reclaimedBytes") == 123
                            for event in json.loads(archive.read("feedback/update-summary.json"))[
                                "events"
                            ]
                        ),
                    )
                result = service.submit(
                    fb.FeedbackSubmission(description="local contract", include_logs=False)
                )
                check(
                    "real HTTP without log consent carries no attachment",
                    result.ok and "logs_bundle" not in received[1],
                )
        finally:
            service.close()
            server.shutdown()
            thread.join()


def main() -> int:
    print("desktop feedback forwarding contract")
    test_update_evidence()
    test_update_bundle_single_redacted_owner()
    test_update_bundle_real_http_submission()
    test_base_url_resolution()
    test_trace_is_opt_in()
    test_multipart_shape()
    test_recording_report_bundle()
    test_renderer_diagnostics_bundle()
    test_recording_report_route()
    test_feedback_route_scopes_execution_tree_to_owned_session()
    test_bundle_filename()
    test_validation_and_upstream_failures()
    _check_bundle_budget_is_hard()
    test_update_log_replaced_by_fifo_does_not_block()
    test_installer_diagnostics_priority()
    test_bundle_budget_and_scope()
    test_subagent_rollouts_are_scoped_and_reported()
    test_historical_roots_are_scoped_and_indexed()
    test_subagent_tail_and_budget_remain_parseable()
    test_session_error_summary_is_additive()
    print(f"passed={PASS} failed={FAIL}")
    return 1 if FAIL else 0


def test_program_source_identity_is_bundled_without_conversation_consent() -> None:
    identity = {
        "schema_version": 1,
        "runtime_kind": "local_dev",
        "commit": "a" * 40,
        "branch": "preview",
        "repository_url": "git@example.test:repo.git",
        "dirty": True,
    }
    with patch.dict(os.environ, {"SCHOLARSEED_SOURCE_BASELINE": json.dumps(identity)}):
        bundle = fb._build_log_bundle_contents(include_trace=False, include_diagnostics=True)
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            check(
                "startup source identity survives without conversation logs",
                json.loads(archive.read("feedback/source-baseline.json")) == identity,
            )
        bundle = fb._build_log_bundle_contents(include_trace=False, include_diagnostics=False)
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            check(
                "no source identity without diagnostic consent",
                "feedback/source-baseline.json" not in archive.namelist(),
            )


if __name__ == "__main__":
    test_program_source_identity_is_bundled_without_conversation_consent()
    raise SystemExit(main())
