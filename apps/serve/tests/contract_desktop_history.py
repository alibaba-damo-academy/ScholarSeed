"""Real Desktop history codec over private SQLite snapshots; not package acceptance."""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from service.cli.desktop_history import (
    HISTORY_NAME,
    HISTORY_OWNERS,
    history_directory,
    initialize_schema,
)
from service.persistence.preview import (
    preview_database,
    projected_database,
    require_candidate_layout,
)
from service.persistence.rows import rows_digest


class DesktopHistoryContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = tempfile.TemporaryDirectory(prefix="desktop-history-codec-")
        cls.addClassCleanup(cls.bundle.cleanup)
        root = Path(__file__).resolve().parents[3]
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Desktop history contracts require repository Node")
        script = Path(cls.bundle.name) / "inspection.cjs"
        subprocess.run(
            [
                str(root / "apps/desktop/node_modules/esbuild/bin/esbuild"),
                str(root / "apps/desktop/src/main/data-inspection.ts"),
                "--bundle",
                "--platform=node",
                "--format=cjs",
                f"--outfile={script}",
            ],
            check=True,
            capture_output=True,
        )
        cls.environment = {
            "SCHOLARSEED_DESKTOP_INSPECTION_EXECUTABLE": node,
            "SCHOLARSEED_DESKTOP_INSPECTION_SCRIPT": str(script),
        }

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="desktop-history-data-")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.database = self.home / "history.sqlite3"
        self.environment_patch = patch.dict(os.environ, self.environment)
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)

    def create_database(self):
        connection = sqlite3.connect(self.database)
        initialize_schema(connection)
        connection.execute(
            "INSERT INTO browser_visits VALUES (?, ?, ?, ?, ?)",
            ("visit", "https://example.org/a", "https://example.org", "Page", 10),
        )
        connection.commit()
        return connection

    def test_projection_repairs_only_private_copy_and_reads_actual_rows(self):
        with closing(self.create_database()) as connection:
            connection.execute("DROP INDEX browser_visits_time")
            connection.commit()
        before = self.database.read_bytes()
        projected = preview_database(self.database, HISTORY_NAME, HISTORY_OWNERS)
        self.assertEqual(projected.row_readers, (HISTORY_NAME,))
        self.assertIn("browser_visits_time", [item.name for item in projected.objects])
        self.assertEqual(self.database.read_bytes(), before)
        require_candidate_layout(projected, projected, HISTORY_OWNERS)

    def test_unknown_schema_and_incompatible_rows_fail_closed(self):
        with closing(self.create_database()) as connection:
            connection.execute("UPDATE browser_visits SET origin='https://other.org'")
            connection.commit()
        with self.assertRaises(ValueError):
            preview_database(self.database, HISTORY_NAME, HISTORY_OWNERS)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE browser_visits SET origin='https://example.org'")
            connection.execute("ALTER TABLE browser_visits ADD COLUMN future TEXT")
            connection.commit()
        with self.assertRaises(ValueError):
            preview_database(self.database, HISTORY_NAME, HISTORY_OWNERS)

    def test_wal_rows_are_included_without_checkpointing_source(self):
        with closing(self.create_database()) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA wal_autocheckpoint=0")
            connection.execute("UPDATE browser_visits SET title='WAL title'")
            connection.commit()
            wal = Path(str(self.database) + "-wal")
            before = (self.database.read_bytes(), wal.read_bytes())
            projected = preview_database(self.database, HISTORY_NAME, HISTORY_OWNERS)
            self.assertEqual(projected.row_readers, (HISTORY_NAME,))
            self.assertEqual((self.database.read_bytes(), wal.read_bytes()), before)

    def test_candidate_row_transfer_runs_the_source_desktop_reader(self):
        with closing(self.create_database()):
            pass
        source = preview_database(self.database, HISTORY_NAME, HISTORY_OWNERS)
        for origin, accepted in (("https://example.org", True), ("https://other.org", False)):
            with (
                self.subTest(origin=origin),
                projected_database(self.database, HISTORY_NAME, HISTORY_OWNERS) as (
                    preview,
                    connection,
                    deadline,
                ),
            ):
                connection.execute("PRAGMA query_only=OFF")
                connection.execute(
                    "UPDATE browser_visits SET title='Candidate', origin=?", (origin,)
                )
                connection.execute("PRAGMA query_only=ON")
                frames = []
                digest = rows_digest(connection, deadline=deadline, emit=frames.append)
                candidate = replace(preview, rows_digest=digest)
                if accepted:
                    result = require_candidate_layout(
                        candidate,
                        source,
                        HISTORY_OWNERS,
                        read_candidate=lambda _, frames=frames: frames,
                    )
                    self.assertEqual(result.row_readers, (HISTORY_NAME,))
                else:
                    with self.assertRaises(ValueError):
                        require_candidate_layout(
                            candidate,
                            source,
                            HISTORY_OWNERS,
                            read_candidate=lambda _, frames=frames: frames,
                        )

    def test_absent_history_is_projected_without_creating_directory(self):
        reader = Mock()
        reader.entry_kind.return_value = None
        self.assertIsNone(history_directory(reader, self.home))
        reader.entry_kind.assert_called_once_with(str(self.home), "browser")
        reader.directory_entries.assert_not_called()
        self.assertFalse((self.home / "browser").exists())
        projected = preview_database(None, HISTORY_NAME, HISTORY_OWNERS)
        self.assertFalse(projected.present)
        reader.entry_kind.return_value = "file"
        with self.assertRaises(ValueError):
            history_directory(reader, self.home)


if __name__ == "__main__":
    unittest.main()
