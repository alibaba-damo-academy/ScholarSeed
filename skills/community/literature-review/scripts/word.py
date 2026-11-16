"""Deterministic Markdown-to-DOCX publication without remote conversion."""

import hashlib
import re
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt
from markdown_it import MarkdownIt

from equations import equation

MATH = re.compile(r'\$\$(.+?)\$\$|\$(.+?)(?<!\\)\$|\\\((.+?)\\\)|\\\[(.+?)\\\]', re.DOTALL)
MATH_TOKEN = 'slr_math'
ANCHOR = re.compile(r'^</?a(?:\s[^>]*)?>$')
HEADING_IDENTIFIER = re.compile(r'\s+\{#([A-Za-z][A-Za-z0-9_.:-]*)\}\s*$')
BOOKMARK_PREFIX = 'section_'
BOOKMARK_DIGEST_LENGTH = 32
BODY_POINTS = 11
IMAGE_WIDTH = 6


def image_box(document=None):
    document = document if document is not None else Document()
    section = document.sections[0]
    width = min(Inches(IMAGE_WIDTH), section.page_width - section.left_margin - section.right_margin)
    height = section.page_height - section.top_margin - section.bottom_margin - Pt(BODY_POINTS)
    return Emu(width), Emu(height)


def text(paragraph, content, bold=False, italic=False, code=False):
    run = paragraph.add_run(content)
    run.bold, run.italic = bold, italic
    if code:
        run.font.name = 'Courier New'


def math_inline(state, silent):
    match = MATH.match(state.src, state.pos)
    if not match or match.end() > state.posMax:
        return False
    if match.group(2) is not None and '`' in match.group(2):
        return False
    if not silent:
        token = state.push(MATH_TOKEN, '', 0)
        token.content = next(value for value in match.groups() if value is not None)
    state.pos = match.end()
    return True


def inline(paragraph, tokens, root):
    bold = italic = False
    link = None
    for token in tokens or []:
        if token.type == 'strong_open': bold = True
        elif token.type == 'strong_close': bold = False
        elif token.type == 'em_open': italic = True
        elif token.type == 'em_close': italic = False
        elif token.type in ('text', 'code_inline'):
            text(paragraph, token.content, bold, italic, token.type == 'code_inline')
        elif token.type == MATH_TOKEN:
            paragraph._p.append(equation(token.content))
        elif token.type in ('softbreak', 'hardbreak'):
            paragraph.add_run().add_break()
        elif token.type == 'image':
            path = (root / token.attrGet('src')).resolve()
            if not path.is_relative_to(root.resolve()) or not path.is_file():
                raise ValueError('DOCX image must be an existing local publication dependency')
            width, height = image_box(paragraph.part.document)
            picture = paragraph.add_run().add_picture(str(path), width=width)
            if picture.height > height:
                picture.width = round(picture.width * height / picture.height)
                picture.height = height
        elif token.type == 'link_open':
            link = token.attrGet('href')
        elif token.type == 'link_close':
            if link and '://' in link:
                paragraph.add_run(' (' + link + ')')
            link = None
        elif token.type == 'html_inline' and ANCHOR.fullmatch(token.content):
            continue
        else:
            raise ValueError('unsupported DOCX inline construct: ' + token.type)


def export(content, root, destination, language='english'):
    document = Document()
    normal = document.styles['Normal']
    normal.font.name = 'Times New Roman'
    normal.font.size = Pt(BODY_POINTS)
    normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), 'SimSun')
    parser = MarkdownIt('commonmark', {'html': True}).enable('table')
    parser.inline.add_terminator_char('$')
    parser.inline.ruler.before('escape', MATH_TOKEN, math_inline)
    tokens = parser.parse(content)
    paragraph = None
    list_styles = []
    table = None
    row = None
    cell_index = 0
    header = False
    heading = False
    identifiers = set()
    for token in tokens:
        kind = token.type
        if kind == 'heading_open':
            paragraph = document.add_heading(level=int(token.tag[1:]))
            heading = True
        elif kind == 'heading_close':
            heading = False
        elif kind == 'paragraph_open':
            paragraph = document.add_paragraph(style=list_styles[-1] if list_styles else None)
        elif kind == 'inline':
            if paragraph is None:
                raise ValueError('DOCX inline content has no paragraph')
            identifier = None
            if heading and token.children and token.children[-1].type == 'text':
                suffix = token.children[-1]
                matched = HEADING_IDENTIFIER.search(suffix.content)
                if matched:
                    identifier = matched.group(1)
                    if identifier in identifiers:
                        raise ValueError('duplicate heading identifier: ' + identifier)
                    identifiers.add(identifier)
                    suffix.content = suffix.content[:matched.start()]
                    bookmark = OxmlElement('w:bookmarkStart')
                    bookmark.set(qn('w:id'), str(len(identifiers)))
                    bookmark.set(qn('w:name'), BOOKMARK_PREFIX + hashlib.sha256(
                        identifier.encode('utf-8')).hexdigest()[:BOOKMARK_DIGEST_LENGTH])
                    paragraph._p.append(bookmark)
            inline(paragraph, token.children, Path(root))
            if identifier:
                bookmark = OxmlElement('w:bookmarkEnd')
                bookmark.set(qn('w:id'), str(len(identifiers)))
                paragraph._p.append(bookmark)
        elif kind == 'bullet_list_open': list_styles.append('List Bullet')
        elif kind == 'ordered_list_open': list_styles.append('List Number')
        elif kind in ('bullet_list_close', 'ordered_list_close'): list_styles.pop()
        elif kind == 'table_open': table = document.add_table(rows=0, cols=0)
        elif kind == 'thead_open': header = True
        elif kind == 'thead_close': header = False
        elif kind == 'tr_open':
            row = table.add_row()
            cell_index = 0
            if header:
                row._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
        elif kind in ('th_open', 'td_open'):
            if cell_index >= len(table.columns):
                table.add_column(Inches(IMAGE_WIDTH / max(1, cell_index + 1)))
            paragraph = row.cells[cell_index].paragraphs[0]
            cell_index += 1
        elif kind == 'table_close':
            for column in table.columns:
                column.width = Inches(IMAGE_WIDTH / len(table.columns))
            for table_row in table.rows:
                for cell in table_row.cells:
                    cell.width = Inches(IMAGE_WIDTH / len(table.columns))
        elif kind in ('fence', 'code_block'):
            text(document.add_paragraph(), token.content, code=True)
        elif kind == 'html_block' and ANCHOR.fullmatch(token.content.strip()):
            continue
        elif kind.endswith('_close') or kind in ('list_item_open', 'tbody_open', 'blockquote_open'):
            continue
        elif kind == 'hr': document.add_paragraph('—')
        else:
            raise ValueError('unsupported DOCX block: ' + kind)
    destination = Path(destination)
    temporary = destination.with_suffix('.part.docx')
    document.save(temporary)
    Document(temporary)
    temporary.replace(destination)
    return {'status': 'SUCCESS', 'deliverable': str(destination), 'format': 'docx',
            'visual_review_required': True, 'next_action': 'Open the DOCX in the product and inspect text, equations, tables and images.'}
