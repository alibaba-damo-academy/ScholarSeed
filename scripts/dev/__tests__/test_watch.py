import json
import os
import pathlib
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts.dev import watch as serve_watch
from scripts.dev.watch import command, supervise

CONTROL_FIXTURE = (
    "import json,socket,struct,sys,threading\n"
    "bootstrap=json.loads(sys.stdin.readline())\n"
    "channel=socket.create_connection(('127.0.0.1',bootstrap['port']))\n"
    "channel.sendall(json.dumps({'token':bootstrap['token']}).encode()+b'\\n')\n"
    "assert channel.recv(6)==b'ready\\n'\n"
    "def control():\n"
    "    stream=channel.makefile('rb')\n"
    "    for line in stream:\n"
    "        assert json.loads(line)=={'operation':'quiesce_if_idle','generation':None}\n"
    "        response=b'\\x01'+b'a'*32\n"
    "        channel.sendall(struct.pack('>I',len(response))+response)\n"
    "threading.Thread(target=control,daemon=True).start()\n"
)


class WatchTests(unittest.TestCase):
    def test_busy_change_remains_pending_until_idle(self):
        def events(*_arguments, **_keywords):
            yield {("change", "file.py")}
            yield set()
            signal.raise_signal(signal.SIGINT)
            yield set()

        with (
            patch.object(serve_watch.subprocess, "Popen") as launch,
            patch.object(serve_watch, "ParentChannel", create=True) as channels,
            patch.object(serve_watch, "watch", side_effect=events),
            patch.object(serve_watch, "stop") as stop,
        ):
            launch.return_value.poll.return_value = None
            channels.return_value.request_idle.return_value = True
            channels.return_value.request_idle.side_effect = [False, True]
            self.assertEqual(supervise(["child"], ["directory"]), 0)
            self.assertEqual(launch.call_count, 2)
            self.assertEqual(channels.return_value.request_idle.call_count, 2)
            self.assertEqual(stop.call_count, 2)

    def test_unknown_control_outcome_never_reloads_live_child(self):
        def events(*_arguments, **_keywords):
            yield {("change", "file.py")}
            yield {("change", "other.py")}
            signal.raise_signal(signal.SIGINT)
            yield set()

        with (
            patch.object(serve_watch.subprocess, "Popen") as launch,
            patch.object(serve_watch, "ParentChannel", create=True) as channels,
            patch.object(serve_watch, "watch", side_effect=events),
            patch.object(serve_watch, "stop") as stop,
        ):
            launch.return_value.poll.return_value = None
            channels.return_value.request_idle.side_effect = RuntimeError("uncertain")
            self.assertEqual(supervise(["child"], ["directory"]), 0)
            self.assertEqual(launch.call_count, 1)
            self.assertEqual(channels.return_value.request_idle.call_count, 1)
            stop.assert_called_once()

    def test_shutdown_before_initial_launch_never_starts_child(self):
        install_handler = signal.signal
        emitted = False

        def install(signum, handler):
            nonlocal emitted
            previous = install_handler(signum, handler)
            if signum == signal.SIGTERM and callable(handler) and not emitted:
                emitted = True
                signal.raise_signal(signal.SIGTERM)
            return previous

        with (
            patch.object(serve_watch.subprocess, "Popen") as launch,
            patch.object(serve_watch.signal, "signal", side_effect=install),
        ):
            self.assertEqual(supervise(["temporary-child"], ["temporary-directory"]), 0)
            launch.assert_not_called()

    def test_shutdown_during_reload_never_starts_replacement(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signum=signum):
                with patch.object(serve_watch.subprocess, "Popen") as launch:
                    launch.return_value.poll.return_value = None
                    with (
                        patch.object(
                            serve_watch, "watch", return_value=iter([{("change", "file.py")}])
                        ),
                        patch.object(
                            serve_watch,
                            "stop",
                            side_effect=lambda _process, signum=signum: signal.raise_signal(signum),
                        ),
                        patch.object(serve_watch, "ParentChannel") as channels,
                    ):
                        channels.return_value.request_idle.return_value = True
                        self.assertEqual(supervise(["temporary-child"], ["temporary-directory"]), 0)
                    self.assertEqual(launch.call_count, 1)

    def test_shutdown_adjacent_to_change_does_not_reload(self):
        def events(*_arguments, **_keywords):
            signal.raise_signal(signal.SIGINT)
            yield {("change", "file.py")}

        with (
            patch.object(serve_watch.subprocess, "Popen") as launch,
            patch.object(serve_watch, "watch", side_effect=events),
            patch.object(serve_watch, "stop"),
        ):
            self.assertEqual(supervise(["temporary-child"], ["temporary-directory"]), 0)
            self.assertEqual(launch.call_count, 1)

    def test_command_preserves_special_arguments(self):
        executable = "service ' \\ with spaces"
        cases = "cases ' \\ with spaces"
        self.assertEqual(
            command(executable, "9876", cases),
            [executable, "--port", "9876", "--cases-root", cases],
        )

    @unittest.skipUnless(os.name == "posix", "POSIX shebang fixture; not Windows exe evidence")
    def test_exact_argv_and_failure_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            output = root / "argv.json"
            executable = root / "child ' \\ script.py"
            executable.write_text(
                f"#!{sys.executable}\n"
                "import json,pathlib,sys\n"
                f"pathlib.Path({str(output)!r}).write_text(json.dumps(sys.argv[1:]))\n"
                "raise SystemExit(7)\n"
            )
            executable.chmod(0o755)
            cases = "cases ' \\ with spaces"
            argv = command(str(executable), "9876", cases)
            self.assertEqual(supervise(argv, [str(root)]), 7)
            self.assertEqual(
                json.loads(output.read_text()),
                ["--port", "9876", "--cases-root", cases, "--parent-control", "--parent-stdin"],
            )

    @unittest.skipUnless(os.name == "posix", "native POSIX process groups")
    def test_real_shutdown_during_reload_starts_only_one_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            watched = root / "watched"
            watched.mkdir()
            starts = root / "starts.jsonl"
            executable = root / "service.py"
            executable.write_text(
                f"#!{sys.executable}\n" + CONTROL_FIXTURE + "import os,signal,time\n"
                "def stop(signum,frame):\n"
                "    os.kill(os.getppid(),signal.SIGTERM)\n"
                "    raise SystemExit(0)\n"
                "signal.signal(signal.SIGINT,stop)\n"
                f"with open({str(starts)!r},'a') as output: output.write(str(os.getpid())+'\\n')\n"
                "time.sleep(60)\n"
            )
            executable.chmod(0o755)
            watcher = subprocess.Popen(
                [
                    sys.executable,
                    "scripts/dev/watch.py",
                    "--python",
                    sys.executable,
                    "--executable",
                    str(executable),
                    "--port",
                    "9876",
                    str(watched),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            try:
                self.wait_for(starts.exists)
                (watched / "change.py").write_text("changed = True\n")
                self.assertEqual(watcher.wait(timeout=15), 0)
                self.assertEqual(len(starts.read_text().splitlines()), 1)
                self.wait_for(lambda: not self.alive(int(starts.read_text().strip())))
            finally:
                if watcher.poll() is None:
                    watcher.send_signal(signal.SIGTERM)
                    watcher.wait(timeout=15)
                assert watcher.stderr is not None
                watcher.stderr.close()

    @unittest.skipUnless(os.name == "posix", "native POSIX process groups")
    def test_restart_and_sigint_leave_no_process_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            watched = root / "watched"
            watched.mkdir()
            evidence = root / "started.jsonl"
            executable = root / "service.py"
            executable.write_text(
                f"#!{sys.executable}\n"
                + CONTROL_FIXTURE
                + "import json,os,signal,subprocess,sys,time\n"
                "signal.signal(signal.SIGINT,signal.SIG_IGN)\n"
                "child=subprocess.Popen([sys.executable,'-c',"
                "'import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);time.sleep(60)'])\n"
                f"with open({str(evidence)!r},'a') as output: output.write(json.dumps([os.getpid(),child.pid])+'\\n')\n"
                "time.sleep(60)\n"
            )
            executable.chmod(0o755)
            watcher = subprocess.Popen(
                [
                    sys.executable,
                    "scripts/dev/watch.py",
                    "--python",
                    sys.executable,
                    "--executable",
                    str(executable),
                    "--port",
                    "9876",
                    str(watched),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            try:
                self.wait_for(evidence.exists)
                (watched / "change.py").write_text("changed = True\n")
                self.wait_for(lambda: len(evidence.read_text().splitlines()) >= 2)
                watcher.send_signal(signal.SIGINT)
                self.assertEqual(watcher.wait(timeout=15), 0)
                for line in evidence.read_text().splitlines():
                    parent, child = json.loads(line)
                    self.wait_for(lambda parent=parent: not self.alive(parent))
                    self.wait_for(lambda child=child: not self.alive(child))
            finally:
                if watcher.poll() is None:
                    watcher.kill()
                    watcher.wait()
                assert watcher.stderr is not None
                watcher.stderr.close()

    @unittest.skipUnless(os.name == "posix", "native POSIX process groups")
    def test_service_exit_cleans_remaining_child_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            watched = root / "watched"
            watched.mkdir()
            child_pid = root / "child.pid"
            service_pid = root / "service.pid"
            executable = root / "service.py"
            child_code = (
                "import os,pathlib,signal,time;"
                "signal.signal(signal.SIGINT,signal.SIG_IGN);"
                f"pathlib.Path({str(child_pid)!r}).write_text(str(os.getpid()));"
                "time.sleep(60)"
            )
            executable.write_text(
                f"#!{sys.executable}\n"
                "import os,pathlib,subprocess,sys,time\n"
                f"pathlib.Path({str(service_pid)!r}).write_text(str(os.getpid()))\n"
                f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}])\n"
                "deadline=time.monotonic()+5\n"
                f"while not pathlib.Path({str(child_pid)!r}).exists():\n"
                "    if time.monotonic()>=deadline: raise RuntimeError('child did not start')\n"
                "    time.sleep(0.01)\n"
                "raise SystemExit(7)\n"
            )
            executable.chmod(0o755)
            errors = (root / "watcher.stderr").open("w+b")
            watcher = subprocess.Popen(
                [
                    sys.executable,
                    str(pathlib.Path(serve_watch.__file__)),
                    "--python",
                    sys.executable,
                    "--executable",
                    str(executable),
                    "--port",
                    "9876",
                    str(watched),
                ],
                stdout=subprocess.DEVNULL,
                stderr=errors,
            )
            try:
                status = watcher.wait(timeout=15)
                self.assertEqual(status, 7, (root / "watcher.stderr").read_text())
                self.wait_for(lambda: not self.alive(int(child_pid.read_text())))
            finally:
                if watcher.poll() is None:
                    watcher.kill()
                    watcher.wait()
                errors.close()
                if sys.platform != "win32" and child_pid.exists():
                    pid = int(child_pid.read_text())
                    try:
                        if os.getpgid(pid) == int(service_pid.read_text()):
                            os.killpg(int(service_pid.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def alive(self, pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def wait_for(self, predicate):
        deadline = time.monotonic() + 15
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail("timed out waiting for process evidence")
            time.sleep(0.05)


class ParentChannelTests(unittest.TestCase):
    def connect(self, owner, bootstrap):
        client = socket.create_connection(("127.0.0.1", bootstrap["port"]))
        client.settimeout(3)
        self.addCleanup(client.close)
        return client

    def authenticate(self, owner):
        deadline = time.monotonic() + 3
        while owner.connection is None:
            owner.poll()
            if time.monotonic() >= deadline:
                self.fail("private authentication did not settle")
            time.sleep(0.01)

    def test_private_channel_authentication_and_exact_idle_responses(self):
        owner = serve_watch.ParentChannel()
        self.addCleanup(owner.close)
        bootstrap = json.loads(owner.bootstrap())
        with self.connect(owner, bootstrap) as client:
            client.sendall(json.dumps({"token": bootstrap["token"]}).encode() + b"\n")
            self.authenticate(owner)
            self.assertEqual(client.recv(6), b"ready\n")
            self.assertEqual(owner.token, "")
            client.sendall(struct.pack(">I", 1) + b"\x00")
            self.assertFalse(owner.request_idle())
            self.assertEqual(
                json.loads(client.recv(512)),
                {"operation": "quiesce_if_idle", "generation": None},
            )
            client.sendall(struct.pack(">I", 33) + b"\x01" + b"a" * 32)
            self.assertTrue(owner.request_idle())

    def test_authentication_rejects_wrong_or_duplicate_tokens(self):
        for duplicated in (False, True):
            with self.subTest(duplicated=duplicated):
                owner = serve_watch.ParentChannel()
                try:
                    bootstrap = json.loads(owner.bootstrap())
                    with self.connect(owner, bootstrap) as client:
                        token = bootstrap["token"] if duplicated else "wrong"
                        frame = json.dumps({"token": token})
                        if duplicated:
                            frame = frame[:-1] + ',"token":' + json.dumps(token) + "}"
                        client.sendall(frame.encode() + b"\n")
                        with self.assertRaises(RuntimeError):
                            self.authenticate(owner)
                        self.assertIsNone(owner.connection)
                finally:
                    owner.close()

    def test_unknown_or_oversized_frames_never_grant_reload(self):
        for response in (struct.pack(">I", 1024), struct.pack(">I", 1) + b"\x02"):
            with self.subTest(response=response):
                owner = serve_watch.ParentChannel()
                try:
                    bootstrap = json.loads(owner.bootstrap())
                    with self.connect(owner, bootstrap) as client:
                        client.sendall(json.dumps({"token": bootstrap["token"]}).encode() + b"\n")
                        self.authenticate(owner)
                        self.assertEqual(client.recv(6), b"ready\n")
                        client.sendall(response)
                        with self.assertRaises(RuntimeError):
                            owner.request_idle()
                finally:
                    owner.close()
