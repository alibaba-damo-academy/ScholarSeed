"""MCP configuration contracts using real private files and OS locks."""

from __future__ import annotations

import json
import os
import tempfile
import traceback
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from scholarseed_runtime.contract.mcp import (
    McpCredentialTarget,
    McpHttpTransport,
    McpStdioTransport,
)
from service.platform.mcp import McpHttpServer, McpStdioServer
from service.platform.storage import canonical_root, open_private_directory
from service.settings.mcp import (
    MCP_CONFIG_LOCK_FILENAME,
    MCP_MAX_CONFIG_BYTES,
    McpConfigurationConflict,
    McpConfigurationError,
    McpConfigurationStore,
    McpDocument,
    runtime_server,
)

CONFIG_NAME = "mcp.json"
SERVER_NAME = "example"
SERVER_URL = "https://example.invalid/mcp"
SECRET_REFERENCE = "credential-reference"


class ConfigurationSchemaTests(unittest.TestCase):
    def test_startup_timeout_survives_storage_and_runtime_projection(self):
        server = McpHttpServer(id="example", url=SERVER_URL, startup_timeout=1250, timeout=9000)
        document = McpConfigurationStore.decode(
            McpDocument(servers=(server,)).model_dump_json().encode()
        )
        projected = runtime_server(document.servers[0])
        self.assertEqual(projected.startup_timeout_ms, 1250)
        self.assertEqual(projected.tool_timeout_ms, 9000)
        for value in (True, 0, 999, 1.5, 2**53):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                McpHttpServer(id="bad", url=SERVER_URL, startup_timeout=value)

    def test_missing_is_empty_but_empty_or_malformed_file_is_not(self):
        self.assertEqual(McpConfigurationStore.decode(None), McpDocument())
        for payload in (b"", b"[]", b"null", b"{", b'{"schema_version":2}'):
            with self.subTest(payload=payload), self.assertRaises(McpConfigurationError):
                McpConfigurationStore.decode(payload)

    def test_unknown_fields_and_duplicate_keys_rejected(self):
        for payload in (
            b'{"unknown":1}',
            b'{"schema_version":true}',
            b'{"revision":1,"revision":2}',
            b'{"servers":[{"id":"bad","transport":"shell","command":"anything"}]}',
        ):
            with self.subTest(payload=payload), self.assertRaises(McpConfigurationError):
                McpConfigurationStore.decode(payload)

    def test_schema_round_trip_preserves_disabled_server_and_secret_refs(self):
        document = McpDocument(
            revision=3,
            servers=(
                McpStdioServer(
                    id=SERVER_NAME,
                    command="program with spaces",
                    args=("argument with spaces",),
                    enabled=False,
                    environment={"LANG": "en_US.UTF-8"},
                    environment_secrets={"TOKEN": SECRET_REFERENCE},
                ),
                McpHttpServer(
                    id="remote",
                    url=SERVER_URL,
                    header_secrets={"Authorization": SECRET_REFERENCE},
                ),
            ),
        )
        self.assertEqual(
            McpConfigurationStore.decode(document.model_dump_json().encode()), document
        )

    def test_duplicate_server_ids_rejected(self):
        server = McpHttpServer(id=SERVER_NAME, url=SERVER_URL)
        with self.assertRaises(ValidationError):
            McpDocument(servers=(server, server))

    def test_runtime_snapshot_has_immutable_values_and_opaque_credentials(self):
        server = McpStdioServer(
            id=SERVER_NAME,
            command="program",
            environment={"LANG": "original"},
            environment_secrets={"TOKEN": SECRET_REFERENCE},
        )
        document = McpDocument(revision=2, servers=(server,))
        request = document.runtime()
        server.environment["LANG"] = "changed"
        projected = request.servers[0]
        self.assertIsInstance(projected.transport, McpStdioTransport)
        self.assertEqual(projected.transport.environment, (("LANG", "original"),))
        self.assertEqual(projected.credentials[0].target, McpCredentialTarget.ENVIRONMENT)
        self.assertNotIn(SECRET_REFERENCE, repr(request))
        self.assertEqual(request.revision, 2)
        remote = runtime_server(McpHttpServer(id="remote", url=SERVER_URL))
        self.assertIsInstance(remote.transport, McpHttpTransport)

    def test_ambiguous_environment_and_injected_arguments_rejected(self):
        with self.assertRaises(ValidationError):
            McpStdioServer(
                id=SERVER_NAME,
                command="program",
                environment={"TOKEN": "plain"},
                environment_secrets={"TOKEN": SECRET_REFERENCE},
            )
        with self.assertRaises(ValidationError):
            McpStdioServer(id=SERVER_NAME, command="program", args=("bad\x00arg",))

    def test_environment_names_remain_unambiguous_on_windows(self):
        for plain, secret in (
            ({"TOKEN": "plain"}, {"token": SECRET_REFERENCE}),
            ({"Path": "one", "PATH": "two"}, {}),
            ({}, {"TOKEN": "one", "token": "two"}),
        ):
            with self.subTest(plain=plain, secret=secret), self.assertRaises(ValidationError):
                McpStdioServer(
                    id=SERVER_NAME,
                    command="program",
                    environment=plain,
                    environment_secrets=secret,
                )

    def test_invalid_payload_is_not_exposed_by_formatted_exception(self):
        private = "PRIVATE-CREDENTIAL-SENTINEL"
        payload = json.dumps({"servers": [{"id": private}]}).encode()
        try:
            McpConfigurationStore.decode(payload)
        except McpConfigurationError as error:
            self.assertNotIn(private, "".join(traceback.format_exception(error)))
        else:
            self.fail("invalid configuration was accepted")

    def test_http_credentials_are_references_not_plain_headers(self):
        for headers in ({"Authorization": "secret"}, {"Cookie": "secret"}, {"X": "a\r\nb"}):
            with self.subTest(headers=headers), self.assertRaises(ValidationError):
                McpHttpServer(id=SERVER_NAME, url=SERVER_URL, headers=headers)
        with self.assertRaises(ValidationError):
            McpHttpServer(
                id=SERVER_NAME,
                url=SERVER_URL,
                headers={"X-Token": "plain"},
                header_secrets={"x-token": SECRET_REFERENCE},
            )

    def test_unsafe_url_and_oversized_document_rejected(self):
        for url in (
            "file:///private",
            "https://user:secret@example.invalid/mcp",
            "https://x/#token",
            "https://example.invalid:abc/mcp",
            "https://example.invalid:99999/mcp",
        ):
            with self.subTest(url=url), self.assertRaises(ValidationError):
                McpHttpServer(id=SERVER_NAME, url=url)
        with self.assertRaises(ValueError):
            McpConfigurationStore.decode(b" " * (MCP_MAX_CONFIG_BYTES + 1))


class ConfigurationStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.store = McpConfigurationStore(self.root / CONFIG_NAME)
        self.server = McpHttpServer(id=SERVER_NAME, url=SERVER_URL)

    def test_atomic_replace_uses_commit_order_for_stale_revision(self):
        self.assertEqual(self.store.read().revision, 0)
        first = self.store.replace((self.server,), expected_revision=0)
        self.assertEqual(first.revision, 1)
        second = self.store.replace((), expected_revision=0)
        self.assertEqual(second.revision, 2)
        self.assertEqual(self.store.read(), second)
        self.assertFalse(tuple(self.root.glob(".mcp-*")))

    def test_corrupt_file_is_not_overwritten(self):
        self.store.replace((self.server,), expected_revision=0)
        self.store.path.write_text("invalid", encoding="utf-8")
        with self.assertRaises(McpConfigurationError):
            self.store.replace((), expected_revision=0)
        self.assertEqual(self.store.path.read_text(), "invalid")

    def test_noncooperating_edit_detected_before_publication_is_preserved(self):
        self.store.replace((self.server,), expected_revision=0)
        external = McpDocument(
            revision=1, servers=(McpHttpServer(id="external", url=SERVER_URL),)
        ).model_dump_json()
        real_fsync = os.fsync

        def external_edit(descriptor):
            real_fsync(descriptor)
            self.store.path.write_text(external, encoding="utf-8")

        with patch("service.settings.mcp.os.fsync", side_effect=external_edit):
            with self.assertRaises(McpConfigurationConflict):
                self.store.replace((), expected_revision=1)
        self.assertEqual(self.store.path.read_text(), external)
        self.assertFalse(tuple(self.root.glob(".mcp-*")))

    def test_second_writer_cannot_bypass_held_os_lock(self):
        with closing(open_private_directory(canonical_root(self.root), ())) as directory:
            with directory.arbitration(MCP_CONFIG_LOCK_FILENAME):
                with self.assertRaises(OSError):
                    self.store.replace((self.server,), expected_revision=0)
        self.assertFalse(self.store.path.exists())
        self.store.replace((self.server,), expected_revision=0)

    @unittest.skipIf(os.name == "nt", "Windows reparse tests require its native fixture")
    def test_config_symlink_does_not_escape_or_get_replaced(self):
        target = self.root / "unrelated.json"
        target.write_text(json.dumps({"keep": True}), encoding="utf-8")
        self.store.path.symlink_to(target)
        with self.assertRaises(OSError):
            self.store.replace((), expected_revision=0)
        self.assertTrue(self.store.path.is_symlink())
        self.assertEqual(json.loads(target.read_text()), {"keep": True})

    def test_boolean_revision_is_not_an_integer_revision(self):
        with self.assertRaises(McpConfigurationConflict):
            self.store.replace((), expected_revision=True)


if __name__ == "__main__":
    unittest.main()
