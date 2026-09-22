"""Product runtime executable ownership."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from typing import Mapping

from scholarseed_codex.profile import (
    CODEX_ALLOW_DEVELOPMENT_VERSION_ENV,
    CODEX_ALLOW_UNTESTED_NEWER,
    CODEX_DEVELOPMENT_VERSION,
    CODEX_ENV_TRUE_VALUES,
    CODEX_MAX_TESTED_VERSION,
    CODEX_MIN_SUPPORTED_VERSION,
)
from scholarseed_codex.protocol.session import (
    CodexRuntimeLaunchArgument,
    CodexRuntimeReadiness,
    CodexRuntimeStatus,
)
from scholarseed_codex.protocol.state import (
    CODEX_DEFAULT_BIN,
    CODEX_LAUNCH_ARGUMENT_INVALID_ERROR,
    CODEX_LAUNCH_ARGUMENT_MISSING_ERROR,
    CODEX_LOGIN_ERROR,
    CODEX_PREFLIGHT_OUTPUT_LIMIT_BYTES,
    CODEX_PREFLIGHT_TIMEOUT_ERROR,
    CODEX_PREFLIGHT_TIMEOUT_SECONDS,
    CODEX_RUNTIME_ID,
    CODEX_UNAVAILABLE_ERROR,
    CODEX_UNTESTED_VERSION_WARNING,
    CODEX_VERSION_ERROR,
    CODEX_VERSION_INCOMPATIBLE_ERROR,
    CODEX_VERSION_UNPARSEABLE_ERROR,
    AppServerError,
    CodexProcessState,
)

CODEX_VERSION_PATTERN = re.compile(r"(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)")


def discover_codex_executable(executable: str = "") -> str:
    """Resolve the executable exactly once without starting App Server."""

    return str(shutil.which(executable or CODEX_DEFAULT_BIN) or "")


def _resolve_launch_arguments(
    arguments: tuple[CodexRuntimeLaunchArgument, ...],
    process_environment: Mapping[str, str],
    remove_environment: tuple[str, ...] = (),
) -> tuple[str, ...]:
    """Resolve consumer-supplied options without owning their semantics."""

    resolved: list[str] = []
    for argument in arguments:
        option = argument.option.strip()
        literal = argument.value.strip()
        environment_name = argument.environment.strip()
        if literal and environment_name:
            raise AppServerError(CODEX_LAUNCH_ARGUMENT_INVALID_ERROR)
        value = literal
        if environment_name:
            value = str(
                process_environment.get(
                    environment_name,
                    (
                        ""
                        if environment_name in remove_environment
                        else os.environ.get(environment_name, "")
                    ),
                )
            ).strip()
            if not value:
                if argument.required:
                    raise AppServerError(CODEX_LAUNCH_ARGUMENT_MISSING_ERROR)
                continue
        if not option and not value:
            raise AppServerError(CODEX_LAUNCH_ARGUMENT_INVALID_ERROR)
        if option:
            resolved.append(option)
        if value:
            resolved.append(value)
    return tuple(resolved)


class CodexPreflightTimeout(Exception):
    """预检子进程超时: 结论**未知**, 不是「检查失败」也不是「没登录」。

    刻意不用内置 `TimeoutError` —— 它是 `OSError` 的子类, 会被调用方已有的
    `except OSError` 捕获, 又变回一个具体的失败结论。
    """


async def _preflight_command(
    executable: str, *args: str, process_environment: Mapping[str, str] | None = None
) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        executable,
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, **process_environment} if process_environment is not None else None,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=CODEX_PREFLIGHT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.wait()
        # 早先这里 `return 1, ""`, 而调用方用 `code == 0` 判定登录 —— 超时于是被读成
        # 「没登录」。抛出来, 让调用方能把「问不出来」和「确定没登录」分开表达。
        raise CodexPreflightTimeout(" ".join((executable, *args))) from exc
    output = (stdout or stderr)[:CODEX_PREFLIGHT_OUTPUT_LIMIT_BYTES]
    return int(process.returncode or 0), output.decode("utf-8", errors="replace").strip()


def _timed_out_readiness(resolved: str, version: str = "") -> CodexRuntimeReadiness:
    """预检问不出结论时的就绪态: authenticated 留 None, 表示「未知」而非「没登录」。"""

    return CodexRuntimeReadiness(
        runtime_id=CODEX_RUNTIME_ID,
        status=CodexRuntimeStatus.UNAVAILABLE,
        ready=False,
        executable=resolved,
        version=version,
        authenticated=None,
        safe_error=CODEX_PREFLIGHT_TIMEOUT_ERROR,
    )


async def _probe_codex_cli_readiness(
    executable: str = "",
    *,
    authentication_required: bool = True,
    process_environment: Mapping[str, str] | None = None,
) -> CodexRuntimeReadiness:
    """Check executable compatibility and, only for native callers, login."""

    resolved = discover_codex_executable(executable)
    if not resolved:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.UNAVAILABLE,
            ready=False,
            safe_error=CODEX_UNAVAILABLE_ERROR,
        )
    try:
        version_code, version_output = await _preflight_command(
            resolved, "--version", process_environment=process_environment
        )
    except CodexPreflightTimeout:
        return _timed_out_readiness(resolved)
    except FileNotFoundError:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.UNAVAILABLE,
            ready=False,
            executable=resolved,
            safe_error=CODEX_UNAVAILABLE_ERROR,
        )
    except OSError:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.ERROR,
            ready=False,
            executable=resolved,
            safe_error=CODEX_VERSION_ERROR,
        )
    version = version_output.splitlines()[0] if version_output else ""
    if version_code:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.ERROR,
            ready=False,
            executable=resolved,
            version=version,
            safe_error=CODEX_VERSION_ERROR,
        )
    parsed_version = _parse_codex_version(version)
    if parsed_version is None:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.INCOMPATIBLE,
            ready=False,
            executable=resolved,
            version=version,
            safe_error=CODEX_VERSION_UNPARSEABLE_ERROR,
        )
    development_version = parsed_version == CODEX_DEVELOPMENT_VERSION
    allow_development_version = (
        os.environ.get(CODEX_ALLOW_DEVELOPMENT_VERSION_ENV, "").strip().lower()
        in CODEX_ENV_TRUE_VALUES
    )
    if (development_version and not allow_development_version) or (
        parsed_version < CODEX_MIN_SUPPORTED_VERSION
        and not (development_version and allow_development_version)
    ):
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.INCOMPATIBLE,
            ready=False,
            executable=resolved,
            version=version,
            authenticated=None,
            safe_error=CODEX_VERSION_INCOMPATIBLE_ERROR,
        )
    newer_than_tested = parsed_version > CODEX_MAX_TESTED_VERSION
    if newer_than_tested and not CODEX_ALLOW_UNTESTED_NEWER:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.INCOMPATIBLE,
            ready=False,
            executable=resolved,
            version=version,
            safe_error=CODEX_VERSION_INCOMPATIBLE_ERROR,
        )
    if not authentication_required:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable=resolved,
            version=version,
            authenticated=None,
            process_state=CodexProcessState.STOPPED.value,
            warning=CODEX_UNTESTED_VERSION_WARNING if newer_than_tested else "",
        )
    try:
        login_code, _ = await _preflight_command(
            resolved, "login", "status", process_environment=process_environment
        )
    except CodexPreflightTimeout:
        # 核心修复点: 超时不能再落到下面的 `authenticated = login_code == 0`,
        # 否则一个已登录的用户会在机器繁忙时被判成未登录。
        return _timed_out_readiness(resolved, version)
    except FileNotFoundError:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.UNAVAILABLE,
            ready=False,
            executable=resolved,
            version=version,
            safe_error=CODEX_UNAVAILABLE_ERROR,
        )
    except OSError:
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.ERROR,
            ready=False,
            executable=resolved,
            version=version,
            safe_error=CODEX_LOGIN_ERROR,
        )
    authenticated = login_code == 0
    return CodexRuntimeReadiness(
        runtime_id=CODEX_RUNTIME_ID,
        status=(CodexRuntimeStatus.READY if authenticated else CodexRuntimeStatus.UNAUTHENTICATED),
        ready=authenticated,
        executable=resolved,
        version=version,
        authenticated=authenticated,
        process_state=CodexProcessState.STOPPED.value,
        safe_error="" if authenticated else CODEX_LOGIN_ERROR,
        warning=CODEX_UNTESTED_VERSION_WARNING if newer_than_tested else "",
    )


def _parse_codex_version(version: str) -> tuple[int, int, int] | None:
    match = CODEX_VERSION_PATTERN.search(version)
    if match is None:
        return None
    return (
        int(match.group("major")),
        int(match.group("minor")),
        int(match.group("patch")),
    )
