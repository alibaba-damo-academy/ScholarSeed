"""Deterministic initial evidence selection; full native text stays in the index."""
import re
from statistics import median
from paper_scope import first_content_line
from cpes_format_converter.scope import columns

COMMON_HEADING = re.compile(r'^(abstract|introduction|background|methods?|materials(?: and methods)?|'
                            r'results?(?: and discussion)?|discussion|conclusions?|limitations?|'
                            r'references|acknowledg(?:e)?ments?|摘要|引言|方法|结果|讨论|结论|参考文献)$', re.I)


def block_texts(index):
    lines = {line['id']: line for line in index['lines']}
    return {s['id']: '\n'.join(lines[lid]['text'] for lid in s['line_ids'])
            for s in index['catalog'] if s['kind'] == 'paper_text'}


def infer_sections(index):
    """Literal heading candidates, never a semantic summary or guaranteed layout."""
    blocks = [s for s in index['catalog'] if s['kind'] == 'paper_text']
    lines = {line['id']: line for line in index['lines']}
    sizes = [r['font_size'] for r in index['lines'] if len(r['text']) > 40]
    body_size = median(sizes) if sizes else 11
    starts = []
    for position, block in enumerate(blocks):
        first = first_content_line(block, lines)
        title = first['text'].strip()
        plain = re.sub(r'^\d+(?:\.\d+)*[.\s]+', '', title).strip().rstrip(':：')
        short = len(title) <= 120 and len(title.split()) <= 16
        furniture = bool(re.match(r'^(fig(?:ure)?\.?|table|extended data fig|nature\s*[|·])\b', title, re.I))
        layout_heading = (first.get('bold') or first['font_size'] >= body_size + 1.5) and not title.endswith(('.', '?', '!', ';'))
        if short and not furniture and (COMMON_HEADING.fullmatch(plain) or layout_heading):
            starts.append((position, title))
    if blocks and (not starts or starts[0][0] != 0):
        starts.insert(0, (0, 'Unclassified opening text'))
    result = []
    for i, (start, title) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(blocks)
        group = blocks[start:end]
        result.append({'id': f'S{i + 1:05d}', 'title': title, 'boundary_status': 'layout_candidate',
                       'pages': sorted({s['page'] for s in group}), 'source_ids': [s['id'] for s in group]})
    return result


def plan_packet(index):
    blocks = [s for s in index['catalog'] if s['kind'] == 'paper_text']
    texts = block_texts(index)
    reasons = {}

    def include(sid, reason):
        if sid in texts and reason not in reasons.setdefault(sid, []):
            reasons[sid].append(reason)

    scope = index['paper_scope']
    for source in blocks:
        if scope['source_roles'][source['id']] == 'body':
            include(source['id'], 'complete_body')

    reading_context = set()
    for source in index['catalog']:
        if source['record_ids']:
            for sid in source['context_ids']:
                include(sid, 'reading_context')
                reading_context.add(sid)

    visual, unresolved = related_units(index, texts, reading_context, include)
    continuations = complete_captions(index, blocks, texts,
        {b['id']: [] for b in blocks if caption_start(texts[b['id']])}, lambda *_: None)
    for seed, followers in continuations.items():
        if seed in reasons:
            for sid in followers:
                include(sid, 'caption_continuation_candidate')
    selected = [s['id'] for s in blocks if s['id'] in reasons]
    return {'mode': 'body_plus_marked_appendix', 'source_ids': selected, 'reasons': reasons,
            'available_paper_blocks': len(blocks), 'selected_paper_blocks': len(selected),
            'selected_paper_characters': sum(len(texts[sid]) for sid in selected),
            'body_scope_status': scope['status'], 'visual_requirements': visual,
            'unresolved_cross_references': unresolved, 'caption_continuations': continuations,
            'scope': 'complete candidate body plus reading context and linked units; check boundaries and visual completeness'}


OBJECT_REF = re.compile(r'\b(?:(extended\s+data|supplementary)\s+)?(fig(?:ure)?s?\.?|tables?)\s*(\d+)', re.I)


def object_key(match):
    prefix = re.sub(r'\s+', '_', (match.group(1) or '').lower())
    kind = 'figure' if match.group(2).lower().startswith('fig') else 'table'
    return prefix, kind, match.group(3)


def caption_start(text):
    text = ' '.join(text.split())
    match = OBJECT_REF.match(text)
    return bool(match and re.match(r'\s*[|:：.]', text[match.end():]))


def related_units(index, texts, context, include):
    """Resolve unique figure/table captions; preserve visual and ambiguous work."""
    blocks = [s for s in index['catalog'] if s['kind'] == 'paper_text']
    lookup = {s['id']: s for s in blocks}
    captions = {}
    for source in blocks:
        text = ' '.join(texts[source['id']].split())
        match = OBJECT_REF.match(text)
        if match and re.match(r'\s*[|:：.]', text[match.end():]):
            captions.setdefault(object_key(match), []).append(source['id'])
    requirements, unresolved = {}, []

    def require(sid, kind, reason):
        source = lookup[sid]
        key = source['page'], kind
        row = requirements.setdefault(key, {'source_ids': [], 'page': source['page'], 'kind': kind,
                                             'status': 'needs_complete_unit_check', 'reason': reason})
        if sid not in row['source_ids']:
            row['source_ids'].append(sid)

    for sid in sorted(context):
        if sid not in lookup:
            continue
        text = texts[sid]
        for match in OBJECT_REF.finditer(text):
            key = object_key(match)
            targets = captions.get(key, [])
            if len(targets) == 1:
                target = targets[0]
                include(target, 'explicit_related_caption')
                require(target, key[1], 'Full object, legend and caption required; caption text alone is insufficient.')
            else:
                unresolved.append({'source_id': sid, 'reference': match.group(0), 'candidate_source_ids': targets})
        if re.search(r'[=∑∫⊙]', text):
            require(sid, 'formula', 'Inspect complete formula and definitions; native fragments do not prove completeness.')
            seed = lookup[sid]
            rect = seed['rects'][0]
            width = index['pages'][seed['page'] - 1]['width']
            page_rows = [{'text': r['text'], 'bbox_pixels': r['rect']} for r in index['lines'] if r['page'] == seed['page']]
            two_columns = columns(page_rows, width) == 2
            right_column = (rect[0] + rect[2]) / 2 > width / 2
            for other in blocks:
                box = other['rects'][0]
                same_column = not two_columns or ((box[0] >= width / 2 - 12) if right_column else (box[2] <= width / 2 + 12))
                if (other['page'] == seed['page'] and same_column and box[3] > rect[1] - 36 and box[1] < rect[3] + 36):
                    include(other['id'], 'formula_neighbor_candidate')

    for source in index['catalog']:
        if source['record_ids'] and source['page'] is not None and not source['context_ids']:
            requirements[(source['id'], 'unlocated_mark')] = {
                'source_ids': [source['id']], 'page': source['page'], 'kind': 'unlocated_mark',
                'status': 'needs_complete_unit_check', 'reason': 'No native paragraph target; inspect the marked page.'}
    return list(requirements.values()), unresolved


def section_sources(index, identifiers):
    sections = {s['id']: s for s in index['sections']}
    result = []
    for sid in identifiers:
        if sid not in sections:
            raise ValueError(f'Unknown section: {sid}')
        result.extend(sections[sid]['source_ids'])
    return list(dict.fromkeys(result))


def complete_captions(index, blocks, texts, reasons, include):
    """Recover adjacent native caption columns conservatively; keep candidate status."""
    result = {}
    for position, source in enumerate(blocks):
        sid = source['id']
        if sid not in reasons or not caption_start(texts[sid]):
            continue
        current = source
        for following in blocks[position + 1:]:
            if re.search(r'[.!?。][”\"\')]*\s*$', texts[current['id']]):
                break
            a, b = current['rects'][0], following['rects'][0]
            if following['page'] != current['page'] or OBJECT_REF.match(' '.join(texts[following['id']].split())):
                break
            across = b[0] >= a[2] - 5 and abs(b[1] - a[1]) < 20
            below = abs(b[0] - a[0]) < 20 and -3 <= b[1] - a[3] <= 20
            if not (across or below):
                break
            # A new title is not a continuation just because it is nearby.
            first = next(r for r in index['lines'] if r['id'] == following['line_ids'][0])
            if first.get('bold') or COMMON_HEADING.fullmatch(texts[following['id']].strip()):
                break
            include(following['id'], 'caption_continuation_candidate')
            result.setdefault(sid, []).append(following['id'])
            current = following
    return result
