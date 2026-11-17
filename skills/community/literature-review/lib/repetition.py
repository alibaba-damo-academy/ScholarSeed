"""Locate possible cross-chapter redefinitions without editing the manuscript."""

from collections import defaultdict
from dataclasses import dataclass
import re

from markdown_it import MarkdownIt


HINT_BUDGET_BYTES = 8192
TERM_CHAR_LIMIT = 80
EXPANSION_CHAR_LIMIT = 120
EXCLUDED_SECTIONS = frozenset(('abstract', '摘要', 'references', 'bibliography', '参考文献'))
EXCLUDED_ENVIRONMENTS = (
    'abstract', 'table', 'table*', 'longtable', 'figure', 'figure*',
    'verbatim', 'lstlisting', 'minted', 'equation', 'equation*', 'align', 'align*',
    'thebibliography',
)
TEX_HEADING = re.compile(r'\\section\*?\{([^{}]+)\}')
MARKDOWN_HEADING = re.compile(r'^##[ \t]+(.+?)[ \t]*#*[ \t]*$')
MARKDOWN_IMAGE = re.compile(r'!\[[^\]\n]*\]\([^\n]*?\)')
MARKDOWN_CAPTION = re.compile(r'(?mi)^\*\*(?:Figure|Table|图|表)\s*\d+[^\n]*$')
ALIAS = re.compile(r'(?:[A-Z][A-Z0-9-]+|[A-Z][a-z]+(?:[A-Z][a-z]+)*)')
DEFINITION = re.compile(
    rf'(?P<term>[\u3400-\u9fff]{{2,{TERM_CHAR_LIMIT}}}|'
    rf'[A-Za-z][A-Za-z -]{{1,{TERM_CHAR_LIMIT}}})[ \t]*'
    rf'[（(](?P<expansion>[^()（）\n]{{2,{EXPANSION_CHAR_LIMIT}}})[）)]'
)
TEX_ENVIRONMENT = re.compile(
    r'\\begin\{(' + '|'.join(re.escape(name) for name in EXCLUDED_ENVIRONMENTS)
    + r')\}.*?\\end\{\1\}', re.S
)
INLINE_CONTENT = re.compile(
    r'`[^`\n]*`|\$\$.*?\$\$|(?<!\\)\$[^$]*?(?<!\\)\$|'
    r'\\\(.*?\\\)|\\\[.*?\\\]', re.S
)


@dataclass(frozen=True)
class Occurrence:
    alias: str
    chapter: int
    title: str
    line: int
    phrase: str


def _blank(match):
    return re.sub(r'[^\n]', ' ', match.group())


def _visible_source(source, output_format):
    visible = source
    if output_format == 'latex_pdf':
        visible = re.sub(r'(?m)(?<!\\)%[^\n]*', _blank, visible)
        visible = TEX_ENVIRONMENT.sub(_blank, visible)
    else:
        lines = visible.splitlines(keepends=True)
        for token in MarkdownIt('commonmark').enable('table').parse(source):
            if token.type in ('fence', 'code_block', 'table_open', 'html_block') and token.map:
                for index in range(*token.map):
                    lines[index] = re.sub(r'[^\n]', ' ', lines[index])
        visible = ''.join(lines)
        visible = MARKDOWN_IMAGE.sub(_blank, visible)
        visible = MARKDOWN_CAPTION.sub(_blank, visible)
    return INLINE_CONTENT.sub(_blank, visible)


def _occurrences(source, output_format):
    original_lines = source.splitlines()
    chapter = 0
    title = None
    heading_pattern = TEX_HEADING if output_format == 'latex_pdf' else MARKDOWN_HEADING
    for number, line in enumerate(_visible_source(source, output_format).splitlines(), 1):
        heading = heading_pattern.search(line)
        if heading:
            title = re.sub(r'<[^>]*>|\{#[^}]*\}', '', heading[1]).strip()
            if title.casefold() in EXCLUDED_SECTIONS:
                title = None
            else:
                chapter += 1
            continue
        if title is None:
            continue
        for match in DEFINITION.finditer(line):
            alias = re.split(r'[,，]', match['expansion'])[-1].strip()
            if not ALIAS.fullmatch(alias) or match['term'].strip().casefold() == alias.casefold():
                continue
            yield Occurrence(alias, chapter, title, number,
                             original_lines[number - 1][match.start():match.end()].strip())


def repetition_notes(source, output_format, language='english', max_bytes=HINT_BUDGET_BYTES):
    grouped = defaultdict(list)
    for occurrence in _occurrences(source, output_format):
        grouped[occurrence.alias.casefold()].append(occurrence)
    groups = [items for items in grouped.values() if len({item.chapter for item in items}) > 1]
    if not groups:
        return ''
    chinese = language.lower() == 'chinese'
    header = (
        '跨章重复释义候选\n\n逐项比较较早释义与后续释义，精简后续不必要的再次解释。'
        '较早释义仅作对照，不因这份清单删除首次必要定义或其他正常用词。'
        '需要修改时直接修改所列后续位置，不以其他段落的改写代替。'
        '行号对应 sources.main 的原始 v1 源码，不是 PDF 页码。'
        '保留必要定义、不同含义及局部限定，不要仅因列入清单就删除。\n'
        if chinese else
        'Possible cross-chapter redefinitions\n\nCompare each earlier definition with its later locations '
        'and simplify unnecessary later redefinitions. Earlier definitions are comparison anchors, '
        'not deletion candidates; retain first necessary definitions and ordinary terminology. '
        'When a later occurrence needs an edit, edit that listed location rather than unrelated prose. '
        'Lines refer to the original v1 source in sources.main, not PDF pages. '
        'Preserve necessary definitions, distinct senses and qualifications; candidates are not mandatory deletions.\n'
    )
    rows = []
    omitted = 0
    for items in groups:
        phrases = defaultdict(list)
        earlier = items[0]
        earlier_location = (f'第{earlier.chapter}章“{earlier.title}”第{earlier.line}行' if chinese else
                            f'chapter {earlier.chapter} "{earlier.title}", line {earlier.line}')
        for item in items[1:]:
            location = (f'第{item.chapter}章“{item.title}”第{item.line}行' if chinese else
                        f'chapter {item.chapter} "{item.title}", line {item.line}')
            phrases[item.phrase].append(location)
        locations = ('；' if chinese else '; ').join(
            ('、' if chinese else ', ').join(positions) + f' “{phrase}”'
            for phrase, positions in phrases.items()
        )
        row = (f'{len(rows) + 1}. {earlier.alias}：较早释义（对照）：{earlier_location} “{earlier.phrase}”；'
               f'后续疑似重复：{locations}' if chinese else
               f'{len(rows) + 1}. {earlier.alias}: Earlier definition (anchor): {earlier_location} '
               f'“{earlier.phrase}”; Possible later redefinitions: {locations}')
        reserve = (f'\n另有{len(groups)}组候选因提示长度限制未列出。' if chinese else
                   f'\n{len(groups)} additional candidate groups omitted to limit hint length.')
        if len((header + '\n'.join([*rows, row]) + reserve).encode('utf-8')) <= max_bytes:
            rows.append(row)
        else:
            omitted += 1
    footer = ''
    if omitted:
        footer = (f'\n另有{omitted}组候选因提示长度限制未列出。' if chinese else
                  f'\n{omitted} additional candidate groups omitted to limit hint length.')
    notes = header + '\n'.join(rows) + footer
    if len(notes.encode('utf-8')) > max_bytes:
        raise ValueError('repetition hint budget is too small for its explanatory text')
    return notes
