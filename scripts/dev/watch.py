import argparse
import hmac
import json
import os
import re
import secrets
import signal
import socket
import struct
import subprocess
import sys
import threading

from watchfiles import PythonFilter, watch

STOP_TIMEOUT = 5
KILL_TIMEOUT = 1
WATCH_TIMEOUT_MS = 200
POSIX_PLATFORM = "posix"
CONTROL_TIMEOUT = 3
CONTROL_FRAME_BYTES = 512
CONTROL_GENERATION = re.compile(rb"[a-f0-9]{32}\Z")
CONTROL_FLAGS = ("--parent-control", "--parent-stdin")


class ParentChannel:
    def __init__(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.setblocking(False)
        self.connection = None
        self.token = secrets.token_hex(32)

    def bootstrap(self):
        return (
            json.dumps(
                {
                    "version": 1,
                    "port": self.listener.getsockname()[1],
                    "token": self.token,
                }
            ).encode("ascii")
            + b"\n"
        )

    def poll(self):
        if self.connection is not None:
            return
        try:
            connection, _address = self.listener.accept()
        except BlockingIOError:
            return
        connection.settimeout(CONTROL_TIMEOUT)
        try:
            frame = bytearray()
            while len(frame) < CONTROL_FRAME_BYTES:
                part = connection.recv(1)
                if not part:
                    raise RuntimeError("private control authentication incomplete")
                frame.extend(part)
                if part == b"\n":
                    break
            value = json.loads(frame, object_pairs_hook=list)
            if (
                not frame.endswith(b"\n")
                or not isinstance(value, list)
                or len(value) != 1
                or value[0][0] != "token"
                or not isinstance(value[0][1], str)
                or not hmac.compare_digest(value[0][1], self.token)
            ):
                raise RuntimeError("private control authentication rejected")
            connection.sendall(b"ready\n")
            self.connection = connection
            self.token = ""
        except BaseException:
            connection.close()
            raise

    def receive(self, length):
        frame = bytearray()
        while len(frame) < length:
            part = self.connection.recv(length - len(frame))
            if not part:
                raise RuntimeError("private control disconnected")
            frame.extend(part)
        return bytes(frame)

    def request_idle(self):
        if self.connection is None:
            return False
        self.connection.sendall(b'{"operation":"quiesce_if_idle","generation":null}\n')
        length = struct.unpack(">I", self.receive(4))[0]
        if length not in (1, 33):
            raise RuntimeError("private control response size rejected")
        response = self.receive(length)
        if response == b"\x00":
            return False
        if response[:1] == b"\x01" and CONTROL_GENERATION.fullmatch(response[1:]):
            return True
        raise RuntimeError("private control outcome unavailable")

    def close(self):
        self.token = ""
        if self.connection is not None:
            self.connection.close()
        self.listener.close()


def command(executable, port, cases_root=None):
    arguments = [executable, "--port", port]
    if cases_root is not None:
        arguments.extend(["--cases-root", cases_root])
    return arguments


def stop(process):
    if sys.platform != "win32" and os.name == POSIX_PLATFORM:
        try:
            os.killpg(process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=STOP_TIMEOUT)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=KILL_TIMEOUT)
    elif process.poll() is None:
        os.kill(process.pid, signal.SIGINT)
        try:
            process.wait(timeout=STOP_TIMEOUT)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=KILL_TIMEOUT)


def supervise(arguments, directories):
    stopped = threading.Event()
    handlers = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        handlers[signum] = signal.signal(signum, lambda *_arguments: stopped.set())
    process = None
    channel = None
    pending = False
    reload_available = True

    def launch():
        owner = ParentChannel()
        try:
            child = subprocess.Popen(
                [*arguments, *CONTROL_FLAGS],
                start_new_session=os.name == POSIX_PLATFORM,
                stdin=subprocess.PIPE,
            )
            try:
                child.stdin.write(owner.bootstrap())
                child.stdin.flush()
            except BrokenPipeError:
                pass
            return child, owner
        except BaseException:
            owner.close()
            raise

    try:
        if stopped.is_set():
            return 0
        process, channel = launch()
        for changes in watch(
            *directories,
            watch_filter=PythonFilter(),
            stop_event=stopped,
            yield_on_timeout=True,
            rust_timeout=WATCH_TIMEOUT_MS,
        ):
            if stopped.is_set():
                return 0
            status = process.poll()
            if status is not None:
                return status
            pending = pending or bool(changes)
            if reload_available:
                try:
                    channel.poll()
                    permitted = pending and channel.request_idle()
                except Exception:
                    reload_available = False
                    permitted = False
                    print(
                        "Safe reload unavailable: private control outcome is uncertain; "
                        "the current service is retained. Exit explicitly to restart.",
                        file=sys.stderr,
                    )
            else:
                permitted = False
            if stopped.is_set():
                return 0
            if permitted:
                stop(process)
                process.stdin.close()
                process = None
                channel.close()
                channel = None
                if stopped.is_set():
                    return 0
                process, channel = launch()
                pending = False
        return 0
    finally:
        try:
            if process is not None:
                stop(process)
        finally:
            if process is not None:
                process.stdin.close()
            if channel is not None:
                channel.close()
            for signum, handler in handlers.items():
                signal.signal(signum, handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True)
    parser.add_argument("--executable", required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--cases-root")
    parser.add_argument("directories", nargs="+")
    arguments = parser.parse_args()
    try:
        same_interpreter = os.path.samefile(arguments.python, sys.executable)
    except OSError:
        same_interpreter = False
    if not same_interpreter:
        parser.error("watcher must run with the declared Python interpreter")
    if os.name != POSIX_PLATFORM:
        print(
            "Windows cleanup preserves the legacy root-only guarantee; descendants are not verified",
            file=sys.stderr,
        )
    return supervise(
        command(arguments.executable, arguments.port, arguments.cases_root), arguments.directories
    )


if __name__ == "__main__":
    raise SystemExit(main())
