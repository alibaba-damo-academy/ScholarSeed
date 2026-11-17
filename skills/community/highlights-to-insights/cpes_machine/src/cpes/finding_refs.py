"""Render selected source spans without presenting partial text as a finding."""
from html import escape
from pathlib import Path
import re


def merged_spans(findings):
    groups = {}
    for finding in findings:
        for span in finding.get('evidence', []):
            groups.setdefault((span['file'], span.get('kind')), []).append(span)
    for spans in groups.values():
        current = None
        for span in sorted(spans, key=lambda s: (int(s['line_start']), int(s['line_end']))):
            span = dict(span, line_start=int(span['line_start']), line_end=int(span['line_end']))
            if current is not None and current['line_start'] <= span['line_start'] <= current['line_end'] + 1 and span['line_end'] >= span['line_start']:
                current['line_end'] = max(current['line_end'], span['line_end'])
            else:
                if current is not None:
                    yield current
                current = span
        if current is not None:
            yield current


def render_findings(findings, source_root):
    root = Path(source_root).resolve()
    if any('evidence_unit_ids' in finding for finding in findings):
        # Preserve each complete selection as a citation group. Its individual
        # source intervals remain separate; an intervening float is never read.
        groups=[];seen=set()
        for finding in findings:
            evidence=list(merged_spans([finding]))
            identity=tuple((s['file'],s['line_start'],s['line_end'],s.get('kind')) for s in evidence)
            if identity in seen:continue
            seen.add(identity);labels=[]
            for file,kind in dict.fromkeys((s['file'],s.get('kind')) for s in evidence):
                intervals='、'.join(f"L{s['line_start']}" +
                    (f"–L{s['line_end']}" if s['line_end']!=s['line_start'] else '')
                    for s in evidence if s['file']==file and s.get('kind')==kind)
                labels.append(('Caption' if kind=='caption' else 'Body')+' '+intervals)
            groups.append('**'+' · '.join(labels)+'**\n\n'+render_findings([{'evidence':evidence}],root))
        return '\n\n'.join(groups) if groups else '- None reported.'
    blocks = []
    seen = set()
    for span in merged_spans(findings):
        file = span['file']
        start, end = int(span['line_start']), int(span['line_end'])
        key = (file, start, end, span.get('kind'))
        if key in seen:
            continue
        seen.add(key)
        kind = 'Caption' if span.get('kind') == 'caption' else 'Body'
        label = f'{kind} L{start}' + (f'–L{end}' if end != start else '')
        path = (root / file).resolve()
        try:
            path.relative_to(root)
            lines = path.read_text(encoding='utf-8').splitlines()
            if not 1 <= start <= end <= len(lines):
                raise ValueError('source span out of bounds')
        except (OSError, ValueError):
            blocks.append(f'- {label} — source unavailable ({escape(str(file))}).')
            continue
        # The expansion works in Markdown viewers supporting details; the
        # absolute file:line link also opens the original in the Codex UI.
        excerpt = '\n'.join(f'L{i}  {lines[i-1]}' for i in range(start, end+1))
        blocks.append(f'<details>\n<summary>{label}</summary>\n\n'
                      f'[{label}](<{path}:{start}>) · `{file}`\n\n'
                      f'<pre>{escape(excerpt)}</pre>\n\n</details>')
    return '\n\n'.join(blocks) if blocks else '- None reported.'


def replace_findings(markdown, findings, source_root):
    section = '## Author findings\n\n' + render_findings(findings, source_root) + '\n\n'
    return re.sub(r'^## Author findings\n.*?(?=^## |\Z)', lambda _: section,
                  markdown, count=1, flags=re.M | re.S)
