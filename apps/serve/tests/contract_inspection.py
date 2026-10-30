"""Private inspector framing/evidence contracts, not signed updater acceptance."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from damoatrace.search.index import IndexCheck
from service.chat.persistence.trace import HistoryInspection, TraceProjection, TraceStartupSources
from service.cli.inspection import (
    FAILURE_EXIT_CODE,
    MAX_REQUEST_BYTES,
    InspectionSelection,
    evidence,
    request,
)


@dataclass(frozen=True)
class EvidenceRecord:
    source: bytes
    generation: int


class InspectionContracts(unittest.TestCase):
    def test_evidence_rejects_unregistered_builtin_subclasses(self):
        # Even apparently ordinary values can have subclass-specific equality.
        for base, value in (
            (str, "x"),
            (int, 1),
            (float, 1.0),
            (tuple, (1,)),
            (list, [1]),
            (dict, {"x": 1}),
        ):
            subclass = type("ExtendedValue", (base,), {})
            extended = subclass(value)
            with self.subTest(base=base.__name__):
                with self.assertRaisesRegex(ValueError, "unsupported inspection evidence"):
                    evidence(extended)
        string_subclass = type("ExtendedKey", (str,), {})
        with self.assertRaisesRegex(ValueError, "unsupported inspection evidence"):
            evidence({string_subclass("key"): 1})

    def test_inspection_evidence_tracks_history_scope_not_timing_observations(self):
        complete = TraceProjection(True, True, IndexCheck.COMPLETE)
        incomplete = TraceProjection(True, True, IndexCheck.INCOMPLETE_BUDGET)
        self.assertEqual(evidence(complete), evidence(incomplete))
        self.assertNotEqual(evidence(complete), evidence(TraceProjection(True, False)))
        deferred = TraceStartupSources((), None, complete, history=HistoryInspection.DEFERRED)
        checked = TraceStartupSources((), (), complete, history=HistoryInspection.COMPLETE)
        self.assertNotEqual(evidence(deferred), evidence(checked))

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native inspector platforms")
    def test_retired_capture_frame_is_rejected_without_receipt_or_storage_creation(self):
        with tempfile.TemporaryDirectory() as parent:
            home = Path(parent) / "selected-home"
            result = subprocess.run(
                [sys.executable, "-P", "-m", "service.cli.inspection"],
                input=b'{"version":1,"operation":"capture","bytes":1,"sha256":"'
                + b"a" * 64
                + b'"}\nX',
                env=dict(os.environ, SCHOLARSEED_HOME=str(home)),
                capture_output=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, FAILURE_EXIT_CODE)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr.splitlines(), [b"inspection_failed"])
            self.assertFalse(home.exists())

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native inspector platforms")
    def test_startup_mode_cannot_enter_update_projection_or_exports(self):
        payloads = [{"version": 1, "operation": operation} for operation in ("cas", "rows")]
        payloads.append(
            {
                "version": 1,
                "bindings": [{"path": str(Path.cwd()), "identity": "identity", "ancestors": []}],
                "cwd": str(Path.cwd()),
                "bridge": None,
                "projection": True,
            }
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                result = subprocess.run(
                    [sys.executable, "-P", "-m", "service.cli.inspection", "--startup"],
                    input=(json.dumps(payload) + "\n").encode(),
                    capture_output=True,
                    timeout=30,
                )
                self.assertEqual(result.returncode, FAILURE_EXIT_CODE)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr.splitlines(), [b"inspection_failed"])

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native inspector platforms")
    def test_inspector_rejects_unknown_or_repeated_startup_mode(self):
        for args in (["--unknown"], ["--startup", "--startup"], ["--startup=false"]):
            with self.subTest(args=args):
                result = subprocess.run(
                    [sys.executable, "-P", "-m", "service.cli.inspection", *args],
                    input=b"",
                    capture_output=True,
                    timeout=30,
                )
                self.assertEqual(result.returncode, FAILURE_EXIT_CODE)
                self.assertEqual(result.stderr.splitlines(), [b"inspection_failed"])

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native inspector platforms")
    def test_startup_and_update_defer_unchanged_diagnostic_history(self):
        program = r"""
import base64, io, json, sqlite3, sys
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from service.cli import inspection as inspector
from service.chat.persistence import ledger, trace
from damoatrace.search.index import TraceIndex
from service.platform.domains import Domains, _binding
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative
trace.MAX_TRACE_BYTES = 32
root = Path(sys.argv[1]).resolve()
native = DarwinDirectoryNative() if sys.platform == 'darwin' else WindowsDirectoryNative()
home = root / 'home'
workspace = root / 'workspace'
coordination = root / 'coordinator'
roots = [home, home / 'service', home / 'logs' / 'trace', workspace]
for path in [home, home / 'service', home / 'logs', home / 'logs' / 'trace', workspace, coordination]:
    pin = native.pin(str(path), True)
    native.release(pin)
payload = b'{"diagnostic_content_version":1}\n' * 8
if sys.argv[3] == 'corrupt':
    payload += b'{"diagnostic_content_version":999}\n'
content = home / 'logs' / 'trace' / 'history.jsonl'
content.write_bytes(payload)
with closing(TraceIndex(home / 'logs' / 'trace' / 'index.sqlite3')):
    pass
index = home / 'logs' / 'trace' / 'index.sqlite3'
if sys.argv[3] == 'future-index':
    with sqlite3.connect(index) as connection:
        connection.execute("UPDATE projection_versions SET version='future-v999'")
index_before = index.read_bytes(), index.stat().st_mtime_ns
for attempt in range(4):
    owner = Domains(native, str(coordination), [str(path) for path in roots])
    owner.occupy()
    bindings = []
    pins = []
    try:
        for path in roots:
            pin = native.pin(str(path), False)
            pins.append(pin)
            binding = _binding(native, pin, str(path))
            bindings.append(dict(path=binding.path, identity=binding.identity, ancestors=list(binding.ancestors)))
        frame = dict(version=1, bindings=bindings, cwd=str(workspace), bridge=None)
        if sys.argv[2] == 'projection':
            frame.update(projection=True, recovery_at=1234, recovery_id='a' * 64)
        sys.stdin = io.TextIOWrapper(io.BytesIO((json.dumps(frame)+'\n').encode() * 2))
        output = io.BytesIO()
        sys.stdout = io.TextIOWrapper(output)
        with (
            patch.object(trace, '_names', side_effect=AssertionError('admission enumerated history')),
            patch.object(ledger._LedgerReader, 'inspect', side_effect=AssertionError('admission read ledger')),
            patch.object(TraceIndex, 'inspect_startup', side_effect=AssertionError('admission copied index')),
        ):
            code = inspector.main(['--startup'] if sys.argv[2] == 'startup' else [])
        sys.stdout.flush()
        frames = output.getvalue().splitlines()
    finally:
        for pin in reversed(pins): native.release(pin)
        owner.close()
    assert content.read_bytes() == payload
    assert (index.read_bytes(), index.stat().st_mtime_ns) == index_before
    if code:
        sys.__stdout__.write('rejected\n')
        raise SystemExit(code)
        assert len(frames) == 2 and frames[0] == frames[1], frames
    wanted = {Path(path) for path in json.loads(frames[-1])['roots']}
    if wanted <= set(roots):
        response = json.loads(frames[-1])
        assert response['projects_deferred'] is (sys.argv[2] == 'startup')
        assert set(response['root_roles']) == set(response['roots'])
        if sys.argv[2] == 'startup':
            assert str(workspace) not in response['roots']
            assert 'layouts' not in response and 'documents' not in response
        observed = json.loads(base64.b64decode(response['evidence']))
        assert 'deferred' in json.dumps(observed)
        if sys.argv[2] == 'projection':
            assert observed[1][-2] == ['enum', trace.HistoryInspection.__module__, 'HistoryInspection', ['str', 'deferred']]
            assert any(document['name'] == 'trace-write-formats' for document in response['documents'])
        sys.__stdout__.write('verified\n')
        raise SystemExit(0)
    roots = sorted(set(roots) | wanted)
    for path in roots:
        path.mkdir(parents=True, exist_ok=True)
raise AssertionError('discovery did not converge')
"""
        for mode, data, expected in (
            ("startup", "valid", 0),
            ("update", "valid", 0),
            ("startup", "corrupt", 0),
            ("update", "corrupt", 0),
            ("projection", "valid", 0),
            ("projection", "corrupt", 0),
            ("startup", "future-index", 2),
            ("update", "future-index", 2),
            ("projection", "future-index", 2),
        ):
            with self.subTest(mode=mode, data=data), tempfile.TemporaryDirectory() as directory:
                home = Path(directory).resolve() / "home"
                environment = dict(
                    os.environ,
                    SCHOLARSEED_HOME=str(home),
                    DAMOATRACE_HOME=str(home),
                    DAMOATRACE_LEDGER_ROOT=str(home / "projects"),
                    SCHOLARSEED_CODEX_HOME=str(home / "codex"),
                )
                result = subprocess.run(
                    [sys.executable, "-P", "-c", program, directory, mode, data],
                    env=environment,
                    capture_output=True,
                    timeout=60,
                )
                self.assertEqual(result.returncode, expected, result.stderr.decode())
                self.assertEqual(
                    result.stdout.splitlines(), [b"verified" if expected == 0 else b"rejected"]
                )

    def test_discovery_can_enter_projection_but_cannot_change_its_inputs_afterward(self):
        for source in (False, True):
            with self.subTest(source=source):
                selection = InspectionSelection()
                for _ in range(3):
                    selection.observe("workspace", None, False, None, None, None, None)
                layouts = [] if source else None
                publications = [] if source else None
                selection.observe("workspace", None, True, layouts, 1234, "a" * 64, publications)
                selection.observe("workspace", None, True, layouts, 1234, "a" * 64, publications)
                for changed in (
                    ("other", None, True, layouts, 1234, "a" * 64, publications),
                    ("workspace", "bridge", True, layouts, 1234, "a" * 64, publications),
                    ("workspace", None, False, None, None, None, None),
                    ("workspace", None, True, layouts, 1235, "a" * 64, publications),
                    ("workspace", None, True, layouts, 1234, "b" * 64, publications),
                    ("workspace", None, True, None if source else [], 1234, "a" * 64, publications),
                    ("workspace", None, True, layouts, 1234, "a" * 64, None if source else []),
                ):
                    with self.subTest(changed=changed), self.assertRaises(ValueError):
                        selection.observe(*changed)

    def test_discovery_freezes_workspace_before_any_projection(self):
        selection = InspectionSelection()
        selection.observe("workspace", None, False, None, None, None, None)
        with self.assertRaises(ValueError):
            selection.observe("replacement", None, True, None, 1234, "a" * 64, None)

    def test_source_declaration_request_has_exact_fields(self):
        self.assertIsNone(request(b'{"version":1,"operation":"sources"}'))
        for payload in (
            b'{"version":true,"operation":"sources"}',
            b'{"version":1,"operation":"unknown"}',
            b'{"version":1,"operation":"sources","bindings":[]}',
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                request(payload)

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native inspector platforms")
    def test_source_declaration_uses_path_owner_without_creating_home(self):
        with tempfile.TemporaryDirectory() as parent:
            home = Path(parent) / "selected-home"
            environment = dict(os.environ, SCHOLARSEED_HOME=str(home))
            frame = b'{"version":1,"operation":"sources"}\n'
            for count in (1, 2):
                result = subprocess.run(
                    [sys.executable, "-P", "-m", "service.cli.inspection"],
                    input=frame * count,
                    env=environment,
                    capture_output=True,
                    timeout=30,
                )
                self.assertEqual(result.returncode, 0 if count == 1 else FAILURE_EXIT_CODE)
                lines = result.stdout.splitlines()
                self.assertEqual(len(lines), 1)
                value = json.loads(lines[0])
                self.assertEqual(
                    value,
                    {
                        "version": 1,
                        "event": "sources",
                        "roots": sorted([str(home), str(home / "service")]),
                    },
                )
                self.assertEqual(
                    result.stderr.splitlines(), [] if count == 1 else [b"inspection_failed"]
                )
                self.assertFalse(home.exists())

    def test_null_bridge_uses_product_default_and_empty_path_is_rejected(self):
        payload = {
            "version": 1,
            "bindings": [{"path": str(Path.cwd()), "identity": "identity", "ancestors": []}],
            "cwd": str(Path.cwd()),
            "bridge": None,
        }
        decoded = request(json.dumps(payload).encode())
        assert decoded is not None
        self.assertIsNone(decoded[2])
        for invalid in ("", False, 0, []):
            payload["bridge"] = invalid
            with self.assertRaises((ValueError, TypeError)):
                request(json.dumps(payload).encode())

    def test_candidate_layout_requires_explicit_projection(self):
        payload = {
            "version": 1,
            "bindings": [{"path": str(Path.cwd()), "identity": "identity", "ancestors": []}],
            "cwd": str(Path.cwd()),
            "bridge": None,
        }
        decoded = request(json.dumps(payload).encode())
        assert decoded is not None
        self.assertEqual(decoded[3:], (False, None, None, None, None, None, None))
        layouts = [{"name": "private-layout"}]
        documents = [{"name": "private-document"}]
        # The framing owner only selects the mode. Persistence owners decode
        # and reject incomplete layout objects before executing any SQL.
        decoded = request(
            json.dumps(
                dict(
                    payload,
                    projection=True,
                    candidate_layouts=layouts,
                    candidate_documents=documents,
                )
            ).encode()
        )
        assert decoded is not None
        self.assertEqual(decoded[3:], (True, layouts, documents, None, None, None, None))
        publications = [{"name": "project.fixture", "objects": []}]
        with_publications = request(
            json.dumps(
                dict(
                    payload,
                    projection=True,
                    candidate_layouts=layouts,
                    candidate_documents=documents,
                    candidate_publications=publications,
                )
            ).encode()
        )
        assert with_publications is not None
        self.assertEqual(with_publications[-1], publications)
        timed = request(json.dumps(dict(payload, projection=True, recovery_at=1234)).encode())
        assert timed is not None
        self.assertEqual(timed[6:8], (1234, None))
        planned = request(
            json.dumps(
                dict(payload, projection=True, recovery_at=1234, recovery_id="a" * 64)
            ).encode()
        )
        assert planned is not None
        self.assertEqual(planned[6:8], (1234, "a" * 64))
        for fields in (
            {"projection": True, "candidate_publications": []},
            {
                "projection": True,
                "candidate_layouts": layouts,
                "candidate_documents": documents,
                "candidate_publications": None,
            },
            {
                "projection": True,
                "candidate_layouts": layouts,
                "candidate_documents": documents,
                "candidate_publications": publications + publications,
            },
            {"projection": True, "recovery_id": "a" * 64},
            {"projection": True, "recovery_at": 1234, "recovery_id": None},
            {"projection": True, "recovery_at": 1234, "recovery_id": "A" * 64},
            {"projection": True, "recovery_at": 1234, "recovery_id": "a" * 63},
            {"recovery_at": 1234},
            {"projection": True, "recovery_at": None},
            {"projection": True, "recovery_at": True},
            {"projection": True, "recovery_at": 0},
            {"projection": True, "recovery_at": -1},
            {"projection": True, "recovery_at": 1.5},
            {"projection": True, "recovery_at": 9007199254740992},
            {"candidate_layouts": layouts},
            {"projection": False, "candidate_layouts": layouts},
            {"projection": 1},
            {"projection": None},
            {"projection": True, "candidate_layouts": None},
            {"projection": True, "candidate_layouts": []},
            {"projection": True, "candidate_layouts": {}},
            {"projection": True, "candidate_layouts": layouts},
            {"projection": True, "candidate_documents": documents},
            {"projection": True, "candidate_layouts": layouts, "candidate_documents": []},
            {"projection": True, "candidate_layouts": layouts, "candidate_documents": None},
        ):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                request(json.dumps(dict(payload, **fields)).encode())

    def test_evidence_preserves_types_bytes_and_all_record_fields(self):
        values = [
            None,
            "",
            False,
            0,
            0.0,
            (),
            [],
            {},
            b"",
            Path("."),
            EvidenceRecord(b"secret-a", 1),
            EvidenceRecord(b"secret-b", 1),
            EvidenceRecord(b"secret-a", 2),
            ["bytes", "c2VjcmV0LWE="],
        ]
        encoded = [json.dumps(evidence(value), separators=(",", ":")) for value in values]
        self.assertEqual(len(set(encoded)), len(values))
        self.assertEqual(evidence({"b": 2, "a": 1}), evidence({"a": 1, "b": 2}))
        for invalid in (float("nan"), float("inf"), object(), {1: "non-string-key"}):
            with self.assertRaises(ValueError):
                evidence(invalid)

    def test_duplicate_fields_and_unknown_protocol_are_rejected(self):
        for payload in (
            b'{"version":1,"version":1}',
            b"[]",
            b'{"version":true,"bindings":[],"cwd":"/","bridge":"/"}',
            b'{"version":2,"bindings":[],"cwd":"/","bridge":"/"}',
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                request(payload)

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native inspector platforms")
    def test_process_rejects_bad_frame_without_echoing_private_input(self):
        for payload in (
            b'{"secret":"do-not-echo"}\n',
            b'{"secret":"do-not-echo"}',
            b"x" * (MAX_REQUEST_BYTES + 1),
        ):
            result = subprocess.run(
                [sys.executable, "-P", "-m", "service.cli.inspection"],
                input=payload,
                capture_output=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, FAILURE_EXIT_CODE)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr.splitlines(), [b"inspection_failed"])

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native inspector platforms")
    def test_empty_private_pipe_exits_without_output(self):
        result = subprocess.run(
            [sys.executable, "-P", "-m", "service.cli.inspection"],
            input=b"",
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual((result.stdout, result.stderr), (b"", b""))


if __name__ == "__main__":
    unittest.main()
