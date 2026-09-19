"""Verbatim source windows for high-risk writing claims; never regenerate cards."""
import json
import re
from pathlib import Path

GUARANTEE = re.compile(r'(?i)stationar|theorem|proposition|lemma|convergen|converges|complexity|assumption')
DIMENSION = re.compile(r'(?i)\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten)[ -]+(?:objectives?|dimensions?)\b')
EXPERIMENT = re.compile(r'(?i)experiment|benchmark|environment|evaluat')


def sentences(text):
    if not isinstance(text, str):
        return []
    markers = list(re.finditer(r'(?m)^#(\d+)[ \t]+', text))
    return [(m[1], text[m.end():markers[i + 1].start() if i + 1 < len(markers) else len(text)].strip())
            for i, m in enumerate(markers)]


def source_windows(records, evidence, max_chars=64000):
    """Budgeted locator view, not an exhaustive proof or absence detector."""
    result, candidates = {}, {}
    for key, entry in evidence.items():
        pid = str(entry.get('paperId', ''))
        raw = records.get(pid) or {}
        if not isinstance(raw, dict):
            raw = {}
        seq = sentences(raw.get('sentences', ''))
        result[key] = {'paper_id': pid, 'source_path': '02_retrieval/paper_info.json',
                       'source_field': f'{pid}.sentences', 'available_sentences': len(seq),
                       'selected_sentences': [], 'exhaustive': False}
        # Rank substantive statements before short section labels. Keep nearby
        # definitions/assumptions as complete source sentences, with original IDs.
        guarantees = [i for i, (_, t) in enumerate(seq) if GUARANTEE.search(t) and len(t) >= 80]
        guarantees.sort(key=lambda i: (-(10 * bool(re.search(r'(?i)stationar', seq[i][1]))
                                       + 5 * bool(re.search(r'(?i)theorem|proposition|lemma', seq[i][1]))), -min(len(seq[i][1]), 600), i))
        experiments = [i for i, (_, t) in enumerate(seq) if DIMENSION.search(t) and EXPERIMENT.search(t)]
        anchors = guarantees[:2] + experiments[:2] + guarantees[2:6]
        order = list(dict.fromkeys(anchors))
        for i in anchors:
            # The anchor first prevents a long preceding sentence from crowding
            # out the claim; final output is restored to source order.
            for j in [i, i - 1, i + 1, i - 2, i + 2]:
                if 0 <= j < len(seq) and j not in order:
                    order.append(j)
        candidates[key] = (seq, order)
    selected, used, per_paper = {k: [] for k in evidence}, 0, {k: 0 for k in evidence}
    # Round-robin avoids spending the entire packet budget on its first paper.
    for rank in range(max((len(v[1]) for v in candidates.values()), default=0)):
        for key, (seq, order) in candidates.items():
            if rank >= len(order):
                continue
            index = order[rank]
            size = len(seq[index][1])
            if used + size <= max_chars and per_paper[key] + size <= 6000:
                selected[key].append(index)
                used += size
                per_paper[key] += size
    for key, indices in selected.items():
        seq = candidates[key][0]
        result[key]['selected_sentences'] = [{'sentence_id': seq[i][0], 'text': seq[i][1]} for i in sorted(indices)]
        result[key]['omitted_sentence_count'] = len(seq) - len(indices)
    return {'selection': 'Deterministic partial locator windows around guarantee/assumption and objective-dimension experiment statements. All text is verbatim; no sentence is shortened. This view cannot establish that a result or experiment is absent. Resolve conflicts using the original source; do not upgrade author claims or omit theorem assumptions.',
            'selected_characters': used, 'character_budget': max_chars, 'papers': result}


def load_source_windows(ws, evidence):
    path = Path(ws) / '02_retrieval/paper_info.json'
    records = json.loads(path.read_text()) if path.exists() else {}
    return source_windows(records, evidence)
