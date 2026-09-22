"""Recover named Type1 glyphs from the document's own encoding, without OCR."""

from __future__ import annotations

import json
from importlib.resources import read_text
from io import BytesIO

from pdfminer.pdffont import PDFType1Font, Type1FontHeaderParser
from pdfminer.pdfinterp import PDFResourceManager
from pdfminer.psparser import PSEOF

GLYPH_REGISTRY = json.loads(read_text(__package__, "fonts.json", encoding="utf-8"))["glyphs"]
FONT_ENCODING_KEY = "Encoding"


def named_encoding(data: bytes) -> dict[int, str]:
    """Use the PostScript tokenizer, never infer a character from a numeric CID."""
    parser = Type1FontHeaderParser(BytesIO(data))
    result: dict[int, str] = {}
    while True:
        try:
            cid, name = parser.nextobject()
        except PSEOF:
            return result
        if name in GLYPH_REGISTRY:
            result[cid] = GLYPH_REGISTRY[name]


class GlyphResourceManager(PDFResourceManager):
    """Fill only unresolved embedded Type1 names; ToUnicode remains authoritative."""

    def __init__(self) -> None:
        super().__init__()
        self._reviewed: set[object] = set()

    def get_font(self, objid, spec):
        font = super().get_font(objid, spec)
        if font in self._reviewed:
            return font
        self._reviewed.add(font)
        if (
            isinstance(font, PDFType1Font)
            and FONT_ENCODING_KEY not in spec
            and hasattr(font, "fontfile")
        ):
            for cid, value in named_encoding(
                font.fontfile.get_data()[: font.fontfile["Length1"]]
            ).items():
                font.cid2unicode.setdefault(cid, value)
        return font
