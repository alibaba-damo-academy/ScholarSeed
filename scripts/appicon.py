#!/usr/bin/env python3
"""Render the ScholarSeed desktop icons from the product brand mark.

The renderer mirrors the in-app BrandMark: a deep-green squircle, an open book,
and a gold spark. Keeping one
script as the source means the packaged icon and the in-app mark cannot drift,
and replacing the artwork later is a single edit here (or drop a finished
icon.png next to the output and re-run with --from-png).

Usage:
    .venv/bin/python scripts/appicon.py            # regenerate icon.icns
    .venv/bin/python scripts/appicon.py --from-png final.png
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

REPO_ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = REPO_ROOT / "apps" / "desktop" / "resources"
ICONSET_DIR = ICON_DIR / "icon.iconset"
ICNS_PATH = ICON_DIR / "icon.icns"
MASTER_PNG = ICON_DIR / "icon.png"

CANVAS = 1024
# macOS draws its own drop shadow, so the artwork keeps a margin instead of
# bleeding to the canvas edge.
MARGIN = 96
CORNER_RADIUS = 208

BRAND_INK = (34, 69, 58, 255)  # --brand-ink
BRAND_SPARK = (242, 193, 78, 255)  # --brand-spark
PAGE_LIGHT = (255, 255, 255, 245)
PAGE_DIM = (255, 255, 255, 190)

# Apple's required icns members: (pixel size, iconset filename).
ICONSET_MEMBERS = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]


def draw_star(draw: ImageDraw.ImageDraw, cx: float, cy: float, outer: float, inner: float) -> None:
    """A four-point spark, matching the mark's gold accent."""
    draw.polygon(
        [
            (cx, cy - outer),
            (cx + inner, cy - inner),
            (cx + outer, cy),
            (cx + inner, cy + inner),
            (cx, cy + outer),
            (cx - inner, cy + inner),
            (cx - outer, cy),
            (cx - inner, cy - inner),
        ],
        fill=BRAND_SPARK,
    )


def render_master() -> Image.Image:
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        [(MARGIN, MARGIN), (CANVAS - MARGIN, CANVAS - MARGIN)],
        radius=CORNER_RADIUS,
        fill=BRAND_INK,
    )

    # Open book: two leaves with a gutter, the right leaf slightly dimmed so the
    # spine reads even at 16px.
    spine_x = CANVAS / 2
    top_y = CANVAS * 0.335
    bottom_y = CANVAS * 0.675
    leaf_outer = CANVAS * 0.175
    gutter = CANVAS * 0.017
    lift = CANVAS * 0.032

    draw.polygon(
        [
            (spine_x - gutter, top_y),
            (spine_x - gutter, bottom_y),
            (spine_x - leaf_outer, bottom_y + lift),
            (spine_x - leaf_outer, top_y + lift),
        ],
        fill=PAGE_LIGHT,
    )
    draw.polygon(
        [
            (spine_x + gutter, top_y),
            (spine_x + gutter, bottom_y),
            (spine_x + leaf_outer, bottom_y + lift),
            (spine_x + leaf_outer, top_y + lift),
        ],
        fill=PAGE_DIM,
    )

    draw_star(draw, CANVAS * 0.695, CANVAS * 0.665, CANVAS * 0.083, CANVAS * 0.03)
    return image


def build_icns(master: Image.Image) -> None:
    if ICONSET_DIR.exists():
        shutil.rmtree(ICONSET_DIR)
    ICONSET_DIR.mkdir(parents=True)

    for size, name in ICONSET_MEMBERS:
        master.resize((size, size), Image.Resampling.LANCZOS).save(ICONSET_DIR / name)

    subprocess.run(
        ["iconutil", "--convert", "icns", str(ICONSET_DIR), "--output", str(ICNS_PATH)],
        check=True,
    )
    shutil.rmtree(ICONSET_DIR)


def fit_master(source: Image.Image) -> Image.Image:
    """Fit supplied artwork onto the square icon canvas without distortion."""
    artwork = ImageOps.contain(source.convert("RGBA"), (CANVAS, CANVAS), Image.Resampling.LANCZOS)
    master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = ((CANVAS - artwork.width) // 2, (CANVAS - artwork.height) // 2)
    master.alpha_composite(artwork, offset)
    return master


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--from-png",
        type=Path,
        help="Use a finished 1024x1024 PNG instead of rendering the brand mark.",
    )
    args = parser.parse_args()

    if args.from_png:
        if not args.from_png.is_file():
            print(f"[appicon] ERROR source not found: {args.from_png}", file=sys.stderr)
            return 1
        master = fit_master(Image.open(args.from_png))
    else:
        master = render_master()

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    master.save(MASTER_PNG)
    build_icns(master)
    print(f"[appicon] wrote {MASTER_PNG.relative_to(REPO_ROOT)}")
    print(f"[appicon] wrote {ICNS_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
