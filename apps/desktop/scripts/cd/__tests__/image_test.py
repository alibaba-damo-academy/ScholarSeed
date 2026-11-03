"""Exercise real copy subprocess failures through the pinned dmgbuild adapter."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("image", Path(__file__).parents[1] / "image.py")
image = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(image)


class CopyTests(unittest.TestCase):
    def test_json_capacity_covers_partitions_and_does_not_follow_directory_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            # Sparse fixture reproduces the payload size at the failing GPT layout.
            with (source / "payload").open("wb") as stream:
                stream.truncate(1988517888)
            (source / "current").symlink_to(source, target_is_directory=True)
            settings_file = root / "settings.json"
            settings_file.write_text(
                json.dumps(
                    {
                        "title": "Probe",
                        "contents": [{"path": str(source), "x": 0, "y": 0}],
                        "size": "6g",
                    }
                )
            )
            options = {"size": None}
            image.core.load_json(str(settings_file), options)
            self.assertIsNone(options["size"])  # upstream drops JSON size
            image.sized_loader(image.core.load_json, root / "copy.log")(str(settings_file), options)
            evidence = json.loads((root / "copy.log").read_text())
            self.assertEqual(evidence["entries"], 2)
            self.assertEqual(options["size"], evidence["size"])
            self.assertGreater(
                evidence["requested_bytes"] - 328 * image.MIB,
                evidence["payload_bytes"] + evidence["metadata_bytes"],
            )

    def test_real_ditto_missing_source_is_fatal_and_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "copy.log"
            with self.assertRaisesRegex(RuntimeError, "ditto failed"):
                image.CheckedSubprocess(log).call(
                    ["/usr/bin/ditto", str(root / "missing"), str(root / "target")]
                )
            self.assertIn('"status": "failed"', log.read_text())
            self.assertIn("ditto:", log.read_text())

    def test_real_ditto_preserves_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "source").write_bytes(b"payload")
            adapter = image.CheckedSubprocess(root / "copy.log")
            self.assertEqual(
                adapter.call(["/usr/bin/ditto", str(root / "source"), str(root / "target")]), 0
            )
            self.assertEqual((root / "target").read_bytes(), b"payload")
            records = [json.loads(line) for line in (root / "copy.log").read_text().splitlines()]
            self.assertTrue(all(record["space"]["total_bytes"] > 0 for record in records))
            self.assertTrue(all(record["space"]["free_bytes"] > 0 for record in records))

    def test_other_commands_are_not_intercepted(self):
        with patch.object(subprocess, "call", return_value=7) as call:
            self.assertEqual(
                image.CheckedSubprocess(Path("unused")).call(["SetFile", "-a", "E"]), 7
            )
            call.assert_called_once()


class DetachTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.log = Path(self.directory.name) / "copy.log"
        self.device = "/dev/disk99s2"
        self.entry = {
            "image-path": "/owned.dmg",
            "system-entities": [{"dev-entry": self.device, "mount-point": "/Volumes/owned"}],
        }
        self.original = Mock()
        self.adapter = image.CheckedImages(self.original, self.log)
        self.original.return_value = (0, {"system-entities": self.entry["system-entities"]})
        self.adapter("attach", "-nobrowse", "/owned.dmg")
        self.original.reset_mock()
        self.sleep = patch.object(image.time, "sleep").start()
        self.addCleanup(patch.stopall)

    def test_busy_recovery_requires_successful_force_and_absent_device(self):
        self.original.side_effect = [(16, "busy")] * image.DETACH_ATTEMPTS + [(0, "ejected")]
        with (
            patch.object(
                self.adapter,
                "snapshot",
                side_effect=[[self.entry]] * (image.DETACH_ATTEMPTS + 1) + [[]],
            ),
            patch.object(self.adapter, "evidence") as evidence,
        ):
            self.assertEqual(self.adapter("detach", self.device, plist=False), (0, "ejected"))
        evidence.assert_called_once_with(self.device, self.entry)
        self.original.assert_called_with("detach", "-force", self.device, plist=False)
        self.assertIn('"status": "verified"', self.log.read_text())

    def test_force_failure_or_surviving_device_is_fatal(self):
        for result, remaining in [((16, "busy"), []), ((0, "ok"), [self.entry])]:
            with self.subTest(result=result, remaining=remaining):
                self.original.side_effect = [(16, "busy")] * image.DETACH_ATTEMPTS + [result]
                with (
                    patch.object(
                        self.adapter,
                        "snapshot",
                        side_effect=[[self.entry]] * (image.DETACH_ATTEMPTS + 1) + [remaining],
                    ),
                    patch.object(self.adapter, "evidence"),
                    self.assertRaisesRegex(RuntimeError, "not verified"),
                ):
                    self.adapter("detach", self.device, plist=False)

    def test_other_error_is_not_forced(self):
        self.original.return_value = (1, "permission denied")
        with (
            patch.object(self.adapter, "snapshot", return_value=[self.entry]),
            patch.object(self.adapter, "evidence") as evidence,
            self.assertRaisesRegex(RuntimeError, "failed"),
        ):
            self.adapter("detach", self.device, plist=False)
        evidence.assert_called_once()
        self.original.assert_called_once_with("detach", self.device, plist=False)

    def test_reused_device_and_unreadable_inventory_refuse_recovery(self):
        self.original.return_value = (16, "busy")
        with (
            patch.object(
                self.adapter,
                "snapshot",
                return_value=[dict(self.entry, **{"image-path": "/other.dmg"})],
            ),
            self.assertRaisesRegex(RuntimeError, "identity changed"),
        ):
            self.adapter("detach", self.device, plist=False)
        self.original.assert_called_once()
        with (
            patch.object(self.adapter, "snapshot", side_effect=ValueError("bad plist")),
            self.assertRaisesRegex(ValueError, "bad plist"),
        ):
            self.adapter("detach", self.device, plist=False)

    def test_success_and_untracked_device_do_not_force(self):
        self.original.return_value = (0, "ok")
        with patch.object(self.adapter, "snapshot") as snapshot:
            self.assertEqual(self.adapter("detach", self.device, plist=False), (0, "ok"))
        snapshot.assert_not_called()
        self.original.return_value = (16, "busy")
        with self.assertRaisesRegex(RuntimeError, "untracked"):
            self.adapter("detach", "/dev/disk100", plist=False)

    def test_diagnostic_timeout_is_recorded_without_masking_recovery(self):
        with patch.object(
            image.subprocess, "run", side_effect=subprocess.TimeoutExpired("lsof", 10)
        ):
            self.adapter.evidence(self.device, self.entry)
        self.assertIn("TimeoutExpired", self.log.read_text())

    def test_released_holder_allows_normal_retry_without_force(self):
        self.original.side_effect = [(16, "busy"), (0, "ok")]
        with (
            patch.object(self.adapter, "snapshot", return_value=[self.entry]),
            patch.object(self.adapter, "evidence"),
        ):
            self.assertEqual(self.adapter("detach", self.device, plist=False), (0, "ok"))
        self.assertEqual(self.original.call_count, 2)
        self.assertFalse(any("-force" in call.args for call in self.original.call_args_list))

    def test_partition_disappearance_does_not_prove_image_detached(self):
        remaining = dict(self.entry, **{"system-entities": [{"dev-entry": "/dev/disk99"}]})
        with patch.object(self.adapter, "snapshot", return_value=[remaining]):
            self.assertEqual(self.adapter.current(self.device, "/owned.dmg"), remaining)

    def test_run_restores_upstream_hooks_after_failure(self):
        context = Path(self.directory.name) / "context.json"
        context.write_text(json.dumps({"runDirectory": self.directory.name}))
        original = (image.core.hdiutil, image.core.subprocess, image.core.load_json)
        with (
            patch.dict(image.os.environ, {"SCHOLARSEED_BUILD_CONTEXT": str(context)}),
            patch.object(image, "main", side_effect=RuntimeError("stop")),
            self.assertRaisesRegex(RuntimeError, "stop"),
        ):
            image.run()
        self.assertEqual(
            original, (image.core.hdiutil, image.core.subprocess, image.core.load_json)
        )

    def test_diagnostics_retain_pid_and_parent_without_arguments(self):
        def command(arguments, **kwargs):
            kwargs["stdout"].write(b"p123\ncHolder\nu501\nf3\nn/Volumes/owned/file\n")
            return subprocess.CompletedProcess(arguments, 0)

        with patch.object(image.subprocess, "run", side_effect=command) as run:
            self.adapter.evidence(self.device, self.entry)
        self.assertEqual(
            run.call_args.args[0], ["/bin/ps", "-p", "123", "-o", "pid=,ppid=,uid=,stat=,comm="]
        )
        self.assertIn("p123", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
