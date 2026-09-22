"""Small real-PDF builder for local import and layout regression tests."""

from io import BytesIO
from pathlib import Path

from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

DEFAULT_PAGE_SIZE = (600, 800)
DEFAULT_FONT_SIZE = 11


class Document:
    def __init__(self):
        self.stream = BytesIO()
        self.canvas = Canvas(self.stream, pagesize=DEFAULT_PAGE_SIZE)
        self.height = DEFAULT_PAGE_SIZE[1]
        self.has_page = False

    def new_page(self, width=DEFAULT_PAGE_SIZE[0], height=DEFAULT_PAGE_SIZE[1]):
        if self.has_page:
            self.canvas.showPage()
        self.canvas.setPageSize((width, height))
        self.canvas.setFont('Helvetica', DEFAULT_FONT_SIZE)
        self.height = height
        self.has_page = True
        return self

    def insert_text(self, point, text):
        self.canvas.drawString(point[0], self.height - point[1], text)

    def draw_line(self, start, end):
        self.canvas.line(start[0], self.height - start[1], end[0], self.height - end[1])

    def insert_image(self, bounds, *, stream):
        left, top, right, bottom = bounds
        self.canvas.drawImage(ImageReader(BytesIO(stream)), left, self.height - bottom,
                              width=right - left, height=bottom - top)

    def set_metadata(self, metadata):
        self.canvas.setTitle(metadata.get('title', ''))
        self.canvas.setAuthor(metadata.get('author', ''))

    def save(self, path):
        if self.has_page:
            self.canvas.showPage()
        self.canvas.save()
        Path(path).write_bytes(self.stream.getvalue())

    def close(self):
        self.stream.close()


def open():
    return Document()


def Rect(left, top, right, bottom):
    return left, top, right, bottom
