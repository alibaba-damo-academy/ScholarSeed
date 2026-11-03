from __future__ import annotations

import ctypes
import json
import os
import select
import struct
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from ctypes import wintypes
from hashlib import sha256
from pathlib import Path
from queue import Empty, Full, Queue
from threading import Event, Thread
from time import monotonic
from unittest.mock import patch

from service.cli import browser
from service.platform import storage

HELPER_DEADLINE_SECONDS = 10
PIPE_CHUNK_BYTES = 64 * 1024
PIPE_QUEUE_CHUNKS = 4
PIPE_HEADER_BYTES = 16 * 1024
PIPE_PAYLOAD_BYTES = 16 * 1024 * 1024
PIPE_QUEUE_POLL_SECONDS = 0.1
CHECKPOINT = b"checkpoint"
TEST_HOME = "home"
TEST_WINDOWS = "nt"
TEST_PRIVATE_DIRECTORY_MODE = 0o700
TEST_WIDE_DIRECTORY_MODE = 0o755
TEST_DACL_SECURITY_INFORMATION = 0x00000004
TEST_PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
TEST_SDDL_REVISION = 1
TEST_SYMLINK_PRIVILEGE_MISSING = 1314


@contextmanager
def private_home():
    with tempfile.TemporaryDirectory() as temporary:
        parent = Path(temporary).resolve()
        root = parent / TEST_HOME
        if os.name == TEST_WINDOWS:
            directory = storage.open_directory(parent, ())
            try:
                handle = storage.windows.open_relative(
                    directory.native_handles[-1],
                    TEST_HOME,
                    directory=True,
                    disposition=storage.windows.CREATE,
                    access=storage.windows.READ
                    | storage.windows.WRITE
                    | storage.windows.READ_CONTROL
                    | storage.windows.SYNCHRONIZE,
                    share=storage.windows.SHARE_READ | storage.windows.SHARE_WRITE,
                )
                storage.windows.close(handle)
            finally:
                directory.close()
        else:
            root.mkdir(mode=TEST_PRIVATE_DIRECTORY_MODE)
        yield str(root)


def wide_windows_dacl(path):
    security = storage.windows.SECURITY
    security.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.LPVOID]
    security.SetFileSecurityW.restype = wintypes.BOOL
    descriptor = wintypes.LPVOID()
    user = storage.windows.current_sid()
    storage.windows.check(
        security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            f"O:{user}D:P(A;;FA;;;{user})(A;;FA;;;SY)(A;;FR;;;WD)",
            TEST_SDDL_REVISION,
            ctypes.byref(descriptor),
            None,
        )
    )
    try:
        storage.windows.check(
            security.SetFileSecurityW(
                str(path),
                TEST_DACL_SECURITY_INFORMATION | TEST_PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            )
        )
    finally:
        storage.windows.KERNEL.LocalFree(descriptor)


def windows_dacl_bytes(path):
    security = storage.windows.SECURITY
    security.GetFileSecurityW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    security.GetFileSecurityW.restype = wintypes.BOOL
    size = wintypes.DWORD()
    security.GetFileSecurityW(
        str(path), TEST_DACL_SECURITY_INFORMATION, None, 0, ctypes.byref(size)
    )
    if not size.value:
        raise AssertionError("Windows DACL fixture query failed")
    descriptor = ctypes.create_string_buffer(size.value)
    storage.windows.check(
        security.GetFileSecurityW(
            str(path),
            TEST_DACL_SECURITY_INFORMATION,
            descriptor,
            len(descriptor),
            ctypes.byref(size),
        )
    )
    return descriptor.raw


class PipeReader:
    def __init__(self, stream):
        self.stream = stream
        self.events = Queue(maxsize=PIPE_QUEUE_CHUNKS)
        self.stopping = Event()
        self.buffer = bytearray()
        self.worker = Thread(target=self.pump, daemon=True)
        self.worker.start()

    def pump(self):
        try:
            while not self.stopping.is_set():
                chunk = self.stream.read1(PIPE_CHUNK_BYTES)
                self.put(chunk)
                if not chunk:
                    return
        except Exception as error:
            self.put(error)

    def put(self, event):
        while not self.stopping.is_set():
            try:
                self.events.put(event, timeout=PIPE_QUEUE_POLL_SECONDS)
                return
            except Full:
                pass

    def read(self, length):
        deadline = monotonic() + HELPER_DEADLINE_SECONDS
        while len(self.buffer) < length:
            try:
                event = self.events.get(timeout=max(0, deadline - monotonic()))
            except Empty as error:
                raise AssertionError("helper pipe timed out") from error
            if isinstance(event, Exception):
                raise AssertionError("helper pipe failed") from event
            if not event:
                raise AssertionError("helper unexpectedly exited")
            self.buffer.extend(event)
        result = bytes(self.buffer[:length])
        del self.buffer[:length]
        return result

    def close(self):
        self.stopping.set()
        self.worker.join(timeout=HELPER_DEADLINE_SECONDS)
        if self.worker.is_alive():
            raise AssertionError("helper pipe reader did not stop")
        self.stream.close()


class StorageBoundaryTests(unittest.TestCase):
    def test_windows_leaf_each_validation_failure_closes_owned_native_once(self):
        for point in ("tag", "identity", "reparse", "links"):
            with self.subTest(point=point):
                closed = []

                class Native:
                    def NtCreateFile(self, output, *arguments):
                        output._obj.value = 8
                        return 0

                class Kernel:
                    def GetFileInformationByHandleEx(self, handle, kind, output, size):
                        output._obj.attributes = 0x400 if point == "reparse" else 0
                        return point != "tag"

                    def GetFileInformationByHandle(self, handle, output):
                        output._obj.links = 2 if point == "links" else 1
                        return point != "identity"

                def check(success):
                    if not success:
                        raise OSError("injected native query failure")

                with (
                    patch.object(storage.windows, "NT", Native()),
                    patch.object(storage.windows, "KERNEL", Kernel()),
                    patch.object(storage.windows, "check", side_effect=check),
                    patch.object(storage.windows, "close", side_effect=closed.append),
                ):
                    with self.assertRaises(OSError):
                        storage.windows.open_relative(1, "leaf", directory=False)
                self.assertEqual(closed, [8])

    def test_close_attempts_all_native_resources_and_is_idempotent_after_error(self):
        calls = []

        class Kernel:
            def CloseHandle(self, handle):
                calls.append(handle)
                return handle != 2

        directory = storage.DirectoryHandle(Path("/not-used"), native_handles=(1, 2, 3))
        with patch.object(storage, "_KERNEL32", Kernel()):
            with self.assertRaises(storage.windows.ReleaseError) as caught:
                directory.close()
            self.assertIsInstance(caught.exception.__cause__, ExceptionGroup)
            directory.close()
        self.assertEqual(calls, [3, 2, 1])

    def test_native_to_crt_failure_closes_untransferred_handle_once(self):
        calls = []

        class Crt:
            def open_osfhandle(self, handle, flags):
                raise OSError("injected CRT failure")

        directory = storage.DirectoryHandle(Path("/not-used"), native_handles=(1,))
        with (
            patch.object(storage, "WINDOWS_CRT", Crt()),
            patch.object(storage.windows, "open_relative", return_value=8),
            patch.object(storage.windows, "close", side_effect=calls.append),
            patch.object(storage.os, "O_BINARY", 0x8000, create=True),
        ):
            with self.assertRaises(OSError):
                directory.open_private("leaf", os.O_RDWR)
        self.assertEqual(calls, [8])

    def test_actual_stable_lock_cannot_be_acquired_twice_and_keeps_same_inode(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            first = storage.open_private_directory(root, ())
            second = storage.open_private_directory(root, ())
            try:
                with first.arbitration("store.lock"):
                    identity = (root / "store.lock").stat().st_ino
                    with self.assertRaises(OSError):
                        with second.arbitration("store.lock"):
                            self.fail("second actual lock acquired")
                with second.arbitration("store.lock"):
                    self.assertEqual((root / "store.lock").stat().st_ino, identity)
            finally:
                first.close()
                second.close()

    def test_windows_invalid_basenames_rejected(self):
        for name in ("data:stream", "CON", "nul.txt", "file.", "file ", "a\x00b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                storage._validate_part(name)

    def test_private_boundary_exists(self):
        self.assertTrue(callable(getattr(storage, "open_private_directory", None)))

    def test_existing_data_permissions_follow_platform_policy_without_rewriting_acl(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            if os.name == TEST_WINDOWS:
                file = root / "shared"
                file.write_bytes(b"preserved")
                wide_windows_dacl(root)
                wide_windows_dacl(file)
                before = {path: windows_dacl_bytes(path) for path in (root, file)}
                directory = storage.open_private_directory(root, ())
                try:
                    descriptor = directory.open_private("shared", os.O_RDWR)
                    try:
                        self.assertEqual(os.read(descriptor, 9), b"preserved")
                        os.write(descriptor, b"!")
                    finally:
                        os.close(descriptor)
                    descriptor = directory.open_private("new", os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                    os.close(descriptor)
                finally:
                    directory.close()
                for path in (root, file):
                    self.assertEqual(windows_dacl_bytes(path), before[path])
                self.assertEqual(file.read_bytes(), b"preserved!")
            else:
                root.chmod(TEST_WIDE_DIRECTORY_MODE)
                with self.assertRaises(PermissionError):
                    storage.open_private_directory(root, ())
                self.assertEqual(root.stat().st_mode & 0o777, TEST_WIDE_DIRECTORY_MODE)

    def test_private_file_rejects_hardlink_and_symlink(self):
        for link in ("linked", "symbolic"):
            with self.subTest(link=link), private_home() as temporary:
                root = Path(temporary).resolve()
                directory = storage.open_private_directory(root, ())
                try:
                    descriptor = directory.open_private(
                        "payload", os.O_WRONLY | os.O_CREAT | os.O_EXCL
                    )
                    try:
                        os.write(descriptor, b"unchanged")
                    finally:
                        os.close(descriptor)
                    if link == "linked":
                        os.link(root / "payload", root / link)
                    else:
                        try:
                            (root / link).symlink_to("payload")
                        except OSError as error:
                            if (
                                os.name != TEST_WINDOWS
                                or error.winerror != TEST_SYMLINK_PRIVILEGE_MISSING
                            ):
                                raise
                            self.skipTest(
                                "Windows symlink requires Developer Mode or symlink privilege"
                            )
                    with self.assertRaises(OSError):
                        descriptor = directory.open_private(link, os.O_RDONLY)
                        os.close(descriptor)
                finally:
                    directory.close()
                self.assertEqual((root / "payload").read_bytes(), b"unchanged")

    def test_helper_handshake_projects_fixed_owner_budgets(self):
        with private_home() as temporary:
            helper = BinaryHelper(Path(temporary).resolve())
            try:
                self.assertEqual(helper.budgets, browser.BUDGETS)
            finally:
                helper.close()

    def test_pipe_reader_handles_partial_bytes_eof_and_timeout_and_joins(self):
        reader_fd, writer_fd = os.pipe()
        reader = PipeReader(os.fdopen(reader_fd, "rb"))
        try:
            os.write(writer_fd, b"partial")
            self.assertEqual(reader.read(3), b"par")
            self.assertEqual(reader.read(4), b"tial")
            with patch(__name__ + ".HELPER_DEADLINE_SECONDS", PIPE_QUEUE_POLL_SECONDS):
                with self.assertRaisesRegex(AssertionError, "timed out"):
                    reader.read(1)
            os.close(writer_fd)
            writer_fd = None
            with self.assertRaisesRegex(AssertionError, "unexpectedly exited"):
                reader.read(1)
        finally:
            if writer_fd is not None:
                os.close(writer_fd)
            reader.close()


class HelperContracts(unittest.TestCase):
    def test_extra_cli_arguments_are_rejected(self):
        with private_home() as temporary:
            result = subprocess.run(
                [sys.executable, "-m", "service.cli.browser", "--path", "not-allowed"],
                input=b"",
                capture_output=True,
                env={**os.environ, "SCHOLARSEED_HOME": temporary},
                timeout=10,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_malformed_binary_headers_fail_before_browser_directory_creation(self):
        cases = [
            b'{"version":1,"version":1}',
            b"{}trailing",
            b"\xff",
            json.dumps(
                {
                    "version": True,
                    "requestId": "request",
                    "verb": "handshake",
                    "profileId": "a" * 64,
                    "payloadLength": 0,
                }
            ).encode(),
            json.dumps(
                {
                    "version": 1,
                    "requestId": "request",
                    "verb": "handshake",
                    "profileId": "a" * 64,
                    "payloadLength": 1,
                }
            ).encode(),
            json.dumps(
                {
                    "version": 1,
                    "requestId": "request",
                    "verb": "handshake",
                    "profileId": "a" * 64,
                    "payloadLength": 0,
                    "path": "forbidden",
                }
            ).encode(),
        ]
        for body in cases:
            with self.subTest(body=body), private_home() as temporary:
                result = subprocess.run(
                    [sys.executable, "-m", "service.cli.browser"],
                    input=struct.pack("!I", len(body)) + body,
                    capture_output=True,
                    env={**os.environ, "SCHOLARSEED_HOME": temporary},
                    timeout=10,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stderr, b"")
                self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_header_length_over_budget_and_partial_frame_fail_closed(self):
        for body in (struct.pack("!I", 16385), b"\x00\x00", struct.pack("!I", 10) + b"{}"):
            with self.subTest(body=body), private_home() as temporary:
                result = subprocess.run(
                    [sys.executable, "-m", "service.cli.browser"],
                    input=body,
                    capture_output=True,
                    env={**os.environ, "SCHOLARSEED_HOME": temporary},
                    timeout=10,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_binary_handshake_read_cas_and_remove(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            helper = BinaryHelper(root)
            request = helper.request
            try:
                session = helper.session
                observed, body = request("read", sessionId=session, kind="vault")
                self.assertEqual(body, b"")
                self.assertIsNone(observed["digest"])
                result, _ = request(
                    "replace",
                    b"opaque\x00\n\r\xff",
                    sessionId=session,
                    kind="vault",
                    token=observed["token"],
                    expectedDigest=None,
                )
                self.assertEqual(result["outcome"], "committed")
                stale, _ = request(
                    "replace",
                    b"bad",
                    sessionId=session,
                    kind="vault",
                    token=observed["token"],
                    expectedDigest=None,
                )
                self.assertEqual(stale["code"], "conflict")
                observed, body = request("read", sessionId=session, kind="vault")
                self.assertEqual(body, b"opaque\x00\n\r\xff")
                removed, _ = request(
                    "remove",
                    sessionId=session,
                    kind="vault",
                    token=observed["token"],
                    expectedDigest=observed["digest"],
                    confirmDigest=observed["digest"],
                )
                self.assertEqual(removed["outcome"], "committed")
                absent, _ = request("read", sessionId=session, kind="vault")
                self.assertIsNone(absent["digest"])
            finally:
                helper.close()


class BinaryHelper:
    def __init__(self, root, instrumentation=None):
        self.profile = sha256(str(root).encode()).hexdigest()
        environment = {**os.environ, "SCHOLARSEED_HOME": str(root)}
        command = [sys.executable, "-m", "service.cli.browser"]
        if instrumentation:
            command = [sys.executable, "-c", instrumentation]
        self.process = subprocess.Popen(
            command,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.output = PipeReader(self.process.stdout)
        self.diagnostics = PipeReader(self.process.stderr)
        self.closed = False
        try:
            handshake, _ = self.request("handshake")
        except BaseException:
            self.close(kill=True)
            raise
        self.session = handshake["sessionId"]
        self.budgets = handshake["budgets"]

    def send(self, verb, payload=b"", **fields):
        header = {
            "version": 1,
            "requestId": "request",
            "verb": verb,
            "profileId": self.profile,
            "payloadLength": len(payload),
            **fields,
        }
        if hasattr(self, "session"):
            header["sessionId"] = self.session
        encoded = json.dumps(header).encode()
        self.process.stdin.write(struct.pack("!I", len(encoded)) + encoded + payload)
        self.process.stdin.flush()

    def receive(self):
        prefix = self.output.read(4)
        length = struct.unpack("!I", prefix)[0]
        if not 0 < length <= PIPE_HEADER_BYTES:
            raise AssertionError("helper header exceeds fixture budget")
        header = json.loads(self.output.read(length))
        payload_length = header["payloadLength"]
        if type(payload_length) is not int or not 0 <= payload_length <= PIPE_PAYLOAD_BYTES:
            raise AssertionError("helper payload exceeds fixture budget")
        return header, self.output.read(payload_length)

    def checkpoint(self):
        if self.diagnostics.read(len(CHECKPOINT)) != CHECKPOINT:
            raise AssertionError("checkpoint not reached")

    def request(self, verb, payload=b"", **fields):
        self.send(verb, payload, **fields)
        return self.receive()

    def mutate(self, verb, observed, payload=b""):
        fields = {"kind": "vault", "token": observed["token"], "expectedDigest": observed["digest"]}
        if verb == "remove":
            fields["confirmDigest"] = observed["digest"]
        return self.request(verb, payload, **fields)

    def close(self, kill=False):
        if self.closed:
            return
        self.closed = True
        if kill and self.process.poll() is None:
            self.process.kill()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=HELPER_DEADLINE_SECONDS)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=HELPER_DEADLINE_SECONDS)
            raise
        finally:
            errors = []
            for reader in (self.output, self.diagnostics):
                try:
                    reader.close()
                except Exception as error:
                    errors.append(error)
            if errors:
                raise ExceptionGroup("helper fixture reader cleanup", errors)


class RecoveryContracts(unittest.TestCase):
    def test_checkpoint_handshake_blocks_prepared_operation_until_control_release(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            instrumentation = """
import sys
from service.cli import browser
save=browser.Store.save_slot
def saving(self,kind,slot):
    result=save(self,kind,slot)
    if slot['active'] is not None and slot['active']['phase']=='prepared':
        sys.stderr.buffer.write(b'checkpoint')
        sys.stderr.buffer.flush()
        if sys.stdin.buffer.read(1)!=b'c': raise SystemExit(3)
    return result
browser.Store.save_slot=saving
raise SystemExit(browser.main())
"""
            helper = BinaryHelper(root, instrumentation)
            try:
                observed, _ = helper.request("read", kind="vault")
                helper.send(
                    "replace",
                    b"released",
                    kind="vault",
                    token=observed["token"],
                    expectedDigest=None,
                )
                helper.checkpoint()
                slot = json.loads((root / "service/browser/receipts/vault.json").read_bytes())
                self.assertEqual(slot["active"]["phase"], "prepared")
                self.assertFalse((root / "service/browser/vault.bin").exists())
                helper.process.stdin.write(b"c")
                helper.process.stdin.flush()
                terminal, _ = helper.receive()
                self.assertEqual(terminal["outcome"], "committed")
                _, payload = helper.request("read", kind="vault")
                self.assertEqual(payload, b"released")
            finally:
                helper.close()

    def test_real_helper_pipe_reader_does_not_require_socket_only_select(self):
        with private_home() as temporary:
            helper = BinaryHelper(Path(temporary).resolve())
            try:
                with patch.object(
                    select, "select", side_effect=AssertionError("pipe select unavailable")
                ):
                    observed, body = helper.request("read", kind="vault")
                self.assertEqual(body, b"")
                self.assertIsNone(observed["digest"])
            finally:
                helper.close()

    def test_terminal_retirement_is_atomic_and_old_intent_never_replays(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            helper = BinaryHelper(root)
            try:
                earliest = None
                for number in range(70):
                    observed, _ = helper.request("read", kind="vault")
                    if earliest is None:
                        earliest = observed
                    self.assertEqual(
                        helper.mutate("replace", observed, str(number).encode())[0]["outcome"],
                        "committed",
                    )
                retired, _ = helper.request(
                    "read",
                    kind="vault",
                    operationId=earliest["operationId"],
                    sequence=earliest["sequence"],
                )
                self.assertEqual(retired["code"], "result_retired")
                old, _ = helper.mutate("replace", earliest, b"replay")
                self.assertEqual(old["code"], "conflict")
                slot = json.loads((root / "service/browser/receipts/vault.json").read_bytes())
                self.assertEqual(slot["retiredThrough"], 6)
                self.assertEqual(len(slot["terminals"]), 64)
                self.assertIsNone(slot["active"])
                _, body = helper.request("read", kind="vault")
                self.assertEqual(body, b"69")
            finally:
                helper.close()

    def test_remove_active_double_missing_is_unknown_and_blocks_next_write(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            helper = BinaryHelper(root)
            try:
                observed, _ = helper.request("read", kind="vault")
                helper.mutate("replace", observed, b"A")
                observed, _ = helper.request("read", kind="vault")
                payload = root / "service/browser/vault.bin"
                identity = payload.stat()
                slot_file = root / "service/browser/receipts/vault.json"
                slot = json.loads(slot_file.read_bytes())
                before = {
                    "digest": observed["digest"],
                    "identity": [identity.st_dev, identity.st_ino],
                }
                slot["active"] = {
                    "operationId": observed["operationId"],
                    "sequence": observed["sequence"],
                    "verb": "remove",
                    "requestId": "request",
                    "before": before,
                    "after": {"digest": None, "identity": None},
                    "owned": {"name": "tombstone-" + "a" * 64, "snapshot": before},
                    "phase": "attempting",
                    "beforePresence": "present",
                    "resultPresence": "absent",
                }
                raw = json.dumps(slot).encode()
                slot_file.write_bytes(raw)
                payload.unlink()
                unknown, _ = helper.request("read", kind="vault")
                self.assertEqual(unknown["code"], "unknown")
                blocked, _ = helper.mutate("replace", observed, b"B")
                self.assertEqual(blocked["code"], "unknown")
                self.assertEqual(slot_file.read_bytes(), raw)
                self.assertFalse(payload.exists())
            finally:
                helper.close()

    def test_remove_cleanup_kill_before_and_after_does_not_restore_A_over_B(self):
        for after in (False, True):
            with self.subTest(after=after), private_home() as temporary:
                root = Path(temporary).resolve()
                helper = BinaryHelper(root)
                try:
                    observed, _ = helper.request("read", kind="vault")
                    helper.mutate("replace", observed, b"A")
                    observed, _ = helper.request("read", kind="vault")
                    helper.mutate("remove", observed)
                finally:
                    helper.close()
                instrumentation = f"""
import sys
from service.cli import browser
from service.platform import storage
remove=storage.DirectoryHandle.remove_private
def removing(self,name):
    if {after!r}: remove(self,name)
    sys.stderr.buffer.write(b'checkpoint')
    sys.stderr.buffer.flush()
    if sys.stdin.buffer.read(1)!=b'c': raise SystemExit(3)
    if not {after!r}: remove(self,name)
storage.DirectoryHandle.remove_private=removing
raise SystemExit(browser.main())
"""
                killed = BinaryHelper(root, instrumentation)
                try:
                    killed.send("read", kind="vault")
                    killed.checkpoint()
                finally:
                    killed.close(kill=True)
                recovered = BinaryHelper(root)
                try:
                    observed, body = recovered.request("read", kind="vault")
                    self.assertEqual(body, b"")
                    recovered.mutate("replace", observed, b"B")
                    _, body = recovered.request("read", kind="vault")
                    self.assertEqual(body, b"B")
                finally:
                    recovered.close()

    def test_unregistered_private_stage_quota_blocks_new_write_and_preserves_unknown(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            helper = BinaryHelper(root)
            try:
                observed, _ = helper.request("read", kind="vault")
                stages = root / "service/browser/stages"
                directory = storage.open_private_directory(stages, ())
                try:
                    for index in range(130):
                        descriptor = directory.open_private(
                            f"unknown-{index}", os.O_WRONLY | os.O_CREAT | os.O_EXCL
                        )
                        try:
                            os.write(descriptor, b"unknown-owner")
                        finally:
                            os.close(descriptor)
                finally:
                    directory.close()
                rejected, _ = helper.mutate("replace", observed, b"new")
                self.assertEqual(rejected.get("code"), "quota")
                self.assertEqual(len(list(stages.iterdir())), 130)
            finally:
                helper.close()

    def test_real_helper_kill_restart_settles_before_next_mutation(self):
        for verb in ("replace", "remove"):
            for checkpoint in ("prepared", "attempting", "renamed", "settled"):
                with (
                    self.subTest(verb=verb, checkpoint=checkpoint),
                    private_home() as temporary,
                ):
                    root = Path(temporary).resolve()
                    seed = BinaryHelper(root)
                    try:
                        observed, _ = seed.request("read", kind="vault")
                        seed.mutate("replace", observed, b"old-A")
                    finally:
                        seed.close()
                    instrumentation = f"""
import sys
from service.cli import browser
from service.platform import storage
save = browser.Store.save_slot
rename = storage.DirectoryHandle.replace_private
def pause():
    sys.stderr.buffer.write(b'checkpoint')
    sys.stderr.buffer.flush()
    if sys.stdin.buffer.read(1)!=b'c': raise SystemExit(3)
def saving(self,kind,slot):
    result=save(self,kind,slot)
    active=slot['active']
    if active is not None and active['phase']=={checkpoint!r}: pause()
    if {checkpoint!r}=='settled' and active is None and slot['settledThrough']==2: pause()
    return result
def renaming(self,source,destination,**kwargs):
    result=rename(self,source,destination,**kwargs)
    if {checkpoint!r}=='renamed' and (source=='vault.bin' or destination=='vault.bin'): pause()
    return result
browser.Store.save_slot=saving
storage.DirectoryHandle.replace_private=renaming
raise SystemExit(browser.main())
"""
                    helper = BinaryHelper(root, instrumentation)
                    try:
                        observed, _ = helper.request("read", kind="vault")
                        fields = {
                            "kind": "vault",
                            "token": observed["token"],
                            "expectedDigest": observed["digest"],
                        }
                        if verb == "remove":
                            fields["confirmDigest"] = observed["digest"]
                        helper.send(verb, b"new-A" if verb == "replace" else b"", **fields)
                        helper.checkpoint()
                    finally:
                        helper.close(kill=True)
                    recovered = BinaryHelper(root)
                    try:
                        state, body = recovered.request("read", kind="vault")
                        expected = (
                            b"old-A"
                            if checkpoint in ("prepared", "attempting")
                            else b"new-A" if verb == "replace" else b""
                        )
                        self.assertEqual(body, expected)
                        historical, _ = recovered.request(
                            "read",
                            kind="vault",
                            operationId=observed["operationId"],
                            sequence=observed["sequence"],
                        )
                        self.assertEqual(
                            historical["outcome"],
                            "aborted" if checkpoint in ("prepared", "attempting") else "committed",
                        )
                        self.assertEqual(
                            recovered.mutate("replace", state, b"B-after-A")[0]["outcome"],
                            "committed",
                        )
                        replay, _ = recovered.mutate(
                            verb, observed, b"replayed" if verb == "replace" else b""
                        )
                        self.assertEqual(replay["code"], "conflict")
                    finally:
                        recovered.close()
                    final = BinaryHelper(root)
                    try:
                        _, body = final.request("read", kind="vault")
                        self.assertEqual(body, b"B-after-A")
                    finally:
                        final.close()

    def test_cleanup_pending_A_does_not_classify_or_remove_recreated_B(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            instrumentation = """
import errno
from service.cli import browser
from service.platform import storage
def busy(self,name):
    raise OSError(errno.EBUSY,'injected cleanup-only failure')
storage.DirectoryHandle.remove_private=busy
raise SystemExit(browser.main())
"""
            helper = BinaryHelper(root, instrumentation)
            try:
                observed, _ = helper.request("read", kind="vault")
                helper.mutate("replace", observed, b"A")
                observed, _ = helper.request("read", kind="vault")
                helper.mutate("remove", observed)
                absent, _ = helper.request("read", kind="vault")
                helper.mutate("replace", absent, b"B")
                slot = json.loads((root / "service/browser/receipts/vault.json").read_bytes())
                self.assertEqual(len(slot["cleanup"]), 1)
                self.assertIsNone(slot["active"])
            finally:
                helper.close()
            recovered = BinaryHelper(root)
            try:
                _, body = recovered.request("read", kind="vault")
                self.assertEqual(body, b"B")
                slot = json.loads((root / "service/browser/receipts/vault.json").read_bytes())
                self.assertEqual(slot["cleanup"], [])
            finally:
                recovered.close()

    def test_corrupt_slot_blocks_without_reset_or_overwriting_payload(self):
        with private_home() as temporary:
            root = Path(temporary).resolve()
            helper = BinaryHelper(root)
            try:
                observed, _ = helper.request("read", kind="vault")
                helper.mutate("replace", observed, b"preserved")
                slot = root / "service/browser/receipts/vault.json"
                slot.write_bytes(b'{"version":1,"version":1}')
                rejected, _ = helper.request("read", kind="vault")
                self.assertIn(rejected["code"], ("unknown", "invalid"))
                self.assertEqual(slot.read_bytes(), b'{"version":1,"version":1}')
                self.assertEqual((root / "service/browser/vault.bin").read_bytes(), b"preserved")
            finally:
                helper.close()


if __name__ == "__main__":
    unittest.main()
