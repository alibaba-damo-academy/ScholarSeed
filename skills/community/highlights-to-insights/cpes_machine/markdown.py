"""Plain Markdown writing with locally consumed source references."""
import re

from markdown_it import MarkdownIt


MARKER_START = '[[hint:'
MARKER_END = ']]'
SOURCE_MAP_START = '[[SOURCE_MAP]]'
SOURCE_MAP_END = '[[/SOURCE_MAP]]'
IDENTITIES = ('paper_summary', 'mixed', 'reader_thought', 'model_explanation', 'model_suggestion')
ALTERNATIVE_MARKER_STARTS = tuple('[[' + identity + ':' for identity in IDENTITIES)
MARKER_STARTS = (MARKER_START, *ALTERNATIVE_MARKER_STARTS)
REFERENCE = re.compile(
    r'\[\[(?:hint:(?P<canonical>' + '|'.join(IDENTITIES) + r')\||(?P<compact>'
    + '|'.join(IDENTITIES) + r'):)(?P<sources>[ABN]\d+(?:\s*,\s*[ABN]\d+)*)\]\]')
BARE_REFERENCE = re.compile(r'\[(?P<sources>[ABN]\d+(?:\s*,\s*[ABN]\d+)*)\]')
BIBLIOGRAPHIC_LINE = re.compile(r'[^\n·]+\s·\s[^\n·]+\s·\s\d{4}[a-z]?')
CONTRACT = '''Return the finished note as plain Markdown with one source marker at the end of each paragraph.
Use a Markdown heading for the note title and headings for later sections (#### and #####
are recommended; the application normalizes heading levels). The original paper title
and FirstAuthor et al. · Journal · Year form one opening paragraph, with a Markdown hard line
break (two spaces and one newline), not a blank line, between these two bibliographic lines.
Separate prose paragraphs with blank lines. Finish each paragraph, including the opening
bibliographic paragraph, with its own marker before the next blank line or heading. For example:
A complete paragraph synthesizing several reading signals. [[hint:model_explanation|B001,A003,A008]]

A later paragraph may reuse a source. [[hint:paper_summary|B001,B005]]

These are format examples only: use actual displayed source IDs supporting that paragraph.
One paragraph can combine multiple paper passages, marks, comments and independent notes;
one source can support several paragraphs. Include the actual A/N IDs when using those reading
signals, alongside supporting B IDs. Do not replace a comment or note source with paper context. If reading signals are supplied,
a note citing only B IDs fails acceptance. Prioritize comments and learning questions; partial
coverage is allowed and reported separately by the application.
Use exactly one marker per paragraph, with all its source IDs separated by commas. Headings
have no markers. Bind sources locally while writing, without paragraph numbers or a trailing
source table. Do not merge the source bindings of paragraphs separated by a blank line.
The allowed identities are paper_summary, mixed, reader_thought, model_explanation and model_suggestion.
Use reader_thought only for genuine supplied personal ideas with their actual A/N evidence;
a highlight alone is not a personal idea. Explanations answering learning questions may use
model_explanation with their supporting sources. Markers are transport metadata: the application
hides them from streaming previews and removes them from the saved note, converting them locally
to source-map.json. Keep source IDs out of the prose itself. Do not output JSON, a SOURCE_MAP
block, footnotes, an omissions list, a code fence around the note, or processing commentary.'''


def visible_markdown(text):
    opening = text.find(SOURCE_MAP_START)
    if opening >= 0:
        text = text[:opening]
    else:
        for length in range(min(len(SOURCE_MAP_START) - 1, len(text)), 0, -1):
            if text.endswith(SOURCE_MAP_START[:length]):
                text = text[:-length]
                break
    pieces, position = [], 0
    while True:
        openings = [(text.find(start, position), start) for start in MARKER_STARTS]
        opening, start = min((item for item in openings if item[0] >= 0),
                             default=(-1, ''), key=lambda item: item[0])
        if opening < 0:
            tail = text[position:]
            for length in range(min(max(map(len, MARKER_STARTS)) - 1, len(tail)), 0, -1):
                if any(length < len(marker) and tail.endswith(marker[:length]) for marker in MARKER_STARTS):
                    tail = tail[:-length]
                    break
            pieces.append(tail)
            break
        pieces.append(text[position:opening])
        closing = text.find(MARKER_END, opening + len(start))
        if closing < 0:
            break
        position = closing + len(MARKER_END)
    return ''.join(pieces)


class MarkdownPreview:
    def __init__(self, emit):
        self.emit, self.raw, self.rendered = emit, '', ''

    def feed(self, delta):
        self.raw += delta
        visible = visible_markdown(self.raw)
        if not visible.startswith(self.rendered):
            raise ValueError('Markdown preview changed earlier text.')
        self.emit(visible[len(self.rendered):])
        self.rendered = visible


def source_reference(state, silent):
    """Capture source spans only after Markdown has recognized code, escapes and links."""
    # Link-label lookahead must see ordinary brackets, not nested link-like tokens.
    if silent or state.linkLevel:
        return False
    match = REFERENCE.match(state.src, state.pos) or BARE_REFERENCE.match(state.src, state.pos)
    if not match:
        prefix = next((start for start in MARKER_STARTS if state.src.startswith(start, state.pos)), None)
        if prefix:
            state.push('note_source_invalid', '', 0)
            state.pos += len(prefix)
            return True
        return False
    if not silent:
        token = state.push('note_source', '', 0)
        token.meta = {
            'start': state.pos, 'end': match.end(),
            'sources': [sid.strip() for sid in match['sources'].split(',')],
            'identity': (match.groupdict().get('canonical') or match.groupdict().get('compact')
                         or 'model_explanation'),
        }
    state.pos = match.end()
    return True


def paragraph_binding(inline):
    references = []
    for number, token in enumerate(inline.children):
        if token.type == 'note_source_invalid':
            raise ValueError('Malformed Markdown source reference.')
        if token.type == 'note_source':
            following = next((child for child in inline.children[number + 1:]
                              if child.type != 'note_source' and not
                              (child.type == 'text' and not child.content.strip())), None)
            preceding = next((child for child in reversed(inline.children[:number])
                              if child.type != 'note_source' and not
                              (child.type == 'text' and not child.content.strip())), None)
            references.append({**token.meta, 'closes_emphasis': following is not None
                               and following.type in ('em_close', 'strong_close'),
                               'opens_emphasis': preceding is not None
                               and preceding.type in ('em_open', 'strong_open')})
    clean = inline.content
    # Remove only parsed spans; preserve literal Markdown, including code and links.
    for reference in reversed(references):
        start, end = reference['start'], reference['end']
        if reference['closes_emphasis'] or clean[end:end + 1] in ('。', '！', '？', '.', '!', '?'):
            while start > 0 and clean[start - 1] in ' \t':
                start -= 1
        if reference['opens_emphasis']:
            while end < len(clean) and clean[end] in ' \t':
                end += 1
        clean = clean[:start] + clean[end:]
    clean = clean.strip()
    if not clean or not references:
        raise ValueError('Each Markdown paragraph needs its own source reference.')
    ids, identities = [], set()
    for reference in references:
        identifiers = reference['sources']
        if len(set(identifiers)) != len(identifiers):
            raise ValueError('Source references need distinct source IDs.')
        ids.extend(sid for sid in identifiers if sid not in ids)
        identities.add(reference['identity'])
    return {'text': clean, 'source_ids': ids,
            'identity': next(iter(identities)) if len(identities) == 1 else 'mixed'}


def parse_markdown(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Response needs nonempty Markdown output_text.')
    text = text.strip()
    if SOURCE_MAP_START in text:
        return parse_separate_sources(text)
    parser = MarkdownIt('commonmark')
    parser.inline.ruler.after('image', 'note_source', source_reference)
    environment = {}
    tokens = parser.parse(text, environment)
    if environment.get('references'):
        raise ValueError('Use inline Markdown links instead of reference definitions in notes.')
    if not tokens or tokens[0].type != 'heading_open':
        raise ValueError('Markdown note needs a title heading and body.')
    title = tokens[1].content.strip()
    if not title or any(token.type == 'note_source' for token in tokens[1].children):
        raise ValueError('Markdown note needs a title without source references.')
    draft = {'title': title, 'sections': [{'title': '', 'paragraphs': []}], 'omissions': []}
    blocks = []
    position = 3
    while position < len(tokens):
        token = tokens[position]
        if token.type == 'hr':
            position += 1
            continue
        if token.type not in ('heading_open', 'paragraph_open') or token.level != 0:
            raise ValueError('Markdown notes need prose paragraphs and headings, not ' + token.type + '.')
        blocks.append((token.type, tokens[position + 1]))
        position += 3
    # Keep the established, narrow bibliography spacing normalization.
    if len(blocks) > 1 and blocks[0][0] == blocks[1][0] == 'paragraph_open':
        first, second = blocks[0][1], blocks[1][1]
        references = [token.meta for token in second.children if token.type == 'note_source']
        if (not any(token.type == 'note_source' for token in first.children)
                and '\n' not in first.content and len(references) == 1
                and references[0]['identity'] == 'paper_summary'
                and BIBLIOGRAPHIC_LINE.fullmatch(paragraph_binding(second)['text'])):
            combined = parser.parseInline(first.content + '  \n' + second.content)[0]
            blocks[:2] = [('paragraph_open', combined)]
    for kind, inline in blocks:
        if kind == 'heading_open':
            heading = inline.content.strip()
            if not heading or any(token.type == 'note_source' for token in inline.children):
                raise ValueError('Markdown sections need headings without source references.')
            current = draft['sections'][-1]
            if not current['title'] and not current['paragraphs']:
                current['title'] = heading
            elif not current['paragraphs']:
                raise ValueError('Markdown sections need headings and paragraphs.')
            else:
                draft['sections'].append({'title': heading, 'paragraphs': []})
        else:
            draft['sections'][-1]['paragraphs'].append(paragraph_binding(inline))
    if not draft['sections'][-1]['paragraphs']:
        raise ValueError('Markdown prose is missing a source reference.')
    return draft


def parse_separate_sources(text):
    note, _, remainder = text.partition(SOURCE_MAP_START)
    rows, closing, tail = remainder.partition(SOURCE_MAP_END)
    if not closing or tail.strip() or SOURCE_MAP_START in remainder:
        raise ValueError('Markdown needs one complete trailing source block.')
    if any(start in note for start in MARKER_STARTS):
        raise ValueError('Keep source references in the separate block, not the note.')
    first, separator, body = note.strip().partition('\n')
    if not separator or not first.startswith('#### ') or not first[5:].strip():
        raise ValueError('Markdown note needs one #### title and body.')
    draft = {'title': first[5:].strip(), 'sections': [{'title': '', 'paragraphs': []}], 'omissions': []}
    paragraphs, pending = [], []

    def flush():
        if pending:
            paragraph = {'text': '\n'.join(pending).strip()}
            draft['sections'][-1]['paragraphs'].append(paragraph)
            paragraphs.append(paragraph)
            pending.clear()

    for line in body.splitlines():
        if line.startswith('##### '):
            flush()
            if not draft['sections'][-1]['paragraphs'] or not line[6:].strip():
                raise ValueError('Markdown sections need headings and paragraphs.')
            draft['sections'].append({'title': line[6:].strip(), 'paragraphs': []})
        elif not line.strip():
            flush()
        elif re.match(r'^#{1,6}\s', line):
            raise ValueError('Use one #### title and ##### section headings.')
        else:
            pending.append(line)
    flush()
    if not paragraphs or not draft['sections'][-1]['paragraphs']:
        raise ValueError('Markdown note needs source-bound paragraphs.')
    bindings = {}
    for row in rows.strip().splitlines():
        fields = [part.strip() for part in row.split('|')]
        if (len(fields) != 3 or not fields[0].isdigit() or fields[1] not in IDENTITIES
                or not re.fullmatch(r'[ABN]\d+(?:\s*,\s*[ABN]\d+)*', fields[2])):
            raise ValueError('Source rows need paragraph number | identity | source IDs.')
        number = int(fields[0])
        if number in bindings or not 1 <= number <= len(paragraphs):
            raise ValueError('Source paragraph numbers must be unique and in range.')
        bindings[number] = {'identity': fields[1],
                            'source_ids': list(dict.fromkeys(sid.strip() for sid in fields[2].split(',')))}
    if len(bindings) != len(paragraphs):
        raise ValueError('Each paragraph needs one separate source binding.')
    for number, paragraph in enumerate(paragraphs, 1):
        paragraph.update(bindings[number])
    return draft
