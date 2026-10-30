"""Real native leases must join short writes without weakening maintenance."""

from __future__ import annotations

import subprocess
import sys
import time
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from service.platform.domains import DomainBusyError, DomainReleaseError, Domains
from service.platform.storage import (
    DarwinDirectoryNative,
    LeaseError,
    LinuxDirectoryNative,
    WindowsDirectoryNative,
)

from ._directories import directory, make_directory
from .contract_domains import Native, NativeError, identity

NATIVE = {
    "darwin": DarwinDirectoryNative,
    "linux": LinuxDirectoryNative,
    "win32": WindowsDirectoryNative,
}[sys.platform]

WRITER = """
import sys, time
from service.platform.domains import Domains
from service.platform.storage import DarwinDirectoryNative, LinuxDirectoryNative, WindowsDirectoryNative
native = {'darwin': DarwinDirectoryNative, 'linux': LinuxDirectoryNative,
          'win32': WindowsDirectoryNative}[sys.platform]()
owner = Domains(native, sys.argv[1], [sys.argv[2]])
owner.occupy()
if sys.argv[3] == 'occupancy': owner.admit()
print('ready', flush=True)
time.sleep(float(sys.argv[4]))
if sys.argv[3] == 'both':
    owner.admit()
    time.sleep(float(sys.argv[4]))
with open(sys.argv[2] + '/completed.log', 'w') as output:
    output.write('actual writer IO complete')
owner.close()
"""


class DirectoryWaitContract(unittest.TestCase):
    @contextmanager
    def writer(self, phase: str, delay: float = 0.3):
        with directory("ss-lease-wait-") as root:
            coordinator = make_directory(parent=root)
            home = make_directory(parent=root)
            logs = make_directory(parent=home)
            child = subprocess.Popen(
                [sys.executable, "-c", WRITER, str(coordinator), str(logs), phase, str(delay)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(child.stdout.readline().strip(), "ready")
                yield NATIVE(), str(coordinator), str(home), logs
            finally:
                stdout, stderr = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, stdout + stderr)
                # Check the SAME directory identities after child close, so
                # partial-lock leaks from a timed out acquisition are visible.
                probe = Domains(NATIVE(), str(coordinator), [str(home)], maintenance=True)
                probe.occupy()
                probe.close()

    def test_maintenance_waits_for_real_descendant_log_writer(self):
        for phase in ("admission", "occupancy"):
            with self.subTest(phase=phase), self.writer(phase) as (native, coordinator, home, logs):
                started = time.monotonic()
                owner = Domains(native, coordinator, [home], maintenance=True, busy_timeout=2)
                try:
                    owner.occupy()
                    self.assertGreaterEqual(time.monotonic() - started, 0.2)
                    self.assertEqual(
                        (logs / "completed.log").read_text(), "actual writer IO complete"
                    )
                    with owner.mutation():
                        (logs.parent / "maintenance.txt").write_text("qualified")
                    # Admission stays closed through the actual maintenance IO.
                    with self.assertRaises(LeaseError) as error:
                        Domains(NATIVE(), coordinator, [str(logs)])
                    self.assertEqual(error.exception.code, "ERR_LEASE_BUSY")
                finally:
                    owner.close()

    def test_default_still_fails_busy_without_waiting(self):
        with self.writer("admission") as (native, coordinator, home, logs):
            with self.assertRaises(LeaseError) as error:
                Domains(native, coordinator, [home], maintenance=True)
            self.assertEqual(error.exception.code, "ERR_LEASE_BUSY")
            self.assertFalse((logs / "completed.log").exists())

    def test_timeout_cannot_grant_mutation_or_leak_partial_locks(self):
        for phase in ("admission", "occupancy"):
            with self.subTest(phase=phase), self.writer(phase) as (native, coordinator, home, logs):
                owner = None
                try:
                    with self.assertRaises(LeaseError) as error:
                        owner = Domains(
                            native, coordinator, [home], maintenance=True, busy_timeout=0.08
                        )
                        owner.occupy()
                    self.assertEqual(error.exception.code, "ERR_LEASE_BUSY")
                    self.assertFalse((logs / "completed.log").exists())
                    if owner is not None:
                        with self.assertRaises(RuntimeError):
                            with owner.mutation():
                                self.fail("timed out maintenance may not mutate")
                finally:
                    if owner is not None:
                        owner.close()

    def test_other_native_failures_are_never_retried(self):
        for code in ("ERR_LEASE_CHANGED", "ERR_LEASE_RELEASE"):
            native = Native()
            attempts = []

            def acquire(*args, attempts=attempts, code=code):
                attempts.append(args)
                raise NativeError(code)

            native.acquire_at = acquire
            expected = DomainReleaseError if code == "ERR_LEASE_RELEASE" else NativeError
            with self.subTest(code=code), self.assertRaises(expected):
                Domains(native, "/coordinator", ["/data"], maintenance=True, busy_timeout=2)
            self.assertEqual(len(attempts), 1)
            self.assertEqual(bool(native.held), code == "ERR_LEASE_RELEASE")

    def test_persistent_membership_is_not_a_short_native_write(self):
        native = Native()
        native.membership(identity(3), "self", b"retained original family")
        owner = Domains(native, "/coordinator", ["/data"], maintenance=True, busy_timeout=2)
        try:
            with self.assertRaises(DomainBusyError):
                owner.occupy()
            with self.assertRaises(RuntimeError):
                with owner.mutation():
                    self.fail("persistent family must still block maintenance")
        finally:
            owner.close()

    def test_admission_and_occupancy_share_one_wait_budget(self):
        # This checks deadline accounting, not scheduler latency. The other
        # writer cases retain real kernel/subprocess coverage for waiting.
        for budget, expires in ((0.3, True), (0.5, False)):
            with self.subTest(budget=budget):
                native = Native()
                now = [0.0]
                acquire = native.acquire_at
                selected = identity(3).replace(":", "-")
                available = {
                    selected + "-admission-a": 0.2,
                    selected + "-occupancy-a": 0.4,
                }

                def delayed_acquire(
                    pin, name, exclusive, now=now, available=available, acquire=acquire
                ):
                    if now[0] < available.get(name, 0.0):
                        raise NativeError("ERR_LEASE_BUSY")
                    return acquire(pin, name, exclusive)

                def advance(seconds, now=now):
                    now[0] = round(now[0] + seconds, 10)

                native.acquire_at = delayed_acquire
                clock = SimpleNamespace(monotonic=lambda now=now: now[0], sleep=advance)
                with patch("service.platform.domains.time", clock):
                    owner = Domains(
                        native, "/coordinator", ["/data"], maintenance=True, busy_timeout=budget
                    )
                    try:
                        self.assertAlmostEqual(now[0], 0.2)
                        if expires:
                            with self.assertRaises(NativeError) as error:
                                owner.occupy()
                            self.assertEqual(error.exception.code, "ERR_LEASE_BUSY")
                            self.assertAlmostEqual(now[0], 0.3)
                        else:
                            owner.occupy()
                            self.assertAlmostEqual(now[0], 0.4)
                    finally:
                        owner.close()
                self.assertEqual(native.held, {})

    def test_wait_is_explicit_bounded_and_maintenance_only(self):
        for value in (-1, 6, True, float("nan"), float("inf"), "1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                Domains(NATIVE(), "/unused", ["/unused"], maintenance=True, busy_timeout=value)
        with self.assertRaises(ValueError):
            Domains(NATIVE(), "/unused", ["/unused"], busy_timeout=0.1)


if __name__ == "__main__":
    unittest.main()
