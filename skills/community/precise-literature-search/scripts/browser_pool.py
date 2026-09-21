#!/usr/bin/env scholarseed-skill-python
"""Three local, persistent Chrome leases. Unknown cleanup always fails closed.

Lock order: run lock -> pool lock -> nonblocking slot execution lock. The pool
lock is never held over process/network waits. Workers are registered before a
pipe gate lets them spawn Chrome/paper-dl in their dedicated process group.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from platform_support import WINDOWS, executable_command, lock_file, private_directory, utf8_environment
import json
import os
from pathlib import Path
import shutil
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener
from urllib.parse import urlparse

from io_utils import atomic_write_json, atomic_write_text, read_json
from process_control import ChildProcessCancelled, wait_for_exit
from profile_template import (
    ProfileInUse, create_template, initialize_profile, require_offline, sanitize_profile,
)

CAPACITY = 3
REFERENCE = "downloads/browser-lease.json"
WORKER_READY_TIMEOUT = 15


class PoolError(ValueError):
    pass


@contextmanager
def cancellation_signals():
    def cancelled(signum, _frame):
        raise ChildProcessCancelled(signum)
    previous = {sig: signal.signal(sig, cancelled) for sig in ((signal.SIGINT, signal.SIGTERM, signal.SIGBREAK) if WINDOWS else (signal.SIGINT, signal.SIGTERM))}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


@contextmanager
def run_lock(run_dir, *, blocking=True):
    path = Path(run_dir) / "downloads/.paid-download.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            lock_file(handle, blocking=blocking)
        except BlockingIOError as exc:
            raise PoolError("Run is executing; stop its adapter before abandoning its browser slot") from exc
        yield


def process_identity(pid):
    if WINDOWS:
        from windows_support import process_identity as identity
        return identity(pid)
    # Include the worker's unique lease argument as well as start time; ps start
    # times alone have only second precision and are insufficient for PID reuse.
    result = subprocess.run(["ps", "-p", str(int(pid)), "-o", "lstart=", "-o", "command="],
                            text=True, capture_output=True)
    if result.returncode not in (0, 1):
        raise PoolError("Cannot inspect process ownership; slot remains reserved")
    return result.stdout.strip() or None


def group_members(pgid):
    inspector = subprocess.Popen(["ps", "-axo", "pid=,pgid=,stat="], text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output, _ = inspector.communicate()
    if inspector.returncode:
        raise PoolError("Cannot inspect process groups; slot remains reserved")
    members = []
    for line in output.splitlines():
        pid, group, status = line.split()[:3]
        if int(group) == pgid and int(pid) != inspector.pid and not status.startswith("Z"):
            members.append(int(pid))
    return members


def stop_process(record, timeout=5):
    """Signal only a registered group whose leader still has its original identity."""
    if not record:
        return
    if WINDOWS:
        from windows_support import stop_record
        return stop_record(record, timeout)
    pid = record["pid"]
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not group_members(pid):
            return
        if process_identity(pid) != record["started"]:
            raise PoolError("Process ownership cannot be verified; close the old processes manually and retry abandon")
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not group_members(pid):
                return
            time.sleep(0.1)
    raise PoolError("Registered process group did not exit; slot remains reserved")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PoolError("CDP redirect refused")


def cdp_json(endpoint, path):
    # endpoint is constructed exclusively from a pool-owned DevToolsActivePort.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(endpoint + path, timeout=1.5) as response:
        return json.loads(response.read(1024 * 1024))


def validate_config():
    for name in ("PAPER_DL_CDP_ENDPOINT", "PAPER_DL_CDP_PROFILE"):
        if os.getenv(name):
            raise PoolError(f"Unset {name}: interactive downloads now use the shared three-slot browser pool")
    if os.getenv("PAPER_DL_ZOTERO_MODE", "off") != "off":
        raise PoolError("The browser-pool requires PAPER_DL_ZOTERO_MODE=off; Zotero concurrency is not supported")
    if os.getenv("PAPER_DL_AUTO_LAUNCH_CHROME", "yes").lower() in {"0", "no", "false"}:
        raise PoolError("The browser pool owns Chrome startup; unset PAPER_DL_AUTO_LAUNCH_CHROME")


def chrome_executable():
    configured = os.getenv("PAPER_DL_CHROME_EXECUTABLE")
    candidates = [configured] if configured else [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        str(Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        shutil.which("google-chrome"), shutil.which("google-chrome-stable"), shutil.which("chromium"),
    ]
    if WINDOWS and not configured:
        candidates = [str(Path(base) / vendor / "Application/chrome.exe")
                      for key in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")
                      if (base := os.getenv(key)) for vendor in ("Google/Chrome", "Chromium")]
        candidates.append(shutil.which("chrome.exe"))
    for value in candidates:
        if value and Path(value).is_file() and os.access(value, os.X_OK):
            return str(Path(value).resolve())
    raise PoolError("Chrome executable not found; install Chrome and configure PAPER_DL_CHROME_EXECUTABLE or PATH")


class BrowserPool:
    def __init__(self, root=None):
        self.default_root = (Path.home() / ".paper-dl/browser-pool").resolve()
        self.root = Path(root or os.getenv("PAPER_DL_BROWSER_POOL_DIR") or self.default_root).expanduser().resolve()

    def profile_path(self, slot):
        if self.root == self.default_root:
            if slot == 1:
                return Path.home() / ".paper-dl-cdp-profile"
            return Path.home() / ".paper-dl-cdp-profile-pool" / f"slot-{slot - 1}"
        # Preserve explicit pool overrides and their existing isolated profiles.
        return self.root / f"slot-{slot}" / "profile"

    def prepare(self, run_dir):
        paths = [self.root, *(self.profile_path(slot) for slot in range(1, CAPACITY + 1))]
        if any(path.resolve() == run_dir or run_dir in path.resolve().parents for path in paths):
            raise PoolError("Browser pool profiles must stay outside the run directory")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            private_directory(self.root)
        except ValueError as exc:
            raise PoolError(str(exc)) from exc

    @contextmanager
    def locked(self):
        with (self.root / "pool.lock").open("a+") as handle:
            lock_file(handle)
            yield

    def state_path(self, slot):
        return self.root / f"slot-{slot}" / "state.json"

    def state(self, slot):
        path = self.state_path(slot)
        if not path.exists():
            return None
        state = read_json(path)
        if not isinstance(state, dict) or state.get("version") != 1 or state.get("slot") != slot:
            raise PoolError(f"Invalid browser-pool state in slot {slot}; refusing allocation")
        return state

    def acquire(self, run_dir, *, existing_only=False, maintenance=False, on_wait=None):
        run_dir = Path(run_dir).resolve()
        if existing_only and not self.root.exists() and not (run_dir / REFERENCE).exists():
            return None
        self.prepare(run_dir)
        ref_path = run_dir / REFERENCE
        while True:
            primary_busy = False
            # Legacy Chrome has no pool lease. Inspect it outside the pool lock
            # and leave its profile untouched, using a parallel slot instead.
            if self.root == self.default_root and not existing_only and not ref_path.exists():
                try:
                    require_offline(self.profile_path(1))
                except ProfileInUse:
                    primary_busy = True
            with self.locked():
                ref = read_json(ref_path) if ref_path.exists() else None
                if ref and ref.get("pool") != str(self.root):
                    raise PoolError("Run belongs to a different browser pool; use its original PAPER_DL_BROWSER_POOL_DIR")
                states = [self.state(slot) for slot in range(1, CAPACITY + 1)]
                owned = next((s for s in states if s and s.get("run_dir") == str(run_dir)), None)
                if owned:
                    # The durable state is authoritative if the run reference write was interrupted.
                    if ref and (ref.get("lease_id") != owned["lease_id"] or ref.get("slot") != owned["slot"]):
                        raise PoolError("Stale browser lease reference; refusing resume or release")
                    if not maintenance and owned["phase"] != "waiting_user":
                        raise PoolError("Previous browser execution did not pause cleanly; run browser_pool.py abandon first")
                    state = owned
                else:
                    if ref:
                        raise PoolError("Stale browser lease reference; refusing resume or release")
                    if existing_only:
                        return None
                    slot = next((i for i, s in enumerate(states, 1)
                                 if s is None and not (i == 1 and primary_busy)), None)
                    state = None if slot is None else {
                        "version": 1, "slot": slot, "lease_id": uuid.uuid4().hex,
                        "run_dir": str(run_dir), "phase": "allocated", "browser": None,
                        "download": None, "endpoint": None,
                        "profile": str(self.profile_path(slot).resolve()),
                    }
                if state is not None:
                    slot_dir = self.root / f'slot-{state["slot"]}'
                    slot_dir.mkdir(exist_ok=True, mode=0o700)
                    handle = (slot_dir / "execution.lock").open("a+")
                    try:
                        lock_file(handle, blocking=False)
                    except BlockingIOError:
                        handle.close()
                        if not owned:
                            continue
                        raise PoolError("This browser slot is already executing; retry after it finishes")
                    try:
                        atomic_write_json(self.state_path(state["slot"]), state)
                        atomic_write_json(ref_path, {"pool": str(self.root), "slot": state["slot"], "lease_id": state["lease_id"]})
                    except BaseException:
                        handle.close()
                        raise
                    return Lease(self, run_dir, state, handle)
            if on_wait:
                on_wait()
            time.sleep(0.25)

    def status(self):
        if not self.root.exists():
            return []
        with self.locked():
            return [self.state(slot) for slot in range(1, CAPACITY + 1)]


class Lease:
    def __init__(self, pool, run_dir, state, handle):
        self.pool, self.run_dir, self.state, self.handle = pool, run_dir, state, handle
        # Leases from the previous layout have no profile field. Resume them
        # at their original location, even after the defaults change.
        self.profile = Path(state.get("profile", pool.root / f'slot-{state["slot"]}' / "profile"))
        self.children = []

    @property
    def endpoint(self):
        return self.state.get("endpoint")

    def save(self, **changes):
        with self.pool.locked():
            current = self.pool.state(self.state["slot"])
            if not current or current["lease_id"] != self.state["lease_id"]:
                raise PoolError("Stale browser lease; refusing mutation")
            self.state.update(changes)
            atomic_write_json(self.pool.state_path(self.state["slot"]), self.state)

    def spawn(self, kind, command, cwd=None):
        if WINDOWS:
            return self.spawn_windows(kind, command, cwd)
        # No child is launched until ownership has been durably recorded. On EOF
        # (parent killed before granting the gate), the worker exits without work.
        self.save(phase=f"starting_{kind}")
        gate_read, gate_write = os.pipe()
        try:
            ready_read, ready_write = os.pipe()
        except BaseException:
            os.close(gate_read)
            os.close(gate_write)
            raise
        try:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "_worker", str(gate_read),
                 str(ready_write), self.state["lease_id"]],
                stdin=subprocess.DEVNULL if kind == "browser" else None,
                stdout=subprocess.DEVNULL if kind == "browser" else None,
                stderr=subprocess.DEVNULL if kind == "browser" else None,
                text=True, start_new_session=True, pass_fds=(gate_read, ready_write),
            )
        except BaseException:
            os.close(gate_write)
            os.close(ready_read)
            raise
        finally:
            os.close(gate_read)
            os.close(ready_write)
        self.children.append(process)
        with os.fdopen(gate_write, "w") as gate, os.fdopen(ready_read, "rb", buffering=0) as ready:
            try:
                # macOS Python launchers can exec the framework interpreter
                # after Popen returns. Record identity only once our Python
                # worker has initialized and is waiting at the command gate.
                readable, _, _ = select.select([ready], [], [], WORKER_READY_TIMEOUT)
                if not readable:
                    raise PoolError("Managed worker initialization timed out before registration")
                if ready.read(6) != b"READY\n":
                    raise PoolError("Managed worker exited before initialization")
            except BaseException:
                # No command has been granted: this direct Popen child cannot
                # have launched Chrome/paper-dl. Reap only that child handle.
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
                raise
            started = process_identity(process.pid)
            if not started:
                raise PoolError("Managed process exited before registration")
            self.save(**{kind: {"pid": process.pid, "started": started}})
            request = {"command": command, "cwd": str(cwd) if cwd else None}
            if kind == "browser":
                request.update(ready_file=str(self.profile / "DevToolsActivePort"), port=self.state["port"])
            gate.write(json.dumps(request) + "\n")
            gate.flush()
        return process

    def spawn_windows(self, kind, command, cwd=None):
        from windows_support import grant, start_worker, stop_record
        self.save(phase=f"starting_{kind}")
        options = {"text": True, "encoding": "utf-8", "env": utf8_environment()}
        if kind == "browser":
            options.update(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process, record = start_worker(Path(__file__).resolve(), "_windows_worker",
                                       kwargs=options, breakaway=kind == "browser")
        self.children.append(process)
        try:
            self.save(**{kind: record})
            request = {"command": executable_command(command), "cwd": str(cwd) if cwd else None}
            if kind == "browser":
                request.update(ready_file=str(self.profile / "DevToolsActivePort"), port=self.state["port"])
            grant(process, request)
        except BaseException:
            process._pls_gate.close()
            stop_record(record)
            process.wait(timeout=5)
            raise
        return process

    def prepare_profile(self):
        # Check before touching Preferences/history, including for legacy
        # profiles which may be open outside this pool. Paused resumes skip it.
        require_offline(self.profile)
        initialize_profile(self.profile, self.pool.root)
        self.profile.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.profile.mkdir(exist_ok=True, mode=0o700)
        if WINDOWS:
            private_directory(self.profile)
        # This profile is pool-owned. Keep cookies/login stores, discard only
        # session restoration and download/history databases between leases.
        sanitize_profile(self.profile)

    def verify_browser(self):
        record = self.state.get("browser")
        if not record or process_identity(record["pid"]) != record["started"]:
            raise PoolError("Owned Chrome process is unavailable; abandon this lease before retrying")
        active = (self.profile / "DevToolsActivePort").read_text().splitlines()
        port = int(active[0])
        if not 0 < port < 65536 or not active[1].startswith("/devtools/browser/"):
            raise PoolError("Invalid owned Chrome discovery record")
        if self.state.get("port") is not None and port != self.state["port"]:
            raise PoolError("Chrome discovery port does not match this lease's reservation")
        endpoint = f"http://127.0.0.1:{port}"
        version = cdp_json(endpoint, "/json/version")
        websocket = urlparse(version.get("webSocketDebuggerUrl", ""))
        if websocket.hostname != "127.0.0.1" or websocket.port != port or websocket.path != active[1]:
            raise PoolError("CDP endpoint does not belong to the leased Chrome")
        if self.endpoint and self.endpoint != endpoint:
            raise PoolError("Owned Chrome endpoint changed unexpectedly")
        return endpoint

    def reserve_port(self):
        """Select a nonzero port while excluding other slots' startup reservations.

        The socket must be released before Chrome binds. If another process wins
        that race, Chrome must still announce its own matching CDP identity; we
        never trust a service merely because it responds on the reserved port.
        """
        with self.pool.locked():
            current = self.pool.state(self.state["slot"])
            if not current or current["lease_id"] != self.state["lease_id"]:
                raise PoolError("Stale browser lease; refusing port allocation")
            reserved = {state.get("port") for slot in range(1, CAPACITY + 1)
                        if (state := self.pool.state(slot))}
            for _ in range(32):
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                    if port in reserved:
                        continue
                    self.state["port"] = port
                    atomic_write_json(self.pool.state_path(self.state["slot"]), self.state)
                    return port
            raise PoolError("Could not reserve a distinct browser port")

    def ensure_browser(self, timeout=15):
        if self.state.get("browser"):
            endpoint = self.verify_browser()
            self.save(phase="running", endpoint=endpoint)
            return
        executable = chrome_executable()
        self.prepare_profile()
        port = self.reserve_port()
        process = self.spawn("browser", [executable, "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={port}", f"--user-data-dir={self.profile}",
            "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble", "about:blank"])
        deadline = time.monotonic() + timeout
        last_error = "Chrome startup timed out"
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise PoolError("Managed Chrome exited during startup")
            try:
                endpoint = self.verify_browser()
                pages = cdp_json(endpoint, "/json/list")
                if not isinstance(pages, list) or any(
                    page.get("type") == "page" and page.get("url") not in {"", "about:blank", "chrome://newtab/"}
                    for page in pages
                ):
                    raise PoolError("Chrome restored old pages; slot cannot start a new download")
                self.save(phase="running", endpoint=endpoint)
                return
            except (OSError, ValueError, IndexError) as exc:
                last_error = str(exc)
                time.sleep(0.2)
        raise PoolError(f"Owned Chrome did not become ready: {last_error}")

    def run_download(self, command, cwd=None, text=True, timeout=None):
        self.verify_browser()
        process = self.spawn("download", command, cwd)
        self.save(phase="running")
        returncode = wait_for_exit(process, timeout=timeout)
        if WINDOWS:
            from windows_support import record_active
            descendants = record_active(self.state["download"])
        else:
            descendants = bool(group_members(process.pid))
        if descendants:
            raise PoolError("Download descendants still exist; slot remains reserved")
        self.save(download=None)
        return subprocess.CompletedProcess(command, returncode)

    def pause(self):
        if self.state.get("download"):
            raise PoolError("Cannot pause with an active download process")
        self.save(phase="waiting_user")

    def release(self):
        self.save(phase="cleaning")
        try:
            for kind in ("download", "browser"):
                stop_process(self.state.get(kind))
                self.save(**{kind: None})
            for child in self.children:
                child.wait(timeout=2)
            # Delete the reference first. A crash in between is repaired from
            # the durable slot ownership; stale references never free a new lease.
            with self.pool.locked():
                current = self.pool.state(self.state["slot"])
                if not current or current["lease_id"] != self.state["lease_id"]:
                    raise PoolError("Stale browser lease; refusing release")
                (self.run_dir / REFERENCE).unlink(missing_ok=True)
                self.pool.state_path(self.state["slot"]).unlink()
        except BaseException:
            self.save(phase="needs_cleanup")
            raise

    def close(self):
        self.handle.close()


def abandon(run_dir):
    """Caller must hold the run lock; refuses to race an active slot executor."""
    lease = BrowserPool().acquire(run_dir, existing_only=True, maintenance=True)
    if lease:
        try:
            lease.release()
        finally:
            lease.close()
    return {"browser_pool_released": True, "had_lease": lease is not None}


def record_browser_ready(stderr, ready_file, expected_port):
    """Keep only Chrome's own CDP announcement, discard all other stderr.

    Chrome writes DevToolsActivePort itself only with --remote-debugging-port=0.
    Nonzero ports retain the original interactive launch behavior. The owned
    child's stderr provides the same unguessable browser identity without
    trusting an unrelated process which may have raced to bind the port.
    """
    with stderr:
        while line := stderr.readline(65536):
            prefix = b"DevTools listening on "
            if not line.strip().startswith(prefix):
                continue
            try:
                url = urlparse(line.strip()[len(prefix):].decode("ascii"))
                if (url.scheme != "ws" or url.hostname != "127.0.0.1"
                        or url.port != expected_port or url.username or url.password
                        or url.query or url.fragment
                        or not url.path.startswith("/devtools/browser/")):
                    continue
                atomic_write_text(Path(ready_file), f"{expected_port}\n{url.path}\n")
            except (UnicodeError, ValueError):
                continue


def worker(gate_fd, ready_fd=None):
    if ready_fd is not None:
        with os.fdopen(ready_fd, "wb", buffering=0) as ready:
            ready.write(b"READY\n")
    with os.fdopen(gate_fd) as gate:
        line = gate.readline()
    if not line:
        return 0
    data = json.loads(line)
    # Caught signals revert to default in exec'd children. The supervisor stays
    # alive to prove group identity until all regular descendants have exited.
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: None)
    ready_file = data.get("ready_file")
    child = subprocess.Popen(data["command"], cwd=data["cwd"],
                             stderr=subprocess.PIPE if ready_file else None)
    reader = None
    if ready_file:
        reader = threading.Thread(target=record_browser_ready,
                                  args=(child.stderr, ready_file, data["port"]), daemon=True)
        reader.start()
    result = child.wait()
    if reader:
        reader.join(timeout=2)
    while any(pid != os.getpid() for pid in group_members(os.getpgrp())):
        time.sleep(0.1)
    return result if result >= 0 else 128 - result


def windows_worker(name, port, token):
    from windows_support import active_count, worker_request
    # Keep the handle until process exit. Closing it explicitly would kill this
    # supervisor too and overwrite its successful exit status.
    job, data = worker_request(name, port, token)
    if data is None:
        return 0
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGBREAK):
        signal.signal(sig, lambda *_: None)
    ready_file = data.get("ready_file")
    child = subprocess.Popen(executable_command(data["command"]), cwd=data["cwd"],
                             stderr=subprocess.PIPE if ready_file else None,
                             env=utf8_environment())
    reader = None
    if ready_file:
        reader = threading.Thread(target=record_browser_ready,
                                  args=(child.stderr, ready_file, data["port"]), daemon=True)
        reader.start()
    result = child.wait()
    if reader:
        reader.join(timeout=2)
    while active_count(job) > 1:
        time.sleep(0.1)
    return result


def main():
    if WINDOWS and len(sys.argv) == 5 and sys.argv[1] == "_windows_worker":
        return windows_worker(*sys.argv[2:5])
    if len(sys.argv) == 5 and sys.argv[1] == "_worker":
        return worker(int(sys.argv[2]), int(sys.argv[3]))
    # Allow a parent already running the previous version to finish its spawn.
    if len(sys.argv) == 4 and sys.argv[1] == "_worker":
        return worker(int(sys.argv[2]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "abandon", "create-template"])
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--source-profile", type=Path, help="Closed Chrome user-data directory containing Default")
    parser.add_argument("--template-dir", type=Path, help="New output directory; defaults to pool/profile-template")
    args = parser.parse_args()
    try:
        if args.command == "status":
            result = BrowserPool().status()
        elif args.command == "create-template":
            if args.source_profile is None:
                raise PoolError("create-template requires --source-profile")
            destination = args.template_dir or BrowserPool().root / "profile-template"
            with cancellation_signals():
                path = create_template(args.source_profile, destination)
            result = {"profile_template": str(path), "created": True}
        else:
            if args.run_dir is None or not args.run_dir.is_dir():
                raise PoolError("abandon requires an existing --run-dir")
            with cancellation_signals(), run_lock(args.run_dir, blocking=False):
                result = abandon(args.run_dir.resolve())
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, ChildProcessCancelled) as exc:
        print(f"browser pool: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
