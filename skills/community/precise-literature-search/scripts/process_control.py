"""Run child commands so cancellation and timeouts terminate their process trees."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Sequence

from platform_support import WINDOWS, executable_command, utf8_environment


class ChildProcessCancelled(Exception):
    """Raised after a host cancellation signal has been forwarded and reaped."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"child process cancelled by signal {signum}")
        self.signum = signum


def _wait_with_signals(operation: Callable[..., Any], timeout: float | None) -> Any:
    """Let Python handle SIGBREAK between short Win32 waits, without extending deadlines."""
    if not WINDOWS:
        return operation(timeout=timeout)
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        interval = 0.1 if deadline is None else min(0.1, max(0, deadline - time.monotonic()))
        try:
            return operation(timeout=interval)
        except subprocess.TimeoutExpired as exc:
            if deadline is not None and time.monotonic() >= deadline:
                exc.timeout = timeout
                raise


def wait_for_exit(process: subprocess.Popen[Any], timeout: float | None = None) -> int:
    return _wait_with_signals(process.wait, timeout)


def _signal_process_tree(process: subprocess.Popen[str], signum: int) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signum)
        elif signum == signal.SIGTERM or signum in (signal.SIGINT, signal.SIGBREAK):
            try:
                process.send_signal(signal.CTRL_BREAK_EVENT)
            except OSError:
                # GUI hosts may have no attached console. Job termination still
                # stops ordinary descendants; detached pool leases remain durable.
                from windows_support import stop_record
                stop_record(process._pls_record)
        else:
            from windows_support import stop_record
            stop_record(process._pls_record)
    except ProcessLookupError:
        return


def _reap_after_signal(process: subprocess.Popen[str], signum: int) -> tuple[str | None, str | None]:
    _signal_process_tree(process, signum)
    try:
        return process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        _signal_process_tree(process, getattr(signal, "SIGKILL", 9))
        # Job termination must also close descendant pipe writers. Never turn a
        # failed Windows cleanup into another unbounded wait.
        return process.communicate(timeout=5) if WINDOWS else process.communicate()


def run_cancellable(
    command: Sequence[str],
    *,
    cwd: str | Path | None = None,
    text: bool = True,
    capture_output: bool = False,
    timeout: float | None = None,
    env: dict[str, str] | None = None,
    heartbeat: Callable[[float], None] | None = None,
    heartbeat_interval: float = 1.0,
) -> subprocess.CompletedProcess[str]:
    """Run a command in its own process group and forward SIGINT/SIGTERM."""
    if heartbeat is not None and heartbeat_interval <= 0:
        raise ValueError("heartbeat_interval must be positive")
    popen_kwargs: dict[str, Any] = {
        "cwd": str(cwd) if cwd is not None else None,
        "text": text,
        "env": utf8_environment(env),
        "start_new_session": os.name == "posix",
    }
    if text and WINDOWS:
        popen_kwargs["encoding"] = "utf-8"
    if capture_output:
        popen_kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if WINDOWS:
        from windows_support import grant, start_worker
        process, record = start_worker(Path(__file__).with_name("windows_support.py"), "_command_worker",
                                       kwargs=popen_kwargs)
        process._pls_record = record
        try:
            grant(process, {"command": executable_command(command), "cwd": str(cwd) if cwd else None, "env": env})
        except BaseException:
            from windows_support import stop_record
            process._pls_gate.close()
            stop_record(record)
            process.wait(timeout=5)
            raise
    else:
        process = subprocess.Popen(list(command), **popen_kwargs)
    previous_handlers: dict[int, Any] = {}
    heartbeat_stop = threading.Event()
    started = time.monotonic()

    def heartbeat_loop() -> None:
        while not heartbeat_stop.wait(heartbeat_interval):
            try:
                assert heartbeat is not None
                heartbeat(time.monotonic() - started)
            except Exception:
                return

    heartbeat_thread = None
    if heartbeat is not None:
        heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
        heartbeat_thread.start()

    def forward(signum: int, _frame: Any) -> None:
        raise ChildProcessCancelled(signum)

    for signum in ((signal.SIGINT, signal.SIGTERM, signal.SIGBREAK) if WINDOWS else (signal.SIGINT, signal.SIGTERM)):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, forward)
    try:
        try:
            stdout, stderr = _wait_with_signals(process.communicate, timeout)
        except ChildProcessCancelled as exc:
            _reap_after_signal(process, exc.signum)
            raise
        except subprocess.TimeoutExpired as exc:
            stdout, stderr = _reap_after_signal(process, signal.SIGTERM)
            exc.stdout = stdout
            exc.stderr = stderr
            raise
    finally:
        heartbeat_stop.set()
        if heartbeat_thread is not None:
            heartbeat_thread.join(timeout=max(heartbeat_interval * 2, 0.1))
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    return subprocess.CompletedProcess(list(command), process.returncode, stdout, stderr)
