"""Resolved path spelling must not change Content's authorization boundary."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

from service.content.domain.model import ContentError
from service.content.service.space import Mount, ProjectSpace, _within
from service.persistence.project import reader
from service.platform.content import AssetKind, ProjectRef
from service.platform.storage import filesystem_path


class ContentPathContract(unittest.TestCase):
    def test_read_only_uri_preserves_filename_and_does_not_create(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "资料 #% data.sqlite3"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("CREATE TABLE evidence (value INTEGER)")
                connection.execute("INSERT INTO evidence VALUES (17)")
            with reader(database) as connection:
                self.assertEqual(connection.execute("SELECT value FROM evidence").fetchone()[0], 17)
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("INSERT INTO evidence VALUES (18)")
            missing = Path(directory) / "missing.sqlite3"
            with self.assertRaises(sqlite3.OperationalError):
                with reader(missing):
                    self.fail("read-only connection created a missing database")
            self.assertFalse(missing.exists())

    @unittest.skipUnless(os.name == "nt", "native Windows SQLite filenames")
    def test_read_only_extended_drive_and_long_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for suffix in ("short", "nested-long-name/" * 24):
                parent = filesystem_path(Path(directory) / suffix)
                parent.mkdir(parents=True)
                database = parent / "资料 #% data.sqlite3"
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute("CREATE TABLE evidence (value INTEGER)")
                    connection.execute("INSERT INTO evidence VALUES (17)")
                with reader(database) as connection:
                    self.assertEqual(
                        connection.execute("SELECT value FROM evidence").fetchone()[0], 17
                    )
                    with self.assertRaises(sqlite3.OperationalError):
                        connection.execute("INSERT INTO evidence VALUES (18)")

    @unittest.skipUnless(os.name == "nt", "native Windows UNC spelling")
    def test_read_only_unc_uri_keeps_native_filename(self) -> None:
        for database in (
            Path("//server/share/资料 #%.sqlite3"),
            Path("//?/UNC/server/share/资料 #%.sqlite3"),
        ):
            with patch("service.persistence.project.sqlite3.connect") as connect:
                with reader(database):
                    pass
                uri = connect.call_args.args[0]
                self.assertEqual(unquote(urlsplit(uri).path), str(database))
                self.assertEqual(urlsplit(uri).netloc, "")
                self.assertTrue(connect.call_args.kwargs["uri"])

    def test_missing_child_and_root_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            space = ProjectSpace(ProjectRef("project", "Project", str(root)))
            target = space.absolute("resources/missing.md")
            self.assertEqual(target, (root / "resources/missing.md").resolve())
            self.assertEqual(space.relative(target), "resources/missing.md")
            self.assertEqual(space.relative(root), "")

    def test_sibling_with_same_prefix_is_outside(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            space = ProjectSpace(ProjectRef("project", "Project", str(root)))
            for action in (
                lambda: space.absolute("../project-other/file.md"),
                lambda: space.relative(root.parent / "project-other/file.md"),
            ):
                with self.assertRaises(ContentError) as caught:
                    action()
                self.assertEqual(caught.exception.code, "path_outside_project")

    def test_resolved_symlink_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            outside = Path(directory) / "outside"
            root.mkdir()
            outside.mkdir()
            (root / "escape").symlink_to(outside, target_is_directory=True)
            space = ProjectSpace(ProjectRef("project", "Project", str(root)))
            with self.assertRaises(ContentError) as caught:
                space.absolute("escape/file.md")
            self.assertEqual(caught.exception.code, "path_outside_project")
            with self.assertRaises(ContentError):
                space.relative(root / "escape/file.md")

    def test_file_mount_cannot_authorize_descendants(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "external.md"
            file.write_text("evidence", encoding="utf-8")
            space = ProjectSpace(
                ProjectRef("project", "Project", str(root / "project")),
                (Mount("resources/external.md", file, AssetKind.FILE),),
            )
            self.assertEqual(space.relative(file), "resources/external.md")
            for action in (
                lambda: space.absolute("resources/external.md/child"),
                lambda: space.relative(file / "child"),
            ):
                with self.assertRaises(ContentError):
                    action()

    @unittest.skipUnless(os.name == "nt", "native Windows Path namespace")
    def test_windows_resolved_spelling_matrix(self) -> None:
        # Simulate the two native resolve results captured on ci-win. No network
        # access is needed to exercise UNC identity and long paths deterministically.
        for ordinary in (
            Path("C:/owned/资料"),
            Path("//server/share/资料"),
            Path("C:/owned") / ("long-name/" * 32) / "资料",
        ):
            extended = filesystem_path(ordinary)
            for root, target in (
                (ordinary, extended / ".scholarseed/service/project.sqlite3"),
                (extended, ordinary / ".scholarseed/service/project.sqlite3"),
            ):
                with self.subTest(root=str(root), target=str(target)):
                    candidate = root / ".scholarseed/service/project.sqlite3"

                    def resolve(path, *args, target=target, candidate=candidate, **kwargs):
                        return target if path == candidate else path

                    with patch.object(Path, "resolve", autospec=True, side_effect=resolve):
                        self.assertEqual(
                            _within(
                                root, ".scholarseed/service/project.sqlite3", "path_outside_project"
                            ),
                            target,
                        )
                        space = ProjectSpace(ProjectRef("project", "Project", str(root)))
                        self.assertEqual(
                            space.relative(target), ".scholarseed/service/project.sqlite3"
                        )
                        mount = Mount("resources/linked", root, AssetKind.DIR)
                        mounted = ProjectSpace(
                            ProjectRef("project", "Project", "D:/project"), (mount,)
                        )
                        self.assertEqual(
                            mounted.relative(target),
                            "resources/linked/.scholarseed/service/project.sqlite3",
                        )
                        self.assertEqual(
                            mounted.relative(target.parent.parent.parent), "resources/linked"
                        )

    @unittest.skipUnless(os.name == "nt", "native Windows Path namespace")
    def test_windows_extended_outside_root_stays_rejected(self) -> None:
        root = Path("C:/owned/project")
        for outside in (
            Path("C:/owned/project-other/file"),
            Path("D:/owned/project/file"),
            Path("//server/share/owned/project/file"),
        ):
            target = filesystem_path(outside)
            candidate = root / "redirected/file"

            def resolve(path, *args, target=target, candidate=candidate, **kwargs):
                return target if path == candidate else path

            with self.subTest(target=str(target)):
                with patch.object(Path, "resolve", autospec=True, side_effect=resolve):
                    with self.assertRaises(ContentError) as caught:
                        _within(root, "redirected/file", "path_outside_project")
                    self.assertEqual(caught.exception.code, "path_outside_project")
                    space = ProjectSpace(ProjectRef("project", "Project", str(root)))
                    with self.assertRaises(ContentError):
                        space.relative(target)


if __name__ == "__main__":
    unittest.main()
