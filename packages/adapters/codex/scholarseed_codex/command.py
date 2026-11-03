"""Own short-lived Codex commands until their process and pipes have drained."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from pathlib import Path

COMMAND_PIPE_CHUNK_BYTES = 64 * 1024
COMMAND_STREAM_LIMIT_BYTES = 64 * 1024
COMMAND_EXIT_POLL_SECONDS = 0.01


class CommandOutputLimitError(RuntimeError):
    """A drained command exceeded its private output budget."""


def _kill(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass


async def _bounded_communication(
    process: asyncio.subprocess.Process, payload: bytes | None, limit: int
) -> tuple[bytes, bytes]:
    exceeded = False

    async def read(stream: asyncio.StreamReader) -> bytes:
        nonlocal exceeded
        collected = bytearray()
        while chunk := await stream.read(COMMAND_PIPE_CHUNK_BYTES):
            remaining = limit - len(collected)
            collected.extend(chunk[:remaining])
            if len(chunk) > remaining:
                exceeded = True
                _kill(process)
            # Continue draining after overflow; a paused pipe can otherwise
            # keep Process.wait pending even after the child has been killed.
        return bytes(collected)

    async def write() -> None:
        if process.stdin is None:
            return
        try:
            source = memoryview(payload or b"")
            for offset in range(0, len(source), COMMAND_PIPE_CHUNK_BYTES):
                process.stdin.write(source[offset : offset + COMMAND_PIPE_CHUNK_BYTES])
                await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdin.close()
            try:
                await process.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass

    assert process.stdout is not None and process.stderr is not None
    workers = (
        asyncio.create_task(read(process.stdout)),
        asyncio.create_task(read(process.stderr)),
        asyncio.create_task(write()),
    )
    try:
        stdout, stderr, _ = await asyncio.gather(*workers)
        await process.wait()
    except BaseException:
        _kill(process)
        await asyncio.gather(*workers, return_exceptions=True)
        await process.wait()
        raise
    if exceeded:
        raise CommandOutputLimitError("private command output exceeded its budget")
    return stdout, stderr


async def _finish[T](operation: asyncio.Task[T]) -> T:
    # Cleanup belongs to this call even if its caller cancels more than once.
    while not operation.done():
        try:
            await asyncio.shield(operation)
        except asyncio.CancelledError:
            pass
    return operation.result()


async def _stop(
    process: asyncio.subprocess.Process,
    communication: asyncio.Task[tuple[bytes, bytes]],
) -> None:
    try:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
    finally:
        while process.returncode is None:
            await asyncio.sleep(COMMAND_EXIT_POLL_SECONDS)
        communication.cancel()
        await asyncio.gather(communication, return_exceptions=True)
        await process.wait()


async def run_command(
    executable: str,
    *arguments: str,
    timeout: float,
    environment: Mapping[str, str] | None = None,
    cwd: Path | None = None,
    payload: bytes | None = None,
    output_limit: int | None = None,
) -> tuple[int, bytes, bytes]:
    """Return an OS exit receipt; cancellation/timeout never detach a live command."""

    if payload is not None and not isinstance(payload, bytes):
        raise TypeError("command payload must be bytes")
    if output_limit is not None and (type(output_limit) is not int or output_limit <= 0):
        raise ValueError("command output limit must be positive")
    creation = asyncio.create_task(
        asyncio.create_subprocess_exec(
            executable,
            *arguments,
            cwd=cwd,
            env=environment,
            stdin=asyncio.subprocess.PIPE if payload is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    )
    try:
        process = await asyncio.shield(creation)
    except BaseException:
        process = await _finish(creation)
        communication = asyncio.create_task(
            _bounded_communication(process, None, output_limit)
            if output_limit is not None
            else process.communicate()
        )
        await _finish(asyncio.create_task(_stop(process, communication)))
        raise
    communication = asyncio.create_task(
        _bounded_communication(process, payload, output_limit)
        if output_limit is not None
        else (process.communicate(payload) if payload is not None else process.communicate())
    )
    try:
        stdout, stderr = await asyncio.wait_for(asyncio.shield(communication), timeout)
        code = await process.wait()
    except BaseException:
        await _finish(asyncio.create_task(_stop(process, communication)))
        raise
    return code, stdout, stderr
