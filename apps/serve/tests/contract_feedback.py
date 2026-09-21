"""Contract coverage for desktop problem-report forwarding to Damoclaw-Server.

反馈上报的三条不变量在这里钉死:
1. 基址与 updater.ts 读同一把 `damoclaw_server_url` (跨语言错配会让两条链路指向不同环境);
2. LLM trace 只在显式授权时才进日志包 (默认打包必须不含用户研究内容);
3. 身份取 serve 侧权威值, 且失败按类别投影 (429 透传, 其余 502)。
"""

from __future__ import annotations

import io
import json
import os
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.api.feedback import mount_feedback_routes
from service.chat.service import feedback as fb

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
        recording_report: bytes = b"",
        include_diagnostics: bool = True,
    ) -> bytes:
        calls.append(
            {
                "include_trace": include_trace,
                "session_id": session_id,
                "vendor_thread_id": vendor_thread_id,
                "recording_report": recording_report,
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
                "include_diagnostics": False,
            }
        ],
        str(calls),
    )
    check(
        "recording bundle is forwarded through the existing logs field",
        result.ok and any(name == "logs_bundle" for name, _ in recorder.files),
    )


def test_recording_report_route() -> None:
    class _Feedback:
        submission: fb.FeedbackSubmission | None = None

        def submit(self, submission: fb.FeedbackSubmission) -> fb.FeedbackResult:
            self.submission = submission
            return fb.FeedbackResult(ok=True, feedback_id="feedback-1")

    class _Catalog:
        def get(self, session_id: str) -> None:
            return None

    class _Credentials:
        async def ensure(self, user_id: str, token: str) -> dict[str, str]:
            return {}

    app = FastAPI()
    app.state.auth_enabled = False
    app.state.ownership_axis = "machine"
    feedback = _Feedback()
    mount_feedback_routes(
        app,
        feedback=feedback,  # type: ignore[arg-type]
        catalog=_Catalog(),  # type: ignore[arg-type]
        credentials=_Credentials(),  # type: ignore[arg-type]
    )
    report = b'{"schemaVersion":1}'
    with TestClient(app) as client:
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
            fb.CODEX_SESSIONS_DIR,
        )
        fb.DIAGNOSTIC_SOURCES = ()
        fb.TRACE_DIR = empty
        fb.CODEX_SESSIONS_DIR = empty
        fb.SYSTEM_LOG = empty / "none.log"
        fb.BACKEND_LOG = hostile
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
                fb.CODEX_SESSIONS_DIR,
            ) = original


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
        backend_log.write_text("serve started\n", encoding="utf-8")
        # 更新链路诊断: 主进程落 logs/update.log (Authenticode STATUS/SUBJECT、计时、
        # 失败分类)。自更新被拦截的工单里, 这是唯一能定论失败类别的证据。
        update_log = root / "update.log"
        update_log.write_text(
            "[update] Windows Authenticode verdict input: status=NotTrusted\n", encoding="utf-8"
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
            fb.UPDATE_LOG,
            fb.CODEX_SESSIONS_DIR,
        )
        fb.DIAGNOSTIC_SOURCES = (("app", app_dir),)
        fb.TRACE_DIR = trace_dir
        fb.SYSTEM_LOG = system_log
        fb.BACKEND_LOG = backend_log
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
                "live update.log is in the default diagnostic bundle",
                "update/update.log" in names,
                str(names),
            )
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
                fb.UPDATE_LOG,
                fb.CODEX_SESSIONS_DIR,
            ) = original


def _bundle_names(payload: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.namelist()


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


def main() -> int:
    print("desktop feedback forwarding contract")
    test_base_url_resolution()
    test_trace_is_opt_in()
    test_multipart_shape()
    test_recording_report_bundle()
    test_recording_report_route()
    test_bundle_filename()
    test_validation_and_upstream_failures()
    _check_bundle_budget_is_hard()
    test_bundle_budget_and_scope()
    test_session_error_summary_is_additive()
    print(f"passed={PASS} failed={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
