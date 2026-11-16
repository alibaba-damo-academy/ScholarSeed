"""Small native PDF fixtures built with the supported reader dependency."""
from pypdf import PdfWriter
from pdfminer.fontmetrics import FONT_METRICS
from PIL import Image
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject


def text_rect(text, origin, phrase, *, size=11, bold=False):
    widths = FONT_METRICS['Helvetica-Bold' if bold else 'Helvetica'][1]
    offset = text.index(phrase)
    left = origin[0] + sum(widths[character] for character in text[:offset]) * size / 1000
    right = left + sum(widths[character] for character in phrase) * size / 1000
    return left, origin[1]-size, right, origin[1]+size/3


def markup(writer, page, rectangles, *, kind='Highlight', comment=''):
    height = float(page.mediabox.top)
    quads = []
    for left, top, right, bottom in rectangles:
        quads.extend((left, height-top, right, height-top, left, height-bottom, right, height-bottom))
    rectangle = (min(rect[0] for rect in rectangles), height-max(rect[3] for rect in rectangles),
                 max(rect[2] for rect in rectangles), height-min(rect[1] for rect in rectangles))
    annotation = DictionaryObject({NameObject('/Type'): NameObject('/Annot'),
                                   NameObject('/Subtype'): NameObject('/'+kind),
                                   NameObject('/Rect'): ArrayObject([FloatObject(value) for value in rectangle]),
                                   NameObject('/QuadPoints'): ArrayObject([FloatObject(value) for value in quads]),
                                   NameObject('/C'): ArrayObject([FloatObject(value) for value in (1, 1, 0)]),
                                   NameObject('/Contents'): TextStringObject(comment),
                                   NameObject('/F'): NumberObject(4)})
    writer.add_annotation(page, annotation)


def document_pdf(path, pages, *, size=(595, 842), attachments=None):
    writer = PdfWriter()
    fonts = DictionaryObject()
    for name, family in (('/F1', '/Helvetica'), ('/F2', '/Helvetica-Bold')):
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                                 NameObject('/Subtype'): NameObject('/Type1'),
                                 NameObject('/BaseFont'): NameObject(family)})
        fonts[NameObject(name)] = writer._add_object(font)
    for specification in pages:
        page = writer.add_blank_page(width=size[0], height=size[1])
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): fonts})
        commands = []
        for text in specification.get('texts', []):
            left, top = text['at']
            font_size = text.get('size', 11)
            font_name = '/F2' if text.get('bold') else '/F1'
            if text.get('center'):
                family = 'Helvetica-Bold' if text.get('bold') else 'Helvetica'
                widths = FONT_METRICS[family][1]
                left -= sum(widths[character] for character in text['text']) * font_size / 2000
            commands.append(f'BT {font_name} {font_size} Tf {font_size*1.375} TL {left} {size[1]-top} Td')
            for line in text['text'].split('\n'):
                escaped = line.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
                commands.append(f'({escaped}) Tj T*')
            commands.append('ET')
        for left, top, right, bottom in specification.get('rectangles', []):
            commands.append(f'{left} {size[1]-bottom} {right-left} {bottom-top} re S')
        for left, top, right, bottom in specification.get('lines', []):
            commands.append(f'{left} {size[1]-top} m {right} {size[1]-bottom} l S')
        images = DictionaryObject()
        image_commands = []
        for number, image_specification in enumerate(specification.get('images', []), 1):
            with Image.new(image_specification.get('mode', 'RGB'), image_specification['size'],
                           image_specification['color']) as image:
                bitmap = DecodedStreamObject()
                with image.convert('RGB') as colors:
                    bitmap.set_data(colors.tobytes())
                bitmap.update({NameObject('/Type'): NameObject('/XObject'),
                               NameObject('/Subtype'): NameObject('/Image'),
                               NameObject('/Width'): NumberObject(image.width),
                               NameObject('/Height'): NumberObject(image.height),
                               NameObject('/BitsPerComponent'): NumberObject(8),
                               NameObject('/ColorSpace'): NameObject('/DeviceRGB')})
                if image.mode == 'RGBA':
                    mask = DecodedStreamObject()
                    with image.getchannel('A') as alpha:
                        mask.set_data(alpha.tobytes())
                    mask.update({NameObject('/Type'): NameObject('/XObject'),
                                 NameObject('/Subtype'): NameObject('/Image'),
                                 NameObject('/Width'): NumberObject(image.width),
                                 NameObject('/Height'): NumberObject(image.height),
                                 NameObject('/BitsPerComponent'): NumberObject(8),
                                 NameObject('/ColorSpace'): NameObject('/DeviceGray')})
                    bitmap[NameObject('/SMask')] = writer._add_object(mask)
                name = f'/Im{number}'
                images[NameObject(name)] = writer._add_object(bitmap)
                left, top, right, bottom = image_specification['bounds']
                width, height = right-left, bottom-top
                if image_specification.get('rotate'):
                    matrix = f'0 {height} {-width} 0 {right} {size[1]-bottom}'
                else:
                    matrix = f'{width} 0 0 {height} {left} {size[1]-bottom}'
                image_commands.append(f'q {matrix} cm {name} Do Q')
        page['/Resources'][NameObject('/XObject')] = images
        content = DecodedStreamObject()
        content.set_data('\n'.join(image_commands + commands).encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(content)
        for mark in specification.get('marks', []):
            rectangles = []
            for phrase in mark['phrases']:
                matches = []
                for text in specification.get('texts', []):
                    font_size = text.get('size', 11)
                    for number, line in enumerate(text['text'].split('\n')):
                        if phrase in line:
                            origin = (text['at'][0], text['at'][1]+number*font_size*1.375)
                            matches.append(text_rect(line, origin, phrase, size=font_size, bold=text.get('bold', False)))
                rectangles.append(matches[0])
            markup(writer, page, rectangles, kind=mark.get('kind', 'Highlight'), comment=mark.get('comment', ''))
        for note in specification.get('notes', []):
            left, top = note['at']
            annotation = DictionaryObject({NameObject('/Type'): NameObject('/Annot'),
                                           NameObject('/Subtype'): NameObject('/Text'),
                                           NameObject('/Rect'): ArrayObject([FloatObject(value) for value in (left, size[1]-top-20, left+20, size[1]-top)]),
                                           NameObject('/Contents'): TextStringObject(note['text'])})
            writer.add_annotation(page, annotation)
    for name, content in (attachments or {}).items():
        writer.add_attachment(name, content)
    writer.write(path)


def simple_pdf(path, text='A probabilistic forecast.', annotations=False):
    writer=PdfWriter()
    page=writer.add_blank_page(400,400)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    content=DecodedStreamObject()
    escaped=text.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
    content.set_data(f'BT /F1 11 Tf 40 340 Td ({escaped}) Tj ET'.encode('ascii'))
    page[NameObject('/Contents')]=writer._add_object(content)
    if annotations:
        writer.add_annotation(page,DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Highlight'),NameObject('/Rect'):ArrayObject([FloatObject(v) for v in (40,338,300,352)]),NameObject('/QuadPoints'):ArrayObject([FloatObject(v) for v in (40,352,300,352,40,338,300,338)])}))
        writer.add_annotation(page,DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Text'),NameObject('/Rect'):ArrayObject([FloatObject(v) for v in (220,300,240,320)]),NameObject('/Contents'):TextStringObject('How is uncertainty represented?')}))
    writer.write(path)
