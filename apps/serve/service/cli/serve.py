"""`scholarseed serve` and its native-Codex headless reference client."""

# Composition-root exception (see `apply_runtime_defaults()` below): the product home must
# land before damoagent is imported, so the remaining imports stay after that call and the
# `service.*` block is necessarily split by it.
# pylint: disable=wrong-import-position,ungrouped-imports

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import httpx
import uvicorn
from fastapi import FastAPI

from scholarseed_runtime.contract.resource import RESOURCE_LIFECYCLE_LOGGER

# 书深运行时根默认值必须在 import damoagent 之前落地: Agent 层的路径常量在 import 时
# 即按 .scholarseed 求值。这是 composition root 的既定例外, 故此处 import 顺序被显式豁免。
from service.brand import apply_runtime_defaults  # noqa: E402
from service.cli.utils import startup_checkpoint
from service.trust import apply_system_trust_store  # noqa: E402

startup_checkpoint("serve.dependencies_ready")
apply_runtime_defaults()
# 同理属于组合根例外: 注入是替换 ssl.SSLContext, 只有早于第一条出站 TLS 连接才生效。
apply_system_trust_store()
startup_checkpoint("serve.defaults_ready")

from service.bootstrap import (  # noqa: E402
    PRODUCT_ALL,
    PRODUCT_CHOICES,
    create_app,
)

startup_checkpoint("serve.bootstrap_imported")
from service.chat.constants import (  # noqa: E402
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_RUNTIME_ERROR,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
)
from service.chat.runtime.selection import RuntimeDiscovery  # noqa: E402
from service.identity.service.account import ACCOUNT_BASE_URL_ENV, ACCOUNT_MODE  # noqa: E402
from service.identity.service.policy import (  # noqa: E402
    AUTH_MODE_AUTO,
    AUTH_MODE_CHOICES,
    AUTH_MODE_OFF,
)
from service.identity.utils import (  # noqa: E402
    OWNERSHIP_AXIS_CHOICES,
    OWNERSHIP_AXIS_DEFAULT,
    OWNERSHIP_AXIS_ENV,
    resolve_ownership_axis,
)
from service.paths import SERVICE_BRIDGE_DIR, SERVICE_CASES_DIR  # noqa: E402
from service.platform.activity import Activities, ActivityDomain  # noqa: E402
from service.platform.executables import (  # noqa: E402
    SKILL_PYTHON_COMMAND,
    SKILL_PYTHON_PROBE_ARGUMENTS,
    SKILL_PYTHON_PROBE_TIMEOUT_SECONDS,
    command_directories,
    probe_command,
    resolve_command,
)
from service.platform.parent_control import ParentControl  # noqa: E402
from service.platform.server import ProductServer  # noqa: E402
from service.platform.shutdown import DEFAULT_SHUTDOWN_SECONDS  # noqa: E402
from service.platform.startup import startup_phase  # noqa: E402
from service.platform.toolchain import ToolchainReadiness  # noqa: E402
from service.platform.vocabulary import INTERNAL_BASE_URL_ENV  # noqa: E402

startup_checkpoint("serve.imports_ready")


def _find_skill_python_launcher() -> Path | None:
    return next(
        (
            candidate
            for directory in command_directories()
            if (candidate := resolve_command(SKILL_PYTHON_COMMAND, directory)) is not None
            and probe_command(
                candidate,
                SKILL_PYTHON_PROBE_ARGUMENTS,
                timeout_seconds=SKILL_PYTHON_PROBE_TIMEOUT_SECONDS,
            )
        ),
        None,
    )


async def _ensure_skill_python_path(activities: Activities) -> None:
    with startup_phase("entry.skill_python"):
        launcher = await activities.finish(
            ActivityDomain.STARTUP,
            lambda: activities.to_thread(ActivityDomain.STARTUP, _find_skill_python_launcher),
        )
    if launcher is None:
        return
    directory = str(launcher.parent)
    inherited = os.environ.get("PATH", "")
    normalized_directory = os.path.normcase(os.path.abspath(directory))
    entries = [
        entry
        for entry in inherited.split(os.pathsep)
        if entry and os.path.normcase(os.path.abspath(entry)) != normalized_directory
    ]
    os.environ["PATH"] = os.pathsep.join((directory, *entries))


def _prepare_startup(app: FastAPI, skill_python: ToolchainReadiness | None = None) -> None:
    previous_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        runtime = application.state.runtime_service
        runtime.schedule_readiness()
        try:
            if skill_python is None:
                await _ensure_skill_python_path(application.state.activities)
            else:
                with startup_phase("entry.skill_python_receipt"):
                    await skill_python.wait()
            async with previous_lifespan(application):
                yield
        finally:
            await runtime.stop_readiness()

    app.router.lifespan_context = lifespan


AUTH_MODE_ENV = "SCHOLARSEED_AUTH_MODE"
SERVER_LOG_LEVEL_CHOICES = ("critical", "error", "warning", "info", "debug", "trace")
SERVER_LOG_LEVEL_ENV = "SCHOLARSEED_LOG_LEVEL"
DESKTOP_ENV = "SCHOLARSEED_DESKTOP"
DEFAULT_SERVER_LOG_LEVEL = "info"
DESKTOP_SERVER_LOG_LEVEL = "debug"
SERVICE_LOGGER_NAMESPACE = "service"
# Codex adapter 命名空间：其 INFO 诊断（codex_provider_error / codex_turn_failed 等）默认被
# root=WARNING 过滤，backend.log 里 0 行，线上无法离线归因（proposal 106 R5）。与 service
# 同档放行，使供应商拒绝/重试的归因证据进 backend 包。
CODEX_LOGGER_NAMESPACE = "scholarseed_codex"
SERVICE_LOG_LEVELS = {
    "critical": logging.CRITICAL,
    "error": logging.ERROR,
    "warning": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
    "trace": logging.DEBUG,
}
TRACE_SERVER_LOG_LEVEL = "trace"
AUTO_APPROVE_OPTION_IDS = (
    "allow",
    "accept",
    "allow_once",
    "accept_once",
    "approved",
)
AUTO_DECLINE_OPTION_IDS = ("deny", "decline", "cancel")


def _server_log_level(cli_value: str | None) -> str:
    if cli_value in SERVER_LOG_LEVEL_CHOICES:
        return cli_value
    env_value = os.environ.get(SERVER_LOG_LEVEL_ENV, "").strip().lower()
    if env_value in SERVER_LOG_LEVEL_CHOICES:
        return env_value
    if os.environ.get(DESKTOP_ENV, ""):
        return DESKTOP_SERVER_LOG_LEVEL
    return DEFAULT_SERVER_LOG_LEVEL


def _configure_resource_logging(log_level: str) -> None:
    """Expose safe resource events without increasing third-party or Trace verbosity."""
    resource_logger = logging.getLogger(RESOURCE_LIFECYCLE_LOGGER)
    if resource_logger.level == logging.NOTSET:
        resource_logger.setLevel(
            logging.DEBUG if log_level == TRACE_SERVER_LOG_LEVEL else log_level.upper()
        )
    # basicConfig keeps existing hosting handlers and leaves the root level unchanged.
    logging.basicConfig()
    logging.getLogger("service.platform.shutdown").setLevel(logging.INFO)


TRACEBACK_MARKER = "Traceback (most recent call last):"


def _is_shutdown_cancellation(record: logging.LogRecord) -> bool:
    """True when a record only reports SIGINT cancelling the ASGI lifespan task.

    watchfiles stops the dev server with SIGINT; a second signal cancels the lifespan
    task while Starlette's ``Router.lifespan`` is blocked on its shutdown ``receive()``.
    Starlette formats that ``CancelledError`` into a traceback string and ships it as a
    ``lifespan.shutdown.failed`` message, which uvicorn logs verbatim on ``uvicorn.error``
    with no ``exc_info`` (``LifespanOn.send``).  Recognize both that string shape and an
    ``exc_info`` ``CancelledError`` so the expected shutdown stays quiet while every
    genuine lifespan failure (e.g. a startup ``OSError``) is preserved.
    """
    if record.exc_info is not None:
        return isinstance(record.exc_info[1], asyncio.CancelledError)
    message = record.getMessage()
    if TRACEBACK_MARKER not in message:
        return False
    last_line = next((line for line in reversed(message.splitlines()) if line.strip()), "")
    exc_name = last_line.split(":", 1)[0].strip().rsplit(".", 1)[-1]
    return exc_name == asyncio.CancelledError.__name__


def serve_main(argv: Optional[List[str]] = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    if argv and argv[0] == "client":
        return _client_main(argv[1:])

    arguments_started = time.monotonic()
    ap = argparse.ArgumentParser(prog="scholarseed-serve")
    ap.add_argument(
        "--host", default="127.0.0.1"
    )  # dev/单机安全默认; 对外部署显式给 --host (rerun-2 P2 归类)
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--cases-root", default=str(SERVICE_CASES_DIR))
    ap.add_argument("--renderer-dist", default="")
    ap.add_argument("--office-root", default="")
    ap.add_argument(
        "--shutdown-timeout-seconds",
        type=float,
        default=DEFAULT_SHUTDOWN_SECONDS,
        help="total product shutdown budget shared by HTTP and resource owners",
    )
    ap.add_argument(
        "--parent-control",
        action="store_true",
        help="accept a private launcher bootstrap through inherited stdin",
    )
    ap.add_argument(
        "--parent-stdin",
        action="store_true",
        help="stop normally when the owning launcher's stdin pipe closes",
    )
    ap.add_argument("--await-toolchain", action="store_true")
    ap.add_argument("--await-skill-python", action="store_true")
    ap.add_argument(
        "--product",
        choices=PRODUCT_CHOICES,
        default=PRODUCT_ALL,
        help="product route set to expose (all or chat)",
    )
    ap.add_argument(
        "--log-level",
        choices=SERVER_LOG_LEVEL_CHOICES,
        default=None,
        help="uvicorn log level (desktop defaults to debug)",
    )
    ap.add_argument(
        "--auth-mode",
        choices=AUTH_MODE_CHOICES,
        default=None,
        help=f"认证模式: {'|'.join(AUTH_MODE_CHOICES)} (默认 auto)",
    )
    ap.add_argument(
        "--ownership-axis",
        choices=OWNERSHIP_AXIS_CHOICES,
        default=None,
        help=(
            "本地数据归属: machine (同机各账号互通, 桌面端) | principal (按账号隔离)。"
            f"默认 {OWNERSHIP_AXIS_DEFAULT} —— 对外部署不要改"
        ),
    )
    auth_grp = ap.add_mutually_exclusive_group()
    auth_grp.add_argument(
        "--auth", action="store_true", help="强制开启认证 (等价 --auth-mode local)"
    )
    auth_grp.add_argument(
        "--no-auth", action="store_true", help="强制关闭认证 (等价 --auth-mode off)"
    )
    args = ap.parse_args(argv)
    if args.await_toolchain and not (args.parent_control and args.parent_stdin):
        ap.error("--await-toolchain requires private parent control and parent stdin")
    if args.await_skill_python and not (args.parent_control and args.parent_stdin):
        ap.error("--await-skill-python requires private parent control and parent stdin")
    log_level = _server_log_level(args.log_level)
    # Uvicorn configures only its own loggers. Keep product diagnostics visible
    # without enabling third-party HTTP logs, whose URLs can contain credentials.
    logging.basicConfig()
    logging.getLogger(SERVICE_LOGGER_NAMESPACE).setLevel(SERVICE_LOG_LEVELS[log_level])
    logging.getLogger(CODEX_LOGGER_NAMESPACE).setLevel(SERVICE_LOG_LEVELS[log_level])
    _configure_resource_logging(log_level)
    logging.getLogger(SERVICE_LOGGER_NAMESPACE).info(
        "startup_phase phase=entry.arguments event=finished pid=%s elapsed_seconds=%.6f",
        os.getpid(),
        time.monotonic() - arguments_started,
    )

    # ── 解析 auth_mode (优先级: --auth-mode > --auth/--no-auth > SCHOLARSEED_AUTH_MODE > auto) ──
    if args.auth_mode is not None:
        auth_mode = args.auth_mode
    elif args.auth:
        auth_mode = "local"
    elif args.no_auth:
        auth_mode = AUTH_MODE_OFF
    else:
        env_mode = os.environ.get(AUTH_MODE_ENV, "").strip().lower()
        if env_mode and env_mode not in AUTH_MODE_CHOICES:
            ap.error(f"{AUTH_MODE_ENV} must be one of {', '.join(AUTH_MODE_CHOICES)}")
        auth_mode = env_mode or AUTH_MODE_AUTO

    ownership_axis = resolve_ownership_axis(
        args.ownership_axis,
        os.environ.get(OWNERSHIP_AXIS_ENV, ""),
    )

    dist = Path(args.renderer_dist) if args.renderer_dist else None
    # 选了账号线却没给账号服务地址: 每个账号令牌都会验不过, 表现成"登录成功但立刻 401"。
    # 这里必须吵出来, 不能静默降级成别的模式。
    if auth_mode == ACCOUNT_MODE and not os.environ.get(ACCOUNT_BASE_URL_ENV, "").strip():
        print(
            f"[scholarseed serve] WARN auth_mode={ACCOUNT_MODE} 但未配 ${ACCOUNT_BASE_URL_ENV}"
            " — 账号服务令牌一律验不过",
            file=sys.stderr,
        )
    # Launcher execution belongs to the local server, after argument/policy
    # validation. Help, usage errors and the HTTP-only client must not probe it.
    with startup_phase("entry.runtime_discovery"):
        runtime_discovery = RuntimeDiscovery.discover()
    bridge_host = "127.0.0.1" if args.host in {"0.0.0.0", "::"} else args.host
    os.environ[INTERNAL_BASE_URL_ENV] = f"http://{bridge_host}:{args.port}"
    app = create_app(
        None,
        cases_root=Path(args.cases_root),
        product=args.product,
        renderer_dist=str(dist) if dist else "",
        office_root=args.office_root,
        auth_mode=auth_mode,
        ownership_axis=ownership_axis,
        local_bridge_root=SERVICE_BRIDGE_DIR,
        runtime_discovery=runtime_discovery,
    )
    if args.await_toolchain:
        app.state.runtime_service.toolchain.defer()
    skill_python = ToolchainReadiness() if args.await_skill_python else None
    if skill_python is not None:
        skill_python.defer()
    _prepare_startup(app, skill_python)
    auth_enabled = app.state.auth_enabled
    print(
        f"[scholarseed serve] http://{args.host}:{args.port}  "
        f"workspace={app.state.workspace}  renderer={'dist' if dist else 'none'}",
        file=sys.stderr,
    )
    print(
        f"[scholarseed serve] auth_mode={auth_mode} auth={'on' if auth_enabled else 'off'} "
        f"ownership_axis={ownership_axis} "
        f"log_level={log_level} product={args.product}",
        file=sys.stderr,
    )

    # 精确过滤 /api/healthz 的 uvicorn access log
    class _HealthzAccessFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            return "/api/healthz" not in record.getMessage()

    logging.getLogger("uvicorn.access").addFilter(_HealthzAccessFilter())

    # watchfiles stops the dev server with SIGINT; a second signal cancels the lifespan
    # task mid-shutdown and Starlette/uvicorn surface that expected cancellation as an
    # ERROR traceback on "uvicorn.error".  Drop only that record and keep every genuine
    # lifespan failure.  See _is_shutdown_cancellation for the exact record shapes.
    class _LifespanCancelFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            return not _is_shutdown_cancellation(record)

    logging.getLogger("uvicorn.error").addFilter(_LifespanCancelFilter())
    ProductServer(
        uvicorn.Config(app, host=args.host, port=args.port, log_level=log_level),
        app.state.activities,
        domains=app.state.storage_domains,
        parent_stdin=args.parent_stdin,
        shutdown_seconds=args.shutdown_timeout_seconds,
        close_model_streams=app.state.completion_bridge.close,
        parent_control=(
            ParentControl(
                app.state.activities,
                interrupt_running=app.state.session_service.interrupt_running_for_update,
                drain_attachments=app.state.runtime_service.drain_for_update,
                prepare_update=app.state.session_service.prepare_for_update_shutdown,
                resume_update=app.state.session_service.resume_after_update_shutdown,
                toolchain_complete=(
                    app.state.runtime_service.toolchain.complete if args.await_toolchain else None
                ),
                skill_python_complete=skill_python.complete if skill_python is not None else None,
            )
            if args.parent_control
            else None
        ),
    ).run()
    return 0


def _client_main(argv: List[str]) -> int:
    """Drive the public native-Codex open → SSE → typed-turn path."""

    ap = argparse.ArgumentParser(prog="scholarseed serve client")
    ap.add_argument(
        "--url", default="http://127.0.0.1:8770", help="running `scholarseed serve` base url"
    )
    ap.add_argument("--resume", default="", help="resume a product session id")
    ap.add_argument("--message", required=True)
    ap.add_argument(
        "--auto-allow",
        action="store_true",
        help="answer real Codex approval requests for unattended smoke tests",
    )
    args = ap.parse_args(argv)
    base = args.url.rstrip("/")

    if args.resume:
        body = {"resume_session_id": args.resume}
    else:
        body = {}
    opened = httpx.post(f"{base}/api/serve/sessions/open", json=body, timeout=120)
    if opened.is_error:
        print(f"[client] session open failed: {opened.text}", file=sys.stderr)
        return 1
    opened_payload = opened.json()
    sid = opened_payload["session_id"]
    print(
        f"[client] opened session={sid} runtime={opened_payload.get('runtime_id')} "
        f"resumed={opened_payload.get('resumed')} last_seq={opened_payload.get('last_seq')}",
        file=sys.stderr,
    )

    final_text = {"v": ""}
    done = {"v": False}
    failure = {"v": ""}
    answered = set()

    def choose_option(data: dict[str, object]) -> str:
        raw_options = data.get("options")
        options = (
            [row for row in raw_options if isinstance(row, dict)]
            if isinstance(raw_options, list)
            else []
        )
        preferred = AUTO_APPROVE_OPTION_IDS if args.auto_allow else AUTO_DECLINE_OPTION_IDS
        for option_id in preferred:
            for option in options:
                if str(option.get("id") or "").lower() == option_id:
                    return str(option.get("id") or "")
        if options:
            return str(options[0].get("id") or options[0].get("value") or "")
        return "allow" if args.auto_allow else "deny"

    def answer_questions(data: dict[str, object]) -> dict[str, str]:
        answers: dict[str, str] = {}
        raw_questions = data.get("questions")
        questions = (
            [row for row in raw_questions if isinstance(row, dict)]
            if isinstance(raw_questions, list)
            else []
        )
        for question in questions:
            question_id = str(
                question.get("id") or question.get("header") or question.get("question") or ""
            )
            if not question_id:
                continue
            options = [row for row in list(question.get("options") or []) if isinstance(row, dict)]
            selected = options[0] if options else {}
            answers[question_id] = str(
                selected.get("value") or selected.get("label") or selected.get("id") or ""
            )
        return answers

    def reader() -> None:
        with httpx.stream(
            "GET",
            (
                f"{base}/api/serve/sessions/{sid}/events"
                f"?from_seq={int(opened_payload.get('last_seq') or 0)}"
            ),
            timeout=600,
        ) as s:
            for line in s.iter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    f = json.loads(line[5:].strip())
                except Exception:
                    continue
                event_type = f.get("type")
                data = f.get("data") or {}
                if not isinstance(data, dict):
                    data = {}
                if event_type == PRODUCT_EVENT_MESSAGE_DELTA:
                    final_text["v"] += str(data.get("delta") or "")
                elif event_type == PRODUCT_EVENT_TOOL_STARTED:
                    print(
                        f"[client]   ⚙ {data.get('name')} "
                        f"{json.dumps(data.get('input', {}), ensure_ascii=False)[:80]}",
                        file=sys.stderr,
                    )
                elif event_type == PRODUCT_EVENT_HIL_REQUESTED:
                    rid = str(data.get("request_id") or "")
                    print(
                        f"[client]   🛡 HIL {data.get('kind')} {data.get('tool_name')} req={rid}",
                        file=sys.stderr,
                    )
                    if rid and rid not in answered:
                        answered.add(rid)
                        response = (
                            {"answers": answer_questions(data)}
                            if str(data.get("kind") or "") == "question"
                            else {"option_id": choose_option(data)}
                        )
                        resolved = httpx.post(
                            f"{base}/api/serve/sessions/{sid}/hil/{rid}",
                            json={**response, "state_version": data.get("state_version", 1)},
                            timeout=30,
                        )
                        if resolved.is_error:
                            failure["v"] = f"HIL response failed: {resolved.text}"
                            return
                elif event_type == PRODUCT_EVENT_TURN_COMPLETED:
                    done["v"] = True
                    return
                elif event_type in {
                    PRODUCT_EVENT_TURN_FAILED,
                    PRODUCT_EVENT_TURN_INTERRUPTED,
                    PRODUCT_EVENT_RUNTIME_ERROR,
                }:
                    failure["v"] = str(data.get("message") or data.get("reason") or "turn failed")
                    return

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    time.sleep(0.8)
    posted = httpx.post(
        f"{base}/api/serve/sessions/{sid}/turns",
        json={"input": [{"type": "text", "text": args.message}], "wait": False},
        timeout=120,
    )
    if posted.is_error:
        print(f"[client] turn failed: {posted.text}", file=sys.stderr)
        return 1
    r = posted.json()
    print(f"[client] turn queued turn_id={r.get('turn_id')}", file=sys.stderr)
    t0 = time.time()
    while not done["v"] and time.time() - t0 < 300:
        time.sleep(0.5)
    print("─── final text (via SSE) ───")
    print(final_text["v"].strip())
    if failure["v"]:
        print(f"[client] turn failed: {failure['v']}", file=sys.stderr)
        return 1
    return 0 if done["v"] else 1


__all__ = ["serve_main"]


if __name__ == "__main__":  # `python -m service.cli.serve` (desktop app / CI spawn)
    raise SystemExit(serve_main())
