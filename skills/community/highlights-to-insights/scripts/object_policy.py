"""Local focus-based selection of recognizable standalone paper objects.

Detection and dependency links are candidates, never semantic completeness proofs.
This module performs no rendering, OCR, network or model calls.
"""
from contextlib import redirect_stdout
from io import StringIO
import re


EQUATION_REFERENCE = re.compile(
    r'(?:\b(?:equations?|eqs?\.?)|公式|式)\s*'
    r'((?:\(?\d+\)?)(?:\s*(?:,|and|&|to|–|-|和|及)\s*\(?\d+\)?)*)', re.I)


def equation_numbers(text):
    result = set()
    for match in EQUATION_REFERENCE.finditer(text):
        numbers = [int(n) for n in re.findall(r'\d+', match.group(1))]
        result.update(numbers)
        if len(numbers) == 2 and re.search(r'–|-|\bto\b', match.group(1), re.I):
            result.add(('range', min(numbers), max(numbers)))
    return result


def equation_matches(numbers, references):
    return bool(numbers & references) or any(
        isinstance(ref, tuple) and any(ref[1] <= n <= ref[2] for n in numbers) for ref in references)


def formula_text(text):
    """Recognize math-only text, retaining prose with inline math as prose."""
    if len(text) > 400 or not re.search(r'[=∑∫⊙]', text):
        return False
    words = re.findall(r'[A-Za-z]{3,}', text)
    functions = {'min', 'max', 'log', 'exp', 'sin', 'cos', 'relu', 'argmax', 'argmin', 'softmax'}
    return all(word.isupper() or word.lower() in functions for word in words)


def overlap_fraction(box, region):
    area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
    intersection = max(0, min(box[2], region[2]) - max(box[0], region[0])) * max(0, min(box[3], region[3]) - max(box[1], region[1]))
    return intersection / area if area else 0


def native_object_regions(page):
    """Use native PDF geometry only; do not send page images to a model."""
    result, issues = [], []
    try:
        for box in page.table_regions():
            result.append({'kind':'table','rect':list(box),'method':'native_table_candidate'})
    except (AttributeError,RuntimeError,ValueError,TypeError) as error:
        issues.append({'kind':'table','status':'unavailable','error':type(error).__name__})
    page_area=page.native_rect.get_area()
    for image in page.images:
        box=image['bbox']
        area=max(0,box[2]-box[0])*max(0,box[3]-box[1])
        if page_area and .01<area/page_area<.7:
            result.append({'kind':'figure','rect':list(box),'method':'native_image_candidate'})
    return result, issues


def apply_object_policy(index, sources, view):
    from packet_selection import OBJECT_REF, object_key

    selection = index['packet_selection']
    initial = set(selection['source_ids'])
    marked = {sid for source in sources.values() if source['record_ids'] for sid in source['context_ids']}
    user_texts = [index['goal']]
    for source in sources.values():
        if source['record_ids']:
            if source.get('comment'):
                user_texts.append(source['comment'])
            if source['kind'] in ('external_note', 'embedded_note'):
                user_texts.append(source['text'])
    requested = '\n'.join(user_texts)
    context = '\n'.join(sources[s]['text'] for s in marked)
    requested_keys = {object_key(m) for m in OBJECT_REF.finditer(requested)}
    dependency_keys = {object_key(m) for m in OBJECT_REF.finditer(context)}
    requested_equations = equation_numbers(requested)
    dependency_equations = equation_numbers(context)
    units = view['units']
    regions = {(p['page'], i): region for p in index['pages'] for i, region in enumerate(p.get('object_regions', []))}
    unit_regions = {}
    caption_keys = {}
    for i, unit in enumerate(units):
        if unit['kind'] == 'caption':
            match = OBJECT_REF.match(' '.join(unit['text'].split()))
            caption_keys[i] = object_key(match)
            continue
        for key, region in regions.items():
            if all(sources[sid]['page'] == key[0] and all(overlap_fraction(box, region['rect']) >= .85
                   for box in sources[sid]['rects']) for sid in unit['source_ids']):
                unit_regions[i] = key
                unit['kind'] = region['kind'] + '_text'
                break
        if unit['kind'] == 'paragraph' and formula_text(unit['text']):
            unit['kind'] = 'formula_text'
    # Bind captions to nearby regions of the same type. These remain candidates.
    caption_regions = {}
    for i, key in caption_keys.items():
        unit = units[i]
        box = sources[unit['source_ids'][0]]['rects'][0]
        choices = []
        for region_key, region in regions.items():
            r = region['rect']
            shared_x = max(0, min(box[2], r[2]) - max(box[0], r[0]))
            min_width = min(box[2] - box[0], r[2] - r[0])
            gap = max(0, box[1] - r[3], r[1] - box[3])
            if region_key[0] == unit['pages'][0] and region['kind'] == key[1] and min_width > 0 and shared_x / min_width > .35 and gap <= 120:
                choices.append((gap, region_key))
        if choices:
            best = min(c[0] for c in choices)
            caption_regions[i] = {key for distance, key in choices if distance <= best + 10}
    keep, reasons = set(), {}

    def retain(i, reason):
        keep.add(i)
        if reason not in reasons.setdefault(i, []):
            reasons[i].append(reason)

    for i, unit in enumerate(units):
        ids = set(unit['source_ids'])
        if unit['kind'] == 'paragraph':
            if ids & initial:
                retain(i, 'body_or_reading_context')
            continue
        if ids & marked:
            retain(i, 'marked_object_or_spatial_candidate')
        if i in caption_keys:
            if caption_keys[i] in requested_keys:
                retain(i, 'explicit_user_reference')
            if caption_keys[i] in dependency_keys:
                retain(i, 'marked_context_reference_candidate')
        if unit['kind'].startswith('formula'):
            numbers = {int(n) for n in re.findall(r'\((\d+)\)', unit['text'])}
            if equation_matches(numbers, requested_equations):
                retain(i, 'explicit_user_equation_reference')
            if equation_matches(numbers, dependency_equations):
                retain(i, 'marked_context_equation_reference')
            # Keep nearby definitions conservatively when the marked prose
            # explicitly discusses an objective/weight/definition.
            for sid in marked:
                source = sources[sid]
                if source['page'] not in unit['pages'] or not re.search(r'defin|given by|loss|objective|weight|regulari[sz]|定义|权重|损失|正则|目标函数', source['text'], re.I):
                    continue
                a = source['rects'][0]
                for member in unit['source_ids']:
                    b = sources[member]['rects'][0]
                    shared = max(0, min(a[2], b[2]) - max(a[0], b[0]))
                    gap = max(0, a[1] - b[3], b[1] - a[3])
                    if shared > 0 and gap <= 40:
                        retain(i, 'marked_definition_neighbor_candidate')
                        break
    marked_regions = set()
    for source in sources.values():
        if source['record_ids'] and source['page']:
            for key, region in regions.items():
                if key[0] == source['page'] and any(overlap_fraction(box, region['rect']) > .1 for box in source['rects']):
                    marked_regions.add(key)
    for i in keep:
        if i in unit_regions:
            marked_regions.add(unit_regions[i])
        marked_regions.update(caption_regions.get(i, set()))
    for i, key in unit_regions.items():
        if key in marked_regions:
            retain(i, 'focused_native_object_region_candidate')
    for i, keys in caption_regions.items():
        if keys & marked_regions:
            retain(i, 'focused_object_caption_candidate')
    # A caption without a detectable table grid can still have adjacent body
    # material; leave uncertain mixed text intact rather than guessing boundaries.
    retained = [unit for i, unit in enumerate(units) if i in keep]
    selected = {sid for unit in retained for sid in unit['source_ids']}
    excluded = [unit for i, unit in enumerate(units) if i not in keep and unit['kind'] != 'paragraph' and set(unit['source_ids']) & initial]
    selection.update(mode='body_text_plus_focus_objects', source_ids=[sid for sid in sources if sid in selected],
                     selected_paper_blocks=len(selected), selected_paper_characters=sum(len(sources[s]['text']) for s in selected),
                     scope='body prose plus marked/requested objects and candidate necessary dependencies; native object boundaries are heuristic')
    selection['reasons'] = {sid: selection['reasons'].get(sid, []) + reasons[i]
                           for i, unit in enumerate(units) if i in keep for sid in unit['source_ids']}
    selection['object_filter'] = {
        'policy': 'skip_unfocused_standalone_objects', 'version': 1,
        'excluded_source_ids': [sid for unit in excluded for sid in unit['source_ids']],
        'excluded_units': [{'kind': u['kind'], 'source_ids': u['source_ids']} for u in excluded],
        'retained_object_units': [{'kind': u['kind'], 'source_ids': u['source_ids'], 'reasons': reasons[i]}
                                  for i, u in enumerate(units) if i in keep and u['kind'] != 'paragraph'],
        'limits': 'Native standalone-object and dependency candidates only; mixed/uncertain prose is retained. No automatic visual interpretation or CPES generation.'}
    selection['visual_requirements'] = [row for row in selection['visual_requirements'] if set(row['source_ids']) & selected]
    view['units'] = retained
    return view
