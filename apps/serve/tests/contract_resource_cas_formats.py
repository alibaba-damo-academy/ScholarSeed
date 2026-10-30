"""Shared CAS decoders; these contracts do not qualify update directories."""

from __future__ import annotations

import io
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.resources.persistence import inspection
from service.resources.persistence.chunks import digest
from service.resources.persistence.objects import (
    CasCorruptError,
    CasEntryKind,
    CasStore,
    GcEntry,
    GcPlan,
    decode_object_descriptor,
    verified_chunks,
    verified_whole,
)
from service.resources.persistence.version import VersionStore


class CasFormatContracts(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.store = CasStore(self.root)

    def object_directory(self, object_id):
        value = object_id.removeprefix("sha256:")
        return self.root / "cas" / "v1" / "objects" / "sha256" / value[:2] / value

    def descriptor(self, object_id):
        path = self.object_directory(object_id) / "meta.json"
        body = json.loads(path.read_bytes())
        body.pop("descriptor_digest")
        return path, body

    def test_private_stream_publication_matches_real_writer_without_filesystem_io(self):
        for raw in (b"", "新建资源\n".encode(), b"chunked capture\n" * 400_000):
            with self.subTest(size=len(raw)):
                identifier = digest(raw)
                before = {
                    path.relative_to(self.root): path.read_bytes()
                    for path in self.root.rglob("*")
                    if path.is_file()
                }
                with (
                    patch(
                        "service.resources.persistence.objects._exclusive",
                        side_effect=AssertionError("preview acquired writer lock"),
                    ),
                    patch(
                        "service.resources.persistence.objects._write_durable_files",
                        side_effect=AssertionError("preview published files"),
                    ),
                ):
                    preview = CasStore.preview_new_stream(
                        io.BytesIO(raw),
                        raw_size_bytes=len(raw),
                        expected_object_id=identifier,
                        max_raw_bytes=8 * 1024 * 1024,
                        max_chunks=32,
                        check=lambda: None,
                    )
                self.assertEqual(
                    {
                        path.relative_to(self.root): path.read_bytes()
                        for path in self.root.rglob("*")
                        if path.is_file()
                    },
                    before,
                )
                self.store.put_stream(
                    io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=identifier
                )
                self.assertEqual(self.store.verify(identifier), preview)

    def test_private_stream_publication_enforces_identity_size_chunk_and_deadline_limits(self):
        raw = b"a" * (5 * 1024 * 1024)
        arguments = dict(
            raw_size_bytes=len(raw),
            expected_object_id=digest(raw),
            max_raw_bytes=len(raw),
            max_chunks=32,
            check=lambda: None,
        )
        for changes, error in (
            ({"max_raw_bytes": len(raw) - 1}, ValueError),
            ({"max_chunks": 1}, ValueError),
            ({"expected_object_id": digest(b"different")}, CasCorruptError),
            ({"raw_size_bytes": len(raw) - 1}, CasCorruptError),
            ({"raw_size_bytes": True}, ValueError),
        ):
            with self.subTest(changes=changes), self.assertRaises(error):
                CasStore.preview_new_stream(io.BytesIO(raw), **{**arguments, **changes})

        def expired():
            raise TimeoutError("expired")

        with self.assertRaises(TimeoutError):
            CasStore.preview_new_stream(io.BytesIO(raw), **{**arguments, "check": expired})
        self.assertEqual(tuple(self.root.iterdir()), ())

    def test_publication_bytes_round_trip_through_receiving_codec_and_real_writer(self):
        for raw in (b"", b"new resource", b"repeated chunks\n" * 400_000):
            with self.subTest(size=len(raw)):
                identifier = digest(raw)
                exported = inspection.CasPublication(identifier)
                descriptor = CasStore.preview_new_stream(
                    io.BytesIO(raw),
                    raw_size_bytes=len(raw),
                    expected_object_id=identifier,
                    max_raw_bytes=len(raw),
                    max_chunks=32,
                    check=lambda: None,
                    emit_file=exported.add,
                )
                with self.assertRaises(ValueError):
                    exported.preview()
                self.assertEqual(exported.verify(), descriptor)
                receipt = exported.preview()
                received = inspection.CasPublication(identifier)
                for kind, value, name, data in exported.files():
                    received.add(kind, value, name, data)
                self.assertEqual(received.verify(), descriptor)
                self.assertEqual(received.preview(), receipt)
                self.store.put_stream(
                    io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=identifier
                )
                self.assertEqual(self.store.verify(identifier), descriptor)
                for kind, value, name, data in received.files():
                    actual = self.root.joinpath(*inspection._object_parts(value, kind), name)
                    self.assertEqual(actual.read_bytes(), data)

    def test_receiving_codec_accepts_supported_layout_without_reencoding_candidate(self):
        raw = b"old writer can retain compressed WHOLE\n" * 100_000
        identifier = self.store.put(raw, "text/plain")
        image = inspection.CasPublication(identifier)
        for file in self.object_directory(identifier).iterdir():
            image.add("objects", identifier, file.name, file.read_bytes())
        received = image.verify()
        generated = CasStore.preview_new_stream(
            io.BytesIO(raw),
            raw_size_bytes=len(raw),
            expected_object_id=identifier,
            max_raw_bytes=len(raw),
            max_chunks=32,
            check=lambda: None,
        )
        self.assertEqual(received.layout.value, "WHOLE")
        self.assertEqual(generated.layout.value, "CHUNKED")
        self.assertEqual(received, self.store.verify(identifier))

    def test_publication_rejects_missing_corrupt_duplicate_and_excess_files(self):
        raw = b"publication content"
        identifier = digest(raw)
        original = inspection.CasPublication(identifier)
        CasStore.preview_new_stream(
            io.BytesIO(raw),
            raw_size_bytes=len(raw),
            expected_object_id=identifier,
            max_raw_bytes=len(raw),
            max_chunks=32,
            check=lambda: None,
            emit_file=original.add,
        )
        original.verify()
        for corrupt in (False, True):
            image = inspection.CasPublication(identifier)
            for kind, value, name, data in original.files():
                if name == "payload":
                    if not corrupt:
                        continue
                    data += b"corruption"
                image.add(kind, value, name, data)
            with self.assertRaises((ValueError, CasCorruptError)):
                image.verify()
            with self.assertRaises(RuntimeError):
                image.preview()
        duplicate = inspection.CasPublication(identifier)
        duplicate.add("objects", identifier, "payload", raw)
        with self.assertRaises(ValueError):
            duplicate.add("objects", identifier, "payload", b"changed")
        with self.assertRaises(RuntimeError):
            duplicate.verify()
        with patch.object(inspection, "MAX_TOTAL_BYTES", len(raw) - 1):
            image = inspection.CasPublication(identifier)
            with self.assertRaises(ValueError):
                image.add("objects", identifier, "payload", raw)
        image = inspection.CasPublication(identifier)
        with self.assertRaises(ValueError):
            image.add("objects", identifier, "../payload", raw)

    def test_existing_objects_are_not_exported_as_new_publications(self):
        raw = b"previously published"
        identifier = self.store.put(raw, "text/plain")
        calls = []
        projection = inspection.CasProjection(self.root)
        actual = projection.project_stream(
            io.BytesIO(raw),
            raw_size_bytes=len(raw),
            expected_object_id=identifier,
            emit_file=lambda *args: calls.append(args),
        )
        self.assertEqual(actual, self.store.verify(identifier))
        self.assertEqual(calls, [])

    def test_future_objects_satisfy_private_ledger_only_after_actual_byte_verification(self):
        existing = self.store.put(b"existing object", "text/plain")
        ledger = self.ledger(existing)
        raw = b"future resource\n" * 100_000
        identifier = digest(raw)
        image = inspection.CasPublication(identifier)
        descriptor = CasStore.preview_new_stream(
            io.BytesIO(raw),
            raw_size_bytes=len(raw),
            expected_object_id=identifier,
            max_raw_bytes=len(raw),
            max_chunks=32,
            check=lambda: None,
            emit_file=image.add,
        )
        VersionStore._record_object(ledger, descriptor, 2)
        ledger.execute("INSERT INTO resources_turn_objects VALUES(?,?)", ("occurrence", identifier))
        ledger.commit()
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        rows = tuple(ledger.iterdump())
        with self.assertRaisesRegex(ValueError, "unavailable CAS object"):
            inspection.inspect_cas_storage(self.root, ledger=ledger)
        result = inspection.inspect_cas_storage(self.root, ledger=ledger, publications=(image,))
        self.assertEqual(result.objects, 1)
        self.assertEqual(result.publications, (image.preview(),))
        self.assertEqual(tuple(ledger.iterdump()), rows)
        self.assertEqual(
            {
                path.relative_to(self.root): path.read_bytes()
                for path in self.root.rglob("*")
                if path.is_file()
            },
            before,
        )
        with self.assertRaisesRegex(ValueError, "duplicate CAS recovery object"):
            inspection.inspect_cas_storage(self.root, publications=(image, image))
        self.store.put_stream(
            io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=identifier
        )
        with self.assertRaisesRegex(ValueError, "replace an existing object"):
            inspection.inspect_cas_storage(self.root, ledger=ledger, publications=(image,))

    def test_private_publication_set_requires_completion_and_keeps_project_identity(self):
        batch = inspection.CasPublicationSet()
        raw = b"shared raw bytes across independent projects"
        identifier = digest(raw)
        for database in ("project.first", "project.second"):
            CasStore.preview_new_stream(
                io.BytesIO(raw),
                raw_size_bytes=len(raw),
                expected_object_id=identifier,
                max_raw_bytes=len(raw),
                max_chunks=32,
                check=lambda: None,
                emit_file=lambda *args: batch.add(database, identifier, *args),
            )
        with self.assertRaises(ValueError):
            batch.for_database("project.first")
        batch.finish()
        first = batch.for_database("project.first")
        second = batch.for_database("project.second")
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0].preview(), second[0].preview())
        self.assertIsNot(first[0], second[0])
        self.assertEqual(batch.for_database("project.absent"), ())
        self.assertEqual(
            inspection.inspect_cas_storage(None, publications=first).publications,
            (first[0].preview(),),
        )
        with self.assertRaises(ValueError):
            batch.add("project.first", identifier, "objects", identifier, "payload", raw)
        with self.assertRaises(RuntimeError):
            batch.for_database("project.first")

    def test_private_publication_set_bounds_aggregate_and_rejects_partial_completion(self):
        raw = b"resource"
        identifier = digest(raw)
        batch = inspection.CasPublicationSet()
        batch.add("project.first", identifier, "objects", identifier, "payload", raw)
        with self.assertRaises(ValueError):
            batch.finish()
        with self.assertRaises(RuntimeError):
            batch.for_database("project.first")
        with patch.object(inspection, "MAX_TOTAL_BYTES", len(raw)):
            batch = inspection.CasPublicationSet()
            batch.add("project.first", identifier, "objects", identifier, "payload", raw)
            with self.assertRaises(ValueError):
                batch.add("project.second", identifier, "objects", identifier, "payload", raw)

    def test_recovery_namespace_keeps_existing_layout_and_projects_new_objects_without_publication(
        self,
    ):
        raw = b"compressible legacy object\n" * 100_000
        existing_id = self.store.put(raw, "text/plain")
        existing = self.store.verify(existing_id)
        self.assertEqual(existing.layout.value, "WHOLE")
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        projection = inspection.CasProjection(self.root)
        self.assertEqual(
            projection.project_stream(
                io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=existing_id
            ),
            existing,
        )
        new_raw = b"new authorization capture"
        new_id = digest(new_raw)
        proposed = projection.project_stream(
            io.BytesIO(new_raw), raw_size_bytes=len(new_raw), expected_object_id=new_id
        )
        self.assertEqual(
            projection.project_stream(
                io.BytesIO(new_raw), raw_size_bytes=len(new_raw), expected_object_id=new_id
            ),
            proposed,
        )
        self.assertEqual(
            set(value.object_id for value in projection.descriptors()), {existing_id, new_id}
        )
        self.assertEqual(
            {
                path.relative_to(self.root): path.read_bytes()
                for path in self.root.rglob("*")
                if path.is_file()
            },
            before,
        )
        self.store.put_stream(
            io.BytesIO(new_raw), raw_size_bytes=len(new_raw), expected_object_id=new_id
        )
        self.assertEqual(self.store.verify(new_id), proposed)
        self.assertEqual(self.store.verify(existing_id), existing)

    def test_recovery_namespace_failure_is_terminal_and_read_budget_is_aggregate(self):
        projection = inspection.CasProjection(None)
        with self.assertRaises(CasCorruptError):
            projection.project_stream(
                io.BytesIO(b"wrong"), raw_size_bytes=5, expected_object_id=digest(b"right")
            )
        with self.assertRaises(RuntimeError):
            projection.project_stream(
                io.BytesIO(b"right"), raw_size_bytes=5, expected_object_id=digest(b"right")
            )
        with self.assertRaises(RuntimeError):
            projection.descriptors()
        with patch.object(inspection, "MAX_TOTAL_BYTES", 6):
            projection = inspection.CasProjection(None)
            projection.project_stream(
                io.BytesIO(b"1234"), raw_size_bytes=4, expected_object_id=digest(b"1234")
            )
            with self.assertRaises(ValueError):
                projection.project_stream(
                    io.BytesIO(b"5678"), raw_size_bytes=4, expected_object_id=digest(b"5678")
                )
        self.assertEqual(tuple(self.root.iterdir()), ())

    def test_whole_decoder_uses_identical_bytes_without_requesting_manifest(self):
        object_id = self.store.put(b"private archived content", "text/plain")
        path, _body = self.descriptor(object_id)
        before = path.read_bytes()

        def no_manifest():
            self.fail("WHOLE decoding requested a manifest")

        decoded = decode_object_descriptor(object_id, before, no_manifest)
        self.assertEqual(decoded, self.store.verify(object_id))
        payload = (path.parent / "payload").read_bytes()
        self.assertEqual(verified_whole(decoded, payload), b"private archived content")
        with self.assertRaises(CasCorruptError):
            verified_whole(decoded, payload + b"changed")
        self.assertEqual(path.read_bytes(), before)

    def test_normal_reader_and_preflight_decoder_reject_unknown_format_and_sizes(self):
        object_id = self.store.put(b"content", "text/plain")
        path, original = self.descriptor(object_id)
        for field, value in (
            ("format_version", 999),
            ("format_version", True),
            ("format_version", 1.0),
            ("codec", "FUTURE"),
            ("raw_size_bytes", -1),
            ("raw_size_bytes", True),
            ("stored_size_bytes", 99),
            ("payload_digest", "sha256:" + "../" * 21 + "x"),
        ):
            with self.subTest(field=field, value=value):
                encoded = self.store._descriptor_bytes({**original, field: value})
                path.write_bytes(encoded)
                with self.assertRaises(CasCorruptError):
                    decode_object_descriptor(object_id, encoded, lambda: b"")
                with self.assertRaises(CasCorruptError):
                    self.store.verify(object_id)
                self.assertEqual(path.read_bytes(), encoded)

    def test_chunk_manifest_checks_identity_order_profile_and_sizes_before_payload_io(self):
        raw = b"chunked data\n" * 100_000
        object_id = digest(raw)
        self.store.put_stream(
            io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=object_id
        )
        path, body = self.descriptor(object_id)
        manifest_path = path.parent / "manifest.json"
        manifest_bytes = manifest_path.read_bytes()
        decoded = decode_object_descriptor(object_id, path.read_bytes(), lambda: manifest_bytes)
        self.assertEqual(decoded, self.store.verify(object_id))
        self.assertEqual(
            b"".join(
                verified_chunks(
                    decoded,
                    lambda identifier: self.store.chunk_payload_path(identifier).read_bytes(),
                )
            ),
            raw,
        )
        with self.assertRaises(CasCorruptError):
            tuple(verified_chunks(decoded, lambda _identifier: b"wrong payload"))
        for change in ("version", "profile", "order", "offset", "size", "identity"):
            with self.subTest(change=change):
                manifest = json.loads(manifest_bytes)
                if change == "version":
                    manifest["manifest_version"] = True
                elif change == "profile":
                    manifest["chunker_profile"] = "future-profile"
                elif change == "order":
                    manifest["chunks"][0]["ordinal"] = 1
                elif change == "offset":
                    manifest["chunks"][0]["raw_offset"] = 1
                elif change == "size":
                    manifest["chunks"][0]["raw_size_bytes"] = True
                else:
                    manifest["chunks"][0]["chunk_id"] = "sha256:" + "z" * 64
                changed = json.dumps(manifest).encode()
                descriptor = self.store._descriptor_bytes(
                    {
                        **body,
                        "manifest_digest": digest(changed),
                        "stored_size_bytes": len(changed),
                    }
                )
                with self.assertRaises(CasCorruptError):
                    decode_object_descriptor(object_id, descriptor, lambda: changed)
                self.assertEqual(manifest_path.read_bytes(), manifest_bytes)

    def test_duplicate_descriptor_fields_are_not_silently_normalized(self):
        object_id = self.store.put(b"content", "text/plain")
        path, _body = self.descriptor(object_id)
        encoded = path.read_bytes()
        duplicate = b'{"format_version":999,' + encoded[1:]
        with self.assertRaises(CasCorruptError):
            decode_object_descriptor(object_id, duplicate, lambda: b"")

    def test_live_inspection_reads_real_objects_without_changing_any_file(self):
        self.store.put(b"whole-content", "text/plain")
        raw = b"chunk-content" * 100_000
        self.store.put_stream(
            io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=digest(raw)
        )
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        result = inspection.inspect_cas_storage(self.root)
        self.assertTrue(result.present)
        self.assertEqual(result.objects, 2)
        self.assertGreater(result.read_bytes, len(raw))
        self.assertEqual(inspection.inspect_cas_storage(self.root), result)
        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)

    def ledger(self, *identifiers):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        VersionStore.initialize_schema(connection)
        connection.execute(
            "INSERT INTO resources_turns(turn_occurrence_id,session_id,turn_id,runtime_generation,"
            "baseline_generation,state,started_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",
            ("occurrence", "session", "turn", "generation", 0, "running", 1, 1),
        )
        for identifier in identifiers:
            VersionStore._record_object(connection, self.store.verify(identifier), 1)
            connection.execute(
                "INSERT INTO resources_turn_objects VALUES(?,?)", ("occurrence", identifier)
            )
        connection.commit()
        return connection

    def test_cas_inspection_cross_checks_whole_and_chunked_ledger_without_writing(self):
        whole = self.store.put(b"whole ledger content", "text/plain")
        raw = b"chunked ledger content" * 100_000
        chunked = self.store.put_stream(
            io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=digest(raw)
        )
        ledger = self.ledger(whole, chunked)
        before = tuple(ledger.iterdump())
        ledger.execute("PRAGMA query_only=ON")
        result = inspection.inspect_cas_storage(self.root, ledger=ledger)
        self.assertEqual(result.objects, 2)
        self.assertEqual(VersionStore.live_object_ids(ledger), frozenset((whole, chunked)))
        self.assertEqual(tuple(ledger.iterdump()), before)

    def test_missing_referenced_object_rejects_even_when_remaining_files_are_valid(self):
        identifier = self.store.put(b"retained history", "text/plain")
        ledger = self.ledger(identifier)
        shutil.rmtree(self.object_directory(identifier))
        self.assertEqual(inspection.inspect_cas_storage(self.root).objects, 0)
        with self.assertRaisesRegex(ValueError, "unavailable CAS object"):
            inspection.inspect_cas_storage(self.root, ledger=ledger)
        with self.assertRaisesRegex(ValueError, "unavailable CAS object"):
            VersionStore.inspect_cas_references(ledger, {})

    def test_ledger_metadata_must_match_verified_physical_descriptor(self):
        identifier = self.store.put(b"matching descriptor", "text/plain")
        ledger = self.ledger(identifier)
        for assignment in (
            "raw_size_bytes=raw_size_bytes+1",
            "stored_size_bytes=stored_size_bytes+1",
            "format_version=format_version+1",
            "descriptor_digest='wrong'",
            "trash_epoch='epoch'",
            "state='CORRUPT'",
            "state='TRASHED'",
        ):
            with self.subTest(assignment=assignment):
                ledger.execute("SAVEPOINT corrupt")
                try:
                    ledger.execute(f"UPDATE resources_objects SET {assignment}")
                    before = tuple(ledger.iterdump())
                    with self.assertRaises(ValueError):
                        inspection.inspect_cas_storage(self.root, ledger=ledger)
                    self.assertEqual(tuple(ledger.iterdump()), before)
                finally:
                    ledger.execute("ROLLBACK TO corrupt")
                    ledger.execute("RELEASE corrupt")

    def test_chunk_ledger_mismatch_and_missing_registration_reject(self):
        raw = b"chunk ledger mismatch" * 100_000
        identifier = self.store.put_stream(
            io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=digest(raw)
        )
        ledger = self.ledger(identifier)
        for statement in (
            "UPDATE resources_object_chunks SET raw_offset=raw_offset+1",
            "DELETE FROM resources_object_chunks",
            "UPDATE resources_chunks SET raw_size_bytes=raw_size_bytes+1",
            "UPDATE resources_chunks SET descriptor_digest='wrong'",
            "UPDATE resources_chunks SET state='TRASHED',trash_epoch='epoch'",
        ):
            with self.subTest(statement=statement):
                ledger.execute("SAVEPOINT corrupt")
                try:
                    ledger.execute(statement)
                    with self.assertRaises(ValueError):
                        inspection.inspect_cas_storage(self.root, ledger=ledger)
                finally:
                    ledger.execute("ROLLBACK TO corrupt")
                    ledger.execute("RELEASE corrupt")
        # Model damage from a writer that bypassed foreign keys. The live-set
        # query must not lose the reference through an inner join to objects.
        ledger.execute("PRAGMA foreign_keys=OFF")
        ledger.execute("DELETE FROM resources_objects")
        ledger.commit()
        with self.assertRaisesRegex(ValueError, "unregistered CAS object"):
            inspection.inspect_cas_storage(self.root, ledger=ledger)

    def test_unreferenced_gc_residue_is_not_treated_as_missing_history(self):
        identifier = self.store.put(b"eligible for collection", "text/plain")
        ledger = self.ledger(identifier)
        ledger.execute("DELETE FROM resources_turn_objects")
        ledger.execute("UPDATE resources_objects SET state='TRASHED',trash_epoch='epoch'")
        ledger.commit()
        self.store.apply_gc(GcPlan((GcEntry(CasEntryKind.OBJECT, identifier, "epoch"),), ()))
        result = inspection.inspect_cas_storage(self.root, ledger=ledger)
        self.assertEqual(result.objects, 0)
        self.assertGreater(result.trashed_files, 0)
        self.assertEqual(
            ledger.execute("SELECT state FROM resources_objects").fetchone()[0], "TRASHED"
        )

    def test_live_inspection_does_not_create_absent_storage(self):
        absent = self.root / "absent"
        result = inspection.inspect_cas_storage(absent)
        self.assertFalse(result.present)
        self.assertEqual(result.objects, 0)
        self.assertFalse(absent.exists())

    def test_orphan_chunks_are_inspected_and_unknown_metadata_is_rejected(self):
        raw = b"orphan chunk content" * 100_000
        object_id = digest(raw)
        self.store.put_stream(
            io.BytesIO(raw), raw_size_bytes=len(raw), expected_object_id=object_id
        )
        descriptor = self.store.verify(object_id)
        chunk = descriptor.chunks[0]
        path = self.store.chunk_payload_path(chunk.chunk_id).parent / "meta.json"
        original = path.read_bytes()
        body = json.loads(original)
        body.pop("descriptor_digest")
        encoded = self.store._descriptor_bytes({**body, "format_version": 999})
        path.write_bytes(encoded)
        with self.assertRaises(CasCorruptError):
            self.store.verify(object_id)
        with self.assertRaises(CasCorruptError):
            inspection.inspect_cas_storage(self.root)
        path.write_bytes(original)
        shutil.rmtree(self.object_directory(object_id))
        result = inspection.inspect_cas_storage(self.root)
        self.assertEqual(result.objects, 0)
        self.assertGreater(result.chunks, 0)
        path.write_bytes(encoded)
        with self.assertRaises(CasCorruptError):
            inspection.inspect_cas_storage(self.root)
        self.assertEqual(path.read_bytes(), encoded)

    def test_staging_and_trash_are_retained_as_residual_bytes_without_recovery(self):
        live = self.store.put(b"live source", "text/plain")
        removed = self.store.put(b"removed source", "text/plain")
        staged = self.store.stage(live, "restore", 0)
        # Recovery always regenerates this file before use. An interrupted raw
        # staging write must not be mistaken for a malformed live descriptor.
        staged.write_bytes(b"interrupted")
        self.store.apply_gc(GcPlan((GcEntry(CasEntryKind.OBJECT, removed, "epoch"),), ()))
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        result = inspection.inspect_cas_storage(self.root)
        self.assertEqual(result.objects, 1)
        self.assertEqual(result.staged_files, 1)
        self.assertEqual(result.trashed_files, 2)
        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)
        staged.write_bytes(b"a different interrupted write")
        self.assertNotEqual(inspection.inspect_cas_storage(self.root).digest, result.digest)
        self.assertEqual(staged.read_bytes(), b"a different interrupted write")

    def test_residual_tree_is_bounded_and_empty_directories_affect_evidence(self):
        (self.root / "staging").mkdir(exist_ok=True)
        initial = inspection.inspect_cas_storage(self.root)
        (self.root / "staging" / "transaction").mkdir()
        self.assertNotEqual(inspection.inspect_cas_storage(self.root).digest, initial.digest)
        with patch.object(inspection, "MAX_RESIDUAL_DEPTH", 1):
            with self.assertRaisesRegex(ValueError, "depth"):
                inspection.inspect_cas_storage(self.root)
        with patch.object(inspection, "MAX_RESIDUAL_ENTRIES", 0):
            with self.assertRaisesRegex(ValueError, "entry budget"):
                inspection.inspect_cas_storage(self.root)

    def test_live_inspection_fails_on_corruption_unknown_storage_or_exceeded_budget(self):
        object_id = self.store.put(b"whole-content", "text/plain")
        with patch.object(inspection, "MAX_TOTAL_BYTES", 1):
            with self.assertRaises(ValueError):
                inspection.inspect_cas_storage(self.root)
        future = self.root / "cas" / "v2"
        future.mkdir()
        with self.assertRaisesRegex(ValueError, "storage version"):
            inspection.inspect_cas_storage(self.root)
        future.rmdir()
        payload = self.object_directory(object_id) / "payload"
        payload.write_bytes(b"wrong-content")
        with self.assertRaises(CasCorruptError):
            inspection.inspect_cas_storage(self.root)
        self.assertEqual(payload.read_bytes(), b"wrong-content")

    @unittest.skipIf(os.name == "nt", "symlink privilege is a separate Windows prerequisite")
    def test_live_inspection_rejects_payload_symlink(self):
        object_id = self.store.put(b"whole-content", "text/plain")
        payload = self.object_directory(object_id) / "payload"
        (self.root / "staging").mkdir(exist_ok=True)
        outside = self.root / "staging" / "outside"
        payload.rename(outside)
        payload.symlink_to(outside)
        with self.assertRaises(OSError):
            inspection.inspect_cas_storage(self.root)
        self.assertTrue(payload.is_symlink())


if __name__ == "__main__":
    unittest.main()
