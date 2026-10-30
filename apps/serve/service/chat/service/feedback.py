"""Forward desktop problem reports to Damoclaw-Server.

serve 侧承接反馈上报, 而不是让 renderer 直连 Damoclaw: 日志包只在这台机器上,
renderer 读不到 `~/.scholarseed/logs/`。

身份**不由这一侧自报**: serve 转发替登录用户备好的书深 ssk- API key，不发送
user_id 表单字段或用户 JWT。预期由 Damoclaw 用该 key 向账号服务核验归属；
上游实际身份处理仍需按当前部署独立核验。

当前发送侧请求形态（上游部署契约需独立核验）:
    POST {damoclaw}/api/v1/feedback/submit   multipart/form-data
        Authorization: Bearer <ssk- API key>   (仅在本侧取得 key 时发送)
        description / email / client_version /
        client_platform / client_arch / images[] / logs_bundle
      → { ok, id }
本侧无 key 时仍发送请求；是否接受、如何归属及限频值取决于上游当前部署。
上游返回 429 时本侧向 Desktop 透传该状态码。
"""

from __future__ import annotations

import io
import json
import logging
import os
import platform
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Protocol, Sequence

import httpx

from damoatrace.data.store import TraceStore
from damoatrace.paths import APP_LOG_DIR, METRICS_DIR, TRACE_DIR
from scholarseed_runtime.contract.session import RuntimeExecutionThread
from service.chat.runtime.evidence import (
    TRACE_RUNTIME_BOUND,
    TRACE_RUNTIME_INCIDENT_PREFIX,
    session_trace_paths,
)
from service.chat.service.sandbox import collect_sandbox_diagnostics
from service.chat.service.streams import DIAGNOSTIC_EVENT, StreamEnd
from service.chat.service.update import BUDGET as UPDATE_DIAGNOSTICS_BUDGET
from service.chat.service.update import collect_update_diagnostics
from service.paths import (
    CODEX_RUNTIME_HOME,
    CONFIG_PATH,
    LOGS_DIR,
    STARTUP_LOG_DIR,
    SYSTEM_LOG,
)

logger = logging.getLogger(__name__)

# ── 对接配置 ──

# 默认地址与 apps/desktop/resources/product.json 的 update_base_url 对齐。
# 反馈仍允许通过环境变量和本地配置显式覆盖上游地址。
CONFIG_BASE_URL_KEY = "damoclaw_server_url"
BASE_URL_ENV = "SCHOLARSEED_DAMOCLAW_SERVER_URL"
DEFAULT_BASE_URL = "https://scholarseed.damo.alibaba.com"
SUBMIT_PATH = "/api/v1/feedback/submit"
HTTP_TIMEOUT_S = 60.0

# ── 上报约束 (与服务端 config.py 对齐, 客户端先挡一层) ──

MAX_IMAGES = 5
MAX_IMAGE_SIZE = 20 * 1024 * 1024
# 单张上限乘张数不等于总量上限: 5×20MB 意味着一次反馈能在 serve 内存里堆 100MB
# 图片, 再加日志包拼成 ~140MB 的 multipart 体发给上游 —— 而上游也没有总量闸。
# 这里单独卡一道总量: 它是对单张上限的**额外**约束, 不是把单张上限重定义。
MAX_IMAGES_TOTAL_SIZE = 40 * 1024 * 1024
# 服务端硬上限 60MB。客户端按 40MB 收口: 压缩后的体积事前算不准, 留出余量比
# 传到一半被拒更好 —— 被拒时用户白等一次上传。
MAX_BUNDLE_SIZE = 40 * 1024 * 1024
MAX_RECORDING_REPORT_SIZE = 2 * 1024 * 1024
DESCRIPTION_MAX = 5000
BUNDLE_MEDIA_TYPE = "application/zip"
RECORDING_REPORT_ARCNAME = "feedback/recording-report.json"
RENDERER_DIAGNOSTICS_ARCNAME = "feedback/renderer-diagnostics.json"
SESSION_ERROR_SUMMARY_ARCNAME = "feedback/session-error-summary.json"
SESSION_ERROR_SUMMARY_VERSION = 1
SESSION_ERROR_SUMMARY_EVENTS = 64
SESSION_ERROR_SUMMARY_MAX_BYTES = 16 * 1024
SESSION_ERROR_SUMMARY_INCIDENT_PREFIX = f"{TRACE_RUNTIME_INCIDENT_PREFIX}."
SESSION_ERROR_SUMMARY_BRIDGE_EVENT = DIAGNOSTIC_EVENT
SESSION_ERROR_SUMMARY_TURN_SUFFIX = ".turn.failed"
SESSION_ERROR_SUMMARY_FAILED_STREAM_ENDS = frozenset(
    {
        StreamEnd.HTTP_ERROR.value,
        StreamEnd.TRANSPORT_ERROR.value,
        StreamEnd.BRIDGE_ERROR.value,
        StreamEnd.PROVIDER_ERROR.value,
    }
)

# 日志包文件名。曾经是固定的 "scholarseed-logs.zip": 上游按 feedback_id 分目录存, OSS 里
# 不冲突, 但管理台把几条反馈的包下到同一个目录后彼此互盖, 也认不出哪个包是谁的。
# 名字里只放已经作为表单字段出网的平台/版本, 加上上报时刻 —— 不新增暴露面, 又让文件
# 脱离管理台上下文后仍能自证来源。身份类字段 (user_id / 手机号 / session_id) 一律不进
# 文件名: 文件会被转发、附进工单, 比数据库更容易漏出去。
BUNDLE_FILENAME_PREFIX = "scholarseed-logs"
BUNDLE_FILENAME_SUFFIX = ".zip"
# 时间戳取北京时间: 看这些文件的是国内团队, 名字里的时刻要和管理台列表、群里说的
# 「几点报的」直接对得上, 中间不要再做一次时区换算。时区标签是名字的一部分, 不然
# 一个没有 Z 的裸时刻会被当成 UTC 读。
BUNDLE_NAME_TIMEZONE = timezone(timedelta(hours=8))
BUNDLE_NAME_ZONE_LABEL = "cst"
BUNDLE_NAME_TIME_FORMAT = "%Y%m%dT%H%M%S"
BUNDLE_NAME_SEPARATOR = "-"
# 逐字符白名单, 而不是「过滤掉危险字符」: 版本串来自环境变量, 且上游把客户端文件名
# 直接拼进 OSS key, 只放行确定安全的字符比枚举危险字符可靠。
BUNDLE_NAME_EXTRA_CHARS = "._"
BUNDLE_NAME_TOKEN_MAX = 32
BUNDLE_NAME_FALLBACK = "unknown"

# ── 日志打包范围 ──

# 诊断面: 运行日志 + 启动计时 + 指标。这些是排障的最小充分集, 不含对话正文。
DIAGNOSTIC_SOURCES: tuple[tuple[str, Path], ...] = (
    ("app", APP_LOG_DIR),
    ("startup", STARTUP_LOG_DIR),
    ("metrics", METRICS_DIR),
)
SYSTEM_LOG_LABEL = "system"
# Electron 主进程把 serve 子进程的 stdout/stderr 转写到这里 (见
# apps/desktop/src/main/backend.ts)。体积可能很大，排在安装/更新诊断之后，
# 避免预算耗尽时丢失无法从 backend 还原的跨进程交接原因。
BACKEND_LOG: Path = LOGS_DIR / "backend.log"
BACKEND_LOG_LABEL = "backend"
WINDOW_LOG: Path = LOGS_DIR / "window.log"
WINDOW_LOG_LABEL = "window"
# Electron 主进程把更新链路的全部诊断落在这里 (见 apps/desktop/src/main/updater.ts 的
# persistUpdateLog): Authenticode 的 STATUS/SUBJECT/LANGMODE、逐步计时、安装失败分类。
# 自更新被拦截时, 这是唯一能区分失败类别的证据; 不收它, 这类工单在线上永远无法定论。
UPDATE_LOG: Path = LOGS_DIR / "update.log"
# collect_update_diagnostics owns this file and its installer/component siblings.
# Never add those sources to the raw log loop: duplicate ZIP entries bypass its
# redaction, no-follow checks and independent diagnostic budget.
# trace 索引是可重建的旁路 sqlite, 打进去只是白占额度。
BUNDLE_EXCLUDED_SUFFIXES = (".sqlite3", ".sqlite3-wal", ".sqlite3-shm")

CODEX_SESSIONS_DIR: Path = CODEX_RUNTIME_HOME / "sessions"
CONVERSATION_LABEL = "conversation"
ROLLOUT_GLOB = "rollout-*.jsonl"
SOURCE_BASELINE_ENV = "SCHOLARSEED_SOURCE_BASELINE"
SOURCE_BASELINE_ARCNAME = "feedback/source-baseline.json"
SOURCE_BASELINE_MAX_BYTES = 64 * 1024
THREAD_TREE_ARCNAME = f"{CONVERSATION_LABEL}/thread-tree.json"
SUBAGENT_LABEL = f"{CONVERSATION_LABEL}/subagents"
THREAD_TREE_SCHEMA_VERSION = 1
THREAD_TREE_MANIFEST_RESERVE = 128 * 1024
THREAD_ROLLOUT_HEADER_RESERVE = 1024
MAX_FEEDBACK_EXECUTION_THREADS = 256
FEEDBACK_RUNTIME_ID = "codex"


class ThreadEvidenceStatus(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    UNAVAILABLE = "unavailable"
    LIMIT_EXCEEDED = "thread_limit_exceeded"
    INCLUDED = "included"
    TRUNCATED = "truncated"
    MISSING = "missing"
    AMBIGUOUS = "ambiguous"
    UNREADABLE = "unreadable"
    BUDGET_EXCLUDED = "budget_excluded"


@dataclass(frozen=True)
class FeedbackThreadHistory:
    thread_ids: tuple[str, ...] = ()
    discovery_status: str = ThreadEvidenceStatus.UNAVAILABLE.value


# 绝不入包的东西 (即使将来有人把 codex/ 整目录加进来, 这道门也要拦住):
#   codex/auth.json        —— 存的是 OPENAI_API_KEY 明文, 上传等于泄凭据
#   codex/shell_snapshots/ —— shell 环境快照, 本就是一堆 export, 带着 token
BUNDLE_FORBIDDEN_NAMES = ("auth.json", "credentials.json", ".env")
BUNDLE_FORBIDDEN_DIRNAMES = ("shell_snapshots", ".sandbox-secrets")

# 逐块写入的块大小。预算必须在**写的过程中**判, 不能只在追加前判:
# archive.write() 一口气写整个文件, 管不住正在写那一份的体积。
BUNDLE_CHUNK_BYTES = 64 * 1024
# 单个文件最多取多少原文。包里全是 append-only 日志, 报障讲的是刚刚发生的事,
# 所以超长时取**尾巴**而不是头: 从头截留下的恰好是最旧、最没用的那段。
LOG_TAIL_BYTES = 8 * 1024 * 1024
# 给 zip 中心目录与每条目的本地头留的余量。
BUNDLE_BUDGET_RESERVE = 128 * 1024


@dataclass
class FeedbackImage:
    """One user-attached screenshot."""

    filename: str
    content_type: str
    data: bytes


@dataclass
class FeedbackSubmission:
    """A problem report as assembled by the serve layer."""

    description: str
    # 本机已验签的 principal。只用于会话归属校验 (resolve_vendor_thread), **不出网** ——
    # 上游不收自报身份, 归属由它自己拿下面这把 api_key 向账号服务求证。
    user_id: str = ""
    email: str = ""
    # 转发给上游的书深 ssk- API key（账号服务机器面只认它、拒用户 JWT）。空 = 这条反馈
    # 落成匿名。
    api_key: str = ""
    include_logs: bool = False
    include_trace: bool = False
    # 用户当前点开的会话 (renderer 的 activeSession)。空 = 无活跃会话, 就不收对话数据。
    session_id: str = ""
    # 该会话在 Codex 侧的 thread id, 用来定位 rollout 文件; 由路由层从会话编目查出。
    vendor_thread_id: str = ""
    execution_threads: tuple[RuntimeExecutionThread, ...] = ()
    execution_tree_status: str = "unavailable"
    thread_history: FeedbackThreadHistory | None = None
    images: Sequence[FeedbackImage] = field(default_factory=tuple)
    recording_report: bytes = b""
    renderer_diagnostics: bytes = b""


@dataclass
class FeedbackResult:
    """Outcome of one upstream submission."""

    ok: bool
    feedback_id: str = ""
    error: str = ""
    status_code: int = 0
    bundle_bytes: int = 0


class FeedbackValidationError(ValueError):
    """The submission is rejected before any upstream call is made."""


class OutboundClient(Protocol):
    """本服务对出站客户端的全部要求: 发一次 multipart POST, 再关掉。

    写成 Protocol 而不是 `httpx.Client`: 契约测要注入不走网络的 stub, 而这个服务
    本就不依赖 httpx.Client 的其余任何行为。
    """

    def post(
        self,
        url: str,
        *,
        data: Optional[Mapping[str, str]] = ...,
        files: Optional[Sequence[tuple[str, tuple[str, bytes, str]]]] = ...,
        headers: Optional[Mapping[str, str]] = ...,
    ) -> httpx.Response: ...

    def close(self) -> None: ...


def resolve_base_url(
    *,
    environ: Optional[Mapping[str, str]] = None,
    config_path: Optional[Path] = None,
) -> str:
    """Resolve the Damoclaw base URL the same way the updater does.

    Precedence: env override > seeded ``config.json`` > predeployed default.
    """

    env = os.environ if environ is None else environ
    override = str(env.get(BASE_URL_ENV, "") or "").strip()
    if override:
        return override.rstrip("/")
    path = CONFIG_PATH if config_path is None else config_path
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return DEFAULT_BASE_URL
    configured = payload.get(CONFIG_BASE_URL_KEY) if isinstance(payload, dict) else None
    if isinstance(configured, str) and configured.strip():
        return configured.strip().rstrip("/")
    return DEFAULT_BASE_URL


def client_platform() -> str:
    """Report the OS family, matching Damoclaw's ``client_platform`` column."""

    return platform.system()


def client_arch() -> str:
    """Report the machine architecture, matching Damoclaw's ``client_arch``."""

    return platform.machine()


def client_version(environ: Optional[Mapping[str, str]] = None) -> str:
    """Report the desktop app version injected by the Electron launcher."""

    env = os.environ if environ is None else environ
    return str(env.get("SCHOLARSEED_APP_VERSION", "") or "").strip()


def _name_token(value: str) -> str:
    """Reduce one metadata string to a filename-safe token."""

    kept = [
        char
        for char in str(value or "").strip().lower()
        if char.isascii() and (char.isalnum() or char in BUNDLE_NAME_EXTRA_CHARS)
    ]
    token = "".join(kept)[:BUNDLE_NAME_TOKEN_MAX].strip(BUNDLE_NAME_EXTRA_CHARS)
    return token or BUNDLE_NAME_FALLBACK


def bundle_filename(
    *,
    platform_name: str = "",
    version: str = "",
    moment: Optional[datetime] = None,
) -> str:
    """Name this report's log bundle so it stays identifiable outside the console.

    形如 ``scholarseed-logs-darwin-v0.1_202608271400-20260831T181500-cst.zip``。时刻按北京
    时间落名 (标签 ``cst`` 明写时区, 免得裸时刻被当成 UTC), 并兼任去重位 —— 同机同版本
    的两次上报只靠平台/版本区分不开。
    """

    moment_here = (moment or datetime.now(BUNDLE_NAME_TIMEZONE)).astimezone(BUNDLE_NAME_TIMEZONE)
    stamp = moment_here.strftime(BUNDLE_NAME_TIME_FORMAT)
    parts = (
        BUNDLE_FILENAME_PREFIX,
        _name_token(platform_name),
        _name_token(version),
        stamp,
        BUNDLE_NAME_ZONE_LABEL,
    )
    return BUNDLE_NAME_SEPARATOR.join(parts) + BUNDLE_FILENAME_SUFFIX


def _bundle_candidates() -> Iterable[tuple[str, Path]]:
    """Yield (label, directory) pairs for the diagnostic sweep."""

    yield from DIAGNOSTIC_SOURCES


def _is_forbidden(path: Path) -> bool:
    """Reject anything that carries credentials, wherever it was reached from."""

    if path.name in BUNDLE_FORBIDDEN_NAMES:
        return True
    return any(part in BUNDLE_FORBIDDEN_DIRNAMES for part in path.parts)


def session_thread_history(session_id: str, vendor_thread_id: str) -> FeedbackThreadHistory:
    """Recover native roots only from the authorized product session's binding evidence."""

    thread_ids = dict.fromkeys((vendor_thread_id,) if vendor_thread_id else ())
    paths = session_trace_paths(session_id, TRACE_DIR)
    status = ThreadEvidenceStatus.UNAVAILABLE.value
    for path in paths:
        try:
            store = TraceStore(path.parent, trace_file=path, offline=True)
            records = store.session_events(session_id)
            skipped = store.completeness(session_id).get("skipped_records", 0)
            if skipped:
                status = ThreadEvidenceStatus.PARTIAL.value
            for record in records:
                attributes = record.get("attributes")
                if (
                    record.get("session_id") != session_id
                    or record.get("name") != TRACE_RUNTIME_BOUND
                    or not isinstance(attributes, dict)
                    or attributes.get("runtime_id") != FEEDBACK_RUNTIME_ID
                ):
                    continue
                thread_id = attributes.get("vendor_thread_id")
                try:
                    if not isinstance(thread_id, str):
                        raise ValueError("invalid native thread identity")
                    uuid.UUID(thread_id)
                except ValueError:
                    status = ThreadEvidenceStatus.PARTIAL.value
                    continue
                if status == ThreadEvidenceStatus.UNAVAILABLE.value:
                    status = ThreadEvidenceStatus.COMPLETE.value
                if (
                    thread_id not in thread_ids
                    and len(thread_ids) >= MAX_FEEDBACK_EXECUTION_THREADS
                ):
                    return FeedbackThreadHistory(
                        tuple(thread_ids), ThreadEvidenceStatus.LIMIT_EXCEEDED.value
                    )
                thread_ids[thread_id] = None
        except (OSError, ValueError):
            status = ThreadEvidenceStatus.PARTIAL.value
    return FeedbackThreadHistory(tuple(thread_ids), status)


def _rollout_paths(thread_ids: tuple[str, ...]) -> dict[str, list[Path]]:
    matches: dict[str, list[Path]] = {
        thread_id: []
        for thread_id in thread_ids
        if thread_id and all(character.isalnum() or character in "-_" for character in thread_id)
    }
    try:
        root = CODEX_SESSIONS_DIR.resolve(strict=True)
        for path in CODEX_SESSIONS_DIR.rglob(ROLLOUT_GLOB):
            if (
                path.is_file()
                and not path.is_symlink()
                and path.resolve().is_relative_to(root)
                and not _is_forbidden(path)
            ):
                for thread_id, candidates in matches.items():
                    if path.name.endswith(f"-{thread_id}.jsonl"):
                        candidates.append(path)
    except OSError:
        logger.debug("feedback bundle could not scan %s", CODEX_SESSIONS_DIR)
    return matches


def _complete_jsonl_tail(path: Path) -> tuple[bytes, bool]:
    size = path.stat().st_size
    with path.open("rb") as source:
        clipped = size > LOG_TAIL_BYTES
        if clipped:
            source.seek(size - LOG_TAIL_BYTES)
        contents = source.read(LOG_TAIL_BYTES)
    if clipped:
        first_line = contents.find(b"\n")
        contents = contents[first_line + 1 :] if first_line >= 0 else b""
    if contents and not contents.endswith(b"\n"):
        last_line = contents.rfind(b"\n")
        contents = contents[: last_line + 1] if last_line >= 0 else b""
        clipped = True
    return contents, clipped


def _append_rollout(
    archive: zipfile.ZipFile,
    buffer: io.BytesIO,
    budget: int,
    thread_id: str,
    paths: list[Path],
    label: str,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "thread_id": thread_id,
        "status": ThreadEvidenceStatus.MISSING.value,
        "path": None,
    }
    if len(paths) > 1:
        entry["status"] = ThreadEvidenceStatus.AMBIGUOUS.value
        return entry
    if not paths:
        return entry
    try:
        contents, truncated = _complete_jsonl_tail(paths[0])
    except OSError:
        entry["status"] = ThreadEvidenceStatus.UNREADABLE.value
        return entry
    if not contents:
        entry["status"] = ThreadEvidenceStatus.UNREADABLE.value
        return entry
    remaining = budget - THREAD_TREE_MANIFEST_RESERVE - BUNDLE_BUDGET_RESERVE - buffer.tell()
    arcname = f"{label}/{paths[0].name}"
    if len(contents) + THREAD_ROLLOUT_HEADER_RESERVE > remaining or not _append_bytes_bounded(
        archive, contents, arcname, buffer, budget - THREAD_TREE_MANIFEST_RESERVE
    ):
        entry["status"] = ThreadEvidenceStatus.BUDGET_EXCLUDED.value
        return entry
    entry.update(
        status=(
            ThreadEvidenceStatus.TRUNCATED.value
            if truncated
            else ThreadEvidenceStatus.INCLUDED.value
        ),
        path=arcname,
        bytes=len(contents),
    )
    return entry


def _collect_files(root: Path) -> list[Path]:
    """List regular files under ``root``, newest first, skipping rebuildables."""

    try:
        entries = [path for path in root.rglob("*") if path.is_file()]
    except OSError:
        return []
    kept = [path for path in entries if path.suffix not in BUNDLE_EXCLUDED_SUFFIXES]

    def _mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    return sorted(kept, key=_mtime, reverse=True)


def build_log_bundle(
    *,
    include_trace: bool,
    session_id: str = "",
    vendor_thread_id: str = "",
    execution_threads: tuple[RuntimeExecutionThread, ...] = (),
    execution_tree_status: str = "unavailable",
    thread_history: FeedbackThreadHistory | None = None,
    recording_report: bytes = b"",
    renderer_diagnostics: bytes = b"",
    include_diagnostics: bool = True,
    budget: int = MAX_BUNDLE_SIZE,
) -> bytes:
    """Preserve the original bundle, then append optional bounded session evidence."""

    bundle = _build_log_bundle_contents(
        include_trace=include_trace,
        session_id=session_id,
        vendor_thread_id=vendor_thread_id,
        execution_threads=execution_threads,
        execution_tree_status=execution_tree_status,
        thread_history=thread_history,
        recording_report=recording_report,
        renderer_diagnostics=renderer_diagnostics,
        include_diagnostics=include_diagnostics,
        budget=budget,
    )
    if not include_trace or not session_id:
        return bundle
    summary = _session_error_summary(session_id)
    if not summary:
        return bundle
    candidate = io.BytesIO(bundle)
    with zipfile.ZipFile(candidate, "a", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(SESSION_ERROR_SUMMARY_ARCNAME, summary)
    if len(candidate.getvalue()) > budget:
        logger.info(
            "feedback session error summary omitted: session_id=%s reason=bundle_budget",
            session_id,
        )
        return bundle
    return candidate.getvalue()


def _session_error_summary(session_id: str) -> bytes:
    events: list[dict[str, Any]] = []
    trace_count = 0
    for path in session_trace_paths(session_id, TRACE_DIR):
        try:
            trace = TraceStore(path.parent, trace_file=path, offline=True)
            records = trace.session_events(session_id)
        except (OSError, ValueError) as error:
            logger.info("feedback session error summary unavailable: %s", type(error).__name__)
            continue
        trace_count += 1
        for record in records:
            name = record.get("name")
            attributes = record.get("attributes")
            if not isinstance(attributes, Mapping):
                continue
            location: dict[str, object] = {}
            span_id = record.get("span_id")
            if (
                isinstance(span_id, str)
                and len(span_id) == 32
                and span_id.isascii()
                and span_id.isalnum()
            ):
                location["span_id"] = span_id
            started_at = record.get("started_at")
            if isinstance(started_at, str) and len(started_at) <= 40 and started_at.isascii():
                location["started_at"] = started_at
            if name == SESSION_ERROR_SUMMARY_BRIDGE_EVENT:
                status = attributes.get("status_code")
                upstream_end = attributes.get("upstream_end")
                upstream = attributes.get("upstream")
                error_seen = isinstance(upstream, Mapping) and upstream.get("error_seen") is True
                rejected = (
                    isinstance(status, int)
                    and not isinstance(status, bool)
                    and 400 <= status <= 599
                )
                if (
                    rejected
                    or upstream_end in SESSION_ERROR_SUMMARY_FAILED_STREAM_ENDS
                    or error_seen
                ):
                    event: dict[str, object] = {"kind": "gateway_failure", **location}
                    if rejected:
                        event["http_status"] = status
                    if upstream_end in SESSION_ERROR_SUMMARY_FAILED_STREAM_ENDS:
                        event["upstream_end"] = upstream_end
                    if error_seen:
                        event["upstream_error_seen"] = True
                    events.append(event)
            elif isinstance(name, str) and name.startswith(SESSION_ERROR_SUMMARY_INCIDENT_PREFIX):
                event = {"kind": "runtime_incident", **location}
                for key in (
                    "incident_kind",
                    "incident_state",
                    "recovery_strategy",
                    "retryability",
                    "provider_error_code",
                ):
                    value = attributes.get(key)
                    if (
                        isinstance(value, str)
                        and value.isascii()
                        and value.replace("_", "").replace(".", "").isalnum()
                        and len(value) <= 64
                    ):
                        event[key] = value
                status = attributes.get("provider_http_status")
                if (
                    isinstance(status, int)
                    and not isinstance(status, bool)
                    and 400 <= status <= 599
                ):
                    event["http_status"] = status
                events.append(event)
            elif isinstance(name, str) and name.endswith(SESSION_ERROR_SUMMARY_TURN_SUFFIX):
                events.append({"kind": "turn_failed", **location})
    if not events:
        return b""
    total_events = len(events)
    events = events[-SESSION_ERROR_SUMMARY_EVENTS:]
    while events:
        summary = json.dumps(
            {
                "version": SESSION_ERROR_SUMMARY_VERSION,
                "session_id": session_id,
                "trace_files": trace_count,
                "matching_events": total_events,
                "truncated": len(events) < total_events,
                "events": events,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(summary) <= SESSION_ERROR_SUMMARY_MAX_BYTES:
            return summary
        events.pop(0)
    return b""


def _build_log_bundle_contents(
    *,
    include_trace: bool,
    session_id: str = "",
    vendor_thread_id: str = "",
    execution_threads: tuple[RuntimeExecutionThread, ...] = (),
    execution_tree_status: str = "unavailable",
    thread_history: FeedbackThreadHistory | None = None,
    recording_report: bytes = b"",
    renderer_diagnostics: bytes = b"",
    include_diagnostics: bool = True,
    budget: int = MAX_BUNDLE_SIZE,
) -> bytes:
    """Zip the local diagnostic logs, newest first, under a size budget.

    Post-condition: ``len(result) <= budget``. 预算在**写入过程中**逐块判定, 所以单个
    超大文件也冲不破 —— 它会被写到一半就停, 而不是整份写进去。早先的实现只在
    追加前查 buffer.tell(), backend.log / system.log 各自可能 50MB, 压缩率差的 trace
    一条就能把 40MB 预算捐穿; 后果还是静默的 —— 服务端超 60MB 就跳过日志包,
    但仍返回 ok=true, 用户看到「已收到」而日志其实没上去。

    截断语义: 单个文件最多取末尾 ``LOG_TAIL_BYTES`` 原文 (包内全是 append-only
    日志, 尾巴才是刚发生的那段); 预算耗尽时当前条目会是不完整的 (jsonl 末行
    可能被切半), 后续文件整体不再入包。

    Newest-first matters: a report is about something that just happened, so when
    the budget runs out the oldest files are the ones worth dropping. 判定走**已压缩**
    字节数, 因为那才是服务端卡的那个数。

    对话记录排在诊断日志**之前**写: 它是本次排障里信息密度最高的一份, 不能被
    一堆历史诊断文件把预算吃完后挤出去。
    """

    buffer = io.BytesIO()
    archive = zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED)
    try:
        if include_diagnostics:
            source = os.environ.get(SOURCE_BASELINE_ENV, "")
            if source and len(source.encode("utf-8")) <= SOURCE_BASELINE_MAX_BYTES:
                try:
                    identity = json.loads(source)
                except ValueError:
                    identity = None
                if (
                    isinstance(identity, dict)
                    and identity.get("runtime_kind") == "local_dev"
                    and identity.get("schema_version") == 1
                ):
                    contents = json.dumps(identity, ensure_ascii=False).encode("utf-8")
                    if not _append_bytes_bounded(
                        archive, contents, SOURCE_BASELINE_ARCNAME, buffer, budget
                    ):
                        return _finish(archive, buffer)
        if include_diagnostics:
            for arcname, contents in collect_sandbox_diagnostics(CODEX_RUNTIME_HOME, budget // 4):
                if not _append_bytes_bounded(archive, contents, arcname, buffer, budget):
                    return _finish(archive, buffer)
        if include_diagnostics:
            for arcname, contents in collect_update_diagnostics(
                UPDATE_LOG, min(budget // 4, UPDATE_DIAGNOSTICS_BUDGET)
            ):
                if not _append_bytes_bounded(archive, contents, arcname, buffer, budget):
                    return _finish(archive, buffer)
        if recording_report:
            if not _append_bytes_bounded(
                archive,
                recording_report,
                RECORDING_REPORT_ARCNAME,
                buffer,
                budget,
            ):
                return _finish(archive, buffer)
        if renderer_diagnostics:
            if not _append_bytes_bounded(
                archive,
                renderer_diagnostics,
                RENDERER_DIAGNOSTICS_ARCNAME,
                buffer,
                budget,
            ):
                return _finish(archive, buffer)
        conversation_exhausted = False
        if include_trace:
            for path in session_trace_paths(session_id, TRACE_DIR):
                arcname = f"{CONVERSATION_LABEL}/{path.name}"
                if not _append_bounded(
                    archive, path, arcname, buffer, budget - THREAD_TREE_MANIFEST_RESERVE
                ):
                    conversation_exhausted = True
                    break
            history = thread_history or session_thread_history(session_id, vendor_thread_id)
            if session_id and history.thread_ids:
                roots = tuple(dict.fromkeys(history.thread_ids))[:MAX_FEEDBACK_EXECUTION_THREADS]
                nodes = tuple(
                    {
                        node.thread_id: node
                        for node in execution_threads
                        if node.thread_id not in roots
                    }.values()
                )[:MAX_FEEDBACK_EXECUTION_THREADS]
                paths = _rollout_paths((*roots, *(node.thread_id for node in nodes)))
                root_records = [
                    _append_rollout(
                        archive,
                        buffer,
                        budget,
                        thread_id,
                        paths.get(thread_id, []),
                        CONVERSATION_LABEL,
                    )
                    for thread_id in roots
                ]
                records: list[dict[str, Any]] = []
                for node in nodes:
                    entry = _append_rollout(
                        archive,
                        buffer,
                        budget,
                        node.thread_id,
                        paths.get(node.thread_id, []),
                        f"{SUBAGENT_LABEL}/{node.thread_id}",
                    )
                    entry["parent_thread_id"] = node.parent_thread_id
                    records.append(entry)
                manifest = json.dumps(
                    {
                        "schema_version": THREAD_TREE_SCHEMA_VERSION,
                        "session_id": session_id,
                        "root_thread_id": vendor_thread_id,
                        "history_discovery_status": history.discovery_status,
                        "root_threads": root_records,
                        "discovery_status": execution_tree_status,
                        "threads": records,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
                if not _append_bytes_bounded(
                    archive, manifest, THREAD_TREE_ARCNAME, buffer, budget
                ):
                    conversation_exhausted = True
                else:
                    logger.info(
                        "feedback execution tree bundled status=%s included=%d total=%d",
                        execution_tree_status,
                        sum(entry["path"] is not None for entry in records),
                        len(records),
                    )
        if include_diagnostics and not conversation_exhausted:
            for label, single in (
                (WINDOW_LOG_LABEL, WINDOW_LOG),
                (BACKEND_LOG_LABEL, BACKEND_LOG),
                (SYSTEM_LOG_LABEL, SYSTEM_LOG),
            ):
                if single.is_file():
                    arcname = f"{label}/{single.name}"
                    if not _append_bounded(archive, single, arcname, buffer, budget):
                        return _finish(archive, buffer)
            for label, root in _bundle_candidates():
                for path in _collect_files(root):
                    try:
                        arcname = f"{label}/{path.relative_to(root).as_posix()}"
                    except ValueError:
                        arcname = f"{label}/{path.name}"
                    if not _append_bounded(archive, path, arcname, buffer, budget):
                        return _finish(archive, buffer)
    finally:
        archive.close()
    return buffer.getvalue()


def _append_bytes_bounded(
    archive: zipfile.ZipFile,
    contents: bytes,
    arcname: str,
    buffer: io.BytesIO,
    budget: int,
) -> bool:
    """Write one bounded in-memory artifact without exceeding the archive budget."""

    limit = budget - BUNDLE_BUDGET_RESERVE
    remaining = limit - buffer.tell()
    if remaining <= 0 or len(contents) > remaining:
        return False
    with archive.open(arcname, "w") as target:
        offset = 0
        while offset < len(contents):
            chunk = contents[offset : offset + min(BUNDLE_CHUNK_BYTES, remaining - offset)]
            if not chunk:
                return False
            target.write(chunk)
            offset += len(chunk)
            if offset >= remaining or buffer.tell() >= limit:
                return offset >= len(contents)
    return True


def _append_bounded(
    archive: zipfile.ZipFile,
    path: Path,
    arcname: str,
    buffer: io.BytesIO,
    budget: int,
) -> bool:
    """Stream one file in, stopping the instant the archive would pass ``budget``.

    上界是**结构性**的, 不靠压缩器的 flush 时机: 除了每块查一次已压字节数,
    还把本条目能吃的**原文**字节数卡在剩余预算以内 —— deflate 的输出不会超过
    输入 (不可压数据最多微幅膨胀, 由 RESERVE 吸掉), 所以先到哪道线都安全。
    光靠 buffer.tell() 是不够的: 它比实际已压字节数滞后一个压缩器缓冲区的量,
    实测会让 1MB 预算超出 456 字节。

    Returns False only when the budget is exhausted —— 调用方据此停掉整包。单个
    文件读不动 (轮转走了 / 被锁住) 返回 True: 用户正在报障, 不能因为一份日志
    没读到就连其他证据一起丢。
    """

    limit = budget - BUNDLE_BUDGET_RESERVE
    remaining = limit - buffer.tell()
    if remaining <= 0:
        logger.info("feedback bundle budget reached before %s", arcname)
        return False
    try:
        size = path.stat().st_size
        with path.open("rb") as source:
            if size > LOG_TAIL_BYTES:
                source.seek(size - LOG_TAIL_BYTES)
            fed = 0
            with archive.open(arcname, "w") as target:
                while True:
                    chunk = source.read(min(BUNDLE_CHUNK_BYTES, remaining - fed))
                    if not chunk:
                        return True
                    target.write(chunk)
                    fed += len(chunk)
                    if fed >= remaining or buffer.tell() >= limit:
                        logger.info("feedback bundle budget reached inside %s", arcname)
                        return False
    except (OSError, ValueError) as exc:
        logger.debug("feedback bundle skipped %s: %s", path, exc)
        return True


def _finish(archive: zipfile.ZipFile, buffer: io.BytesIO) -> bytes:
    """Close the archive early (budget exhausted) and return its bytes."""

    archive.close()
    return buffer.getvalue()


class FeedbackService:
    """Assemble a problem report and hand it to Damoclaw-Server."""

    def __init__(
        self,
        *,
        base_url: str = "",
        client: Optional[OutboundClient] = None,
        environ: Optional[Mapping[str, str]] = None,
        bundle_builder: Optional[Any] = None,
    ) -> None:
        self._environ = os.environ if environ is None else environ
        self._base_url = (base_url or resolve_base_url(environ=self._environ)).rstrip("/")
        # 契约测注入 stub client / builder: 上报路径不能靠真网络和真日志目录来验。
        self._client = client if client is not None else httpx.Client(timeout=HTTP_TIMEOUT_S)
        self._bundle_builder = bundle_builder or build_log_bundle

    @property
    def base_url(self) -> str:
        """Expose the resolved endpoint (diagnostics/tests read this)."""

        return self._base_url

    def submit(self, submission: FeedbackSubmission) -> FeedbackResult:
        """Validate, package and forward one report."""

        description = submission.description.strip()
        if not description:
            raise FeedbackValidationError("description is required")
        if len(description) > DESCRIPTION_MAX:
            raise FeedbackValidationError(f"description exceeds {DESCRIPTION_MAX} characters")
        images = tuple(submission.images)
        if len(images) > MAX_IMAGES:
            raise FeedbackValidationError(f"at most {MAX_IMAGES} images")
        total = 0
        for image in images:
            if len(image.data) > MAX_IMAGE_SIZE:
                raise FeedbackValidationError(f"image {image.filename} exceeds 20MB")
            total += len(image.data)
        if total > MAX_IMAGES_TOTAL_SIZE:
            raise FeedbackValidationError(
                f"images exceed {MAX_IMAGES_TOTAL_SIZE // (1024 * 1024)}MB in total"
            )
        recording_report = bytes(submission.recording_report)
        if len(recording_report) > MAX_RECORDING_REPORT_SIZE:
            raise FeedbackValidationError("recording report exceeds 2MB")
        renderer_diagnostics = bytes(submission.renderer_diagnostics)
        if len(renderer_diagnostics) > MAX_RECORDING_REPORT_SIZE:
            raise FeedbackValidationError("renderer diagnostics exceed 2MB")

        data = {"description": description}
        version = client_version(self._environ)
        platform_name = client_platform()
        # 空串不进表单: 服务端把它当 "" 落库, 管理台就分不清「用户没填」和
        # 「填了个空」。缺席才是 NULL。
        for key, value in (
            ("email", submission.email),
            ("client_version", version),
            ("client_platform", platform_name),
            ("client_arch", client_arch()),
        ):
            cleaned = str(value or "").strip()
            if cleaned:
                data[key] = cleaned

        files: list[tuple[str, tuple[str, bytes, str]]] = [
            ("images", (image.filename, image.data, image.content_type)) for image in images
        ]
        bundle = b""
        if submission.include_logs or recording_report or renderer_diagnostics:
            bundle = self.build_bundle(submission)
            if bundle:
                data["attach_logs"] = "true"
                name = bundle_filename(platform_name=platform_name, version=version)
                files.append(("logs_bundle", (name, bundle, BUNDLE_MEDIA_TYPE)))

        # 归属的唯一依据。上游拿它去账号服务机器面换回 user_id; 缺席就落成匿名。
        # key 只进请求头, 不进任何日志。
        key = str(submission.api_key or "").strip()
        headers = {"Authorization": f"Bearer {key}"} if key else None

        try:
            response = self._client.post(
                self._base_url + SUBMIT_PATH,
                data=data,
                files=files or None,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            logger.warning("feedback submit unreachable: %s", exc)
            return FeedbackResult(ok=False, error=str(exc), bundle_bytes=len(bundle))

        if response.status_code >= 400:
            logger.warning("feedback submit -> HTTP %s", response.status_code)
            return FeedbackResult(
                ok=False,
                error=_error_detail(response),
                status_code=response.status_code,
                bundle_bytes=len(bundle),
            )
        payload = _json_object(response)
        return FeedbackResult(
            ok=bool(payload.get("ok", True)),
            feedback_id=str(payload.get("id", "") or ""),
            status_code=response.status_code,
            bundle_bytes=len(bundle),
        )

    def build_bundle(self, submission: FeedbackSubmission) -> bytes:
        return self._bundle_builder(
            include_trace=submission.include_trace and submission.include_logs,
            session_id=submission.session_id,
            vendor_thread_id=submission.vendor_thread_id,
            execution_threads=submission.execution_threads,
            execution_tree_status=submission.execution_tree_status,
            thread_history=submission.thread_history,
            recording_report=submission.recording_report,
            renderer_diagnostics=submission.renderer_diagnostics,
            include_diagnostics=submission.include_logs,
        )

    def close(self) -> None:
        """Release the outbound HTTP client."""

        self._client.close()


def _json_object(response: httpx.Response) -> dict[str, Any]:
    """Decode a JSON object body, tolerating a non-JSON upstream reply."""

    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _error_detail(response: httpx.Response) -> str:
    """Project the upstream error into one human-readable line."""

    detail = _json_object(response).get("detail")
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    return f"HTTP {response.status_code}"


__all__ = [
    "MAX_BUNDLE_SIZE",
    "MAX_IMAGES",
    "MAX_IMAGES_TOTAL_SIZE",
    "MAX_IMAGE_SIZE",
    "MAX_RECORDING_REPORT_SIZE",
    "RENDERER_DIAGNOSTICS_ARCNAME",
    "FeedbackImage",
    "FeedbackResult",
    "FeedbackService",
    "FeedbackSubmission",
    "FeedbackValidationError",
    "OutboundClient",
    "build_log_bundle",
    "bundle_filename",
    "resolve_base_url",
]
