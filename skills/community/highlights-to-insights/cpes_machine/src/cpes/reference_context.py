"""Bounded native-PDF reference windows, without rewriting source lines.

Known crops and native caption/table blocks are excluded before following prose.
Geometry is a conservative heuristic, not a certificate of sentence semantics.
"""
from collections import defaultdict
import re
from statistics import median

VERSION = 'native-context-v1'
MAX_LINES = 24
LABEL = r'(?:[A-Za-z]?(?:\d+\.)*\d+[A-Za-z]?|[IVXLC]+)'
CAPTION = re.compile(r'^\s*(?:Fig(?:ure)?s?\.?|Tables?|图|表)\s*' + LABEL + r'\s*[:：.]\s', re.I)


def reference_numbers(text, kind):
    name = r'(?:Fig(?:ure)?s?\.?|图)' if kind == 'figure' else r'(?:Tables?|表)'
    pattern = name + r'[\s~\u00a0]*(' + LABEL + r'(?:\s*(?:,\s*(?:and\s+)?|and\s+|&|to\s+|[-–—、])\s*' + LABEL + r')*)(?!\w|\.\d)'
    result = set()
    for match in re.finditer(r'\b' + pattern, text, re.I):
        value = match.group(1)
        result.update(n.lower() for n in re.findall(LABEL, value))
        for lo, hi in re.findall(r'\b(\d+)\s*(?:[-–—]|to)\s*(\d+)\b', value, re.I):
            if 0 <= int(hi) - int(lo) <= 128:
                result.update(map(str, range(int(lo), int(hi) + 1)))
    return result


def block_id(row):
    return str(row.get('source_line_id', 'line-' + str(row['line_number']))).rsplit('-l', 1)[0]


def box(row):
    return row.get('bbox_pixels')


def terminal(text):
    return bool(re.search(r'[.!?。！？][\s\]})”’"\']*$', text.strip()))


def spans(lines, file='system/document.txt'):
    result = []
    for row in lines:
        n = row['line']
        if result and n == result[-1]['line_end'] + 1:
            result[-1]['line_end'] = n
        else:
            result.append({'file': file, 'line_start': n, 'line_end': n, 'kind': 'body'})
    return result


class NativeContext:
    def __init__(self, rows, objects=()):
        self.rows = sorted(rows, key=lambda r: r['line_number'])
        self.blocked = set()
        self.reasons = {}
        blocks = defaultdict(list)
        for row in self.rows:
            blocks[block_id(row)].append(row)
        sizes = [r['font_size'] for r in self.rows if r.get('font_size') and
                 len(r['text']) >= 45 and not CAPTION.match(r['text'])]
        body_size = median(sizes) if sizes else None
        repeats = defaultdict(set)
        for row in self.rows:
            if box(row) and len(row['text'].strip()) < 100:
                repeats[row['text'].strip()].add(row.get('page_number'))
        for group in blocks.values():
            caption = any(CAPTION.match(r['text']) for r in group)
            # Native table cells are often emitted as separate lines on one baseline.
            aligned = sum(any(box(a) and box(b) and
                abs((box(a)[1] + box(a)[3] - box(b)[1] - box(b)[3]) / 2) < 3 and
                (box(a)[2] <= box(b)[0] or box(b)[2] <= box(a)[0])
                for b in group[i+1:]) for i, a in enumerate(group))
            numeric = sum(bool(re.fullmatch(r'[\s\d.,+−\-–—%↑↓()±]+', r['text'])) for r in group)
            table = len(group) >= 3 and (aligned >= 2 or numeric >= max(2, len(group) / 3))
            small = body_size and all(r.get('font_size', body_size) < body_size * .88 for r in group)
            reason = 'caption' if caption else 'table_block' if table else 'small_text' if small else None
            if reason:
                for row in group:
                    self.reasons[row['line_number']] = reason
        for row in self.rows:
            n = row['line_number'];rect = box(row)
            if not row.get('in_figure_scope', True):
                self.reasons[n] = 'outside_body'
            if rect and (re.fullmatch(r'\s*\d+\s*', row['text']) or
                         (len(repeats[row['text'].strip()]) > 1 and rect[1] < 90)):
                self.reasons[n] = 'page_furniture'
            for item in objects:
                loc = item.get('pdf_locator', {})
                regions = ([loc['bbox_pixels']] if loc.get('bbox_pixels') else []) + [
                    r['bbox_pixels'] for r in item.get('caption_source_lines', []) if r.get('bbox_pixels')]
                if not rect or row.get('page_number') != loc.get('page_number'):
                    continue
                if any(max(rect[0], b[0]) < min(rect[2], b[2]) and
                       max(rect[1], b[1]) < min(rect[3], b[3]) for b in regions):
                    self.reasons[n] = 'object_region'
        self.blocked = set(self.reasons)
        self.body = [r for r in self.rows if r['line_number'] not in self.blocked and r['text'].strip()]

    def adjacent(self, a, b):
        """Follow one native block/column, or a geometrically plausible page turn."""
        if b['line_number'] <= a['line_number']:
            return False
        if a.get('page_number') == b.get('page_number'):
            if not box(a) or not box(b):
                return b['line_number'] == a['line_number'] + 1
            if block_id(a) == block_id(b):
                return True
            # Same column continuing down; rightward text is a different column.
            if abs(box(a)[0] - box(b)[0]) < 45 and box(b)[1] >= box(a)[1]:
                return box(b)[1] - box(a)[3] < 50
            # At a column turn, the next column starts above the previous line.
            return box(b)[0] > box(a)[0] + 100 and box(b)[1] < box(a)[1]
        if b.get('page_number', 0) != a.get('page_number', 0) + 1 or not box(a) or not box(b):
            return False
        between = [r for r in self.rows if a['line_number'] < r['line_number'] < b['line_number']]
        return all(self.reasons.get(r['line_number']) in
                   ('caption', 'table_block', 'small_text', 'object_region', 'page_furniture') for r in between)

    def window(self, index):
        reference = self.body[index]
        if not reference.get('font_size') or not reference.get('source_line_id', '').startswith('p'):
            # Legacy/coordinate-poor records keep the bounded old window. Never
            # infer a page turn from text alone, even if the last sentence wraps.
            selected=[r for r in self.body[max(0,index-3):index+4]
                      if r.get('page_number')==reference.get('page_number') and
                      abs(r['line_number']-reference['line_number'])<=3]
            lines=[{'line':r['line_number'],'text':r['text'],'page':r.get('page_number')} for r in selected]
            return {'file':'system/document.txt','reference_line':reference['line_number'],
                    'line_start':lines[0]['line'],'line_end':lines[-1]['line'],'lines':lines,
                    'context_issues':['geometry_unavailable'], 'evidence_spans':spans(lines),
                    'context_version':VERSION}
        start = index
        # Include the start of a wrapped sentence, up to the overall bound.
        while start > 0 and index - start < 11:
            previous, current = self.body[start-1], self.body[start]
            if terminal(previous['text']) or not self.adjacent(previous, current):
                break
            start -= 1
        end = index
        while end + 1 < len(self.body) and end - start + 1 < MAX_LINES:
            if end >= index + 3 and terminal(self.body[end]['text']):
                break
            current, following = self.body[end], self.body[end+1]
            if not self.adjacent(current, following):
                break
            # Keep the original three-line look-ahead, completing the last
            # sentence, but do not pad past a paragraph end into a new block.
            if terminal(current['text']) and block_id(current) != block_id(following):
                break
            end += 1
        selected = self.body[start:end+1]
        issues = []
        if not terminal(selected[-1]['text']):
            issues.append('context_end_incomplete')
        paragraph_start = (selected[0].get('source_line_id', '').endswith('-l0000') and
                           selected[0]['text'][:1].isupper())
        if not paragraph_start and (start == 0 or (start > 0 and not terminal(self.body[start-1]['text']))):
            issues.append('context_start_unverified')
        lines = [{'line': r['line_number'], 'text': r['text'], 'page': r.get('page_number')} for r in selected]
        return {'file': 'system/document.txt', 'reference_line': reference['line_number'],
                'line_start': lines[0]['line'], 'line_end': lines[-1]['line'],
                'lines': lines, 'context_issues': issues, 'evidence_spans': spans(lines),
                'context_version': VERSION}


def select_mentions(rows, kind, number, *, objects=()):
    context = NativeContext(rows, objects)
    result = []
    for index, row in enumerate(context.body):
        text = row['text']
        # A printed label can wrap after "Table"/"Figure".
        if index + 1 < len(context.body) and context.adjacent(row, context.body[index+1]):
            text += '\n' + context.body[index+1]['text']
        if str(number).lower() not in reference_numbers(text, kind):
            continue
        if str(number).lower() not in reference_numbers(row['text'], kind) and not re.search(
                r'(?:Tables?|Fig(?:ure)?s?\.?)\s*$', row['text'], re.I):
            continue
        window = context.window(index)
        # Keep separate references but coalesce overlapping context for the wire packet later.
        result.append(window)
    return result


def body_clauses(mentions, *, complete_start=False):
    """Offer complete source sentences; retain disjoint line spans across floats."""
    result = [];seen = set()
    for mention in mentions:
        rows = mention['lines'];buffer = [];text = ''
        usable = not complete_start or not any(issue in mention.get('context_issues', [])
            for issue in ('context_start_unverified', 'geometry_unavailable'))
        for row in rows:
            buffer.append(row);text += (' ' if text else '') + row['text'].strip()
            if not terminal(row['text']):
                continue
            if complete_start and re.search(r'\b(?:Fig|Figs|Eq|Eqs|Dr|Mr|vs|e\.g|i\.e|et al)\.$', row['text'].strip(), re.I):
                continue
            if not usable:
                # The first buffer may start inside a sentence. Its terminator
                # establishes a boundary for the next buffer, not for this one.
                buffer = [];text = '';usable = True
                continue
            key = (mention['file'], tuple(r['line'] for r in buffer), text)
            if key not in seen:
                seen.add(key)
                evidence = spans(buffer, mention['file'])
                result.append({'clause_id': f'body-{len(result)+1}', 'raw_latex': text,
                    'display_text': text, 'evidence': evidence[0], 'evidence_spans': evidence,
                    'source_lines': [r['line'] for r in buffer]})
            buffer = [];text = ''
    return result


def complete_evidence_catalog(job):
    """Whole line-bounded sentence/paragraph units; never enclosing float gaps.

    A physical line may contain several sentence boundaries, so a unit can be
    more than one sentence. We deliberately keep that whole bounded passage
    instead of pretending punctuation splitting is a semantic sentence parser.
    """
    catalog = {}
    source = job['card_template']['source']['tex_file']
    caption = job.get('context', {}).get('figure_source', [])
    if caption:
        evidence = spans(caption, source)
        catalog['C1'] = {**evidence[0], 'kind':'caption',
            'text':' '.join(r['text'].strip() for r in caption),
            'evidence_spans':[{**s,'kind':'caption'} for s in evidence],
            'source_lines':[r['line'] for r in caption]}
    for clause in body_clauses(job.get('context', {}).get('numbered_mentions', []), complete_start=True):
        catalog[f'S{len(catalog) - bool(caption) + 1}'] = {**clause['evidence'],
            'text':clause['display_text'], 'evidence_spans':clause['evidence_spans'],
            'source_lines':clause['source_lines']}
    return catalog


def unit_packet_text(job, catalog):
    lines = [f"Figure: {job['card_template']['caption'].get('number', '')}",
             'Evidence units (select whole IDs; source line intervals are not selectable IDs):']
    for file in dict.fromkeys(v['file'] for v in catalog.values()):
        lines.append('Source: ' + file)
        for key, value in catalog.items():
            if value['file'] != file:continue
            labels = ', '.join(f"L{s['line_start']}" +
                (f"–L{s['line_end']}" if s['line_end'] != s['line_start'] else '')
                for s in value['evidence_spans'])
            lines.append(f"{key} ({value['kind']}; {labels}): {value['text']}")
    if not any(v['kind']=='caption' for v in catalog.values()):
        lines.append('Caption (uncitable): ' + job['card_template']['caption'].get('text',''))
    return '\n'.join(lines)
