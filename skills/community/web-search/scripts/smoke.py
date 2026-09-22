#!/usr/bin/env scholarseed-skill-python
"""Run a real credential-safe smoke test against the official search API."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import http.client
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

import official

SUCCESS_STATUSES = frozenset({official.STATUS_COMPLETED, official.STATUS_EMPTY})
EXIT_SUCCESS = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2
EXIT_INTERRUPTED = 130
API_KEY_PROMPT = "SCHOLARSEED_API_KEY: "
REDACTED_VALUE = "<redacted>"
DEBUG_BODY_PREVIEW_CHARACTERS = 1_000
DEBUG_RESPONSE_HEADERS = frozenset(
    {
        "content-length",
        "content-type",
        "date",
        "eagleeye-traceid",
        "location",
        "server",
        "traceparent",
        "x-ca-request-id",
        "x-request-id",
        "x-trace-id",
    }
)
MISSING_CREDENTIAL_MESSAGE = (
    "SCHOLARSEED_API_KEY is missing. Export it or run this script in an interactive terminal."
)


@dataclass
class SmokeDiagnostics:
    request_method: str = ""
    request_path: str = ""
    request_body_bytes: int = 0
    authorization_present: bool = False
    response_status: int | None = None
    response_reason: str = ""
    response_headers: dict[str, str] = field(default_factory=dict)
    response_body: bytes = b""
    transport_stage: str = ""
    transport_error_type: str = ""
    transport_error_message: str = ""


class DiagnosticResponse:
    def __init__(self, response: Any, diagnostics: SmokeDiagnostics) -> None:
        self._response = response
        self._diagnostics = diagnostics
        self.status = response.status

    def read(self, amount: int) -> bytes:
        try:
            raw = self._response.read(amount)
        except Exception as error:
            _record_transport_error(self._diagnostics, "response.read", error)
            raise
        self._diagnostics.response_body = raw
        return raw


class DiagnosticConnection:
    def __init__(self, connection: Any, diagnostics: SmokeDiagnostics) -> None:
        self._connection = connection
        self._diagnostics = diagnostics

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes,
        headers: Mapping[str, str],
    ) -> None:
        self._diagnostics.request_method = method
        self._diagnostics.request_path = path
        self._diagnostics.request_body_bytes = len(body)
        self._diagnostics.authorization_present = any(
            name.casefold() == "authorization" and bool(value.strip())
            for name, value in headers.items()
        )
        try:
            self._connection.request(method, path, body=body, headers=dict(headers))
        except Exception as error:
            _record_transport_error(self._diagnostics, "connection.request", error)
            raise

    def getresponse(self) -> DiagnosticResponse:
        try:
            response = self._connection.getresponse()
        except Exception as error:
            _record_transport_error(self._diagnostics, "connection.getresponse", error)
            raise
        self._diagnostics.response_status = response.status
        self._diagnostics.response_reason = str(getattr(response, "reason", "") or "")
        getheaders = getattr(response, "getheaders", None)
        if callable(getheaders):
            self._diagnostics.response_headers = {
                str(name).casefold(): str(value)
                for name, value in getheaders()
                if str(name).casefold() in DEBUG_RESPONSE_HEADERS
            }
        return DiagnosticResponse(response, self._diagnostics)

    def close(self) -> None:
        self._connection.close()


def _record_transport_error(diagnostics: SmokeDiagnostics, stage: str, error: Exception) -> None:
    diagnostics.transport_stage = stage
    diagnostics.transport_error_type = type(error).__name__
    diagnostics.transport_error_message = str(error)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Smoke-test the official ScholarSeed web-search API without printing its key."
    )
    parser.add_argument("--query", required=True, help="Public-web search query.")
    parser.add_argument("--limit", type=official.bounded_integer, default=official.DEFAULT_LIMIT)
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Print credential-redacted HTTP and response diagnostics to stderr.",
    )
    return parser.parse_args(argv)


def _api_key(
    environment: Mapping[str, str],
    *,
    interactive: bool,
    prompt: Callable[[str], str],
) -> str:
    api_key = environment.get(official.API_KEY_ENVIRONMENT, "").strip()
    if api_key or not interactive:
        return api_key
    return prompt(API_KEY_PROMPT).strip()


def _redact(value: str, api_key: str) -> str:
    return value.replace(api_key, REDACTED_VALUE) if api_key else value


def _redact_structure(value: Any, api_key: str) -> Any:
    if isinstance(value, str):
        return _redact(value, api_key)
    if isinstance(value, Mapping):
        return {str(key): _redact_structure(item, api_key) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_structure(item, api_key) for item in value]
    return value


def _response_summary(raw: bytes, api_key: str) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "body_bytes": len(raw),
        "body_sha256": hashlib.sha256(raw).hexdigest(),
    }
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        summary["utf8"] = False
        return summary
    summary["utf8"] = True
    summary["body_preview"] = _redact(text[:DEBUG_BODY_PREVIEW_CHARACTERS], api_key)
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        summary["json"] = False
        return summary
    summary["json"] = True
    summary["json_type"] = type(decoded).__name__
    if isinstance(decoded, Mapping):
        summary["top_level_keys"] = sorted(str(key) for key in decoded)
        if "success" in decoded:
            summary["success"] = decoded["success"]
        data = decoded.get("data")
        summary["data_type"] = type(data).__name__
        if isinstance(data, list):
            summary["data_items"] = len(data)
        elif isinstance(data, Mapping):
            summary["data_keys"] = sorted(str(key) for key in data)
    return summary


def _debug_payload(diagnostics: SmokeDiagnostics, api_key: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "endpoint": official.API_URL,
        "request": {
            "method": diagnostics.request_method,
            "path": diagnostics.request_path,
            "body_bytes": diagnostics.request_body_bytes,
            "authorization_present": diagnostics.authorization_present,
        },
        "response": {
            "status": diagnostics.response_status,
            "reason": diagnostics.response_reason,
            "headers": diagnostics.response_headers,
            **_response_summary(diagnostics.response_body, api_key),
        },
    }
    if diagnostics.transport_error_type:
        payload["transport_error"] = {
            "stage": diagnostics.transport_stage,
            "type": diagnostics.transport_error_type,
            "message": _redact(diagnostics.transport_error_message, api_key),
        }
    return payload


def main(
    argv: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    interactive: bool | None = None,
    prompt: Callable[[str], str] = getpass.getpass,
    connection_factory: Callable[..., http.client.HTTPConnection] = http.client.HTTPSConnection,
) -> int:
    args = parse_args(argv)
    source = os.environ if environment is None else environment
    can_prompt = sys.stdin.isatty() if interactive is None else interactive
    try:
        api_key = _api_key(source, interactive=can_prompt, prompt=prompt)
    except (EOFError, KeyboardInterrupt):
        print("Credential input interrupted.", file=sys.stderr)
        return EXIT_INTERRUPTED
    if not api_key:
        print(MISSING_CREDENTIAL_MESSAGE, file=sys.stderr)
        return EXIT_USAGE

    search_args = official.parse_args(["--query", args.query, "--limit", str(args.limit)])
    diagnostics = SmokeDiagnostics()
    if args.debug:
        payload, exit_code = official.search(
            search_args,
            environment={official.API_KEY_ENVIRONMENT: api_key},
            connection_factory=lambda host, timeout: DiagnosticConnection(
                connection_factory(host, timeout=timeout), diagnostics
            ),
        )
        print(
            json.dumps(
                {"smoke_debug": _redact_structure(_debug_payload(diagnostics, api_key), api_key)},
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
    else:
        payload, exit_code = official.search(
            search_args,
            environment={official.API_KEY_ENVIRONMENT: api_key},
        )
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    if exit_code != EXIT_SUCCESS:
        return exit_code
    return EXIT_SUCCESS if payload.get("status") in SUCCESS_STATUSES else EXIT_FAILURE


if __name__ == "__main__":
    raise SystemExit(main())
