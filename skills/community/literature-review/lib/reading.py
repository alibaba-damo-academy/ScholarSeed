"""Consume product-validated reading assets as content; provenance stays in Serve."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

from task_contract import atomic_json

BUNDLE_SCHEMA = 'slr-reading/v1'
RETRIEVAL = '02_retrieval'
PROCESSING = '03_process'
BUNDLE = 'reading_assets.json'
MARKER = 'reading_asset'
SELECTION_ERRORS = frozenset({'reading_selection_changed', 'reading_selection_unbound'})
RUN_PREFIX = 'slr-'
RUN_HASH_CHARS = 16


def load(path, default):
    return json.loads(Path(path).read_text()) if Path(path).is_file() else default


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def material_selection(paper):
    return {key: value for key, value in paper.items() if key not in ('authors', 'author_metadata')}


def bound_selection(workspace, value):
    selected = load(Path(workspace) / RETRIEVAL / 'selected_paper.json', {})
    baseline = json.loads(value.get('selection_json') or '{}')
    problems = {pid: 'reading_selection_changed' for pid in selected
                if pid not in baseline or material_selection(selected[pid]) != material_selection(baseline[pid])}
    return selected, problems


def bundle(workspace):
    try:
        value = load(Path(workspace) / RETRIEVAL / BUNDLE, {})
    except (ValueError, OSError):
        return {}, {}, "invalid_reading_bundle"
    if not isinstance(value, dict):
        return {}, {}, "invalid_reading_bundle"
    if not value:
        return {}, {}, "no_reading_bundle"
    try:
        binding = load(Path(workspace) / ".slr-binding.json", {})
    except (ValueError, OSError):
        return {}, {}, "invalid_reading_binding"
    if not isinstance(binding, dict):
        return {}, {}, "invalid_reading_binding"
    relative = value.get("workspace", "")
    parts = Path(relative).parts if isinstance(relative, str) else ()
    if (
        (not parts and relative != ".")
        or Path(relative).is_absolute()
        or ".." in parts
        or (parts and tuple(Path(workspace).resolve().parts[-len(parts) :]) != parts)
    ):
        return {}, {}, "reading_workspace_mismatch"
    expected_run = binding.get("run_id") or RUN_PREFIX + sha(relative)[:RUN_HASH_CHARS]
    if value.get("run_id") != expected_run:
        return {}, {}, "reading_run_mismatch"
    if value.get("schema") != BUNDLE_SCHEMA:
        return {}, {}, "stale_reading_bundle"
    if not isinstance(value.get("assets"), dict) or not isinstance(value.get("misses"), dict):
        return {}, {}, "invalid_reading_bundle"
    try:
        selected, problems = bound_selection(workspace, value)
    except json.JSONDecodeError:
        return {}, {}, "invalid_reading_selection"
    except (ValueError, OSError) as exc:
        return {}, {}, str(exc) if isinstance(exc, ValueError) else "invalid_reading_selection"
    assets = {
        pid: asset for pid, asset in value["assets"].items()
        if pid in selected and pid not in problems
    }
    return assets, {**value["misses"], **problems}, None



def validation_context(workspace):
    assets, _, error = bundle(workspace)
    return {'assets': assets, 'error': error}


def imported_problem(workspace, pid, paper, info, card, context=None):
    context = context or validation_context(workspace)
    asset = context['assets'].get(pid)
    if asset is None:
        return context['error'] or 'reading_asset_unavailable'
    revision = asset['source_snapshot']['source_revision'].removeprefix('sha256:')
    return None if card.get('asset_revision') == revision else 'reading_source_changed'


def preserves_task_card(paper, info, card):
    return bool(card and card.get('asset_revision') and card.get('card'))


def import_assets(workspace):
    ws = Path(workspace)
    selected = load(ws / RETRIEVAL / 'selected_paper.json', {})
    assets, misses, error = bundle(ws)
    info_path = ws / RETRIEVAL / 'paper_info.json'
    cards_path = ws / PROCESSING / 'paper_cards.json'
    info, cards = load(info_path, {}), load(cards_path, {})
    imports = {}
    for pid, asset in assets.items():
        if pid not in selected:
            continue
        revision = asset['source_snapshot']['source_revision'].removeprefix('sha256:')
        l1 = copy.deepcopy(asset['l1'])
        content = '\n'.join(fragment['text'] for fragment in asset['source_snapshot']['fragments'].values())
        info[pid] = {'info_type': 'saved_l1', 'sentences': content, MARKER: revision}
        cards[pid] = {**l1, 'paperId': pid, 'title': selected[pid]['title'],
                      'authors': selected[pid].get('authors', []), 'year': selected[pid].get('year'),
                      'abstract': selected[pid].get('abstract', ''), 'asset_revision': revision,
                      'source_coverage': asset['metadata'].get('coverage', {}), MARKER: revision}
        imports[pid] = revision
    if assets:
        atomic_json(info_path, info)
        atomic_json(cards_path, cards)
    return {'schema': BUNDLE_SCHEMA, 'imports': imports, 'reused_count': len(imports),
            'reasons': misses, 'error': error}
