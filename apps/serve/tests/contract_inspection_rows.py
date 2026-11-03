"""Private streamed-row framing; never whole-product update acceptance."""

from __future__ import annotations

import io
import json
import unittest
from dataclasses import replace

from service.cli.inspection_cas import (
    PublicationExports,
    PublicationOutput,
    read_candidate_publication,
)
from service.cli.inspection_rows import RowOutput, read_candidate_rows
from service.persistence.preview import DatabasePreview
from service.resources.persistence.chunks import digest
from service.resources.persistence.inspection import CasPublication
from service.resources.persistence.objects import CasStore


class InspectionRowContracts(unittest.TestCase):
    def setUp(self):
        self.preview = DatabasePreview("sessions", True, "a" * 64, ("sessions",), (), "b" * 64, ())

    def frames(self):
        output = io.BytesIO()
        sender = RowOutput(output, self.preview)
        sender.emit(b"private-value-one")
        sender.emit(b"private-value-two")
        sender.finish()
        return output.getvalue()

    def test_exact_chunks_and_completion_are_required(self):
        output = io.BytesIO()
        self.assertEqual(
            list(read_candidate_rows(self.preview, io.BytesIO(self.frames()), output)),
            [b"private-value-one", b"private-value-two"],
        )
        request = json.loads(output.getvalue())
        self.assertEqual(request["event"], "rows_required")
        self.assertEqual(request["preview"]["rows_digest"], self.preview.rows_digest)
        self.assertNotIn(b"private-value", output.getvalue())

    def test_truncation_order_identity_and_final_count_are_rejected(self):
        frames = self.frames().splitlines(keepends=True)
        damaged = [
            b"".join(frames[:-1]),
            frames[1] + frames[0] + frames[2],
            b"".join(frames).replace(b'"name":"sessions"', b'"name":"another"', 1),
        ]
        for field, value in (("sequence", 1), ("size", 0), ("digest", "c" * 64), ("extra", True)):
            final = json.loads(frames[-1])
            final[field] = value
            damaged.append(b"".join(frames[:-1]) + json.dumps(final).encode() + b"\n")
        damaged.append(b"".join(frames).replace(b'"sequence":0', b'"sequence":null', 1))
        damaged.append(b"".join(frames).replace(b'"version":1', b'"version":1,"version":1', 1))
        for raw in damaged:
            with self.subTest(length=len(raw)), self.assertRaises(ValueError):
                list(read_candidate_rows(self.preview, io.BytesIO(raw), io.BytesIO()))
        with self.assertRaises(ValueError):
            list(
                read_candidate_rows(
                    replace(self.preview, rows_digest="c" * 64),
                    io.BytesIO(self.frames()),
                    io.BytesIO(),
                )
            )

    def test_sender_cannot_finish_empty_or_send_after_completion(self):
        sender = RowOutput(io.BytesIO(), self.preview)
        with self.assertRaises(ValueError):
            sender.finish()
        sender.emit(b"value")
        sender.finish()
        for operation in (sender.finish, lambda: sender.emit(b"late")):
            with self.assertRaises(ValueError):
                operation()


class InspectionPublicationContracts(unittest.TestCase):
    def publication(self, raw=None):
        if raw is None:
            raw = b"private future object\n" * 100_000
        image = CasPublication(digest(raw))
        CasStore.preview_new_stream(
            io.BytesIO(raw),
            raw_size_bytes=len(raw),
            expected_object_id=image.object_id,
            max_raw_bytes=len(raw),
            max_chunks=32,
            check=lambda: None,
            emit_file=image.add,
        )
        image.verify()
        return image

    def frames(self, image):
        output = io.BytesIO()
        sender = PublicationOutput(output, "project.fixture", image)
        sender.emit()
        sender.finish()
        return output.getvalue()

    def test_receiving_codec_checks_exact_encoded_bytes_and_receipt(self):
        image = self.publication()
        requests = io.BytesIO()
        received = read_candidate_publication(
            "project.fixture", image.preview(), io.BytesIO(self.frames(image)), requests
        )
        self.assertEqual(received.preview(), image.preview())
        self.assertEqual(tuple(received.files()), tuple(image.files()))
        request = json.loads(requests.getvalue())
        self.assertEqual(request["event"], "cas_required")
        self.assertNotIn(b"private future object", requests.getvalue())

    def test_partial_reordered_wrong_owner_and_false_completion_fail(self):
        image = self.publication()
        frames = self.frames(image).splitlines(keepends=True)
        damaged = [
            b"".join(frames[:-1]),
            frames[1] + frames[0] + b"".join(frames[2:]),
            b"".join(frames).replace(
                b'"database":"project.fixture"', b'"database":"project.other"', 1
            ),
        ]
        for key, value in (("sequence", None), ("extra", True)):
            first = json.loads(frames[0])
            first[key] = value
            damaged.append(json.dumps(first).encode() + b"\n" + b"".join(frames[1:]))
        final = json.loads(frames[-1])
        final["preview"]["digest"] = "0" * 64
        damaged.append(b"".join(frames[:-1]) + json.dumps(final).encode() + b"\n")
        for data in damaged:
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                read_candidate_publication(
                    "project.fixture", image.preview(), io.BytesIO(data), io.BytesIO()
                )

    def test_sender_requires_full_emission_before_completion(self):
        image = self.publication()
        sender = PublicationOutput(io.BytesIO(), "project.fixture", image)
        with self.assertRaises(ValueError):
            sender.finish()
        sender.emit()
        with self.assertRaises(ValueError):
            sender.emit()
        sender.finish()
        with self.assertRaises(ValueError):
            sender.finish()

    def test_batch_reprojects_once_and_never_replays_consumed_objects(self):
        first = self.publication(b"first project content")
        second = self.publication(b"second project content")
        images = {"project.first": (first,), "project.second": (second,)}
        reports = {
            name: tuple(image.preview() for image in group) for name, group in images.items()
        }
        batch = PublicationExports(reports)
        preparations = []

        def prepare():
            preparations.append("closed snapshot")
            return images

        for name, image in (("project.first", first), ("project.second", second)):
            selected = batch.select(name, image.preview(), prepare)
            output = io.BytesIO()
            sender = PublicationOutput(output, name, selected)
            sender.emit()
            sender.finish()
            batch.complete()
            received = read_candidate_publication(
                name, image.preview(), io.BytesIO(output.getvalue()), io.BytesIO()
            )
            self.assertEqual(received.preview(), image.preview())
        self.assertEqual(preparations, ["closed snapshot"])
        with self.assertRaises(ValueError):
            batch.select("project.first", first.preview(), prepare)
        self.assertEqual(preparations, ["closed snapshot"])

    def test_batch_rejects_changed_sibling_and_failed_pin_close_before_first_export(self):
        first = self.publication(b"first capture")
        second = self.publication(b"second capture")
        reports = {"project.first": (first.preview(),), "project.second": (second.preview(),)}
        batch = PublicationExports(reports)
        with self.assertRaises(ValueError):
            batch.select(
                "project.first",
                first.preview(),
                lambda: {"project.first": (first,), "project.second": ()},
            )
        called = []
        with self.assertRaises(ValueError):
            batch.select("project.first", first.preview(), lambda: called.append(True))
        self.assertEqual(called, [])

        def failed_close():
            raise RuntimeError("native pin did not close")

        batch = PublicationExports(reports)
        with self.assertRaises(RuntimeError):
            batch.select("project.first", first.preview(), failed_close)
        with self.assertRaises(ValueError):
            batch.select("project.first", first.preview(), lambda: called.append(True))
        self.assertEqual(called, [])

    def test_batch_does_not_advance_before_object_completion(self):
        image = self.publication(b"incomplete object")
        reports = {"project.fixture": (image.preview(),)}
        batch = PublicationExports(reports)
        batch.select("project.fixture", image.preview(), lambda: {"project.fixture": (image,)})
        with self.assertRaises(ValueError):
            batch.select(
                "project.fixture", image.preview(), lambda: self.fail("reprojected inflight export")
            )
        with self.assertRaises(ValueError):
            batch.complete()


if __name__ == "__main__":
    unittest.main()
