"""Lossless, bounded reading files for a human or main-agent editorial review."""
import hashlib
import json
from pathlib import Path


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def utf8_parts(text, limit):
    """Split only at character boundaries; concatenation exactly restores text."""
    part, size = [], 0
    for char in text:
        width = len(char.encode('utf-8'))
        if part and size + width > limit:
            yield ''.join(part)
            part, size = [], 0
        part.append(char)
        size += width
    if part:
        yield ''.join(part)


def export_reading(packet, root, max_bytes=3500):
    if max_bytes < 4:
        raise ValueError('reading limit must fit a UTF-8 character')
    # Hash directory keeps older packets auditable and avoids stale mixed files.
    dest = Path(root) / packet['base_sha256']
    dest.mkdir(parents=True, exist_ok=True)
    entries = []
    buffer, segments = '', []
    def flush():
        nonlocal buffer, segments
        if not segments:
            return
        name = f"part-{len(entries) + 1:03d}.txt"
        (dest / name).write_text(buffer, encoding='utf-8')
        entries.append({'file': name, 'bytes': len(buffer.encode('utf-8')),
                        'sha256': sha(buffer), 'segments': segments})
        buffer, segments = '', []
    if max_bytes < 200:
        raise ValueError('reading limit must fit headers')
    for block in packet['blocks']:
        parts = list(utf8_parts(block['text'], max_bytes - 150)) or ['']
        for index, text in enumerate(parts, 1):
            header = f"\n--- block {block['id']} part {index}/{len(parts)} ---\n"
            if len((buffer + header + text).encode('utf-8')) > max_bytes:
                flush()
            buffer += header
            segments.append({'block_id': block['id'], 'block_sha256': block['sha256'],
                             'part': index, 'parts': len(parts), 'offset_bytes': len(buffer.encode('utf-8')),
                             'bytes': len(text.encode('utf-8')), 'sha256': sha(text)})
            buffer += text
    flush()
    manifest = {'base_sha256': packet['base_sha256'], 'review_complete': False,
                'max_file_bytes': max_bytes, 'blocks': len(packet['blocks']), 'files': entries,
                'instructions': 'Read every listed file in order, at most two per tool output. A truncated output is not read. Use block IDs and full block hashes for patches, joining split parts without separators and excluding the marked block headers. Preparing these files does not perform or certify review.',
                'asset_lifecycle': 'v1 contains references; generation_publish inserts planned assets. Do not investigate missing inline asset code in v1. Inspect the actual images, table assets and final PDF separately.',
                'semantic_checks': ['Check theorem assumptions and distinguish stationarity from optimality.',
                                    'Check claims that a guarantee or experiment is absent against the available original source.',
                                    'Verify numerical claims, method attribution and every table row; qualify incomplete evidence.',
                                    'Check mathematical meaning of each figure, not just style.'],
                'patch_schema': packet['patch_schema']}
    index_path = dest / 'index.json'
    index_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    manifest = {**manifest, 'files': [e['file'] for e in entries], 'index': str(index_path)}
    path = dest / 'manifest.json'
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'reading_manifest': str(path), 'reading_directory': str(dest),
            'reading_index': str(index_path), 'reading_files': len(entries), 'reading_blocks': len(packet['blocks']),
            'max_file_bytes': max_bytes, 'review_complete': False,
            'next': 'Read manifest then all listed bounded text files, inspect evidence and assets, apply editorial patch; publish inserts assets into v2.'}
