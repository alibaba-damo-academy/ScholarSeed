#!/usr/bin/env scholarseed-skill-python
"""Create a bounded RGB PNG, compositing transparency on white."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-edge", type=int, default=2400)
    args = parser.parse_args()
    source = args.input.resolve(strict=True)
    image = Image.open(source)
    had_alpha = image.mode in {"RGBA", "LA"} or "transparency" in image.info
    if had_alpha:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, rgba).convert("RGB")
    else:
        image = image.convert("RGB")
    if max(image.size) > args.max_edge:
        image.thumbnail((args.max_edge, args.max_edge), Image.Resampling.LANCZOS)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output, format="PNG", optimize=True)
    print(
        json.dumps(
            {
                "input": str(source),
                "output": str(args.output),
                "width": image.width,
                "height": image.height,
                "alpha_composited": had_alpha,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
