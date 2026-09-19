"""Deterministic generated-image finishing, adapted from the supplied survey workflow.

Always crop vertical background margins, then stamp the publisher watermark.
No model requests, semantic review, or per-image disable switches.
"""
from __future__ import annotations
from pathlib import Path
from branding import IMAGE_WATERMARK

TRIM_THRESHOLD = 245
TRIM_PADDING = 8
BG_TOLERANCE = 28
WATERMARK_MARGIN = 10


def check_available():
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    ImageFont.load_default()


def _detect_background_color(flat) -> "tuple[int, int, int] | None":
    """Infer a uniform solid background color from a flattened RGB image.

    Scans inward from the top edge and from the bottom edge, counting how many
    consecutive rows are (a) internally uniform within ``BG_TOLERANCE`` and
    (b) the same color as that side's first row. A real background margin shows
    up as a band of several identical rows; a single edge row that merely happens
    to touch content does not. The background is accepted only when such a band
    is at least ``_MIN_BG_ROWS`` rows deep, and the color of the deeper band is
    returned. Otherwise ``None`` — callers should not trust a detected background.
    """
    from PIL import ImageStat  # type: ignore

    _MIN_BG_ROWS = 2
    w, h = flat.size
    if w == 0 or h == 0:
        return None

    def _row_color(y: int) -> "tuple[int, int, int] | None":
        row = flat.crop((0, y, w, y + 1))
        ext = row.getextrema()  # ((rmin,rmax),(gmin,gmax),(bmin,bmax))
        if max(hi - lo for lo, hi in ext) > BG_TOLERANCE:
            return None  # row is not internally uniform
        m = ImageStat.Stat(row).mean
        return (round(m[0]), round(m[1]), round(m[2]))

    def _band(ys) -> "tuple[tuple[int, int, int] | None, int]":
        first = _row_color(ys[0])
        if first is None:
            return None, 0
        count = 1
        for y in ys[1:]:
            c = _row_color(y)
            if c is None or max(abs(a - b) for a, b in zip(c, first)) > BG_TOLERANCE:
                break
            count += 1
        return first, count

    top_color, top_n = _band(range(0, h))
    bot_color, bot_n = _band(range(h - 1, -1, -1))

    if top_n >= _MIN_BG_ROWS and top_n >= bot_n:
        return top_color
    if bot_n >= _MIN_BG_ROWS:
        return bot_color
    return None


def _content_mask_from_bg(flat, bg: tuple[int, int, int]):
    """Build a content mask (255=content, 0=background) by per-pixel color
    distance from ``bg``. A pixel is content when its max per-channel absolute
    difference from ``bg`` exceeds ``BG_TOLERANCE``."""
    from PIL import Image, ImageChops  # type: ignore

    diff = ImageChops.difference(flat, Image.new("RGB", flat.size, bg))
    r, g, b = diff.split()
    max_chan = ImageChops.lighter(ImageChops.lighter(r, g), b)
    return max_chan.point(lambda p: 255 if p > BG_TOLERANCE else 0)


def _trim_whitespace(png_bytes: bytes) -> tuple[bytes, str, str]:
    """Crop near-background top/bottom borders from a PNG.

    Only the vertical (top and bottom) margins are cropped; the full original
    width is always preserved. Left/right borders are never trimmed.

    Returns ``(bytes, status, reason)``. ``bytes`` is the cropped PNG on
    success and the original bytes on every other branch. ``status`` is one
    of:

        ok           — crop applied
        noop         — content already spans >= 98% of the frame height
        pil_missing  — Pillow not importable (caller blocks successful integration)
        bbox_none    — entire image registered as background (suspicious)
        error        — PIL raised an exception during crop

    Callers should treat ``pil_missing``, ``bbox_none``, and ``error`` as
    trim failures worth surfacing.
    """
    try:
        from io import BytesIO
        from PIL import Image, ImageOps  # type: ignore
    except ImportError as e:
        return png_bytes, "pil_missing", f"Pillow not installed: {e}"
    try:
        with Image.open(BytesIO(png_bytes)) as im:
            im.load()
            original_mode = im.mode
            if original_mode in ("RGBA", "LA") or (
                original_mode == "P" and "transparency" in im.info
            ):
                rgba = im.convert("RGBA")
                bg = Image.new("RGB", rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.split()[-1])
                flat = bg
            else:
                flat = im.convert("RGB")

            bg = _detect_background_color(flat)
            if bg is None or all(c >= TRIM_THRESHOLD for c in bg):
                # White / undetectable background: keep the original brightness
                # path so existing near-white outputs are unchanged.
                gray = ImageOps.grayscale(flat)
                mask = gray.point(lambda p: 0 if p >= TRIM_THRESHOLD else 255)
            else:
                # Uniform non-white background: trim by color distance from it.
                mask = _content_mask_from_bg(flat, bg)
            bbox = mask.getbbox()
            w, h = flat.size
            if bbox is None:
                return png_bytes, "bbox_none", "image is entirely background"
            # Only the vertical extent matters — width is always kept in full.
            height_ratio = (bbox[3] - bbox[1]) / float(h)
            if height_ratio >= 0.98:
                return png_bytes, "noop", f"height_ratio={height_ratio:.3f} >= 0.98"

            pad = max(0, TRIM_PADDING)
            y0 = max(0, bbox[1] - pad)
            y1 = min(h, bbox[3] + pad)
            cropped = flat.crop((0, y0, w, y1))  # full width, trim top/bottom only

            out = BytesIO()
            cropped.save(out, format="PNG", optimize=True)
            return out.getvalue(), "ok", ""
    except Exception as e:  # noqa: BLE001
        return png_bytes, "error", f"{type(e).__name__}: {e}"


def _add_watermark(png_bytes: bytes, text: str) -> tuple[bytes, str, str]:
    """Stamp ``text`` at the bottom-right corner of a PNG.

    If the watermark's target rect contains non-white pixels the canvas is
    extended downward with a white strip before drawing, preserving content.

    Returns ``(bytes, status, reason)``:

        ok           — watermark applied without padding
        padded       — canvas extended downward before drawing
        pil_missing  — Pillow not importable
        error        — an exception was raised (original bytes returned)
    """
    try:
        from io import BytesIO
        from PIL import Image, ImageDraw, ImageFont, ImageOps  # type: ignore
    except ImportError as e:
        return png_bytes, "pil_missing", f"Pillow not installed: {e}"
    try:
        with Image.open(BytesIO(png_bytes)) as im:
            im.load()
            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                rgba = im.convert("RGBA")
                bg = Image.new("RGB", rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.split()[-1])
                flat = bg
            else:
                flat = im.convert("RGB")

        _font_size = 18
        _font_candidates = [
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
            "C:/Windows/Fonts/msyh.ttc",
            "/System/Library/Fonts/Helvetica.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
        font = None
        for fp in _font_candidates:
            try:
                font = ImageFont.truetype(fp, _font_size)
                break
            except Exception:
                continue
        if font is None:
            font = ImageFont.load_default()

        draw_probe = ImageDraw.Draw(flat)
        try:
            tb = draw_probe.textbbox((0, 0), text, font=font)
            text_w, text_h = tb[2] - tb[0], tb[3] - tb[1]
        except AttributeError:
            text_w, text_h = font.getsize(text)  # type: ignore[attr-defined]

        if text_w + 2 * WATERMARK_MARGIN > flat.width:
            # Preserve the image width even for small imported raster assets.
            for point_size in range(_font_size - 1, 5, -1):
                try: font = ImageFont.truetype(font.path, point_size)
                except (AttributeError, OSError): font = ImageFont.load_default(size=point_size)
                tb = draw_probe.textbbox((0, 0), text, font=font)
                text_w, text_h = tb[2]-tb[0], tb[3]-tb[1]
                if text_w + 2 * WATERMARK_MARGIN <= flat.width: break
            if text_w + 2 * WATERMARK_MARGIN > flat.width:
                raise ValueError('image too narrow for a readable watermark without changing its width')

        # Detect a uniform background so padding and the collision check work on
        # non-white images. White / undetectable backgrounds fall through to the
        # original brightness path so existing outputs stay byte-for-byte identical.
        bg_detected = _detect_background_color(flat)
        white_bg = bg_detected is None or all(c >= TRIM_THRESHOLD for c in bg_detected)
        bg = bg_detected or (255, 255, 255)

        m = max(0, WATERMARK_MARGIN)
        w, h = flat.size
        wx0 = max(0, w - text_w - m)
        wy0 = max(0, h - text_h - m)

        region = flat.crop((wx0, wy0, w, h))
        has_region = region.size[0] * region.size[1] > 0
        if white_bg:
            gray_r = ImageOps.grayscale(region)
            min_px = gray_r.getextrema()[0] if has_region else 255
            padded = min_px < TRIM_THRESHOLD
            pad_fill = (255, 255, 255)
            text_fill = (150, 150, 150)
        else:
            if has_region:
                from PIL import ImageChops  # type: ignore
                diff = ImageChops.difference(region, Image.new("RGB", region.size, bg))
                r_, g_, b_ = diff.split()
                max_chan = ImageChops.lighter(ImageChops.lighter(r_, g_), b_)
                max_dist = max_chan.getextrema()[1]
            else:
                max_dist = 0
            # Content sits under the watermark only if some pixel differs from bg.
            padded = max_dist > BG_TOLERANCE
            pad_fill = bg
            # Pick text color for contrast against the background luminance.
            lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
            text_fill = (210, 210, 210) if lum < 128 else (150, 150, 150)

        if padded:
            pad_h = text_h + 2 * m
            canvas = Image.new("RGB", (w, h + pad_h), pad_fill)
            canvas.paste(flat, (0, 0))
            flat = canvas
            h = h + pad_h
            wy0 = h - text_h - m

        draw = ImageDraw.Draw(flat)
        draw.text((w - text_w - m - tb[0], wy0 - tb[1]), text, fill=text_fill, font=font)

        out = BytesIO()
        flat.save(out, format="PNG", optimize=True)
        return out.getvalue(), "padded" if padded else "ok", ""
    except Exception as e:  # noqa: BLE001
        return png_bytes, "error", f"{type(e).__name__}: {e}"
