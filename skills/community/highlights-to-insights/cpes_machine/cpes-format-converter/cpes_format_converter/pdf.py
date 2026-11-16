"""Shared PDF reading and rendering, with unrotated CropBox point coordinates.

Text/geometry is read once per page. Rendering is explicit and uses PDFium.
"""
from __future__ import annotations

from importlib.metadata import version
from contextlib import closing
import math

import pdfplumber
from pdfplumber.page import Page as LayoutPage
from pdfminer.layout import LTTextBox, LTTextLine
from pypdf import PdfReader
import pypdfium2


def engine_versions():
    return {name: version(name) for name in ('pypdf', 'pdfplumber', 'pdfminer.six', 'pypdfium2', 'Pillow')}


class Rect:
    def __init__(self, *values):
        values = values[0] if len(values) == 1 else values
        self.x0, self.y0, self.x1, self.y1 = map(float, values)

    def __iter__(self):
        return iter((self.x0, self.y0, self.x1, self.y1))

    @property
    def width(self): return self.x1 - self.x0

    @property
    def height(self): return self.y1 - self.y0

    @property
    def is_empty(self): return self.width <= 0 or self.height <= 0

    def get_area(self): return max(0, self.width) * max(0, self.height)

    def __and__(self, other):
        return Rect(max(self.x0, other.x0), max(self.y0, other.y0), min(self.x1, other.x1), min(self.y1, other.y1))

    def __or__(self, other):
        return Rect(min(self.x0, other.x0), min(self.y0, other.y0), max(self.x1, other.x1), max(self.y1, other.y1))

    def __add__(self, offset): return Rect(*(a + b for a, b in zip(self, offset)))

    def intersects(self, other): return not (self & other).is_empty

    def contains(self, other):
        return self.x0 <= other.x0 and self.y0 <= other.y0 and self.x1 >= other.x1 and self.y1 >= other.y1


def polygon_contains(point, vertices):
    cx = sum(x for x, y in vertices) / len(vertices)
    cy = sum(y for x, y in vertices) / len(vertices)
    ordered = sorted(vertices, key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
    signs = []
    for a, b in zip(ordered, ordered[1:] + ordered[:1]):
        cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
        if abs(cross) > 1e-7: signs.append(cross > 0)
    return not signs or all(s == signs[0] for s in signs)


def reading_order(blocks, width):
    if len(blocks) <= 1: return blocks
    middle = width / 2
    left = [b for b in blocks if b['rect'][2] <= middle + 4]
    right = [b for b in blocks if b['rect'][0] >= middle - 4]
    if (sum(b['rect'][2] - b['rect'][0] > width * .2 for b in left) >= 2 and
            sum(b['rect'][2] - b['rect'][0] > width * .2 for b in right) >= 2):
        spans = [b for b in blocks if b not in left and b not in right]
        pending, result = left + right, []
        def columns(rows):
            return sorted(rows, key=lambda b: (0 if (b['rect'][0] + b['rect'][2]) / 2 < middle else 1, b['rect'][1], b['rect'][0]))
        for span in sorted(spans, key=lambda b: (b['rect'][1], b['rect'][0])):
            above = [b for b in pending if (b['rect'][1] + b['rect'][3]) / 2 < span['rect'][1]]
            result.extend(columns(above)); result.append(span)
            pending = [b for b in pending if b not in above]
        return result + columns(pending)
    for axis, gap in ((0, 20), (1, 6)):
        ordered = sorted(blocks, key=lambda b: b['rect'][axis])
        edge = ordered[0]['rect'][axis + 2]
        for i in range(1, len(ordered)):
            if ordered[i]['rect'][axis] - edge >= gap:
                # A single short right-hand caption fragment is not a column.
                if axis == 0 and (len(ordered[:i]) < 2 or len(ordered[i:]) < 2):
                    edge = max(edge, ordered[i]['rect'][axis + 2])
                    continue
                return reading_order(ordered[:i], width) + reading_order(ordered[i:], width)
            edge = max(edge, ordered[i]['rect'][axis + 2])
    return sorted(blocks, key=lambda b: (b['rect'][1], b['rect'][0]))


class PDFPage:
    def __init__(self, document, number):
        self.document, self.number = document, number
        self.raw = document.reader.pages[number]
        self.rotation = int(self.raw.get('/Rotate', 0)) % 360
        if self.rotation not in (0, 90, 180, 270): raise ValueError('Unsupported page rotation.')
        self.cropbox = tuple(map(float, self.raw.cropbox))
        self.mediabox = tuple(map(float, self.raw.mediabox))
        x0, y0, x1, y1 = self.cropbox
        self.native_rect = Rect(0, 0, x1-x0, y1-y0)
        self.rect = Rect(0, 0, y1-y0, x1-x0) if self.rotation in (90, 270) else Rect(self.native_rect)
        self.label = document.labels[number]
        # Parse upright, then explicitly transform locators for the display frame.
        original = document.layout.pages[number]
        original.page_obj.attrs['Rotate'] = 0
        original.page_obj.rotate = 0
        self.layout = LayoutPage(document.layout, original.page_obj, number + 1)
        self.chars = []
        for char in self.layout.chars:
            box = self.layout_rect(char)
            center = ((box.x0+box.x1)/2, (box.y0+box.y1)/2)
            if 0 <= center[0] <= self.native_rect.width and 0 <= center[1] <= self.native_rect.height:
                self.chars.append({**char, 'bbox': list(box), 'c': char['text']})
        blocks = []
        def lines(obj):
            if isinstance(obj, LTTextLine): yield obj
            else:
                for child in obj:
                    if isinstance(child, (LTTextBox, LTTextLine)): yield from lines(child)
        for obj in self.layout.layout:
            if not isinstance(obj, (LTTextBox, LTTextLine)): continue
            rows = []
            for line in lines(obj):
                item = self.layout.process_object(line)
                box = self.layout_rect(item)
                chosen = [c for c in self.chars if box.x0-1e-5 <= (c['bbox'][0]+c['bbox'][2])/2 <= box.x1+1e-5
                          and box.y0-1e-5 <= (c['bbox'][1]+c['bbox'][3])/2 <= box.y1+1e-5]
                text = line.get_text().rstrip('\n')
                if not chosen or not text.strip(): continue
                # A cropped line must not retain text outside the visible page.
                if not self.native_rect.contains(box): text = ''.join(c['c'] for c in chosen)
                rows.append({'text': text, 'rect': list(box & self.native_rect),
                             'font_size': max(float(c.get('size', 0)) for c in chosen),
                             'bold': any(any(s in str(c.get('fontname', '')).lower() for s in ('bold', 'black', 'heavy', 'demi')) for c in chosen)})
            if rows:
                box = Rect(rows[0]['rect'])
                for row in rows[1:]: box = box | Rect(row['rect'])
                blocks.append({'text': '\n'.join(r['text'] for r in rows), 'rect': list(box), 'lines': rows})
        self.blocks = reading_order(blocks, self.native_rect.width)
        self.text = '\n'.join(b['text'] for b in self.blocks)
        self.images = [{**i, 'bbox': list(self.layout_rect(i))} for i in self.layout.images]
        self.drawings = [{'rect': list(self.layout_rect(i))} for i in self.layout.rects + self.layout.curves + self.layout.lines]

    def layout_rect(self, item):
        dx = self.mediabox[0] - self.cropbox[0] - self.layout.mediabox[0]
        dy = self.cropbox[3] - self.mediabox[3] - self.layout.mediabox[1]
        return Rect(item['x0']+dx, item['top']+dy, item['x1']+dx, item['bottom']+dy)

    def raw_point(self, x, y): return (float(x)-self.cropbox[0], self.cropbox[3]-float(y))

    def raw_rect(self, values):
        x0, y0, x1, y1 = map(float, values)
        return Rect(x0-self.cropbox[0], self.cropbox[3]-y1, x1-self.cropbox[0], self.cropbox[3]-y0)

    def display_point(self, x, y):
        w, h = self.native_rect.width, self.native_rect.height
        return {0: (x,y), 90: (h-y,x), 180: (w-x,h-y), 270: (y,w-x)}[self.rotation]

    def display_rect(self, values):
        x0, y0, x1, y1 = values
        points = [self.display_point(x,y) for x,y in ((x0,y0),(x1,y0),(x0,y1),(x1,y1))]
        return Rect(min(x for x,y in points), min(y for x,y in points), max(x for x,y in points), max(y for x,y in points))

    def native_display_rect(self, values):
        x0,y0,x1,y1=values;w,h=self.native_rect.width,self.native_rect.height
        def point(x,y): return {0:(x,y),90:(y,h-x),180:(w-x,h-y),270:(w-y,x)}[self.rotation]
        pts=[point(x,y) for x,y in ((x0,y0),(x1,y0),(x0,y1),(x1,y1))]
        return Rect(min(x for x,y in pts),min(y for x,y in pts),max(x for x,y in pts),max(y for x,y in pts))

    def table_regions(self):
        return [self.layout_rect({'x0': t.bbox[0], 'top': t.bbox[1], 'x1': t.bbox[2], 'bottom': t.bbox[3]})
                for t in self.layout.find_tables() if len(t.rows) >= 2 and len(t.columns) >= 2]


class PDFDocument:
    def __init__(self, path):
        self.path = path
        self.reader = PdfReader(path)
        if self.reader.is_encrypted and not self.reader.decrypt(''):
            raise ValueError('Password-protected PDF must be unlocked before extraction.')
        if not self.reader.pages: raise ValueError('PDF has no pages.')
        self.labels = self.reader.page_labels
        self.layout = pdfplumber.open(path, password='', laparams={})
        self.cache = {}
        raw = self.reader.metadata or {}
        self.metadata = {key: str(raw.get('/'+pdfkey, '') or '') for key,pdfkey in
                         (('title','Title'),('author','Author'),('subject','Subject'),('keywords','Keywords'),('creator','Creator'),('producer','Producer'),('creationDate','CreationDate'),('modDate','ModDate'))}
        self.metadata['format'] = self.reader.pdf_header

    def __len__(self): return len(self.reader.pages)
    def __iter__(self): return (self[i] for i in range(len(self)))
    def __getitem__(self, number):
        if number not in self.cache: self.cache[number] = PDFPage(self, number)
        return self.cache[number]
    def __enter__(self): return self
    def __exit__(self, *args):
        self.layout.close()
        self.reader.close()


def render_page(path, number, *, scale=1, region=None, annotations=True):
    if not math.isfinite(scale) or scale <= 0: raise ValueError('Render scale must be positive.')
    with pypdfium2.PdfDocument(path, password='') as document:
        if not 0 <= number < len(document): raise ValueError('Invalid physical page.')
        with closing(document[number]) as page:
            width,height=page.get_size()
            box = Rect(region) & Rect(0,0,width,height) if region is not None else Rect(0,0,width,height)
            if box.is_empty: raise ValueError('Crop is outside the page.')
            bitmap = page.render(scale=scale, crop=(box.x0,height-box.y1,width-box.x1,box.y0), draw_annots=annotations)
            try: return bitmap.to_pil().convert('RGB').copy()
            finally: bitmap.close()
