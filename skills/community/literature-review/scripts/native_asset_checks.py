"""Read-only asset diagnostics for the one native-manuscript refinement.

Recognizes native LaTeX table/figure environments and Markdown pipe/HTML tables.
Warnings locate source defects; they neither rewrite text nor gate publication.
"""
from collections import Counter
import re

from figure_caption import has_numbering_prefix

_ENV = re.compile(r'\\begin\{(table\*?|longtable|tabularx|tabular\*?|figure\*?)\}.*?\\end\{\1\}', re.S)
_LABEL = re.compile(r'\\label\{((?:tab|fig)[:-][^}]+)\}')
_ANCHOR = re.compile(r'<a\s+(?:id|name)=["\']((?:tab|fig)[:-][^"\']+)["\']\s*>\s*</a>|\{#((?:tab|fig)[:-][^}]+)\}', re.I)


def _blank(match):
    return re.sub(r'[^\n]', ' ', match[0])


def visible_source(source, markdown=False):
    if markdown:
        source = re.sub(r'(?ms)^\s*(`{3,}|~{3,})[^\n]*\n.*?^\s*\1\s*$', _blank, source)
        source = re.sub(r'(`+)[^`\n]*?\1', _blank, source)
        return re.sub(r'<!--.*?-->', _blank, source, flags=re.S)
    source = re.sub(r'\\begin\{(verbatim\*?|lstlisting|minted)\}.*?\\end\{\1\}', _blank, source, flags=re.S)
    source = re.sub(r'\\verb\*?([^\w\s]).*?\1', _blank, source)
    return re.sub(r'(?<!\\)%[^\n]*', _blank, source)


def _anchor_label(match):
    return re.sub(r'^(tab|fig)-', r'\1:', match[1] or match[2])


def _braced(source, start):
    if start >= len(source) or source[start] != '{':
        return None
    depth = 0; escaped = False
    for i in range(start, len(source)):
        if escaped:
            escaped = False
            continue
        if source[i] == '\\':
            escaped = True
            continue
        if source[i] == '{': depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0: return source[start+1:i]
    return None


def latex_blocks(source):
    # Outer environments consume their inner tabular, so one logical table is
    # counted once; bare tabular/longtable remains visible for identity checks.
    return [(m.start(), m.end(), 'figure' if m[1].startswith('figure') else 'table', m[0])
            for m in _ENV.finditer(source)]


def markdown_tables(source):
    lines = source.splitlines(keepends=True); offsets = [0]
    for line in lines: offsets.append(offsets[-1]+len(line))
    result = []; i = 1
    while i < len(lines):
        cells = lines[i].strip().strip('|').split('|')
        if '|' in lines[i-1] and cells and all(re.fullmatch(r':?-{3,}:?', c.strip()) for c in cells):
            start = i-1; end = i+1
            while end < len(lines) and '|' in lines[end] and lines[end].strip(): end += 1
            # Caption and identity must be adjacent, not borrowed from a prior
            # table or an arbitrary prose reference elsewhere in the chapter.
            prefix_start = start
            while prefix_start > 0 and start-prefix_start < 5:
                prev = lines[prefix_start-1]
                if prev.lstrip().startswith('#') or '|' in prev: break
                prefix_start -= 1
                if _ANCHOR.search(prev): break
            result.append((offsets[prefix_start], offsets[end], 'table',
                           source[offsets[prefix_start]:offsets[end]]))
            i = end
        else: i += 1
    for m in re.finditer(r'<table\b[^>]*>.*?</table>', source, re.S|re.I):
        result.append((m.start(), m.end(), 'table', m[0]))
    return result


def inspect_native_assets(sources, assets, output_format='latex_pdf'):
    """Diagnose inventory and caption defects across editable source targets."""
    markdown = output_format == 'markdown'
    planned = {a['label']: a for kind in ('shared_tables', 'shared_figures') for a in assets.get(kind, [])}
    counts = Counter(); issues = []; checked = 0
    def issue(code, target, source, pos, label=None, **details):
        issues.append({'code': code, 'target': target,
                       'source_line': source.count('\n', 0, pos)+1,
                       'label': label, **details})
    for target, original in sources.items():
        source = visible_source(original, markdown)
        blocks = markdown_tables(source) if markdown else latex_blocks(source)
        for start, end, kind, block in blocks:
            checked += 1
            labels = ([_anchor_label(m) for m in _ANCHOR.finditer(block)] if markdown else _LABEL.findall(block))
            labels = list(dict.fromkeys(l for l in labels if l.startswith('tab:' if kind=='table' else 'fig:')))
            if len(labels) != 1:
                issue('asset_identity_missing_or_ambiguous', target, source, start, asset_kind=kind, labels=labels)
            for label in labels:
                counts[label] += 1
                if label not in planned:
                    issue('asset_unplanned', target, source, start, label, asset_kind=kind)
                elif counts[label] > 1:
                    issue('asset_duplicate', target, source, start, label)
                if label in planned and not markdown:
                    headings = list(re.finditer(r'\\label\{sec:s(\d+(?:_\d+)*)\}', source[:start]))
                    owner = headings[-1][1].replace('_','.') if headings else None
                    expected = planned[label].get('section_id')
                    if owner and expected and owner != expected:
                        issue('asset_wrong_owner', target, source, start, label, expected_owner=expected, actual_owner=owner)
            if kind == 'figure' and not re.search(r'\\(?:includegraphics|input|subfile)\b|\\begin\{(?:tikzpicture|forest)\}', block):
                issue('figure_wrapper_without_content', target, source, start, labels[0] if len(labels)==1 else None)
            if markdown:
                for line in block.splitlines():
                    caption = re.sub(r'<[^>]+>', '', line).strip().strip('*_ ')
                    if not caption.startswith('|') and has_numbering_prefix(caption):
                        issue('caption_numbering_prefix', target, source, start, labels[0] if len(labels)==1 else None, caption=caption)
        if markdown:
            anchors = list(_ANCHOR.finditer(source))
            for anchor in anchors:
                label = _anchor_label(anchor)
                if not label.startswith('fig:'): continue
                counts[label] += 1
                if label not in planned:
                    issue('asset_unplanned', target, source, anchor.start(), label, asset_kind='figure')
                elif counts[label] > 1:
                    issue('asset_duplicate', target, source, anchor.start(), label)
            # Official Markdown images have a preceding figure anchor. A bare
            # chapter-authored image remains reportable after an empty delta.
            used = set()
            for m in re.finditer(r'!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])|<img\b[^>]*>', source, re.I):
                preceding = [a for a in anchors if a.end() <= m.start()]
                anchor = preceding[-1] if preceding else None
                nearby = source[anchor.end():m.start()] if anchor else ''
                if (anchor is None or not _anchor_label(anchor).startswith('fig:') or
                        anchor.start() in used or nearby.strip()):
                    issue('asset_identity_missing_or_ambiguous', target, source, m.start(), asset_kind='figure')
                else: used.add(anchor.start())
            # The official renderer adds a bold display label. Inspect only
            # its caption content, preserving that legitimate publication label.
            for m in re.finditer(r'(?m)^\*\*(?:图|Figure)\s+\d+[.]\*\*\s*(.*)$', source):
                if has_numbering_prefix(m[1]):
                    issue('caption_numbering_prefix', target, source, m.start(), caption=m[1])
        else:
            for m in re.finditer(r'\\caption(?:\[[^\]]*\])?\s*(?=\{)', source):
                caption = _braced(source, m.end())
                if caption and has_numbering_prefix(caption):
                    issue('caption_numbering_prefix', target, source, m.start(), caption=caption)
    for label in planned:
        if not counts[label]:
            issues.append({'code':'asset_missing', 'target':'main', 'source_line':None, 'label':label})
    return {'status':'WARNING' if issues else 'SUCCESS', 'assets_checked':checked, 'issues':issues}


def inspect_chapter_figures(chapters, output_format='latex_pdf'):
    """Chapter-authored images are distinct from official assembled wrappers."""
    issues = []; markdown = output_format == 'markdown'
    pattern = (r'!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])|<(?:img|figure)\b' if markdown else
               r'\\begin\{figure\*?\}|\\includegraphics\b')
    for chapter_id, text in chapters.items():
        source = visible_source(text, markdown)
        for m in re.finditer(pattern, source, re.I):
            issues.append({'code':'chapter_authored_figure', 'chapter_id':chapter_id,
                           'source_line':source.count('\n',0,m.start())+1,
                           'location':'chapter_source', 'message':'Locate this chapter in assembled sources; retain the official completed wrapper, remove the authored duplicate or placeholder.'})
    return issues
