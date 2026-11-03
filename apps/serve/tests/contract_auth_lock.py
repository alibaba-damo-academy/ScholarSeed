"""Actual process contention and read-modify-write for the identity owner."""

from __future__ import annotations

import json
import multiprocessing
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from service.identity.persistence import store


def contend(path, attempting, entered, done):
    store.AUTH_FILE = Path(path)
    attempting.set()
    with store.auth_file_lock():
        entered.set()
        if not done.wait(10):
            raise TimeoutError("test parent did not release child")


def increment(path, ready):
    store.AUTH_FILE = Path(path)
    if not ready.wait(10):
        raise TimeoutError("test start gate")
    for _ in range(8):
        with store.auth_file_lock():
            data = store.load_auth_data()
            data["count"] = data.get("count", 0) + 1
            time.sleep(0.005)
            store.save_auth_data(data)


def time_out(path, result):
    store.AUTH_FILE = Path(path)
    store.AUTH_LOCK_TIMEOUT_SECONDS = 0.15
    try:
        with store.auth_file_lock():
            result.put("entered")
    except TimeoutError:
        result.put("timeout")


class AuthLockContract(unittest.TestCase):
    def test_timeout_preserves_data_without_entering_transaction(self):
        context = multiprocessing.get_context("spawn")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            path.write_bytes(b"unchanged")
            result = context.Queue()
            child = context.Process(target=time_out, args=(str(path), result))
            try:
                with patch.object(store, "AUTH_FILE", path), store.auth_file_lock():
                    child.start()
                    self.assertEqual(result.get(timeout=10), "timeout")
                    self.assertEqual(path.read_bytes(), b"unchanged")
                child.join(10)
                self.assertEqual(child.exitcode, 0)
            finally:
                if child.is_alive():
                    child.terminate()
                    child.join(5)
                result.close()
                result.join_thread()

    def test_other_process_cannot_enter_until_owner_releases(self):
        context = multiprocessing.get_context("spawn")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            attempting, entered, done = (context.Event() for _ in range(3))
            child = context.Process(target=contend, args=(str(path), attempting, entered, done))
            try:
                with patch.object(store, "AUTH_FILE", path), store.auth_file_lock():
                    child.start()
                    self.assertTrue(attempting.wait(10))
                    self.assertFalse(entered.wait(0.3), "another process entered the held lock")
                    self.assertFalse(path.exists())
                self.assertTrue(entered.wait(10))
            finally:
                done.set()
                child.join(15)
                if child.is_alive():
                    child.terminate()
                    child.join(5)
            self.assertEqual(child.exitcode, 0)
            self.assertTrue((path.parent / "auth.lock").is_file())

    def test_process_writes_preserve_every_update_and_unknown_fields(self):
        context = multiprocessing.get_context("spawn")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            path.write_text(json.dumps({"users": [], "tokens": [], "future": "preserved"}))
            ready = context.Event()
            children = [
                context.Process(target=increment, args=(str(path), ready)) for _ in range(4)
            ]
            try:
                for child in children:
                    child.start()
                ready.set()
                for child in children:
                    child.join(20)
                    self.assertEqual(child.exitcode, 0)
            finally:
                for child in children:
                    if child.is_alive():
                        child.terminate()
                        child.join(5)
            data = json.loads(path.read_bytes())
            self.assertEqual(data["count"], 32)
            self.assertEqual(data["future"], "preserved")


if __name__ == "__main__":
    unittest.main()
