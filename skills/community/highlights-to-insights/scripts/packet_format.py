"""Reading signals lead model input; full evidence and exact provenance remain available."""
import json
import re

from packet_selection import caption_start
from source_ids import display_source_id


def quoted(value):
    return json.dumps(value, ensure_ascii=False)


def id_list(ids):
    """Compact only truly consecutive IDs, retaining discontinuous groups."""
    groups = []
    for sid in ids:
        if groups and sid[0] == groups[-1][-1][0] and int(sid[1:]) == int(groups[-1][-1][1:]) + 1:
            groups[-1].append(sid)
        else:
            groups.append([sid])
    return ', '.join(display_source_id(g[0]) if len(g) == 1 else f'{display_source_id(g[0])}–{display_source_id(g[-1])}' for g in groups)


def normalized(value):
    chars, positions = [], []
    for i, char in enumerate(value):
        if char.isspace():
            if chars and chars[-1] != ' ':
                chars.append(' '); positions.append(i)
        else:
            chars.append(char); positions.append(i)
    if chars and chars[-1] == ' ':
        chars.pop(); positions.pop()
    return ''.join(chars), positions


def unique_anchor(text, mark, sid):
    haystack, positions = normalized(text)
    needle, _ = normalized(mark)
    if not needle or haystack.count(needle) != 1:
        return None
    offset = haystack.index(needle)
    start, end = positions[offset], positions[offset + len(needle) - 1] + 1
    exact = text[start:end]
    # The excerpt identifies the start; the local range retains the full extent.
    quote = exact
    words = list(re.finditer(r'\S+', exact))
    for word in words[2:12]:
        candidate = exact[:word.end()]
        if text.count(candidate) == 1:
            quote = candidate
            break
    return {'source_id': sid, 'start': start, 'end': end, 'text': exact, 'quote': quote}


def formula_piece(source):
    text = source['text'].strip()
    return bool(text) and len(text) < 140 and not re.search(r'[A-Za-z]{4,}|[\u4e00-\u9fff]', text)


def near_formula(left, right):
    if left['page'] != right['page']:
        return False
    a, b = left['rects'][0], right['rects'][0]
    return abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) < 200 and max(a[1], b[1]) - min(a[3], b[3]) <= 40


def build_view(index, sources):
    selected = [sid for sid, source in sources.items() if source["kind"] == "paper_text"]
    continuation = index['packet_selection'].get('caption_continuations', {})
    consumed, units = set(), []
    for position, sid in enumerate(selected):
        if sid in consumed:
            continue
        source = sources[sid]
        ids, kind = [sid], 'paragraph'
        if caption_start(source['text']):
            ids += continuation.get(sid, [])
            kind = 'caption'
        elif formula_piece(source):
            run = [sid]
            for following in selected[position + 1:]:
                if following in consumed or not formula_piece(sources[following]) or not near_formula(sources[run[-1]], sources[following]):
                    break
                run.append(following)
            text = '\n'.join(sources[s]['text'] for s in run)
            if (len(run) >= 3 or len(source['text'].splitlines()) >= 3) and re.search(r'[=∑∫⊙λθϕψ]|\(\d+\)', text):
                ids, kind = run, 'formula_fragments'
        parts, ranges, offset = [], {}, 0
        for source_id in ids:
            value = sources[source_id]['text']
            ranges[source_id] = [offset, offset + len(value)]
            parts.append(value); offset += len(value) + 1
        consumed.update(ids)
        units.append({'source_ids': ids, 'pages': sorted({sources[s]['page'] for s in ids}),
                      'kind': kind, 'text': '\n'.join(parts), 'source_ranges': ranges, 'verified': False})
    signals = []
    for source in sources.values():
        if not source['record_ids']:
            continue
        anchors = []
        if source['text'] and source['kind'] != 'external_note':
            for sid in source['context_ids']:
                if sid in selected:
                    anchor = unique_anchor(sources[sid]['text'], source['text'], sid)
                    if anchor:
                        anchors.append(anchor)
        signals.append({'source_id': source['id'], 'association': source['association'],
                        'anchors': anchors, 'context_ids': source['context_ids'],
                        'target_source_id': source.get('target_source_id')})
    supplement_names = {}
    for match in re.finditer(
        r'\b(?:(?i:Supplements?)\s+(?:[A-Z]|\d+)\b|'
        r'(?i:Supplementary\s+(?:Information|Materials?|Methods?|Notes?))(?:\s+(?:[A-Z]|\d+)\b)?)',
        '\n'.join(u['text'] for u in units)):
        name = ' '.join(match.group(0).split())
        supplement_names.setdefault(name.casefold(), name)
    supplements = sorted(supplement_names.values())
    return {'schema_version': 1, 'offset_convention': 'Unicode code points, zero-based, half-open, exact B text',
            'units': units, 'signals': signals, 'supplement_references': supplements,
            'cross_reference_coverage': 'literal figure/table references and supplement names only; completeness not established'}


def render_packet(index, sources):
    from object_policy import apply_object_policy
    view = apply_object_policy(index, sources, build_view(index, sources))
    index['packet_view'] = view
    doc = index['document']
    title = doc.get('metadata', {}).get('title', '').strip() or '未识别（以 PDF 原文为准）'
    first_text = '\n'.join(s['text'] for s in sources.values() if s['kind'] == 'paper_text' and s['page'] == 1)
    doi = re.search(r'10\.\d{4,9}/[^\s<>]+', first_text)
    note_count = sum(s['kind'] == 'external_note' for s in sources.values())
    visual = index['coverage']['channels']['visual']
    visual_state = ('未执行；本次仅使用文字证据' if not visual['reviewed_pages'] else
                    '已记录检查页：' + ', '.join(map(str, visual['reviewed_pages'])))
    packet = ['# 论文与材料状态',
              f'题目：{title}', f'DOI：{doi.group(0).rstrip(".,;)") if doi else "未识别"}',
              f'页数：{doc["page_count"]}（以下 p 均为 PDF 物理页码）',
              f'独立笔记：{str(note_count) + " 段" if note_count else "未提供"}',
              f'视觉处理：{visual_state}',
              '补充材料：' + ('、'.join(view['supplement_references']) + '；可用性及覆盖范围未核实' if view['supplement_references'] else '未核实；未检出引用不代表不存在'),
              '取材范围：保留正文解释；独立图表、图注和公式仅在被标记、明确询问或解释关注点所需时纳入。边界和依赖关系为程序候选。',
              '未纳入对象的来源索引仍保留在本地。锚点范围为原文 Unicode 码点零基左闭右开区间。']
    if index['goal']:
        packet.append('阅读目标：' + quoted(index['goal']))
    excluded = index['packet_selection']['object_filter']['excluded_units']
    if excluded:
        packet.append('已跳过未关注独立对象：' + str(len(excluded)) + ' 个；详细来源索引留在本地。')
    fragments = [id_list(u['source_ids']) for u in view['units'] if u['kind'] == 'formula_fragments']
    if fragments:
        packet.append('公式缺口：' + '; '.join(fragments) + ' 为原生排版片段，结构未核验；相关解释与定义保留在邻近原文。')
    unresolved = index['packet_selection']['unresolved_cross_references']
    if unresolved:
        packet.append('待定位图表引用：' + '; '.join(f'{display_source_id(r["source_id"])}: {r["reference"]}' for r in unresolved))
    unsupported = [a['name'] for a in index['attachments'] if a['status'] != 'parsed']
    if unsupported:
        packet.append('未解析附件：' + ', '.join(unsupported))
    packet += ['', '# 阅读标记']
    packet.append('以下完整标注与评论决定笔记的关注点；使用某条阅读信号时引用其 A/N ID，相关 B ID 是补充证据，不能替代它。')
    for signal in sorted(view['signals'], key=lambda item: not bool(sources[item['source_id']].get('comment'))):
        source = sources[signal['source_id']]
        label = display_source_id(source['id'])
        if signal['target_source_id']:
            label += ' → ' + display_source_id(signal['target_source_id'])
        targets = list(dict.fromkeys(a['source_id'] for a in signal['anchors']))
        if targets:
            label += ' → ' + id_list(targets)
        elif signal['context_ids']:
            label += ' → 候选 ' + id_list(signal['context_ids'])
        elif source['page']:
            label += f' → 仅定位 p{source["page"]}'
        else:
            label += ' → 文献级，未定位段落'
        if source['association'] == 'spatial_candidate' and targets:
            label += '（空间候选）'
        if source['text']:
            label += ' | ' + ('个人笔记：' if source['kind'] in ('external_note', 'embedded_note') else '原标记文字：') + quoted(source['text'])
        if signal['anchors']:
            label += ' | 范围：' + '; '.join(f"@{display_source_id(a['source_id'])}[{a['start']}:{a['end']}]" for a in signal['anchors'])
        if source.get('comment'):
            label += ' | 评论：' + quoted(source['comment'])
        packet.append(label)
    packet += ['', '# 原文证据']
    related = {}
    for signal in view['signals']:
        for sid in signal['context_ids']:
            related.setdefault(sid, []).append(signal['source_id'])
    # Keep every selected evidence unit once, with marked context before background.
    for unit in sorted(view['units'], key=lambda item: not any(sid in related for sid in item['source_ids'])):
        label = id_list(unit['source_ids']) + ' p' + ','.join(map(str, unit['pages']))
        references = list(dict.fromkeys(mark for sid in unit['source_ids'] for mark in related.get(sid, [])))
        if references:
            label += ' | 对应阅读标记：' + id_list(references) + '（上下文关联，不代表笔记已引用这些标记）'
        if unit['kind'] == 'formula_fragments':
            label += ' | 公式排版片段，未核验（不代表完整公式）'
        elif unit['kind'] == 'caption':
            label += ' | 图表说明；续段关系为程序候选'
        packet += ['', label, unit['text']]
    return '\n'.join(packet) + '\n'
