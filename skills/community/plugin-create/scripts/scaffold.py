"""Create an editable display-only OpenUI plugin."""

from __future__ import annotations

import argparse
import json
from importlib.metadata import version
from pathlib import Path
from typing import Any

from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR, PluginDescriptor

TEMPLATE = Path(__file__).resolve().parent.parent / "templates" / "comparison.json"
REQUESTS = "requests"


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("comparison",))
    parser.add_argument("destination", type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--host", default=f"=={version('scholarseed')}")
    args = parser.parse_args()
    template = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    component = template["component"]
    slot = f"{args.name}.{component['id']}"
    component["slot"] = slot
    descriptor = {
        "schema": 2,
        "id": args.name,
        "version": args.version,
        "host": args.host,
        "skill": "SKILL.md",
        "capabilities": [],
        "components": [component],
    }
    PluginDescriptor.model_validate(descriptor)
    args.destination.mkdir(parents=True, exist_ok=False)
    write_json(args.destination / PLUGIN_DESCRIPTOR, descriptor)
    write_json(args.destination / component["preview"], template["scenario"])
    (args.destination / REQUESTS).mkdir()
    write_json(
        args.destination / REQUESTS / "display.json",
        {
            "request_id": "comparison-result",
            "title": "Version comparison",
            "slot": slot,
            "data": template["scenario"]["data"],
        },
    )
    (args.destination / "SKILL.md").write_text(
        f'---\nname: {args.name}\nversion: "{args.version}"\n'
        "description: Compare two versions and present the verified changes.\n---\n\n"
        "Read the selected versions and verify each old and new value against its source. "
        "Keep missing values and unverified sources explicit.\n\n"
        "Read [the display request](requests/display.json). Replace all example data "
        "with the current comparison and assign a fresh request_id for each result. "
        "Keep columns aligned, then publish through "
        "`scholarseed_bridge` → `component/display`. Send only business data in `data`; "
        "do not send layout, source code, or a schema. Do not publish the example as a finding.\n",
        encoding="utf-8",
    )
    print(json.dumps({"source": str(args.destination), "ready_for_delivery": False}))


if __name__ == "__main__":
    main()
