"""Preset and authorization security contracts; not live service acceptance."""

from __future__ import annotations

import asyncio
import gzip
import json
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from mcp import ClientSession, types
from mcp.client.streamable_http import streamablehttp_client

from scholarseed_runtime.contract.mcp import McpConfigurationReceipt
from service.chat.api.connectors import CALLBACK_ROUTE, CALLBACK_STATE_KEY, ConnectorCallbackPrivacy
from service.platform.activity import Activities, ActivityDomain, MaintenanceStale
from service.platform.mcp import McpHttpServer
from service.settings.connectors.broker import Binding, ConnectorBroker
from service.settings.connectors.catalog import CONNECTORS
from service.settings.connectors.custom import (
    SERVER_ADAPTER,
    material,
    prepare,
    public_custom,
    validate_binding,
)
from service.settings.connectors.discovery import PublicTransport, custom_discovery
from service.settings.connectors.hosted import HostedOAuth
from service.settings.connectors.oauth import checked_url, json_response, pkce, request
from service.settings.connectors.probe import ConnectionFailure, verify
from service.settings.connectors.service import (
    ConnectorSecrets,
    ConnectorService,
    new_entry,
    public_entry,
)
from service.settings.connectors.store import ConnectorStore
from service.settings.connectors.transport import (
    Connection,
    CredentialAuth,
    inspect_server,
    transport_error,
)
from service.settings.connectors.zotero import GROUP_PAGE_SIZE, groups
from service.settings.mcp import McpConfigurationService, McpConfigurationStore, runtime_server


class ConnectorContracts(unittest.TestCase):
    def test_hosted_credentials_refresh_through_the_resolver_without_local_exchange(self):
        hosted = HostedOAuth("https://accounts.example", lambda owner: "account-token")
        resolver = ConnectorSecrets(None, Activities(), hosted)
        attempt = {"client": {"hosted": True}}
        with (
            patch.object(hosted, "exchange", return_value={"access_token": "next"}) as remote,
            patch("service.settings.connectors.service.exchange") as direct,
        ):
            result = resolver.exchange(
                None, CONNECTORS["github"], attempt, {"grant_type": "refresh_token"}
            )
        self.assertEqual(result["access_token"], "next")
        remote.assert_called_once()
        direct.assert_not_called()
        with self.assertRaisesRegex(ValueError, "connector_oauth_registration_required"):
            ConnectorSecrets(None, Activities()).exchange(None, CONNECTORS["github"], attempt, {})

    def test_hosted_authorization_never_requires_or_returns_an_application_secret(self):
        hosted = HostedOAuth(
            "https://accounts.example", lambda owner: "account-token" if owner == "owner" else ""
        )
        issued = {
            "authorization_id": "attempt",
            "state": "state",
            "expires_at": time.time() + 60,
            "authorization_url": "https://github.com/login/oauth/authorize?client_id=public",
        }
        with patch.object(hosted, "_call", return_value=issued) as invoke:
            attempt = hosted.begin(
                CONNECTORS["github"],
                "owner",
                "http://127.0.0.1:1111/api/settings/connectors/callback",
            )
        self.assertNotIn("client_secret", json.dumps(attempt))
        self.assertEqual(invoke.call_args.args[2], "authorizations")
        self.assertNotIn("code_verifier", invoke.call_args.args[3])
        with patch.object(
            hosted,
            "_call",
            return_value={
                "access_token": "access",
                "refresh_token": "refresh",
                "token_type": "bearer",
                "connection_id": "connection",
            },
        ):
            credential = hosted.exchange(
                CONNECTORS["github"],
                attempt,
                {
                    "grant_type": "authorization_code",
                    "code": "code",
                    "code_verifier": attempt["verifier"],
                },
            )
        self.assertEqual(attempt["client"]["connection_id"], "connection")
        with patch.object(
            hosted, "_call", return_value={"access_token": "next", "token_type": "bearer"}
        ) as invoke:
            hosted.exchange(
                CONNECTORS["github"],
                attempt,
                {"grant_type": "refresh_token", "refresh_token": credential["refresh_token"]},
            )
        self.assertEqual(invoke.call_args.args[3]["connection_id"], "connection")

    def test_hosted_rejects_missing_identity_and_insecure_account_transport(self):
        for url, token, expected in (
            ("http://accounts.example", "token", "connector_oauth_registration_required"),
            (
                "https://user:secret@accounts.example",
                "token",
                "connector_oauth_registration_required",
            ),
            ("https://accounts.example", "", "connector_login_required"),
        ):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, expected):
                HostedOAuth(url, lambda _, token=token: token)._call(
                    CONNECTORS["github"], "owner", "authorizations", {}
                )

    def test_key_labels_are_uniform_without_changing_supported_methods(self):
        for item in CONNECTORS.values():
            if "key" in item.methods:
                self.assertEqual(item.key_label, "API Key")
            else:
                self.assertEqual(item.key_label, "")

    def test_compressed_responses_are_decoded_once_and_preserve_status(self):
        for status, content, media_type, rpc_id in (
            (200, b"[]", "application/json", None),
            (403, b'{"error":"insufficient_scope"}', "application/json", None),
            (200, b'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', "text/event-stream", 1),
        ):
            with self.subTest(status=status, media_type=media_type):
                compressed = gzip.compress(content)

                def handler(incoming):
                    return httpx.Response(
                        status,
                        headers={
                            "Content-Encoding": "gzip",
                            "Content-Type": media_type,
                            "Content-Length": str(len(compressed)),
                            "Mcp-Session-Id": "session",
                        },
                        stream=httpx.ByteStream(compressed),
                    )

                with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                    response = request(client, "GET", "https://example.invalid/mcp", rpc_id=rpc_id)
                self.assertEqual(response.content, content)
                self.assertEqual(response.status_code, status)
                self.assertNotIn("content-encoding", response.headers)
                self.assertEqual(int(response.headers["content-length"]), len(content))
                self.assertEqual(response.headers["mcp-session-id"], "session")
                if status == 403:
                    with self.assertRaisesRegex(ValueError, "connector_permission_denied"):
                        json_response(response)

    def test_corrupt_compression_is_response_error_not_network_failure(self):
        def handler(incoming):
            return httpx.Response(
                200,
                headers={"Content-Encoding": "gzip"},
                stream=httpx.ByteStream(b"invalid gzip content"),
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaisesRegex(ValueError, "connector_response_invalid"):
                request(client, "GET", "https://example.invalid/mcp")
        self.assertEqual(
            transport_error(httpx.DecodingError("bad encoding")), "connector_response_invalid"
        )

    def test_connection_errors_preserve_tls_certificate_proxy_and_timeout_categories(self):
        for cause, expected in (
            (ssl.SSLEOFError("TLS handshake interrupted"), "connector_tls_failed"),
            (
                ssl.SSLCertVerificationError("untrusted certificate"),
                "connector_certificate_untrusted",
            ),
        ):
            with self.subTest(expected=expected):

                def handler(incoming):
                    raise httpx.ConnectError("connection failed", request=incoming) from cause

                with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                    with self.assertRaisesRegex(ValueError, expected):
                        request(client, "GET", "https://example.invalid/mcp")
                try:
                    raise httpx.ConnectError("connection failed") from cause
                except httpx.HTTPError as error:
                    self.assertEqual(transport_error(error), expected)
        self.assertEqual(
            transport_error(httpx.ProxyError("proxy failed")), "connector_proxy_failed"
        )
        self.assertEqual(transport_error(httpx.ReadTimeout("timed out")), "connector_timeout")
        self.assertEqual(
            transport_error(httpx.ConnectError("connection failed")),
            "connector_network_unavailable",
        )

    def test_http_denials_distinguish_known_gateway_notice_from_service_permissions(self):
        for status, content, expected in (
            (
                403,
                "域名不在安全策略默认允许的范围内。云壳-防护记录-域名拦截",
                "connector_network_blocked",
            ),
            (403, "Organization policy denied access", "connector_permission_denied"),
            (401, "Unauthorized", "connector_credentials_invalid"),
            (407, "Proxy authentication required", "connector_proxy_failed"),
            (503, "Unavailable", "connector_service_unavailable"),
        ):
            with self.subTest(status=status, expected=expected):
                response = httpx.Response(
                    status, text=content, request=httpx.Request("GET", "https://example.invalid")
                )
                with self.assertRaisesRegex(ValueError, expected):
                    json_response(response)
                self.assertEqual(
                    transport_error(
                        httpx.HTTPStatusError("failed", request=response.request, response=response)
                    ),
                    expected,
                )

    def test_new_authorization_clears_previous_revocation_notice_even_when_discovery_pending(self):
        for method in ("key", "oauth"):
            entry = {**new_entry(), "revocation_scope": "local"}
            ConnectorService._authorized(
                entry, method, {"access_token": "test-only"}, {"tools": None, "version": None}
            )
            self.assertNotIn("revocation_scope", entry)

    def test_existing_credentials_never_display_a_stale_revocation_notice(self):
        entry = {
            **new_entry(),
            "revocation_scope": "local",
            "credential": {"access_token": "test-only"},
        }
        self.assertEqual(public_entry(CONNECTORS["huggingface"], entry)["revocation_scope"], "")
        custom = prepare({"name": "Private", "transport": "http", "url": "https://example.com/mcp"})
        custom.update(revocation_scope="local", credential={"access_token": "test-only"})
        self.assertEqual(public_custom(custom)["revocation_scope"], "")

    def test_custom_sse_is_preserved_as_distinct_transport(self):
        entry = prepare({"name": "Events", "transport": "sse", "url": "https://example.com/sse"})
        self.assertEqual(public_custom(entry)["transport"], "sse")

    def test_custom_authorization_replacement_keeps_configuration_disabled(self):
        entry = prepare({"name": "Private", "transport": "http", "url": "https://example.com/mcp"})
        entry.update(credential={"access_token": "old"}, enabled=True)
        entry["config"]["enabled"] = False
        ConnectorService._authorized(
            entry, "oauth", {"access_token": "replacement"}, {"tools": [], "version": "actual"}
        )
        self.assertFalse(entry["config"]["enabled"])

    def test_custom_target_change_cannot_reuse_original_credentials(self):
        original = prepare(
            {
                "name": "Private",
                "transport": "http",
                "url": "https://first.example/mcp",
                "headers": {"Authorization": "Bearer private"},
            }
        )
        with self.assertRaises(ValueError):
            prepare(
                {
                    "name": "Private",
                    "transport": "http",
                    "url": "https://other.example/mcp",
                    "headers": {"Authorization": ""},
                },
                original,
            )
        same = prepare(
            {
                "name": "Renamed",
                "transport": "http",
                "url": "https://first.example/mcp",
                "headers": {"Authorization": ""},
            },
            original,
        )
        self.assertEqual(same["config"]["header_secrets"], original["config"]["header_secrets"])
        self.assertEqual(same["values"], original["values"])

    def test_custom_stdio_target_change_needs_explicit_credentials(self):
        original = prepare(
            {
                "name": "Local",
                "transport": "stdio",
                "command": "node",
                "args": ["original.mjs"],
                "environment": {"API_KEY": "private"},
            }
        )
        with self.assertRaises(ValueError):
            prepare(
                {
                    "name": "Local",
                    "transport": "stdio",
                    "command": "node",
                    "args": ["different.mjs"],
                    "environment": {"API_KEY": ""},
                },
                original,
            )

    def test_custom_metadata_and_timeout_have_real_runtime_projection(self):
        entry = prepare(
            {
                "name": "Custom",
                "description": "Research service",
                "startup_timeout": 2500,
                "timeout": 1250,
                "transport": "http",
                "url": "https://example.com/mcp",
            }
        )
        self.assertTrue(entry["config"]["enabled"])
        self.assertEqual(public_custom(entry)["description"], "Research service")
        server = McpHttpServer.model_validate(entry["config"])
        self.assertEqual(runtime_server(server).tool_timeout_ms, 1250)
        self.assertEqual(runtime_server(server).startup_timeout_ms, 2500)
        self.assertEqual(public_custom(entry)["configuration"]["startup_timeout"], 2500)

    def test_custom_credentials_are_private_and_bound_to_configuration(self):
        entry = prepare(
            {
                "name": "Private MCP",
                "transport": "http",
                "url": "https://example.com/mcp",
                "headers": {"Authorization": "Bearer private-key"},
            }
        )
        state = {"entries": {entry["config"]["id"]: entry}, "clients": {}}
        server = McpHttpServer.model_validate(entry["config"])
        reference = server.header_secrets["Authorization"]
        resolver = ConnectorSecrets(None, Activities())
        self.assertEqual(resolver.material(state, reference), "Bearer private-key")
        self.assertNotIn("private-key", json.dumps(public_custom(entry)))
        validate_binding(state, server, reference)
        with self.assertRaises(ValueError):
            validate_binding(
                state, server.model_copy(update={"url": "https://other.com/mcp"}), reference
            )

    def test_custom_edit_preserves_only_explicitly_retained_secret_fields(self):
        entry = prepare(
            {
                "name": "Custom",
                "transport": "stdio",
                "command": "python",
                "args": ["with space", ""],
                "environment": {"API_KEY": "private-key"},
            }
        )
        revised = prepare(
            {
                "name": "Renamed",
                "transport": "stdio",
                "command": "python",
                "args": ["with space", ""],
                "environment": {"API_KEY": ""},
            },
            entry,
        )
        self.assertEqual(revised["config"]["id"], entry["config"]["id"])
        self.assertEqual(list(revised["values"].values()), ["private-key"])
        self.assertEqual(revised["config"]["args"], ["with space", ""])
        removed = prepare({"name": "Renamed", "transport": "stdio", "command": "python"}, revised)
        self.assertEqual(removed["values"], {})
        with self.assertRaises(ValueError):
            material({"entries": {entry["config"]["id"]: removed}}, next(iter(entry["values"])))

    def test_custom_rejects_unsupported_transport_and_embedded_credentials(self):
        for values in (
            {"transport": "unknown", "url": "https://example.com/sse"},
            {"transport": "http", "url": "https://example.com/mcp?api_key=private"},
            {
                "transport": "http",
                "url": "https://example.com/mcp",
                "headers": {"Authorization": "value\r\ninjected"},
            },
        ):
            with self.assertRaises(ValueError):
                prepare({"name": "Custom", **values})

    def test_public_view_never_returns_private_tokens_or_client_secrets(self):
        entry = new_entry()
        entry.update(
            credential={"access_token": "secret-access", "refresh_token": "secret-refresh"},
            credential_id="opaque",
            method="oauth",
            tools=[],
        )
        entry["oauth"] = {"client": {"client_secret": "private-client"}}
        view = public_entry(CONNECTORS["github"], entry)
        serialized = json.dumps(view)
        for secret in ("secret-access", "secret-refresh", "private-client", "credential_id"):
            self.assertNotIn(secret, serialized)
        self.assertEqual(view["state"], "disabled")
        entry["reauth_required"] = True
        self.assertEqual(public_entry(CONNECTORS["github"], entry)["state"], "auth_required")

    def test_install_does_not_request_credentials_or_enable_server(self):
        service = ConnectorService(None, None, Activities())
        state = {"entries": {}, "clients": {}}
        with patch("service.settings.connectors.service.verify") as probe:
            result = service._operate(state, CONNECTORS["github"], "install", {}, "")
        self.assertTrue(result["installed"])
        self.assertFalse(result["enabled"])
        self.assertFalse(result["authorized"])
        probe.assert_not_called()

    def test_valid_first_key_survives_connection_failure_but_replacement_is_atomic(self):
        service = ConnectorService(None, None, Activities())
        entry = new_entry()
        state = {"entries": {"github": entry}, "clients": {}}
        with patch(
            "service.settings.connectors.service.verify",
            side_effect=ConnectionFailure(ValueError("connector_network_unavailable")),
        ):
            result = service._operate(
                state, CONNECTORS["github"], "key", {"access_token": "valid-key"}, ""
            )
            self.assertTrue(result["authorized"])
            self.assertEqual(result["state"], "failed")
            with self.assertRaisesRegex(ValueError, "connector_replacement_failed"):
                service._operate(
                    state, CONNECTORS["github"], "key", {"access_token": "replacement"}, ""
                )
        self.assertEqual(entry["credential"]["access_token"], "valid-key")

    def test_invalid_replacement_preserves_original_credential_and_enabled_choice(self):
        service = ConnectorService(None, None, Activities())
        entry = new_entry()
        entry.update(credential={"access_token": "old-key"}, method="key", tools=[])
        state = {"entries": {"github": entry}, "clients": {}}
        with patch(
            "service.settings.connectors.service.verify",
            side_effect=ValueError("connector_credentials_invalid"),
        ):
            with self.assertRaises(ValueError):
                service._operate(
                    state, CONNECTORS["github"], "key", {"access_token": "new-key"}, ""
                )
        self.assertEqual(entry["credential"]["access_token"], "old-key")
        self.assertFalse(entry["enabled"])
        with patch(
            "service.settings.connectors.service.verify",
            return_value={"tools": [], "version": "actual-version"},
        ):
            service._operate(state, CONNECTORS["github"], "key", {"access_token": "new-key"}, "")
        self.assertEqual(entry["credential"]["access_token"], "new-key")
        self.assertFalse(entry["enabled"])
        self.assertEqual(entry["version"], "actual-version")

    def test_probe_initializes_and_reads_every_tool_page_and_real_version(self):
        calls = []

        def handler(request):
            payload = json.loads(request.content) if request.content else {}
            calls.append(payload)
            method = payload.get("method")
            if method == "initialize":
                result = {
                    "protocolVersion": "2025-06-18",
                    "serverInfo": {"name": "test", "version": "7.2"},
                }
            elif method == "notifications/initialized":
                return httpx.Response(202)
            elif payload.get("params", {}).get("cursor"):
                result = {"tools": [{"name": "second", "inputSchema": {"type": "object"}}]}
            else:
                result = {
                    "tools": [{"name": "first", "inputSchema": {"type": "object"}}],
                    "nextCursor": "next",
                }
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": payload["id"], "result": result}
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            result = verify(client, CONNECTORS["github"], "key", {"access_token": "test-only"})
        self.assertEqual(result["version"], "7.2")
        self.assertEqual([tool["name"] for tool in result["tools"]], ["first", "second"])
        self.assertEqual(len(calls), 4)

    def test_probe_never_treats_unauthorized_response_as_empty_tools(self):
        with httpx.Client(
            transport=httpx.MockTransport(lambda request: httpx.Response(401))
        ) as client:
            with self.assertRaisesRegex(ValueError, "connector_credentials_invalid"):
                verify(client, CONNECTORS["github"], "key", {"access_token": "invalid"})

    def test_anonymous_huggingface_tools_cannot_validate_an_invalid_account_token(self):
        requests = []

        def handler(request):
            requests.append(str(request.url))
            return httpx.Response(401)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaisesRegex(ValueError, "connector_credentials_invalid"):
                verify(client, CONNECTORS["huggingface"], "key", {"access_token": "invalid"})
        self.assertEqual(requests, ["https://huggingface.co/api/whoami-v2"])

    def test_zotero_empty_library_is_valid_and_local_tools_remain_unknown(self):
        def handler(request):
            self.assertEqual(request.url.path, "/groups/123/items")
            self.assertEqual(request.headers["Zotero-API-Key"], "test-only")
            return httpx.Response(200, json=[])

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            result = verify(
                client,
                CONNECTORS["zotero"],
                "key",
                {"access_token": "test-only", "library_type": "group", "library_id": "123"},
            )
        self.assertIsNone(result["tools"])

    def test_zotero_personal_library_resolves_id_before_verification(self):
        paths = []

        def handler(incoming):
            paths.append(incoming.url.path)
            self.assertEqual(incoming.headers["Zotero-API-Key"], "test-only")
            self.assertNotIn("test-only", str(incoming.url))
            if incoming.url.path == "/keys/current":
                return httpx.Response(
                    200, json={"userID": 456, "access": {"user": {"library": True}}}
                )
            return httpx.Response(200, json=[])

        credential = {"access_token": "test-only", "library_type": "user", "library_id": ""}
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            result = verify(client, CONNECTORS["zotero"], "key", credential)
        self.assertEqual(credential["library_id"], "456")
        self.assertEqual(result["account_context"], "user:456")
        self.assertEqual(paths, ["/keys/current", "/users/456/items"])

    def test_zotero_personal_discovery_requires_read_access_and_valid_identity(self):
        for payload, expected in (
            (
                {"userID": 456, "access": {"user": {"library": False}}},
                "connector_permission_denied",
            ),
            (
                {"userID": "../456", "access": {"user": {"library": True}}},
                "connector_response_invalid",
            ),
            ({"userID": True, "access": {}}, "connector_response_invalid"),
        ):
            with self.subTest(payload=payload):
                with httpx.Client(
                    transport=httpx.MockTransport(
                        lambda incoming, payload=payload: httpx.Response(200, json=payload)
                    )
                ) as client:
                    with self.assertRaisesRegex(ValueError, expected):
                        verify(
                            client,
                            CONNECTORS["zotero"],
                            "key",
                            {"access_token": "test-only", "library_type": "user", "library_id": ""},
                        )

    def test_zotero_manual_personal_id_does_not_require_discovery(self):
        def handler(incoming):
            self.assertEqual(incoming.url.path, "/users/789/items")
            return httpx.Response(200, json=[])

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            verify(
                client,
                CONNECTORS["zotero"],
                "key",
                {"access_token": "test-only", "library_type": "user", "library_id": "789"},
            )

    def test_zotero_group_id_is_never_guessed(self):
        with httpx.Client(
            transport=httpx.MockTransport(lambda incoming: self.fail("unexpected request"))
        ) as client:
            with self.assertRaisesRegex(ValueError, "connector_library_invalid"):
                verify(
                    client,
                    CONNECTORS["zotero"],
                    "key",
                    {"access_token": "test-only", "library_type": "group", "library_id": ""},
                )

    def test_zotero_group_discovery_paginates_filters_permissions_and_ignores_remote_links(self):
        paths = []

        def handler(incoming):
            self.assertEqual(incoming.url.host, "api.zotero.org")
            self.assertEqual(incoming.headers["Zotero-API-Key"], "test-only")
            self.assertNotIn("test-only", str(incoming.url))
            paths.append(incoming.url.path)
            if incoming.url.path == "/keys/current":
                return httpx.Response(
                    200,
                    json={
                        "userID": 456,
                        "access": {"groups": {"all": {"library": True}, "2": {"library": False}}},
                    },
                )
            start = int(incoming.url.params["start"])
            rows = [
                {"id": index + 1, "data": {"name": f"Group {index + 1}"}}
                for index in range(start, min(start + GROUP_PAGE_SIZE, GROUP_PAGE_SIZE + 1))
            ]
            return httpx.Response(
                200, json=rows, headers={"Link": '<https://evil.invalid/>; rel="next"'}
            )

        client = httpx.Client(transport=httpx.MockTransport(handler))
        with patch("service.settings.connectors.zotero.httpx.Client", return_value=client):
            result = groups("test-only")
        self.assertEqual(len(result["libraries"]), GROUP_PAGE_SIZE)
        self.assertNotIn("2", {row["id"] for row in result["libraries"]})
        self.assertEqual(
            result["libraries"][-1],
            {"id": str(GROUP_PAGE_SIZE + 1), "name": f"Group {GROUP_PAGE_SIZE + 1}"},
        )
        self.assertEqual(paths, ["/keys/current", "/users/456/groups", "/users/456/groups"])

    def test_zotero_group_discovery_supports_group_only_keys_empty_and_public_libraries(self):
        for rows, expected in (
            ([], []),
            ([{"id": 10, "data": {"name": "Private"}}], [{"id": "10", "name": "Private"}]),
            (
                [{"id": 20, "data": {"name": "Public", "libraryReading": "all"}}],
                [{"id": "20", "name": "Public"}],
            ),
            ([{"id": 30, "data": {"name": "Denied"}}], []),
        ):
            with self.subTest(rows=rows):

                def handler(incoming, rows=rows):
                    if incoming.url.path == "/keys/current":
                        return httpx.Response(
                            200,
                            json={"userID": 456, "access": {"groups": {"10": {"library": True}}}},
                        )
                    return httpx.Response(200, json=rows)

                client = httpx.Client(transport=httpx.MockTransport(handler))
                with patch("service.settings.connectors.zotero.httpx.Client", return_value=client):
                    self.assertEqual(groups("test-only"), {"libraries": expected})

    def test_zotero_group_discovery_does_not_return_partial_or_malformed_results(self):
        for rows in ({}, [{"id": "../1", "data": {"name": "Bad"}}], [{"id": 1, "data": {}}]):
            with self.subTest(rows=rows):

                def handler(incoming, rows=rows):
                    if incoming.url.path == "/keys/current":
                        return httpx.Response(200, json={"userID": 456, "access": {}})
                    return httpx.Response(200, json=rows)

                client = httpx.Client(transport=httpx.MockTransport(handler))
                with patch("service.settings.connectors.zotero.httpx.Client", return_value=client):
                    with self.assertRaisesRegex(ValueError, "connector_response_invalid"):
                        groups("test-only")

    def test_zotero_group_discovery_preserves_auth_and_network_errors(self):
        for status, expected in (
            (401, "connector_credentials_invalid"),
            (403, "connector_permission_denied"),
            (429, "connector_rate_limited"),
        ):
            with self.subTest(status=status):
                client = httpx.Client(
                    transport=httpx.MockTransport(
                        lambda incoming, status=status: httpx.Response(status)
                    )
                )
                with patch("service.settings.connectors.zotero.httpx.Client", return_value=client):
                    with self.assertRaisesRegex(ValueError, expected):
                        groups("test-only")

    def test_zotero_group_discovery_does_not_save_credentials_or_synchronize(self):
        service = ConnectorService(None, None, Activities())
        with patch(
            "service.settings.connectors.service.groups", return_value={"libraries": []}
        ) as discover_groups:
            result = asyncio.run(
                service.operate("zotero", "libraries", values={"access_token": "test-only"})
            )
        self.assertEqual(result, {"libraries": []})
        discover_groups.assert_called_once_with("test-only")
        with self.assertRaisesRegex(ValueError, "connector_method_invalid"):
            asyncio.run(
                service.operate("github", "libraries", values={"access_token": "test-only"})
            )

    def test_zotero_resolved_personal_id_is_saved_and_passed_to_mcp(self):
        def handler(incoming):
            if incoming.url.path == "/keys/current":
                return httpx.Response(
                    200, json={"userID": 456, "access": {"user": {"library": True}}}
                )
            return httpx.Response(200, json=[])

        client = httpx.Client(transport=httpx.MockTransport(handler))
        service = ConnectorService(None, None, Activities())
        state = {"entries": {"zotero": new_entry()}, "clients": {}}
        with patch("service.settings.connectors.service.httpx.Client", return_value=client):
            with patch(
                "service.settings.connectors.service.inspect_server",
                new_callable=AsyncMock,
                return_value={"tools": [], "version": "test-version"},
            ) as inspect:
                result = service._operate(
                    state,
                    CONNECTORS["zotero"],
                    "key",
                    {"access_token": "test-only"},
                    "",
                )
        self.assertTrue(result["authorized"])
        self.assertEqual(result["account_context"], "user:456")
        self.assertEqual(state["entries"]["zotero"]["credential"]["library_id"], "456")
        self.assertEqual(inspect.call_args.args[0].environment["ZOTERO_LIBRARY_ID"], "456")
        self.assertEqual(inspect.call_args.args[0].environment["ZOTERO_LIBRARY_TYPE"], "user")
        self.assertEqual(inspect.call_args.args[1], {"ZOTERO_API_KEY": "test-only"})
        self.assertNotIn("test-only", json.dumps(result))

    def test_zotero_failed_auto_detection_preserves_existing_authorization(self):
        client = httpx.Client(transport=httpx.MockTransport(lambda incoming: httpx.Response(401)))
        service = ConnectorService(None, None, Activities())
        entry = new_entry()
        original = {"access_token": "old-key", "library_id": "123", "library_type": "user"}
        entry.update(credential=original.copy(), method="key", tools=[], enabled=False)
        with patch("service.settings.connectors.service.httpx.Client", return_value=client):
            with self.assertRaisesRegex(ValueError, "connector_credentials_invalid"):
                service._operate(
                    {"entries": {"zotero": entry}, "clients": {}},
                    CONNECTORS["zotero"],
                    "key",
                    {"access_token": "invalid", "library_type": "user", "library_id": ""},
                    "",
                )
        self.assertEqual(entry["credential"], original)
        self.assertFalse(entry["enabled"])

    def test_catalog_has_exact_seven_presets_and_auth_profiles(self):
        self.assertEqual(
            set(CONNECTORS),
            {"zotero", "firecrawl", "github", "gitlab", "huggingface", "notion", "elicit"},
        )
        self.assertEqual(CONNECTORS["zotero"].methods, ("key",))
        self.assertEqual(CONNECTORS["elicit"].methods, ("oauth",))
        self.assertEqual(CONNECTORS["github"].url, "https://api.githubcopilot.com/mcp/")
        self.assertNotEqual(CONNECTORS["firecrawl"].url, CONNECTORS["firecrawl"].oauth_url)

    def test_oauth_metadata_cannot_redirect_secrets_to_another_host(self):
        item = CONNECTORS["github"]
        for url in (
            "http://github.com/token",
            "https://evil.example/token",
            "https://user:secret@github.com/token",
            "https://github.com:8443/token",
            "https://github.com/token#fragment",
            "https://127.0.0.1/token",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                checked_url(item, url)
        self.assertEqual(
            checked_url(item, "https://github.com/login/oauth/access_token"),
            "https://github.com/login/oauth/access_token",
        )

    def test_pkce_is_random_s256_without_padding(self):
        verifier, challenge = pkce()
        self.assertGreaterEqual(len(verifier), 43)
        self.assertEqual(len(challenge), 43)
        self.assertNotEqual(pkce(), (verifier, challenge))
        self.assertNotIn("=", challenge)

    def test_private_state_survives_reopen_and_failed_transaction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "connectors"
            store = ConnectorStore(root)
            store.transaction(
                lambda state: state["entries"].update({"github": {"token": "private"}})
            )

            def fail(state):
                state["entries"].clear()
                raise ValueError("cancelled")

            with self.assertRaises(ValueError):
                store.transaction(fail)
            self.assertEqual(
                ConnectorStore(root).transaction(lambda state: state["entries"]),
                {"github": {"token": "private"}},
            )


class ConnectorDiscoveryContracts(unittest.TestCase):
    def discover_custom(self, responses):
        visited = []

        def handler(incoming):
            self.assertEqual(incoming.method, "GET")
            self.assertNotIn("authorization", incoming.headers)
            visited.append(str(incoming.url))
            status, payload, headers = responses[str(incoming.url)]
            return httpx.Response(status, json=payload, headers=headers)

        with patch(
            "service.settings.connectors.discovery.PublicTransport",
            return_value=httpx.MockTransport(handler),
        ):
            result = custom_discovery("custom-contract", "Contract", "https://mcp.example/team/mcp")
        return result, visited

    def metadata_responses(self):
        return {
            "https://mcp.example/team/mcp": (405, {}, {}),
            "https://mcp.example/.well-known/oauth-protected-resource/team/mcp": (
                200,
                {
                    "resource": "https://mcp.example/team/mcp",
                    "authorization_servers": ["https://auth.example"],
                },
                {},
            ),
            "https://auth.example/.well-known/oauth-authorization-server": (
                200,
                {
                    "issuer": "https://auth.example",
                    "authorization_endpoint": "https://auth.example/authorize",
                    "token_endpoint": "https://auth.example/token",
                    "code_challenge_methods_supported": ["S256"],
                },
                {},
            ),
        }

    def test_post_only_mcp_discovers_path_metadata_without_get_challenge(self):
        result, visited = self.discover_custom(self.metadata_responses())
        self.assertIsNotNone(result)
        self.assertEqual(result[0]["issuer"], "https://auth.example")
        self.assertEqual(
            visited[1], "https://mcp.example/.well-known/oauth-protected-resource/team/mcp"
        )

    def test_missing_path_metadata_falls_back_to_root(self):
        responses = self.metadata_responses()
        path = "https://mcp.example/.well-known/oauth-protected-resource/team/mcp"
        responses["https://mcp.example/.well-known/oauth-protected-resource"] = responses[path]
        responses[path] = (404, {}, {})
        result, visited = self.discover_custom(responses)
        self.assertIsNotNone(result)
        self.assertEqual(visited[2], "https://mcp.example/.well-known/oauth-protected-resource")

    def test_absent_metadata_does_not_invent_oauth(self):
        responses = self.metadata_responses()
        responses["https://mcp.example/.well-known/oauth-protected-resource/team/mcp"] = (
            404,
            {},
            {},
        )
        responses["https://mcp.example/.well-known/oauth-protected-resource"] = (404, {}, {})
        result, visited = self.discover_custom(responses)
        self.assertIsNone(result)
        self.assertEqual(len(visited), 3)

    def test_explicit_challenge_takes_precedence_over_well_known(self):
        responses = self.metadata_responses()
        responses["https://mcp.example/team/mcp"] = (
            401,
            {},
            {
                "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/metadata", scope="read"'
            },
        )
        responses["https://mcp.example/metadata"] = responses.pop(
            "https://mcp.example/.well-known/oauth-protected-resource/team/mcp"
        )
        result, visited = self.discover_custom(responses)
        self.assertEqual(result[0]["scope"], "read")
        self.assertEqual(visited[1], "https://mcp.example/metadata")

    def test_fallback_rejects_resource_mismatch_and_does_not_mask_denial(self):
        for status, resource, expected in (
            (200, "https://other.example/mcp", "connector_oauth_resource_invalid"),
            (403, "https://mcp.example/team/mcp", "connector_permission_denied"),
        ):
            with self.subTest(status=status):
                responses = self.metadata_responses()
                responses["https://mcp.example/.well-known/oauth-protected-resource/team/mcp"] = (
                    status,
                    {"resource": resource, "authorization_servers": ["https://auth.example"]},
                    {},
                )
                with self.assertRaisesRegex(ValueError, expected):
                    self.discover_custom(responses)

    def test_resource_probe_denial_is_not_hidden_by_metadata_fallback(self):
        responses = self.metadata_responses()
        responses["https://mcp.example/team/mcp"] = (403, {}, {})
        with self.assertRaisesRegex(ValueError, "connector_permission_denied"):
            self.discover_custom(responses)


class ConnectorLifecycleContracts(unittest.IsolatedAsyncioTestCase):
    async def test_callback_codes_are_removed_from_the_access_log_scope(self):
        async def application(scope, receive, send):
            self.assertEqual(scope["query_string"], b"")
            self.assertEqual(scope["state"][CALLBACK_STATE_KEY]["code"], "private-code")

        scope = {
            "type": "http",
            "path": CALLBACK_ROUTE,
            "query_string": b"state=private-state&code=private-code",
            "state": {},
        }
        await ConnectorCallbackPrivacy(application)(scope, AsyncMock(), AsyncMock())
        self.assertEqual(scope["query_string"], b"")

    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = ConnectorStore(Path(self.temporary.name) / "connectors")
        self.service = ConnectorService(self.store, None, Activities())
        self.service.synchronize = AsyncMock()
        self.entry = new_entry()
        self.store.transaction(lambda state: state["entries"].update({"github": self.entry}))

    def custom_configuration(self, project_server=runtime_server):
        discovery = patch("service.settings.connectors.service.custom_discovery", return_value=None)
        discovery.start()
        self.addCleanup(discovery.stop)
        local_probe = patch(
            "service.settings.connectors.service.inspect_server",
            new=AsyncMock(side_effect=ValueError("connector_process_failed")),
        )
        local_probe.start()
        self.addCleanup(local_probe.stop)
        probe = patch(
            "service.settings.connectors.service.verify_http",
            return_value={"version": "contract", "tools": []},
        )
        probe.start()
        self.addCleanup(probe.stop)
        runtime = SimpleNamespace(
            mcp_configuration=AsyncMock(return_value=McpConfigurationReceipt(0)),
            configure_mcp=AsyncMock(
                side_effect=lambda request: McpConfigurationReceipt(request.revision)
            ),
        )
        self.service.configuration = McpConfigurationService(
            McpConfigurationStore(Path(self.temporary.name) / "mcp.json"),
            lambda: runtime,
            activities=self.service.activities,
            secret_port=self.service.secrets,
            validate_servers=self.service.secrets.validate_servers,
            project_server=project_server,
        )
        return runtime

    async def test_custom_batch_save_edit_toggle_remove_preserves_unrelated_configuration(self):
        self.custom_configuration()
        unrelated = McpHttpServer(
            id="existing", name="Existing", url="https://existing.example/mcp", enabled=False
        )
        await self.service.configuration.replace((unrelated,), expected_revision=0)
        configs = [
            {
                "name": "Remote custom",
                "transport": "http",
                "url": "https://example.com/mcp",
                "headers": {"Authorization": "Bearer private"},
            },
            {
                "name": "Local custom",
                "transport": "stdio",
                "command": "node",
                "args": ["with space", ""],
            },
        ]
        await self.service.operate(
            "custom", "custom_save", values={"expected_revision": 1, "servers": configs}
        )
        rows = [row for row in await self.service.catalog() if row.get("custom")]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row["enabled"] for row in rows))
        self.assertEqual(next(row for row in rows if row["transport"] == "http")["state"], "ready")
        self.assertEqual(
            next(row for row in rows if row["transport"] == "stdio")["state"], "failed"
        )
        self.assertNotIn("Bearer private", json.dumps(rows))
        remote = next(row for row in rows if row["transport"] == "http")
        identifier = remote["id"]
        await self.service.operate(
            identifier,
            "custom_save",
            values={
                "expected_revision": 2,
                "servers": [
                    {
                        "name": "Renamed",
                        "transport": "http",
                        "url": "https://example.com/mcp",
                        "headers": {"Authorization": ""},
                    }
                ],
            },
        )
        await self.service.operate(
            identifier, "custom_toggle", values={"expected_revision": 3, "enabled": True}
        )
        view = await self.service.configuration.status()
        server = next(server for server in view.configuration.servers if server.id == identifier)
        self.assertTrue(server.enabled)
        self.assertEqual(
            (await self.service.secrets.resolve(server.header_secrets["Authorization"])).value,
            "Bearer private",
        )
        await self.service.operate(identifier, "custom_remove", values={"expected_revision": 4})
        final = await self.service.configuration.status()
        self.assertEqual(len(final.configuration.servers), 2)
        self.assertIn(unrelated, final.configuration.servers)
        self.assertNotIn(identifier, self.store.transaction(lambda state: state["entries"]))

    async def test_custom_network_failure_retains_config_and_401_requires_authorization(self):
        self.custom_configuration()
        for index, code in enumerate(
            ("connector_network_unavailable", "connector_credentials_invalid")
        ):
            with patch(
                "service.settings.connectors.service.verify_http", side_effect=ValueError(code)
            ):
                await self.service.operate(
                    "custom",
                    "custom_save",
                    values={
                        "expected_revision": index,
                        "servers": [
                            {
                                "name": f"Failure {index}",
                                "transport": "http",
                                "url": "https://example.com/mcp",
                            }
                        ],
                    },
                )
            row = next(
                row for row in await self.service.catalog() if row["name"] == f"Failure {index}"
            )
            self.assertEqual(row["error"], code)
            self.assertTrue(row["enabled"])
            self.assertEqual(row["state"], "auth_required" if index else "failed")
            self.assertIsNone(row["tools"])

    async def test_remove_failure_preserves_recoverable_record(self):
        self.service.synchronize = AsyncMock(
            side_effect=ValueError("connector_configuration_failed")
        )
        with self.assertRaisesRegex(ValueError, "connector_configuration_failed"):
            await self.service.operate("github", "remove")
        row = next(row for row in await self.service.catalog() if row["id"] == "github")
        self.assertTrue(row["installed"])
        self.assertEqual(row["error"], "connector_configuration_failed")

    async def test_custom_oauth_callback_updates_bound_credentials_without_exposing_tokens(self):
        broker = ConnectorBroker(
            McpConfigurationStore(Path(self.temporary.name) / "mcp.json"),
            self.service.secrets,
            self.service.activities,
        )
        await broker.start()
        self.addAsyncCleanup(broker.aclose)
        self.custom_configuration(broker.project)
        await self.service.operate(
            "custom",
            "custom_save",
            values={
                "expected_revision": 0,
                "servers": [
                    {
                        "name": "OAuth service",
                        "transport": "sse",
                        "url": "https://service.example/mcp",
                    }
                ],
            },
        )
        identifier = next(row["id"] for row in await self.service.catalog() if row.get("custom"))
        item = {
            "id": identifier,
            "name": "OAuth service",
            "source": "https://service.example/mcp",
            "url": "https://service.example/mcp",
            "oauth_url": "https://service.example/mcp",
            "issuer": "https://service.example",
            "oauth_hosts": ["service.example"],
        }

        def attempt(state):
            entry = state["entries"][identifier]
            entry["oauth_definition"] = item
            entry["attempt"] = {
                "state": "custom-state",
                "expires_at": time.time() + 300,
                "verifier": "private",
                "redirect_uri": "http://127.0.0.1:12345/callback",
                "metadata": {"issuer": item["issuer"]},
                "client": {"client_id": "client"},
            }

        self.store.transaction(attempt)
        with (
            patch(
                "service.settings.connectors.service.exchange",
                return_value={"access_token": "private-custom-access", "expires_at": None},
            ),
            patch.object(self.service, "_verify", return_value={"tools": [], "version": "actual"}),
        ):
            self.assertTrue(
                await self.service.callback("custom-state", "code", item["issuer"], False)
            )
        entry = self.store.transaction(lambda state: state["entries"][identifier])
        source = SERVER_ADAPTER.validate_python(entry["config"])
        self.service.secrets.validate_servers((source,))
        reference = source.header_secrets["Authorization"]
        self.assertEqual(
            (await self.service.secrets.resolve(reference)).value, "Bearer private-custom-access"
        )
        self.assertNotIn("private-custom-access", json.dumps(public_custom(entry)))
        same = prepare(
            {
                "name": "Renamed",
                "transport": "sse",
                "url": item["url"],
                "headers": {"Authorization": ""},
            },
            entry,
        )
        self.assertEqual(same["config"]["header_secrets"], source.header_secrets)
        self.store.transaction(
            lambda state: state["entries"][identifier]["credential"].update(
                expires_at=time.time() - 1, refresh_token="private-refresh"
            )
        )
        revision = (await self.service.configuration.status()).configuration.revision
        with (
            patch(
                "service.settings.connectors.service.exchange",
                return_value={"access_token": "rotated-access", "expires_at": None},
            ) as exchange,
            patch(
                "service.settings.connectors.service.inspect_server",
                new=AsyncMock(return_value={"tools": [], "version": "actual"}),
            ) as inspect,
        ):
            await self.service.operate(
                identifier, "custom_retry", values={"expected_revision": revision}
            )
        self.assertEqual(exchange.call_count, 1)
        self.assertEqual(inspect.call_args.args[1], {"Authorization": "Bearer rotated-access"})
        result = await self.service.operate(identifier, "revoke")
        self.assertEqual(result["state"], "auth_required")
        self.assertEqual(result["revocation_scope"], "local")

    async def test_invalid_or_conflicting_batch_does_not_partially_save(self):
        self.custom_configuration()
        for values in (
            {
                "expected_revision": 1,
                "servers": [{"name": "One", "transport": "stdio", "command": "node"}],
            },
            {
                "expected_revision": 0,
                "servers": [
                    {"name": "One", "transport": "stdio", "command": "node"},
                    {"name": "One", "transport": "stdio", "command": "node"},
                ],
            },
            {
                "expected_revision": 0,
                "servers": [
                    {"name": "One", "transport": "stdio", "command": "node"},
                    {"name": "Two", "transport": "unsupported", "url": "https://example.com/sse"},
                ],
            },
        ):
            with self.assertRaises(ValueError):
                await self.service.operate("custom", "custom_save", values=values)
            self.assertEqual((await self.service.configuration.status()).configuration.revision, 0)
            self.assertEqual(
                set(self.store.transaction(lambda state: state["entries"])), {"github"}
            )

    async def test_unavailable_runtime_rolls_back_unpublished_custom_credentials(self):
        self.custom_configuration()
        self.service.configuration._runtime = lambda: None
        with self.assertRaises(ValueError):
            await self.service.operate(
                "custom",
                "custom_save",
                values={
                    "expected_revision": 0,
                    "servers": [
                        {
                            "name": "Private custom",
                            "transport": "http",
                            "url": "https://example.com/mcp",
                            "headers": {"Authorization": "Bearer private"},
                        }
                    ],
                },
            )
        self.assertEqual(set(self.store.transaction(lambda state: state["entries"])), {"github"})

    def attempt(self):
        entry = new_entry()
        entry["attempt"] = {
            "state": "expected-state",
            "expires_at": time.time() + 300,
            "verifier": "private-verifier",
            "redirect_uri": "http://127.0.0.1:12345/callback",
            "metadata": {"issuer": "https://github.com/login/oauth"},
            "client": {"client_id": "test-client"},
        }
        self.store.transaction(lambda state: state["entries"].update({"github": entry}))

    async def test_unknown_or_cancelled_callback_cannot_apply_configuration(self):
        self.attempt()
        await self.service.operate("github", "cancel")
        with patch("service.settings.connectors.service.exchange") as exchange:
            self.assertFalse(await self.service.callback("expected-state", "code", "", False))
        exchange.assert_not_called()
        self.service.synchronize.assert_not_called()

    async def test_callback_is_single_use_and_uses_original_verifier(self):
        self.attempt()
        with (
            patch(
                "service.settings.connectors.service.exchange",
                return_value={"access_token": "new", "expires_at": None},
            ) as exchange,
            patch(
                "service.settings.connectors.service.verify",
                return_value={"tools": [], "version": "actual"},
            ),
        ):
            self.assertTrue(
                await self.service.callback(
                    "expected-state", "code", "https://github.com/login/oauth", False
                )
            )
            self.assertFalse(
                await self.service.callback(
                    "expected-state", "code", "https://github.com/login/oauth", False
                )
            )
        self.assertEqual(exchange.call_count, 1)
        self.assertEqual(exchange.call_args.args[3]["code_verifier"], "private-verifier")
        self.service.synchronize.assert_awaited_once()

    async def test_issuer_mixup_does_not_exchange_code(self):
        self.attempt()
        with patch("service.settings.connectors.service.exchange") as exchange:
            self.assertFalse(
                await self.service.callback("expected-state", "code", "https://evil.example", False)
            )
        exchange.assert_not_called()
        record = self.store.transaction(lambda state: state["entries"]["github"])
        self.assertIsNone(record["credential"])
        self.assertNotIn("attempt", record)

    async def test_oauth_rejected_token_does_not_report_authorization_success(self):
        self.attempt()
        with (
            patch(
                "service.settings.connectors.service.exchange",
                return_value={"access_token": "rejected", "expires_at": None},
            ),
            patch(
                "service.settings.connectors.service.verify",
                side_effect=ValueError("connector_credentials_invalid"),
            ),
        ):
            self.assertFalse(
                await self.service.callback(
                    "expected-state", "code", "https://github.com/login/oauth", False
                )
            )
        row = next(row for row in await self.service.catalog() if row["id"] == "github")
        self.assertEqual(row["state"], "auth_required")
        self.assertEqual(row["authorization_error"], "connector_credentials_invalid")

    async def test_refresh_rotates_once_and_revoked_generation_cannot_resolve(self):
        entry = new_entry()
        entry.update(
            method="oauth",
            credential_id="current",
            credential={
                "access_token": "expired",
                "refresh_token": "old-refresh",
                "expires_at": time.time() - 1,
            },
            oauth={"metadata": {}, "client": {}},
        )
        self.store.transaction(lambda state: state["entries"].update({"github": entry}))
        resolver = ConnectorSecrets(self.store, Activities())
        with patch(
            "service.settings.connectors.service.exchange",
            return_value={
                "access_token": "rotated",
                "refresh_token": "new-refresh",
                "expires_at": time.time() + 3600,
            },
        ) as exchange:
            first = await resolver.resolve("connector:github:current:bearer")
            second = await resolver.resolve("connector:github:current:bearer")
        self.assertEqual(first.value, "Bearer rotated")
        self.assertEqual(second.value, first.value)
        self.assertEqual(exchange.call_count, 1)
        self.store.transaction(lambda state: state["entries"].update({"github": new_entry()}))
        with self.assertRaises(ValueError):
            await resolver.resolve("connector:github:current:bearer")

    async def test_credential_reference_cannot_be_rebound_to_another_destination(self):
        entry = new_entry()
        entry.update(method="key", credential_id="current", credential={"access_token": "private"})
        self.store.transaction(lambda state: state["entries"].update({"github": entry}))
        resolver = ConnectorSecrets(self.store, Activities())
        server = McpHttpServer(
            id="market-github",
            url=CONNECTORS["github"].url,
            header_secrets={"Authorization": "connector:github:current:bearer"},
        )
        resolver.validate_servers((server,))
        for unsafe in (
            server.model_copy(update={"url": "https://evil.example/mcp"}),
            server.model_copy(update={"id": "custom-copy"}),
            server.model_copy(
                update={
                    "header_secrets": {"Authorization": "connector:github:current:refresh_token"}
                }
            ),
        ):
            with self.subTest(server=unsafe.id), self.assertRaises(ValueError):
                resolver.validate_servers((unsafe,))
        with self.assertRaises(ValueError):
            await resolver.resolve("connector:github:current:refresh_token")

    async def test_expired_update_attempt_does_not_look_like_success(self):
        self.attempt()

        def expire(state):
            entry = state["entries"]["github"]
            entry["attempt"]["expires_at"] = time.time() - 1
            entry.update(credential={"access_token": "original"}, method="key", tools=[])

        self.store.transaction(expire)
        row = next(row for row in await self.service.catalog() if row["id"] == "github")
        self.assertTrue(row["authorized"])
        self.assertIsNone(row["attempt"])
        self.assertEqual(row["authorization_error"], "connector_attempt_expired")

    async def test_invalid_grant_persists_reauthorization_without_exposing_old_token(self):
        entry = new_entry()
        entry.update(
            method="oauth",
            credential_id="current",
            credential={
                "access_token": "expired",
                "refresh_token": "old-refresh",
                "expires_at": time.time() - 1,
            },
            oauth={"metadata": {}, "client": {}},
        )
        self.store.transaction(lambda state: state["entries"].update({"github": entry}))
        resolver = ConnectorSecrets(self.store, Activities())
        with patch(
            "service.settings.connectors.service.exchange",
            side_effect=ValueError("connector_credentials_invalid"),
        ):
            with self.assertRaises(ValueError):
                await resolver.resolve("connector:github:current:bearer")
        row = (await self.service.catalog())[2]
        self.assertEqual(row["state"], "auth_required")
        self.assertFalse(row["authorized"])


class BrokerClosureContracts(unittest.TestCase):
    WATCHDOG_SECONDS = 10
    PHASE_SECONDS = 1
    HANG_SECONDS = 0.1
    CHILD = (
        "import asyncio,sys\n"
        "from apps.serve.tests.contract_connectors import BrokerClosureContracts\n"
        "asyncio.run(BrokerClosureContracts().run_scenario("
        "fail=sys.argv[1]=='fail', hang=sys.argv[2]))\n"
    )

    def test_concurrent_close_isolates_repeated_caller_cancellation(self):
        self.run_child(fail=False)

    def test_concurrent_close_preserves_all_failures_and_repeat_result(self):
        self.run_child(fail=True)

    def test_hung_cleanup_times_out_and_reaps_owned_tasks(self):
        for stage in ("binding", "listener"):
            with self.subTest(stage=stage):
                result = self.run_child(fail=False, hang=stage)
                self.assertIn("broker_fixture_timeout_clean", result.stdout)

    def test_watchdog_reaps_fixture_that_refuses_cancellation(self):
        with self.assertRaises(subprocess.TimeoutExpired) as timeout:
            self.run_child(fail=False, hang="stubborn")
        # Prove the watchdog reached the injected hang, rather than timing out imports.
        output = timeout.exception.stdout
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        self.assertIn("broker_fixture_stubborn", output or "")

    def test_watchdog_output_accepts_bytes_and_text_but_rejects_missing(self):
        for output in (b"broker_fixture_stubborn", "broker_fixture_stubborn", None):
            with self.subTest(output_type=type(output).__name__):
                failure = subprocess.TimeoutExpired("fixture", self.WATCHDOG_SECONDS, output)
                with patch.object(self, "run_child", side_effect=failure):
                    if output is None:
                        with self.assertRaises(AssertionError):
                            self.test_watchdog_reaps_fixture_that_refuses_cancellation()
                    else:
                        self.test_watchdog_reaps_fixture_that_refuses_cancellation()

    def run_child(self, *, fail: bool, hang: str = ""):
        # subprocess.run kills and waits for its child on timeout on both OSes.
        result = subprocess.run(
            [sys.executable, "-B", "-c", self.CHILD, "fail" if fail else "pass", hang],
            capture_output=True,
            text=True,
            timeout=self.WATCHDOG_SECONDS,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("broker_fixture_complete", result.stdout)
        return result

    async def run_scenario(self, *, fail: bool, hang: str):
        try:
            await self.concurrent_close(fail=fail, hang=hang)
        except TimeoutError as error:
            if hang not in ("binding", "listener"):
                raise
            self.assertEqual(str(error), "broker fixture phase timed out")
            remaining = asyncio.all_tasks() - {asyncio.current_task()}
            self.assertFalse(remaining, "fixture detached unfinished tasks")
            print("broker_fixture_timeout_clean", flush=True)
        else:
            self.assertFalse(hang, "injected cleanup hang did not time out")
        print("broker_fixture_complete", flush=True)

    async def observe(self, tasks, timeout):
        _, pending = await asyncio.wait(tasks, timeout=timeout)
        if pending:
            raise TimeoutError("broker fixture phase timed out")

    async def concurrent_close(self, *, fail: bool, hang: str = ""):
        broker = ConnectorBroker(None, None, Activities())
        binding_entered, binding_release = asyncio.Event(), asyncio.Event()
        listener_entered, listener_release = asyncio.Event(), asyncio.Event()
        owned = set()
        closed = []
        failures = [ValueError("binding_one"), RuntimeError("binding_two"), OSError("listener")]

        async def event(event):
            waiter = asyncio.create_task(event.wait())
            owned.add(waiter)
            await self.observe({waiter}, self.PHASE_SECONDS)

        async def binding_close(index):
            owned.add(asyncio.current_task())
            closed.append(index)
            binding_entered.set()
            if index == 0 and hang in ("binding", "stubborn"):
                print("broker_fixture_" + hang, flush=True)
                blocked = asyncio.Event()
                while True:
                    try:
                        await blocked.wait()
                    except asyncio.CancelledError:
                        if hang != "stubborn":
                            raise
            await binding_release.wait()
            if fail:
                raise failures[index]

        async def listener():
            while not broker.server.should_exit:
                await asyncio.sleep(0)
            listener_entered.set()
            await listener_release.wait()
            if hang == "listener":
                await asyncio.Event().wait()
            if fail:
                raise failures[2]

        broker.bindings = {
            str(index): SimpleNamespace(aclose=lambda index=index: binding_close(index))
            for index in range(2)
        }
        broker.server = SimpleNamespace(should_exit=False)
        broker.task = asyncio.create_task(listener())
        callers = [asyncio.create_task(broker.aclose()) for _ in range(4)]
        owned.update([*callers, broker.task])
        try:
            await event(binding_entered)
            for _ in range(2):
                callers[0].cancel()
                await asyncio.sleep(0)
                self.assertFalse(any(caller.done() for caller in callers))
            binding_release.set()
            if hang in ("binding", "stubborn"):
                await self.observe(callers, self.HANG_SECONDS)
            await event(listener_entered)
            callers[0].cancel()
            await asyncio.sleep(0)
            self.assertFalse(any(caller.done() for caller in callers))
            self.assertEqual(closed, [0, 1])
            listener_release.set()
            await self.observe(callers, self.HANG_SECONDS if hang else self.PHASE_SECONDS)
            results = []
            for task in callers:
                try:
                    results.append(task.result())
                except BaseException as error:
                    results.append(error)
            self.assertTrue(broker.task.done())
            if fail:
                for result in results:
                    self.assertIsInstance(result, ExceptionGroup)
                    self.assertEqual(list(result.exceptions), failures)
                repeated_close = asyncio.create_task(broker.aclose())
                owned.add(repeated_close)
                await self.observe({repeated_close}, self.PHASE_SECONDS)
                with self.assertRaises(ExceptionGroup) as repeated:
                    repeated_close.result()
                self.assertEqual(list(repeated.exception.exceptions), failures)
            else:
                self.assertIsInstance(results[0], asyncio.CancelledError)
                self.assertEqual(results[1:], [None, None, None])
                repeated_close = asyncio.create_task(broker.aclose())
                owned.add(repeated_close)
                await self.observe({repeated_close}, self.PHASE_SECONDS)
                repeated_close.result()
            self.assertEqual(closed, [0, 1])
        finally:
            binding_release.set()
            listener_release.set()
            broker.server.should_exit = True
            if broker._close_task is not None:
                owned.add(broker._close_task)
            for task in owned:
                if not task.done():
                    task.cancel()
            done, pending = await asyncio.wait(owned, timeout=self.PHASE_SECONDS)
            for task in done:
                if not task.cancelled():
                    task.exception()
            if pending:
                raise TimeoutError("broker fixture cleanup did not terminate")


class ConnectorTransportContracts(unittest.IsolatedAsyncioTestCase):
    async def test_idle_drain_rejects_stale_generation_and_retains_active_bindings(self):
        activities = Activities()
        broker = ConnectorBroker(None, None, activities)
        source = McpHttpServer(id="drain", url="https://example.invalid/mcp")
        binding = Binding(broker, source)
        binding.task = asyncio.create_task(asyncio.sleep(0))
        binding.ready.set()
        broker.bindings["owned"] = binding
        broker.admit = AsyncMock()
        binding.connection.aclose = AsyncMock()
        with self.assertRaises(MaintenanceStale):
            await broker.drain_resources("stale")
        async with binding.invocation():
            generation = activities.begin()
            self.assertEqual(await broker.drain_resources(generation), (source.id,))
            binding.connection.aclose.assert_not_called()
            self.assertFalse(activities.seal(generation))
        binding.requests = 1
        self.assertEqual(await broker.drain_resources(generation), (source.id,))
        binding.requests = 0
        binding.ready.clear()
        self.assertEqual(await broker.drain_resources(generation), (source.id,))
        binding.ready.set()
        self.assertEqual(await broker.drain_resources(generation), ())
        binding.connection.aclose.assert_awaited_once()
        self.assertIsNot(broker.bindings["owned"], binding)
        self.assertTrue(activities.seal(generation))
        activities.resume(generation)
        with self.assertRaises(MaintenanceStale):
            await broker.drain_resources(generation)

    async def test_idle_drain_waits_for_cleanup_and_preserves_failure(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                activities = Activities()
                broker = ConnectorBroker(None, None, activities)
                source = McpHttpServer(id="drain", url="https://example.invalid/mcp")
                binding = Binding(broker, source)
                binding.task = asyncio.create_task(asyncio.sleep(0))
                binding.ready.set()
                broker.bindings["owned"] = binding
                occupied = activities.enter(ActivityDomain.RESOURCE)
                entered, release = asyncio.Event(), asyncio.Event()

                async def close(entered=entered, release=release, failed=failed, occupied=occupied):
                    entered.set()
                    await release.wait()
                    if failed:
                        raise RuntimeError("cleanup_failed")
                    occupied.close()

                binding.connection.aclose = close
                generation = activities.begin()
                drain = asyncio.create_task(broker.drain_resources(generation))
                await entered.wait()
                self.assertFalse(drain.done())
                self.assertFalse(activities.seal(generation))
                release.set()
                if failed:
                    with self.assertRaisesRegex(RuntimeError, "cleanup_failed"):
                        await drain
                    with self.assertRaisesRegex(RuntimeError, "cleanup_failed"):
                        await broker.drain_resources(generation)
                    self.assertIs(broker.bindings["owned"], binding)
                    self.assertFalse(activities.seal(generation))
                else:
                    self.assertEqual(await drain, ())
                    self.assertTrue(activities.seal(generation))
                occupied.close()
                activities.resume(generation)

    async def test_cancelled_idle_drain_joins_cleanup_before_returning(self):
        activities = Activities()
        broker = ConnectorBroker(None, None, activities)
        binding = Binding(broker, McpHttpServer(id="drain", url="https://example.invalid/mcp"))
        binding.task = asyncio.create_task(asyncio.sleep(0))
        binding.ready.set()
        broker.bindings["owned"] = binding
        occupied = activities.enter(ActivityDomain.RESOURCE)
        entered, release = asyncio.Event(), asyncio.Event()

        async def close():
            entered.set()
            await release.wait()
            occupied.close()

        binding.connection.aclose = close
        generation = activities.begin()
        drain = asyncio.create_task(broker.drain_resources(generation))
        await entered.wait()
        drain.cancel()
        await asyncio.sleep(0)
        self.assertFalse(drain.done())
        self.assertFalse(activities.seal(generation))
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await drain
        self.assertTrue(binding.task.done())
        self.assertEqual(await broker.drain_resources(generation), ())
        self.assertTrue(activities.seal(generation))
        activities.resume(generation)

    async def test_broker_cancelled_close_waits_for_bindings_and_listener(self):
        for phase in ("bindings", "listener"):
            with self.subTest(phase=phase):
                broker = ConnectorBroker(None, None, Activities())
                binding_entered, binding_release = asyncio.Event(), asyncio.Event()
                listener_entered, listener_release = asyncio.Event(), asyncio.Event()

                async def binding_close(
                    binding_entered=binding_entered, binding_release=binding_release
                ):
                    binding_entered.set()
                    await binding_release.wait()

                async def listener(
                    listener_entered=listener_entered, listener_release=listener_release
                ):
                    listener_entered.set()
                    await listener_release.wait()

                broker.bindings["owned"] = SimpleNamespace(aclose=binding_close)
                broker.server = SimpleNamespace(should_exit=False)
                broker.task = asyncio.create_task(listener())
                close = asyncio.create_task(broker.aclose())
                try:
                    await binding_entered.wait()
                    await listener_entered.wait()
                    if phase == "listener":
                        binding_release.set()
                        while not broker.server.should_exit:
                            await asyncio.sleep(0)
                    close.cancel()
                    close.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(close.done())
                    binding_release.set()
                    await asyncio.sleep(0)
                    await asyncio.sleep(0)
                    self.assertFalse(close.done())
                    listener_release.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await close
                    self.assertTrue(broker.server.should_exit)
                    self.assertTrue(broker.task.done())
                    await broker.aclose()
                finally:
                    binding_release.set()
                    listener_release.set()
                    await asyncio.gather(close, broker.task, return_exceptions=True)

    async def test_broker_binding_failure_still_stops_and_joins_listener(self):
        broker = ConnectorBroker(None, None, Activities())
        failure = ValueError("binding_cleanup_failed")
        broker.bindings["failed"] = SimpleNamespace(aclose=AsyncMock(side_effect=failure))
        completed = asyncio.Event()

        async def other_binding_close():
            await asyncio.sleep(0)
            completed.set()

        async def listener():
            while not broker.server.should_exit:
                await asyncio.sleep(0)

        broker.bindings["other"] = SimpleNamespace(aclose=other_binding_close)
        broker.server = SimpleNamespace(should_exit=False)
        broker.task = asyncio.create_task(listener())
        try:
            with self.assertRaisesRegex(ValueError, "binding_cleanup_failed"):
                await broker.aclose()
            self.assertTrue(completed.is_set())
            self.assertTrue(broker.server.should_exit)
            self.assertTrue(broker.task.done())
        finally:
            broker.server.should_exit = True
            await broker.task

    async def test_closed_broker_rejects_start_and_new_projections(self):
        broker = ConnectorBroker(None, None, Activities())
        broker.port = 12345
        await broker.aclose()
        source = McpHttpServer(id="closed", url="https://example.invalid/mcp")
        with self.assertRaisesRegex(ValueError, "connector_configuration_conflict"):
            broker.project(source)
        with self.assertRaisesRegex(ValueError, "connector_configuration_conflict"):
            await broker.start()
        self.assertFalse(broker.bindings)

    async def test_close_interrupts_initialization_and_joins_owned_task(self):
        server = McpHttpServer(
            id="closing", url="https://example.invalid/mcp", startup_timeout=120000
        )

        async def headers():
            return {}

        connection = Connection(server, headers)
        entered, release = asyncio.Event(), asyncio.Event()

        async def initialize(stack, diagnostics):
            entered.set()
            await release.wait()

        connection._initialize = initialize
        start = asyncio.create_task(connection.start())
        await entered.wait()
        close = asyncio.create_task(connection.aclose())
        try:
            await asyncio.wait_for(asyncio.shield(close), 0.2)
            self.assertTrue(connection.task.done())
            with self.assertRaisesRegex(ValueError, "connector_transport_closed"):
                await start
        finally:
            release.set()
            await asyncio.gather(start, close, return_exceptions=True)

    async def test_close_during_real_stdio_handshake_reaps_transport(self):
        server = SERVER_ADAPTER.validate_json(
            json.dumps(
                {
                    "id": "stdio-closing",
                    "transport": "stdio",
                    "command": sys.executable,
                    "args": ["-u", "-c", "import time;time.sleep(60)"],
                    "startup_timeout": 120000,
                }
            )
        )

        async def headers():
            return {}

        connection = Connection(server, headers)
        start = asyncio.create_task(connection.start())
        try:
            async with asyncio.timeout(5):
                while connection.session is None:
                    if connection.task is not None and connection.task.done():
                        await start
                    await asyncio.sleep(0.01)
            await asyncio.wait_for(connection.aclose(), 10)
            self.assertTrue(connection.task.done())
            self.assertIsNone(connection.session)
            with self.assertRaisesRegex(ValueError, "connector_transport_closed"):
                await start
        finally:
            await connection.aclose()
            await asyncio.gather(start, return_exceptions=True)

    async def test_cancelled_close_caller_still_waits_for_cleanup(self):
        async def headers():
            return {}

        connection = Connection(
            McpHttpServer(id="closing", url="https://example.invalid/mcp", startup_timeout=120000),
            headers,
        )
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def initialize(stack, diagnostics):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await release.wait()

        connection._initialize = initialize
        start = asyncio.create_task(connection.start())
        await entered.wait()
        close = asyncio.create_task(connection.aclose())
        await asyncio.wait_for(cleaning.wait(), 1)
        close.cancel()
        await asyncio.sleep(0)
        self.assertFalse(close.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await close
        await asyncio.gather(start, return_exceptions=True)
        self.assertTrue(connection.task.done())
        await connection.aclose()

    async def test_binding_close_interrupts_cold_start(self):
        server = McpHttpServer(
            id="closing", url="https://example.invalid/mcp", startup_timeout=120000
        )
        owner = SimpleNamespace(token="test-token", activities=Activities(), observe=AsyncMock())
        binding = Binding(owner, server)
        entered, release = asyncio.Event(), asyncio.Event()

        async def initialize(stack, diagnostics):
            entered.set()
            await release.wait()

        binding.connection._initialize = initialize
        start = asyncio.create_task(binding.start())
        await entered.wait()
        close = asyncio.create_task(binding.aclose())
        try:
            await asyncio.wait_for(asyncio.shield(close), 0.2)
            self.assertTrue(binding.connection.task.done())
            self.assertTrue(binding.task.done())
        finally:
            release.set()
            await asyncio.gather(start, close, return_exceptions=True)

    async def test_diagnostic_tempfile_denial_keeps_failure_and_releases_waiter(self):
        server = SERVER_ADAPTER.validate_json(
            json.dumps({"id": "temp-denied", "transport": "stdio", "command": sys.executable})
        )

        async def headers():
            return {}

        connection = Connection(server, headers)
        with (
            patch(
                "service.settings.connectors.transport.tempfile.TemporaryFile",
                side_effect=PermissionError(13, "private-directory"),
            ),
            self.assertLogs("service.settings.connectors.transport", level="WARNING") as captured,
        ):
            with self.assertRaisesRegex(ValueError, "connector_process_failed"):
                await connection.start()
            await connection.aclose()
        self.assertTrue(connection.task.done())
        self.assertIn("errno=13", " ".join(captured.output))
        self.assertNotIn("private-directory", " ".join(captured.output))

    async def test_startup_log_preserves_system_code_and_does_not_mask_failure(self):
        server = SERVER_ADAPTER.validate_json(
            json.dumps(
                {"id": "private-server", "transport": "stdio", "command": "missing-private-command"}
            )
        )

        async def headers():
            return {}

        connection = Connection(server, headers)
        error = PermissionError(13, "do-not-export-private-message")
        error.winerror = 5
        with self.assertLogs("service.settings.connectors.transport", level="WARNING") as captured:
            connection._record_failure(error)
        text = " ".join(captured.output)
        self.assertIn("errno=13 system_code=5", text)
        self.assertNotIn("private-server", text)
        self.assertNotIn("do-not-export-private-message", text)
        with patch(
            "service.settings.connectors.transport.LOGGER.warning",
            side_effect=RuntimeError("sink unavailable"),
        ):
            connection._record_failure(error)

    async def test_explicit_startup_timeout_bounds_handshake_and_initial_discovery(self):
        for delayed in ("initialize", "tools/list"):
            program = "\n".join(
                [
                    "import json,sys,time",
                    "for line in sys.stdin:",
                    " message=json.loads(line)",
                    " if 'id' not in message: continue",
                    f" if message['method']=={delayed!r}: time.sleep(2)",
                    " result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'contract','version':'1'}} if message['method']=='initialize' else {'tools':[]}",
                    " print(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}),flush=True)",
                ]
            )
            server = SERVER_ADAPTER.validate_json(
                json.dumps(
                    {
                        "id": "slow-stdio",
                        "transport": "stdio",
                        "command": sys.executable,
                        "args": ["-c", program],
                        "startup_timeout": 1000,
                        "timeout": 9000,
                    }
                )
            )
            with (
                self.subTest(delayed=delayed),
                self.assertRaisesRegex(ValueError, "connector_timeout"),
            ):
                await inspect_server(server, {})

    async def test_startup_budget_does_not_shorten_later_inventory_calls(self):
        program = "\n".join(
            [
                "import json,sys,time",
                "count=0",
                "for line in sys.stdin:",
                " message=json.loads(line)",
                " if 'id' not in message: continue",
                " if message['method']=='tools/list': count+=1",
                " if count>1: time.sleep(1.1)",
                " result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'contract','version':'1'}} if message['method']=='initialize' else {'tools':[]}",
                " print(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}),flush=True)",
            ]
        )
        server = SERVER_ADAPTER.validate_json(
            json.dumps(
                {
                    "id": "budgets",
                    "transport": "stdio",
                    "command": sys.executable,
                    "args": ["-c", program],
                    "startup_timeout": 1000,
                    "timeout": 3000,
                }
            )
        )

        async def headers():
            return {}

        connection = Connection(server, headers)
        try:
            self.assertEqual((await connection.inventory())["tools"], [])
            self.assertEqual((await connection.inventory())["tools"], [])
        finally:
            await connection.aclose()
        self.assertTrue(connection.task.done())

    async def test_stdio_preserves_unicode_paths_arguments_environment_and_crlf(self):
        arguments = ["中文 空格", 'literal "quotes" & %PATH%', ""]
        program = "\n".join(
            [
                "import json, os, sys",
                f"assert sys.argv[1:] == {arguments!r}",
                "assert os.path.basename(os.getcwd()) == '研究 目录'",
                "assert os.environ['CONNECTOR_CONTRACT_VALUE'] == '中文 环境'",
                "for line in sys.stdin:",
                " message = json.loads(line)",
                " if 'id' not in message: continue",
                " result = {'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'contract','version':'中文版本'}} if message['method']=='initialize' else {'tools':[]}",
                " os.write(1, (json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}, ensure_ascii=False) + '\\r\\n').encode('utf-8'))",
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            working = Path(directory) / "研究 目录"
            working.mkdir()
            server = SERVER_ADAPTER.validate_json(
                json.dumps(
                    {
                        "id": "portable-stdio",
                        "transport": "stdio",
                        "command": sys.executable,
                        "args": ["-c", program, *arguments],
                        "cwd": str(working),
                        "environment": {"CONNECTOR_CONTRACT_VALUE": "中文 环境"},
                    }
                )
            )
            observed = await inspect_server(server, {})
            self.assertEqual(observed, {"version": "中文版本", "tools": []})

    async def test_process_diagnostics_do_not_depend_on_system_text_encoding(self):
        for payload, expected in (
            (b"\x81ModuleNotFoundError: missing\r\n", "connector_dependency_missing"),
            (b"\xffImportError: unavailable\r\n", "connector_dependency_missing"),
            (b"\x81\xfflocal process failed\r\n", "connector_process_failed"),
        ):
            with self.subTest(expected=expected, payload=payload):
                with self.assertRaisesRegex(ValueError, expected):
                    await inspect_server(
                        SERVER_ADAPTER.validate_json(
                            json.dumps(
                                {
                                    "id": "encoded-diagnostics",
                                    "transport": "stdio",
                                    "command": sys.executable,
                                    "args": [
                                        "-c",
                                        f"import os; os.write(2, {payload!r})",
                                    ],
                                }
                            )
                        ),
                        {},
                    )

    async def test_binding_close_drains_accepted_calls_and_rejects_new_ones(self):
        owner = SimpleNamespace(
            token="private-test-token", admit=AsyncMock(), activities=Activities()
        )
        source = McpHttpServer(id="drain", url="https://example.invalid/mcp")
        binding = Binding(owner, source)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def call():
            async with binding.invocation():
                entered.set()
                await release.wait()

        running = asyncio.create_task(call())
        await entered.wait()
        closing = asyncio.create_task(binding.aclose())
        await asyncio.sleep(0)
        self.assertFalse(closing.done())
        self.assertFalse(binding.stop.is_set())
        with self.assertRaisesRegex(ValueError, "connector_configuration_conflict"):
            async with binding.invocation():
                self.fail("closed binding admitted a new call")
        release.set()
        await running
        await closing
        self.assertTrue(binding.stop.is_set())

    async def test_missing_process_and_dependency_have_distinct_diagnostics(self):
        with self.assertRaisesRegex(ValueError, "connector_command_not_found"):
            await inspect_server(
                SERVER_ADAPTER.validate_json(
                    json.dumps(
                        {
                            "id": "missing",
                            "transport": "stdio",
                            "command": "scholarseed-mcp-nonexistent-contract-command",
                        }
                    )
                ),
                {},
            )
        with self.assertRaisesRegex(ValueError, "connector_dependency_missing"):
            await inspect_server(
                SERVER_ADAPTER.validate_json(
                    json.dumps(
                        {
                            "id": "dependency",
                            "transport": "stdio",
                            "command": sys.executable,
                            "args": ["-c", "import nonexistent_connector_contract_dependency"],
                        }
                    )
                ),
                {},
            )

    async def test_cross_origin_auth_never_resolves_or_forwards_credentials(self):
        headers = AsyncMock(return_value={"Authorization": "private"})
        auth = CredentialAuth("https://expected.example/mcp", headers)
        with self.assertRaisesRegex(ValueError, "connector_oauth_resource_invalid"):
            await anext(auth.async_auth_flow(httpx.Request("POST", "https://other.example/mcp")))
        headers.assert_not_called()

    async def test_same_origin_auth_normalizes_host_case_and_default_port(self):
        headers = AsyncMock(return_value={"Authorization": "private"})
        auth = CredentialAuth("https://EXPECTED.example:443/mcp", headers)
        request = await anext(
            auth.async_auth_flow(httpx.Request("POST", "https://expected.example/messages"))
        )
        self.assertEqual(request.headers["authorization"], "private")

    async def test_custom_metadata_cannot_connect_to_loopback(self):
        with httpx.Client(transport=PublicTransport(), trust_env=False) as client:
            with self.assertRaisesRegex(ValueError, "connector_oauth_metadata_invalid"):
                client.get("https://127.0.0.1/metadata")

    async def test_real_stdio_wire_through_private_bridge_and_revoke_admission(self):
        program = "\n".join(
            [
                "import json,sys",
                "tool_lists=0",
                "for line in sys.stdin:",
                " message=json.loads(line)",
                " if 'id' not in message: continue",
                " method=message['method']",
                " if method=='tools/list': tool_lists+=1",
                " if method=='tools/list' and tool_lists==2: print(json.dumps({'jsonrpc':'2.0','method':'notifications/tools/list_changed'}),flush=True)",
                " result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'contract','version':'1'}} if method=='initialize' else {'tools':[{'name':'probe','inputSchema':{'type':'object'}}]} if method=='tools/list' else {'content':[{'type':'text','text':'contract-result'}]} if method=='tools/call' else {}",
                " print(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}),flush=True)",
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activities = Activities()
            store = McpConfigurationStore(root / "mcp.json")
            source = SERVER_ADAPTER.validate_json(
                json.dumps(
                    {
                        "id": "contract",
                        "startup_timeout": 9000,
                        "transport": "stdio",
                        "command": sys.executable,
                        "args": ["-u", "-c", program],
                    }
                )
            )
            store.replace((source,), expected_revision=0)
            broker = ConnectorBroker(
                store, ConnectorSecrets(ConnectorStore(root / "private"), activities), activities
            )
            await broker.start()
            try:
                target = broker.project(source)
                self.assertEqual(target.startup_timeout_ms, 9000)
                token = (await broker.resolve(target.credentials[0].secret_ref)).value
                async with httpx.AsyncClient() as client:
                    denied = await client.post(target.transport.url, json={})
                    self.assertEqual(denied.status_code, 403)
                async with streamablehttp_client(
                    target.transport.url, headers={"Authorization": token}
                ) as streams:
                    notified = asyncio.Event()

                    async def notification(message):
                        if isinstance(
                            getattr(message, "root", None), types.ToolListChangedNotification
                        ):
                            notified.set()

                    async with ClientSession(
                        streams[0], streams[1], message_handler=notification
                    ) as session:
                        initialized = await session.initialize()
                        self.assertTrue(initialized.capabilities.tools.listChanged)
                        self.assertEqual(
                            [tool.name for tool in (await session.list_tools()).tools], ["probe"]
                        )
                        self.assertEqual(
                            (await session.call_tool("probe", {})).content[0].text,
                            "contract-result",
                        )
                        await asyncio.wait_for(notified.wait(), timeout=5)
                previous = next(iter(broker.bindings.values()))
                self.assertEqual(activities.snapshot().counts, {"resource": 1})
                generation = activities.begin()
                self.assertEqual(await broker.drain_resources(generation), ())
                self.assertTrue(previous.task.done())
                self.assertTrue(previous.connection.task.done())
                self.assertTrue(activities.seal(generation))
                activities.resume(generation)
                async with streamablehttp_client(
                    target.transport.url, headers={"Authorization": token}
                ) as streams:
                    async with ClientSession(streams[0], streams[1]) as session:
                        await session.initialize()
                        self.assertEqual(
                            (await session.call_tool("probe", {})).content[0].text,
                            "contract-result",
                        )
                disabled = source.model_copy(update={"enabled": False})
                store.replace((disabled,), expected_revision=1)
                await broker.reconcile((disabled,))
                with self.assertRaisesRegex(ValueError, "connector_configuration_conflict"):
                    await broker.admit(source)
                broker.project(disabled)
                await broker.reconcile((disabled,))
                store.replace((source,), expected_revision=2)
                await broker.reconcile((source,))
                revived = broker.project(source)
                async with streamablehttp_client(
                    revived.transport.url, headers={"Authorization": token}
                ) as streams:
                    async with ClientSession(streams[0], streams[1]) as session:
                        await session.initialize()
                        self.assertEqual(
                            (await session.call_tool("probe", {})).content[0].text,
                            "contract-result",
                        )
            finally:
                await broker.aclose()
            self.assertTrue(
                all(binding.connection.task.done() for binding in broker.bindings.values())
            )


if __name__ == "__main__":
    unittest.main()
