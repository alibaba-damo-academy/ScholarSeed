"""Deterministic native-line extraction and layout binding; no text rewriting."""
from __future__ import annotations

from .pdf import PDFDocument


def export_native_context(pdf, root, source_hash, *, figure_scope=None, cpes_direct=False):
    """Read text layers only; never render pages, detect layout, or run OCR."""
    from .common import artifact, sha256_file, write_json
    from .scope import before_boundary
    output = root / ('system' if cpes_direct else 'native-context')
    if not cpes_direct:
        output.mkdir()
    lines, skipped = [], []
    with PDFDocument(pdf) as document:
        for page in document:
            rows = native_lines(page, page.rect.width * 2, page.rect.height * 2)
            if not rows:
                skipped.append(page.number + 1)
            for row in rows:
                box=row['bbox_pixels'];width,height=page.rect.width*2,page.rect.height*2
                allowed=not figure_scope or figure_scope['mode']=='all' or before_boundary(
                    page.number+1,[box[0]/width,box[1]/height,box[2]/width,box[3]/height],figure_scope['boundary'])
                lines.append({**row, 'page_number': page.number + 1, 'line_number': len(lines) + 1,'in_figure_scope':allowed})
    body = output / 'document.txt'
    # Binary writing preserves embedded CR/form-feed glyphs without newline translation.
    with body.open('xb' if cpes_direct else 'wb') as stream:
        stream.write(''.join(row['text'] + '\n' for row in lines).encode('utf-8'))
    source_value = {'schema_version': 'cpes-text-source.v1', 'pdf_sha256': source_hash,
                    'text_sha256': sha256_file(body), 'line_count': len(lines), 'lines': lines,
                    'coordinate_space': 'pdf_render_2x_pixels_top_left',
                    'pages_without_native_text': skipped}
    result = {'status': 'success' if lines else 'success_empty', 'mode': 'native_only',
              'line_count': len(lines), 'pages_without_native_text': skipped}
    if cpes_direct:
        source_value['text_storage'] = 'document-lines'
        source_value['lines'] = [{key: value for key, value in row.items() if key != 'text'} for row in lines]
        result.update(source=source_value, artifacts=[artifact(body, root)])
    else:
        numbered = output / 'document.numbered.txt'
        numbered.write_text(''.join(f"{row['line_number']:06d}\t{row['text']}\n" for row in lines), encoding='utf-8')
        source = output / 'source.json'
        write_json(source, source_value)
        result['artifacts'] = [artifact(p, root) for p in (body, numbered, source)]
    return result



def native_lines(page, width, height):
    sx,sy=width/page.rect.width,height/page.rect.height
    result=[]
    for bi,block in enumerate(page.blocks):
        for li,line in enumerate(block['lines']):
            displayed=page.display_rect(line['rect'])
            result.append({'source_line_id':f'p{page.number+1:04d}-b{bi:04d}-l{li:04d}',
                           'text':line['text'],'bbox_points':line['rect'],'font_size':line['font_size'],'bold':line['bold'],
                           'bbox_pixels':[displayed.x0*sx,displayed.y0*sy,displayed.x1*sx,displayed.y1*sy],
                           'extraction_method':'native','coordinate_precision':'line'})
    return result


def area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def coverage(line, region):
    intersection = [max(line[0], region[0]), max(line[1], region[1]),
                    min(line[2], region[2]), min(line[3], region[3])]
    return area(intersection) / max(area(line), 1e-9)


def reading_order(blocks):
    """Recursive whitespace cuts order columns without merging their text."""
    if len(blocks) <= 1:
        return blocks
    for axis, gap in ((0, 20), (1, 6)):
        ordered = sorted(blocks, key=lambda b: b['block_bbox'][axis])
        edge = ordered[0]['block_bbox'][axis + 2]
        for i in range(1, len(ordered)):
            if ordered[i]['block_bbox'][axis] - edge >= gap:
                return reading_order(ordered[:i]) + reading_order(ordered[i:])
            edge = max(edge, ordered[i]['block_bbox'][axis + 2])
    return sorted(blocks, key=lambda b: (b['block_bbox'][1], b['block_bbox'][0], str(b['block_id'])))


def bind_lines(lines, layout):
    blocks = [{'block_id': i, 'block_label': box['label'],
               'block_bbox': box['coordinate'], 'block_content': '', 'source_lines': []}
              for i, box in enumerate(layout.get('boxes', [])) if area(box['coordinate']) > 0]
    unmatched = []
    for line in lines:
        candidates = [(coverage(line['bbox_pixels'], b['block_bbox']), b) for b in blocks]
        candidates = [(c, b) for c, b in candidates if c >= .5]
        if candidates:
            best = max(c for c, _ in candidates)
            # Broad parent regions retain lines when nested detections overlap.
            owner = max((b for c, b in candidates if c >= best - .05),
                        key=lambda b: area(b['block_bbox']))
            owner['source_lines'].append(line)
        else:
            unmatched.append({'block_id': line['source_line_id'], 'block_label': 'text',
                              'block_bbox': line['bbox_pixels'], 'block_content': line['text'],
                              'source_lines': [line], 'layout_unmatched': True})
    for block in blocks:
        block['block_content'] = '\n'.join(line['text'] for line in block['source_lines'])
    return reading_order(blocks + unmatched)
