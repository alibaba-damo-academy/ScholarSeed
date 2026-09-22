"""Permissively licensed PDF fixtures shared by Serve contract tests."""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any

import pypdfium2
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject, RectangleObject
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas

DEFAULT_PAGE_WIDTH = 600.0
DEFAULT_PAGE_HEIGHT = 800.0
DEFAULT_FONT_SIZE = 11.0
DEFAULT_FONT = "Helvetica"
CJK_FONT = "STSong-Light"
LINK_URI = "uri"
PDF_ENCRYPT_AES_256 = "AES-256"
csRGB = "RGB"

pdfmetrics.registerFont(UnicodeCIDFont(CJK_FONT))


@dataclass(frozen=True)
class Rect:
    x0: float
    y0: float
    x1: float
    y1: float

    def __init__(self, *values: object):
        coordinates = values[0] if len(values) == 1 else values
        x0, y0, x1, y1 = coordinates  # type: ignore[misc]
        object.__setattr__(self, "x0", float(x0))
        object.__setattr__(self, "y0", float(y0))
        object.__setattr__(self, "x1", float(x1))
        object.__setattr__(self, "y1", float(y1))

    def __iter__(self):
        return iter((self.x0, self.y0, self.x1, self.y1))

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def get_area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)

    def __and__(self, other: Rect) -> Rect:
        return Rect(
            max(self.x0, other.x0),
            max(self.y0, other.y0),
            min(self.x1, other.x1),
            min(self.y1, other.y1),
        )

    def __or__(self, other: Rect) -> Rect:
        return Rect(
            min(self.x0, other.x0),
            min(self.y0, other.y0),
            max(self.x1, other.x1),
            max(self.y1, other.y1),
        )


@dataclass(frozen=True)
class TextFixture:
    x: float
    top: float
    text: str
    size: float = DEFAULT_FONT_SIZE


@dataclass(frozen=True)
class PageFixture:
    texts: tuple[TextFixture, ...] = ()
    width: float = DEFAULT_PAGE_WIDTH
    height: float = DEFAULT_PAGE_HEIGHT


@dataclass
class Pixmap:
    image: Image.Image

    def __init__(self, *values: object):
        if len(values) == 1:
            value = values[0]
            self.image = (
                value.copy() if isinstance(value, Image.Image) else Image.open(value).convert("RGB")
            )
            return
        _colorspace, bounds, _alpha = values
        x0, y0, x1, y1 = bounds  # type: ignore[misc]
        self.image = Image.new("RGB", (int(x1) - int(x0), int(y1) - int(y0)))

    def clear_with(self, value: int) -> None:
        self.image.paste((value, value, value), (0, 0, *self.image.size))

    def save(self, path: str | Path) -> None:
        self.image.save(path)

    def tobytes(self, format: str) -> bytes:
        stream = BytesIO()
        self.image.save(stream, format=format.upper())
        return stream.getvalue()


@dataclass
class _Operation:
    kind: str
    values: tuple[Any, ...]
    options: dict[str, Any] = field(default_factory=dict)


class FixturePage:
    def __init__(self, width: float, height: float):
        self.width = width
        self.height = height
        self.rotation = 0
        self.crop: Rect | None = None
        self.operations: list[_Operation] = []

    @property
    def rect(self) -> Rect:
        return Rect(0, 0, self.width, self.height)

    def insert_text(self, point, text, fontsize=DEFAULT_FONT_SIZE, **options) -> None:
        self.operations.append(
            _Operation("text", (point[0], point[1], str(text), fontsize), options)
        )

    def insert_textbox(self, bounds, text, fontsize=DEFAULT_FONT_SIZE, **_options) -> None:
        self.operations.append(_Operation("textbox", (Rect(bounds), str(text), fontsize)))

    def draw_rect(self, bounds, **_options) -> None:
        self.operations.append(_Operation("rect", (Rect(bounds),)))

    def draw_line(self, start, end, **_options) -> None:
        self.operations.append(_Operation("line", (start, end)))

    def insert_image(
        self,
        bounds,
        *,
        pixmap: Pixmap | None = None,
        stream: bytes | None = None,
        **_options,
    ) -> None:
        image = pixmap.image if pixmap is not None else Image.open(BytesIO(stream or b""))
        self.operations.append(_Operation("image", (Rect(bounds), image.copy())))

    def insert_link(self, link: dict[str, Any]) -> None:
        self.operations.append(_Operation("link", (Rect(link["from"]), str(link.get("uri") or ""))))

    def set_cropbox(self, bounds) -> None:
        self.crop = Rect(bounds)

    def set_rotation(self, rotation: int) -> None:
        self.rotation = rotation

    def show_pdf_page(self, _bounds, source: FixtureDocument, page_number: int) -> None:
        source_page = source.pages[page_number]
        self.operations.extend(deepcopy(source_page.operations))

    def get_pixmap(self) -> Pixmap:
        document = FixtureDocument()
        document.pages.append(deepcopy(self))
        with pypdfium2.PdfDocument(document.tobytes()) as pdf:
            image = pdf[0].render(scale=1).to_pil()
        return Pixmap(image)

    def search_for(self, needle: str) -> list[Rect]:
        results = []
        for operation in self.operations:
            if operation.kind == "text":
                x, top, text, size = operation.values
                for line_index, line in enumerate(text.splitlines()):
                    start = line.find(needle)
                    if start < 0:
                        continue
                    font = _font_name(line)
                    left = x + stringWidth(line[:start], font, size)
                    results.append(
                        Rect(
                            left,
                            top - size + line_index * size * 1.2,
                            left + stringWidth(needle, font, size),
                            top + 2 + line_index * size * 1.2,
                        )
                    )
            elif operation.kind == "textbox":
                bounds, text, size = operation.values
                start = text.find(needle)
                if start >= 0:
                    font = _font_name(text)
                    left = bounds.x0 + stringWidth(text[:start], font, size)
                    results.append(
                        Rect(
                            left,
                            bounds.y0,
                            left + stringWidth(needle, font, size),
                            bounds.y0 + size * 1.2,
                        )
                    )
        return results


class FixtureDocument:
    def __init__(self):
        self.pages: list[FixturePage] = []
        self.metadata: dict[str, str] = {}
        self.attachments: list[tuple[str, bytes]] = []
        self.xmp = ""

    def __enter__(self) -> FixtureDocument:
        return self

    def __exit__(self, *_args) -> None:
        self.close()

    def close(self) -> None:
        return None

    @property
    def page_count(self) -> int:
        return len(self.pages)

    def __getitem__(self, index: int) -> FixturePage:
        return self.pages[index]

    def new_page(
        self,
        *,
        width: float = DEFAULT_PAGE_WIDTH,
        height: float = DEFAULT_PAGE_HEIGHT,
    ) -> FixturePage:
        page = FixturePage(width, height)
        self.pages.append(page)
        return page

    def set_metadata(self, metadata: dict[str, str]) -> None:
        self.metadata = dict(metadata)

    def embfile_add(self, name: str, payload: bytes, **_options) -> None:
        self.attachments.append((name, payload))

    def set_xml_metadata(self, value: str) -> None:
        text = re.sub(r"<[^>]+>", " ", value).strip()
        self.xmp = (
            '<?xpacket begin=""?>'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about="">'
            + text.replace("&", "&amp;")
            + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
        )

    def tobytes(
        self,
        *,
        encryption: str | None = None,
        user_pw: str = "",
        owner_pw: str = "",
        **_options,
    ) -> bytes:
        stream = BytesIO()
        canvas = Canvas(stream)
        if self.metadata.get("title"):
            canvas.setTitle(self.metadata["title"])
        if self.metadata.get("author"):
            canvas.setAuthor(self.metadata["author"])
        if self.metadata.get("subject"):
            canvas.setSubject(self.metadata["subject"])
        if self.metadata.get("keywords"):
            canvas.setKeywords(self.metadata["keywords"])
        for page in self.pages:
            canvas.setPageSize((page.width, page.height))
            for operation in page.operations:
                _draw(canvas, page, operation)
            canvas.showPage()
        canvas.save()
        reader = PdfReader(BytesIO(stream.getvalue()))
        writer = PdfWriter()
        writer.clone_document_from_reader(reader)
        writer.add_metadata(
            {
                "/Title": self.metadata.get("title", ""),
                "/Author": self.metadata.get("author", ""),
                "/Subject": self.metadata.get("subject", ""),
                "/Keywords": self.metadata.get("keywords", ""),
            }
        )
        for index, page in enumerate(self.pages):
            target = writer.pages[index]
            if page.crop is not None:
                target.cropbox = RectangleObject(
                    (
                        page.crop.x0,
                        page.height - page.crop.y1,
                        page.crop.x1,
                        page.height - page.crop.y0,
                    )
                )
            if page.rotation:
                target.rotate(page.rotation)
        for name, payload in self.attachments:
            writer.add_attachment(name, payload)
        if self.xmp:
            metadata_stream = DecodedStreamObject()
            metadata_stream.set_data(self.xmp.encode("utf-8"))
            metadata_stream[NameObject("/Type")] = NameObject("/Metadata")
            metadata_stream[NameObject("/Subtype")] = NameObject("/XML")
            writer.root_object[NameObject("/Metadata")] = writer._add_object(metadata_stream)
        if encryption is not None:
            writer.encrypt(
                user_password=user_pw,
                owner_password=owner_pw or None,
                algorithm=PDF_ENCRYPT_AES_256,
            )
        output = BytesIO()
        writer.write(output)
        return output.getvalue()

    def save(self, path: str | Path, **options) -> None:
        Path(path).write_bytes(self.tobytes(**options))


def _draw(canvas: Canvas, page: FixturePage, operation: _Operation) -> None:
    if operation.kind == "text":
        x, top, text, size = operation.values
        rotation = int(operation.options.get("rotate", 0))
        canvas.saveState()
        if rotation:
            canvas.translate(x, page.height - top)
            canvas.rotate(rotation)
            x, top = 0, page.height
        for line_index, line in enumerate(text.splitlines()):
            canvas.setFont(_font_name(line), size)
            canvas.drawString(x, page.height - top - line_index * size * 1.2, line)
        canvas.restoreState()
    elif operation.kind == "textbox":
        bounds, text, size = operation.values
        font = _font_name(text)
        canvas.setFont(font, size)
        lines = [
            line
            for paragraph in text.splitlines() or [""]
            for line in simpleSplit(paragraph, font, size, bounds.width)
        ]
        leading = size * 1.2
        y = page.height - bounds.y0 - size
        for line in lines:
            if y < page.height - bounds.y1:
                break
            canvas.drawString(bounds.x0, y, line)
            y -= leading
    elif operation.kind == "rect":
        (bounds,) = operation.values
        canvas.rect(
            bounds.x0,
            page.height - bounds.y1,
            bounds.width,
            bounds.height,
            stroke=1,
            fill=0,
        )
    elif operation.kind == "line":
        start, end = operation.values
        canvas.line(start[0], page.height - start[1], end[0], page.height - end[1])
    elif operation.kind == "image":
        bounds, image = operation.values
        canvas.drawImage(
            ImageReader(image),
            bounds.x0,
            page.height - bounds.y1,
            width=bounds.width,
            height=bounds.height,
            preserveAspectRatio=False,
        )
    elif operation.kind == "link":
        bounds, uri = operation.values
        canvas.linkURL(
            uri,
            (bounds.x0, page.height - bounds.y1, bounds.x1, page.height - bounds.y0),
            relative=0,
        )


def open() -> FixtureDocument:
    return FixtureDocument()


def get_text_length(text: str, *, fontsize: float = DEFAULT_FONT_SIZE) -> float:
    return stringWidth(text, _font_name(text), fontsize)


def _font_name(text: str) -> str:
    return CJK_FONT if any(ord(character) > 127 for character in text) else DEFAULT_FONT


def build_pdf(
    *pages: PageFixture,
    title: str = "",
    author: str = "",
    attachment: tuple[str, bytes] | None = None,
) -> bytes:
    document = FixtureDocument()
    document.set_metadata({"title": title, "author": author})
    for fixture in pages:
        page = document.new_page(width=fixture.width, height=fixture.height)
        for text in fixture.texts:
            page.insert_text((text.x, text.top), text.text, fontsize=text.size)
    if attachment is not None:
        document.embfile_add(*attachment)
    return document.tobytes()


__all__ = [
    "LINK_URI",
    "PDF_ENCRYPT_AES_256",
    "PageFixture",
    "Pixmap",
    "Rect",
    "TextFixture",
    "build_pdf",
    "csRGB",
    "get_text_length",
    "open",
]
