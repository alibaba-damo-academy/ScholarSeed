"""Store PDF jobs as verified source references; load legacy full packets too."""
from __future__ import annotations
import copy
import json
from pathlib import Path
from .contracts import source_lines,digest,write_json
from .paths import job_root


def source_path(root,relative):
    path=(root/relative).resolve()
    if not path.is_relative_to(root.resolve()):raise ValueError('Source path outside run')
    return path


def pack_job(job,root,caption_file):
    value=copy.deepcopy(job)
    value['storage']='source-references-v1'
    value['caption_file']=caption_file
    caption=value['card_template']['caption']
    caption.pop('text');caption.pop('display')
    files={caption_file,value['card_template']['source']['tex_file']}
    for row in value['context']['figure_source']:row.pop('text')
    for mention in value['context']['numbered_mentions']:
        files.add(mention['file'])
        for row in mention['lines']:row.pop('text')
    value['source_hashes']={name:digest(source_path(root,name)) for name in sorted(files)}
    return value


def save_job(path,job,root,caption_file):
    write_json(path,pack_job(job,root,caption_file))


def load_job(path):
    path=Path(path)
    job=json.loads(path.read_text(encoding='utf-8'))
    return hydrate_job(job,job_root(path))


def hydrate_job(value,root):
    job=copy.deepcopy(value)
    if 'storage' not in job:return job
    if job.pop('storage')!='source-references-v1':raise ValueError('Unsupported job storage')
    contents={}
    for name,sha in job.pop('source_hashes').items():
        source=source_path(root,name)
        if digest(source)!=sha:raise ValueError('Source hash mismatch: '+name)
        contents[name]=source.read_bytes().decode('utf-8')
    caption=contents[job.pop('caption_file')].rstrip('\n')
    job['card_template']['caption'].update(text=caption,display=caption)
    def restore(rows,name):
        lines=source_lines(contents[name])
        for row in rows:
            line=row['line']
            if type(line) is not int or not 1<=line<=len(lines):raise ValueError('Invalid source line')
            row['text']=lines[line-1]
    restore(job['context']['figure_source'],job['card_template']['source']['tex_file'])
    for mention in job['context']['numbered_mentions']:restore(mention['lines'],mention['file'])
    return job


def schema_template(schema):
    value=copy.deepcopy(schema)
    value['properties']['author_findings']['items']['properties']['evidence_ids']['items'].pop('enum',None)
    return value


def content_from_card(card,job,skill):
    """Reconstruct model-owned content for importing compact, validated deliveries."""
    if skill.validate_normalized(card,job):raise ValueError('Card does not satisfy current contract')
    raw={name:copy.deepcopy(card[name]) for name in skill.MUTABLE_FIELDS}
    def location(span):return tuple(span[k] for k in ('file','line_start','line_end','kind'))
    ids={location(span):eid for eid,span in skill.model_evidence_catalog(job).items()}
    raw['author_findings']=[{'claim':f['claim'],'evidence_ids':[ids[location(s)] for s in f['evidence']]} for f in card['author_findings']]
    return raw


def saved_jobs(root):
    """Return job IDs and hydrated jobs from a finished index or an active run."""
    from .paths import internal
    if internal(root,'index.json').is_file():
        from .bundle import read_index
        return {key:hydrate_job(value,root) for key,value in read_index(root)['jobs'].items()}
    return {p.name.removesuffix('.job.json'):load_job(p) for p in internal(root,'figure-cards/jobs').glob('*.job.json')}
