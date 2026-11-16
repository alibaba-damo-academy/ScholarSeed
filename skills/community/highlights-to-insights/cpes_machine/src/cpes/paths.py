"""Two-directory delivery layout, with legacy run paths still readable."""
import json
from pathlib import Path


def organized(root):return (Path(root)/'system').is_dir()


def internal(root,name):
    root=Path(root)
    return root/('system' if organized(root) else '')/name


def relative_internal(root,name):return internal(root,name).relative_to(root).as_posix()


def card_path(root,number):
    if organized(root):return Path(root)/'figure-cards'/f'figure-{number}'/'card.json'
    return Path(root)/'figure-cards/cards'/f'figure-{number}.json'


def answer_path(root):
    if (Path(root)/'table-cards').is_dir():return Path(root)/'table-cards/README.md'
    return Path(root)/'figure-cards/README.md' if organized(root) else Path(root)/'answers/final.md'


def job_root(path):
    candidate=Path(path).parents[2]
    if candidate.name=='system' and (candidate/'run.json').is_file():
        state=json.loads((candidate/'run.json').read_text(encoding='utf-8'))
        if state.get('layout_version')==2:return candidate.parent
    return candidate


def canonical_source(name,paper_id):
    # Layout-only moves must not invalidate a source-bound card cache.
    if name.startswith(('system/conversion/','system/sources/')):return name.removeprefix('system/')
    parts=Path(name).parts
    if len(parts)==3 and parts[0]=='figure-cards' and parts[1].startswith('figure-') and parts[2]=='caption.md':
        return f'conversion/{paper_id}/figures/{parts[1]}/caption.md'
    return name
