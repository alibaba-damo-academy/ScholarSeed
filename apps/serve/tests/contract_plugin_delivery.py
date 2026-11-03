"""Generated package handoff invariants; not real product acceptance."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from service.capabilities.service.delivery import read_delivery, validate_receipt
from service.capabilities.service.package import digest


class DeliveryContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.payload = b"generated package"
        (self.root / "generated.zip").write_bytes(self.payload)

    def test_reads_exact_workspace_artifact(self):
        self.assertEqual(
            read_delivery(self.root, "generated.zip", digest(self.payload)), self.payload
        )

    def test_rejects_changed_artifact_and_escape(self):
        for path in ("../generated.zip", str(self.root / "generated.zip"), "C:\\generated.zip"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                read_delivery(self.root, path, digest(self.payload))
        with self.assertRaisesRegex(ValueError, "plugin_delivery_changed"):
            read_delivery(self.root, "generated.zip", digest(b"different"))

    def test_does_not_follow_link(self):
        (self.root / "linked.zip").symlink_to(self.root / "generated.zip")
        with self.assertRaises((OSError, ValueError)):
            read_delivery(self.root, "linked.zip", digest(self.payload))

    def test_confirmation_requires_host_receipt_and_exact_answer(self):
        receipt = {"name": "demo", "version": "1.0.0", "enabled": True, "sha256": "digest"}
        with self.assertRaises(ValueError):
            validate_receipt(None, receipt)
        with self.assertRaises(ValueError):
            validate_receipt(receipt, {**receipt, "enabled": False})
        self.assertEqual(validate_receipt(receipt, receipt), receipt)


if __name__ == "__main__":
    unittest.main()
