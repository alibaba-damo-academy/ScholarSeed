"""Local MCP protocol fixture; not a product acceptance server."""

from __future__ import annotations

import json
import sys

PROTOCOL_VERSION = "2024-11-05"
TOOL_NAME = "revision"
SERVER_NAME = "projection-contract"
SERVER_VERSION = "1"
METHOD_INITIALIZE = "initialize"
METHOD_TOOLS_LIST = "tools/list"
METHOD_TOOLS_CALL = "tools/call"
METHOD_RESOURCES_LIST = "resources/list"
METHOD_TEMPLATES_LIST = "resources/templates/list"
METHOD_PROMPTS_LIST = "prompts/list"


def main() -> None:
    revision = sys.argv[1]
    responses = {
        METHOD_INITIALIZE: {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        },
        METHOD_TOOLS_LIST: {"tools": [{"name": TOOL_NAME, "inputSchema": {"type": "object"}}]},
        METHOD_TOOLS_CALL: {"content": [{"type": "text", "text": revision}]},
        METHOD_RESOURCES_LIST: {"resources": []},
        METHOD_TEMPLATES_LIST: {"resourceTemplates": []},
        METHOD_PROMPTS_LIST: {"prompts": []},
    }
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        response = {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": responses.get(request["method"], {}),
        }
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
