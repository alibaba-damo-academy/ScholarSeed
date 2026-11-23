"""Deterministic native context-policy contract; this is not product acceptance."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from scholarseed_codex.executable import _resolve_launch_arguments
from scholarseed_codex.isolation import managed_codex_launch
from tests.integration.appserver import AppServer

CONTEXT_WINDOW = 8192
BASELINE_INPUT = 6000
BASELINE_OUTPUT = 500
PARTIAL_OUTPUT = 4000
PARTIAL_TEXT = "word " * PARTIAL_OUTPUT


def verify_native_context_policy() -> None:
    executable = os.environ.get("SCHOLARSEED_CODEX_EXECUTABLE") or shutil.which("codex")
    if not executable:
        raise RuntimeError("Codex binary is required for the context contract")

    for truncated in (False, True):
        requests: list[dict] = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

            def do_POST(self) -> None:
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                index = len(requests)
                incomplete = truncated and index == 2
                text = PARTIAL_TEXT if incomplete else "context contract response"
                if index == 1:
                    input_tokens = BASELINE_INPUT if truncated else CONTEXT_WINDOW
                    output_tokens = BASELINE_OUTPUT
                elif incomplete:
                    input_tokens, output_tokens = BASELINE_INPUT, PARTIAL_OUTPUT
                else:
                    input_tokens, output_tokens = 100, 10
                response = {
                    "id": f"response_{index}",
                    "status": "incomplete" if incomplete else "completed",
                    "usage": {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "total_tokens": input_tokens + output_tokens,
                    },
                }
                if incomplete:
                    response["incomplete_details"] = {"reason": "max_output_tokens"}
                events = [
                    {"type": "response.created", "response": {"id": response["id"]}},
                    {
                        "type": "response.output_item.done",
                        "item": {
                            "type": "message",
                            "id": f"message_{index}",
                            "role": "assistant",
                            "status": "completed",
                            "content": [{"type": "output_text", "text": text}],
                        },
                    },
                    {
                        "type": "response.incomplete" if incomplete else "response.completed",
                        "response": response,
                    },
                ]
                body = "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        endpoint = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=endpoint.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                environment, arguments = managed_codex_launch(
                    root / "runtime",
                    {},
                    (),
                    inherited_environment={
                        "HOME": str(root / "user"),
                        "PATH": os.environ.get("PATH", ""),
                    },
                )
                server = AppServer(
                    executable, root, environment, _resolve_launch_arguments(arguments, environment)
                )
                try:
                    server.request(
                        "initialize",
                        {
                            "clientInfo": {"name": "context-contract", "version": "1"},
                            "capabilities": {"experimentalApi": True},
                        },
                    )
                    server.notify("initialized", {})
                    result = server.request(
                        "thread/start",
                        {
                            "model": "gpt-5",
                            "modelProvider": "fixture",
                            "cwd": str(root),
                            "baseInstructions": "Reply without calling tools.",
                            "approvalPolicy": "never",
                            "sandbox": "read-only",
                            "config": {
                                "model_context_window": CONTEXT_WINDOW,
                                "model_providers": {
                                    "fixture": {
                                        "name": "fixture",
                                        "wire_api": "responses",
                                        "base_url": f"http://127.0.0.1:{endpoint.server_port}/v1",
                                        "requires_openai_auth": False,
                                        "stream_max_retries": 0,
                                    }
                                },
                            },
                        },
                    )
                    thread_id = result["thread"]["id"]

                    def turn() -> dict:
                        server.request(
                            "turn/start",
                            {
                                "threadId": thread_id,
                                "input": [
                                    {"type": "text", "text": "Continue.", "text_elements": []},
                                ],
                            },
                        )
                        return server.wait_notification("turn/completed")["params"]["turn"]

                    assert turn()["status"] == "completed"
                    if truncated:
                        failed = turn()
                        assert failed["status"] == "failed", failed
                        assert "max_output_tokens" in json.dumps(failed), failed
                        assert not any(
                            event.get("params", {}).get("item", {}).get("type")
                            == "contextCompaction"
                            for event in server.notifications
                        ), "baseline unexpectedly compacted"
                    server.notifications.clear()
                    assert turn()["status"] == "completed"
                    checkpoints = [
                        event
                        for event in server.notifications
                        if event.get("method") == "item/completed"
                        and event.get("params", {}).get("item", {}).get("type")
                        == "contextCompaction"
                    ]
                    assert len(checkpoints) == 1, (truncated, checkpoints)
                    assert len(requests) == (4 if truncated else 3), len(requests)
                    print(
                        "  ✓ native context threshold compacts after "
                        + ("truncated" if truncated else "successful")
                        + " output"
                    )
                finally:
                    server.close()
        finally:
            endpoint.shutdown()
            endpoint.server_close()
            worker.join()
