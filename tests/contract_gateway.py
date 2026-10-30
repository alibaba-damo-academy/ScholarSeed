"""Deterministic contracts for the developer skill's optional gateway reader."""

import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

SCRIPT = Path(__file__).resolve().parents[1] / ".agents/skills/evidence-session/scripts/gateway.py"
SPEC = importlib.util.spec_from_file_location("session_gateway", SCRIPT)
GATEWAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATEWAY)
BASE = "https://admin.example.test/admin/api/v1/gateway/admin"
TOKEN = "header.payload.signature"
SESSION = "selected-session"
TRACE = "gw-selected"
START = "2026-10-08T17:50:00+08:00"
END = "2026-10-08T18:00:00+08:00"
CREATED = "2026-10-08 09:55:00"


def arguments(*extra):
    return GATEWAY.parser().parse_args(
        [
            "--base-url",
            BASE,
            "--session",
            SESSION,
            "--start",
            START,
            "--end",
            END,
            *extra,
        ]
    )


def record(**extra):
    return {
        "trace_id": TRACE,
        "chat_id": SESSION,
        "created_at": CREATED,
        "status": "success",
        **extra,
    }


class Response:
    status = 200

    def __init__(self, raw):
        self.raw = raw

    def read(self, size):
        return self.raw[:size]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Client:
    token = TOKEN

    def __init__(self, pages):
        self.pages = iter(pages)
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, params))
        return next(self.pages)


class GatewayContracts(unittest.TestCase):
    def test_selection_bounds_and_explicit_offsets(self):
        start, end = GATEWAY.validate_selection(arguments())
        self.assertEqual(start.isoformat(), "2026-10-08T09:50:00+00:00")
        self.assertEqual(end.isoformat(), "2026-10-08T10:00:00+00:00")
        for extra in [
            ("--start", "2026-10-08T17:50:00"),
            ("--end", "2026-10-20T18:00:00+08:00"),
            ("--end", START),
            ("--limit", "0"),
            ("--pages", "6"),
            ("--offset", "-1"),
            ("--trace", "../other"),
            ("--content", "request"),
        ]:
            with self.subTest(extra=extra), self.assertRaises(GATEWAY.GatewayError):
                GATEWAY.validate_selection(arguments(*extra))

    def test_base_rejects_credential_forwarding_routes(self):
        self.assertEqual(GATEWAY.validate_base(BASE + "/"), BASE)
        for base in [
            BASE.replace("https:", "http:"),
            BASE + "?token=secret",
            BASE + "#fragment",
            BASE.replace("admin.example.test", "user@admin.example.test"),
            BASE.replace("admin.example.test", "admin.example.test:8443"),
            BASE.replace("/admin/api", "/other/api"),
        ]:
            with self.subTest(base=base), self.assertRaises(GATEWAY.GatewayError):
                GATEWAY.validate_base(base)

    def test_stdin_has_no_token_argument_or_echo(self):
        self.assertEqual(GATEWAY.read_token(io.StringIO(TOKEN + "\nignored\n")), TOKEN)
        for supplied in [
            "",
            "Bearer " + TOKEN,
            TOKEN + "\r\nInjected: value",
            "a" * (GATEWAY.MAX_TOKEN_BYTES + 1),
        ]:
            if supplied.startswith(TOKEN + "\r\n"):
                self.assertEqual(GATEWAY.read_token(io.StringIO(supplied)), TOKEN)
                continue
            with self.subTest(supplied=supplied[:20]), self.assertRaises(GATEWAY.GatewayError):
                GATEWAY.read_token(io.StringIO(supplied))

    def test_transport_is_get_only_and_bounded(self):
        client = GATEWAY.GatewayClient(BASE, TOKEN)
        client.opener = mock.Mock()
        client.opener.open.return_value = Response(
            json.dumps({"code": 0, "data": {"items": []}}).encode()
        )
        self.assertEqual(client.get("/logs", {"chat_id": SESSION}), {"items": []})
        request = client.opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(parse_qs(urlsplit(request.full_url).query), {"chat_id": [SESSION]})
        client.opener.open.return_value = Response(b"x" * (GATEWAY.MAX_RESPONSE_BYTES + 1))
        with self.assertRaisesRegex(GATEWAY.GatewayError, "response_too_large"):
            client.get("/logs")

    def test_redirects_and_errors_never_expose_server_bodies(self):
        self.assertIsNone(
            GATEWAY.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.test")
        )
        client = GATEWAY.GatewayClient(BASE, TOKEN)
        client.opener = mock.Mock()
        for status in (302, 401, 403, 404, 429, 500, 503):
            client.opener.open.side_effect = HTTPError(
                BASE, status, TOKEN, {}, io.BytesIO(TOKEN.encode())
            )
            with self.subTest(status=status), self.assertRaises(GATEWAY.GatewayError) as caught:
                client.get("/logs")
            self.assertNotIn(TOKEN, str(caught.exception))
        client.opener.open.side_effect = URLError(TOKEN)
        with self.assertRaisesRegex(GATEWAY.GatewayError, "network_error"):
            client.get("/logs")

    def test_invalid_envelopes_fail_closed(self):
        client = GATEWAY.GatewayClient(BASE, TOKEN)
        client.opener = mock.Mock()
        for raw in [b"not json", b"[]", b'{"code":1,"message":"secret"}', b'{"code":0,"data":[]}']:
            client.opener.open.return_value = Response(raw)
            with self.subTest(raw=raw), self.assertRaises(GATEWAY.GatewayError):
                client.get("/logs")

    def test_substring_rows_filtered_before_output_and_pagination_bounded(self):
        args = arguments("--limit", "2", "--pages", "2")
        start, end = GATEWAY.validate_selection(args)
        client = Client(
            [
                {"items": [record(chat_id=SESSION + "-other"), record()], "total": 5},
                {
                    "items": [record(created_at="2026-10-07 09:55:00"), record(trace_id="gw-next")],
                    "total": 5,
                },
            ]
        )
        result = GATEWAY.query(client, args, start, end)
        self.assertEqual(result["exact_matches"], 2)
        self.assertEqual(result["scanned"], 4)
        self.assertEqual(result["next_offset"], 4)
        self.assertFalse(result["complete"])
        self.assertEqual(client.calls[1][1]["offset"], 2)
        self.assertEqual(client.calls[0][1]["created_from"], "2026-10-08T09:50:00+00:00")

    def test_detail_rechecks_session_trace_and_time(self):
        args = arguments("--trace", TRACE, "--content", "both")
        start, end = GATEWAY.validate_selection(args)
        for wrong in [
            record(chat_id="other"),
            record(trace_id="gw-other"),
            record(created_at="2026-10-09 09:55:00"),
        ]:
            with (
                self.subTest(wrong=wrong),
                self.assertRaisesRegex(GATEWAY.GatewayError, "selection_mismatch"),
            ):
                GATEWAY.query(Client([wrong]), args, start, end)

    def test_metadata_never_emits_headers_or_raw_bodies(self):
        projected = GATEWAY.metadata(
            record(
                request_body=TOKEN,
                request_headers={"Authorization": TOKEN},
                response_overview={"reasoning": "hidden"},
                sse_events="hidden",
                tokens={"reasoning": 10, "unknown": "hidden"},
                upstream_attempts=[
                    {
                        "response_status": 200,
                        "request_body": TOKEN,
                        "request_headers": {"cookie": "hidden"},
                    }
                ],
            ),
            TOKEN,
        )
        serialized = json.dumps(projected)
        self.assertNotIn(TOKEN, serialized)
        self.assertNotIn("hidden", serialized)
        self.assertEqual(projected["tokens"], {"reasoning": 10})
        self.assertEqual(projected["upstream_attempts"], [{"response_status": 200}])

    def test_request_projection_redacts_tokens_and_excludes_reasoning(self):
        body = {
            "model": "model",
            "instructions": "Authorization: Bearer " + TOKEN,
            "input": [
                {"type": "reasoning", "summary": "hidden"},
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Cookie: secret-cookie\nquestion"},
                        {"type": "reasoning_text", "text": "hidden"},
                        {"type": "input_image", "image_url": TOKEN},
                    ],
                },
            ],
            "tools": [{"type": "function", "name": "tool", "parameters": {"secret": TOKEN}}],
            "client_metadata": {"secret": TOKEN},
        }
        result = GATEWAY.request_content(json.dumps(body), TOKEN)
        serialized = json.dumps(result)
        for secret in [TOKEN, "hidden", "secret-cookie", "image_url", "client_metadata"]:
            self.assertNotIn(secret, serialized)
        self.assertIn("question", serialized)
        self.assertEqual(result["tools"], [{"type": "function", "name": "tool"}])
        self.assertTrue(
            GATEWAY.safe_text("x" * (GATEWAY.MAX_TEXT_CHARS + 1)).endswith(GATEWAY.TRUNCATED)
        )

    def test_responses_sse_supports_both_data_separators_and_event_names(self):
        final = {
            "id": "response",
            "status": "completed",
            "output": [
                {"type": "reasoning", "summary": "hidden"},
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "public answer"}],
                },
                {"type": "function_call", "name": "tool", "arguments": "hidden"},
            ],
        }
        for separator in ("data:", "data: "):
            events = (
                "event: response.reasoning_text.delta\n"
                + separator
                + '{"delta":"hidden"}\n\nevent: response.completed\n'
                + separator
                + json.dumps({"response": final})
            )
            result = GATEWAY.response_content({"sse_events": events}, TOKEN)
            self.assertEqual(result["messages"], [{"role": "assistant", "text": ["public answer"]}])
            self.assertEqual(result["tool_names"], ["tool"])
            self.assertNotIn("hidden", json.dumps(result))

    def test_chat_and_anthropic_public_responses(self):
        for body in [
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "answer",
                            "reasoning_content": "hidden",
                        }
                    }
                ]
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "hidden"},
                    {"type": "text", "text": "answer"},
                ],
            },
        ]:
            result = GATEWAY.response_content({"response_body": json.dumps(body)}, TOKEN)
            self.assertEqual(result["messages"], [{"role": "assistant", "text": ["answer"]}])
            self.assertNotIn("hidden", json.dumps(result))

    def test_incomplete_content_never_returns_raw_text(self):
        for projector, values in [
            (GATEWAY.request_content, ("truncated " + TOKEN, TOKEN)),
            (
                GATEWAY.response_content,
                (
                    {"sse_events": 'event: response.reasoning_text.delta\ndata:{"delta":"hidden"}'},
                    TOKEN,
                ),
            ),
        ]:
            result = GATEWAY.content_result(projector, *values)
            self.assertFalse(result["available"])
            self.assertNotIn(TOKEN, json.dumps(result))
            self.assertNotIn("hidden", json.dumps(result))

    def test_cli_failure_does_not_echo_stdin_or_exception(self):
        args = [
            "gateway.py",
            "--base-url",
            BASE,
            "--session",
            SESSION,
            "--start",
            START,
            "--end",
            END,
        ]
        output, errors = io.StringIO(), io.StringIO()
        with (
            mock.patch("sys.argv", args),
            mock.patch("sys.stdin", io.StringIO(TOKEN + "\n")),
            mock.patch("sys.stdout", output),
            mock.patch("sys.stderr", errors),
            mock.patch.object(GATEWAY, "query", side_effect=RuntimeError(TOKEN)),
        ):
            self.assertEqual(GATEWAY.main(), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn(TOKEN, errors.getvalue())

    def test_error_body_is_not_reported_as_a_public_answer(self):
        result = GATEWAY.content_result(
            GATEWAY.response_content,
            {"response_body": json.dumps({"error": {"message": TOKEN}})},
            TOKEN,
        )
        self.assertFalse(result["available"])
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_windows_stdin_and_timestamp_formats(self):
        self.assertEqual(GATEWAY.read_token(io.StringIO(TOKEN + "\r\n")), TOKEN)
        self.assertEqual(
            GATEWAY.parse_time("2026-10-08T17:50:00+08:00"),
            GATEWAY.parse_time("2026-10-08T09:50:00Z"),
        )


if __name__ == "__main__":
    unittest.main()
