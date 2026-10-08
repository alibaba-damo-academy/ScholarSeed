from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import progress


class HeartbeatPathTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.run = self.root / "run"
        self.run.mkdir()
        self.now = datetime.now(timezone.utc)
        progress.update_progress(self.run, stage="reading", activity="Reading", now=self.now)

    def assert_canonical_heartbeat(self, path):
        with (
            mock.patch.object(progress, "read_progress", wraps=progress.read_progress) as reader,
            mock.patch.object(
                progress, "atomic_write_json", wraps=progress.atomic_write_json
            ) as writer,
            mock.patch.object(progress, "_progress_lock", wraps=progress._progress_lock) as lock,
        ):
            self.assertTrue(progress.heartbeat_if_due(path, now=self.now + timedelta(seconds=21)))
        lock.assert_called_once_with(self.run)
        reader.assert_called_once_with(self.run)
        self.assertEqual(writer.call_args.args[0], self.run / progress.PROGRESS_FILENAME)
        self.assertEqual(progress.read_progress(self.run)["sequence"], 2)

    def test_relative_path_uses_one_canonical_identity(self):
        self.assert_canonical_heartbeat(Path(os.path.relpath(self.run)))

    @unittest.skipIf(os.name == "nt", "symlink creation needs separate Windows privileges")
    def test_symlink_uses_one_canonical_identity(self):
        alias = self.root / "alias"
        alias.symlink_to(self.run, target_is_directory=True)
        self.assert_canonical_heartbeat(alias)
