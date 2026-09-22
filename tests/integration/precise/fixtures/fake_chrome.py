#!/usr/bin/env python3
"""Owned local CDP test process. No external network or real browser access."""

import json
import os
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

profile = Path(next(arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--user-data-dir=")))
profile.mkdir(parents=True, exist_ok=True)
identity = "/devtools/browser/" + uuid.uuid4().hex
pages = [{"type": "page", "url": os.getenv("PAPER_DL_TEST_CHROME_START_URL", "about:blank")}]


class Handler(BaseHTTPRequestHandler):
    def reply(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/json/version":
            self.reply(
                {
                    "Browser": "Fake Chrome",
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.server.server_port}{identity}",
                }
            )
        elif self.path == "/json/list":
            self.reply(pages)
        else:
            self.send_error(404)

    def do_PUT(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/json/new":
            pages.append({"type": "page", "url": unquote(parsed.query)})
            (profile / "opened-urls.json").write_text(json.dumps([p["url"] for p in pages[1:]]))
            self.reply({"id": str(len(pages))})
        else:
            self.send_error(404)

    def log_message(self, *_):
        pass


port = int(
    next(arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--remote-debugging-port="))
)
if not port:
    raise SystemExit("Pool Chrome must use an explicit nonzero port")
server = HTTPServer(("127.0.0.1", port), Handler)
print(
    f"DevTools listening on ws://127.0.0.1:{server.server_port}{identity}",
    file=sys.stderr,
    flush=True,
)
server.serve_forever()
