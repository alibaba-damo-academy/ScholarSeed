"""Persistent, content-addressed Figure cards; only validated model-owned fields."""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
from .paths import internal,relative_internal,organized,canonical_source
from .contracts import source_lines,CpesError,digest
from .job_io import load_job,content_from_card,schema_template


def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def value_hash(value):return hashlib.sha256(canonical(value).encode()).hexdigest()


def valid_origin(value):
    return (isinstance(value,dict) and set(value)=={'run_dir','run_id','figure_id','backend','model'}
            and all(isinstance(value[k],str) and value[k] for k in ('run_dir','run_id','figure_id'))
            and value['backend'] in ('api','codex')
            and (value['model'] is None or isinstance(value['model'],str)))


def default_directory():
    return Path(os.environ.get('CPES_FIGURE_CACHE_DIR',str(Path.home()/'.cache/cpes/figure-cards')))


def checked_content(raw,job,skill):
    from .figures import validate_content
    validate_content(raw,skill.output_schema(job))
    card,repairs=skill.merge_content(raw,job)
    if repairs or skill.validate_normalized(card,job):raise ValueError('Cached card does not satisfy current contract')
    return card


def previous_ledger_signature(signature):
    """Only the known v3 -> v4 field deletion is compatible, not other policy edits."""
    if signature['policy_sha256'] != 'ff1b49e2f00b407efa3a4594834a5e6cb10c85ef38d302fabd339cde9b58ca8b':
        return None
    previous = copy.deepcopy(signature)
    previous['policy_sha256'] = '71877a60b899fc7ac0f8ad0a1b1f36c0852bf7ea1bb03353f16e062ae70ab28f'
    schema = previous['schema']
    if 'evidence_ledger' in schema['properties']:return None
    schema['required'].append('evidence_ledger')
    schema['properties']['evidence_ledger'] = {
        'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
        'required': ['kind', 'statement'], 'properties': {
            'kind': {'type': 'string', 'enum': ['visual', 'author', 'synthesis', 'unknown']},
            'statement': {'type': 'string'}}}}
    return previous


def previous_card_signatures(signature):
    """Project only known field deletions; any unrelated policy change is a miss."""
    if signature['policy_sha256'] != '30770334e959769f10f32ab9df0694f170b1538e01f68bae73a159284a4b23d0':
        return []
    previous = copy.deepcopy(signature)
    previous['policy_sha256'] = 'ff1b49e2f00b407efa3a4594834a5e6cb10c85ef38d302fabd339cde9b58ca8b'
    for name in ('cannot_conclude', 'uncertainties'):
        previous['schema']['required'].append(name)
        previous['schema']['properties'][name] = {'type': 'array', 'items': {'type': 'string'}}
    return [previous, previous_ledger_signature(previous)]


def previous_prerequisites_signature(signature):
    """Only the known prerequisites deletion preserves all remaining semantics."""
    if signature['policy_sha256'] != 'd22ba4b908fc6f604764a341ae91cb93d58e90bff4707d67c12afe31df472d0d':
        return None
    previous=copy.deepcopy(signature)
    previous['policy_sha256']='05bc341171d24640699900fc6d9a0f8c5dfce1aab3f6c25e1ff36ca230bca3e0'
    schema=previous['schema']
    schema['required'].insert(schema['required'].index('scope'),'prerequisites')
    schema['properties']['prerequisites']={'type':'array','items':{'type':'string'}}
    return previous


class FigureCache:
    def __init__(self,directory=None):
        self.directory=Path(directory or default_directory()).expanduser().resolve()

    def has_pdf(self,pdf_sha256):
        return any((self.directory/pdf_sha256).glob('*.json'))

    def identity(self,job,skill,*,legacy=False):
        packet=skill.model_packet(job,legacy=legacy)
        for span in packet['evidence_catalog']:
            span['file']=job.get('source_aliases',{}).get(span['file'],canonical_source(span['file'],job['card_template']['paper_id']))
        schema=skill.output_schema(job)
        if legacy:
            schema['properties']['author_findings']['items']['properties']['evidence_ids']['items']['enum']=[r['evidence_id'] for r in packet['evidence_catalog']]
        signature={'version':1,'pdf_sha256':job['pdf_locator']['pdf_sha256'],
                   'image_sha256':[digest(path) for path in job['image_files']],
                   'packet':packet,'schema':schema,
                   'policy_sha256':('30770334e959769f10f32ab9df0694f170b1538e01f68bae73a159284a4b23d0' if legacy else digest(skill.SKILL_DIR/'references/model-instructions.md')),
                   'context_mode':job['context_mode'],'language':'unspecified','prompt_version':1 if legacy else 2}
        if job.get('wire_prefix'):signature['wire_prefix_sha256']=hashlib.sha256(job['wire_prefix'].encode()).hexdigest()
        # Preserve identities of historical Chinese-only policies, not a current default.
        if legacy or signature['policy_sha256'] in {
            '71877a60b899fc7ac0f8ad0a1b1f36c0852bf7ea1bb03353f16e062ae70ab28f',
            'ff1b49e2f00b407efa3a4594834a5e6cb10c85ef38d302fabd339cde9b58ca8b',
            '30770334e959769f10f32ab9df0694f170b1538e01f68bae73a159284a4b23d0',
            'c6cc958ed90f0e780be793dcb6ce49ba8470808001f9f4aae10e698375ca8bd4',
            '05bc341171d24640699900fc6d9a0f8c5dfce1aab3f6c25e1ff36ca230bca3e0',
            'd22ba4b908fc6f604764a341ae91cb93d58e90bff4707d67c12afe31df472d0d',
        }:signature['language']='zh-CN'
        # Preserve the verified historical V5 key. New named experiments bind
        # their full release contract, including prefix/language, into identity.
        config=skill.reader_config(job)
        if not legacy and config['version'] not in ('V5','unversioned'):
            signature['reader_release_sha256']=config['release_sha256']
            signature['language']=config['language']
        key=value_hash(signature)
        return key,signature,self.directory/signature['pdf_sha256']/f'{key}.json'

    def lookup(self,job,skill):
        hit=self._lookup(job,job,skill)
        if hit is not None:return hit
        # Older caption-only jobs referenced a byte-identical copied caption.
        # Rebuild only that known alias; never match cards by Figure number alone.
        source=job['card_template']['source']['tex_file']
        if canonical_source(source,job['card_template']['paper_id']).startswith('conversion/') and source.endswith('/caption.md'):
            root=Path(job['card_json']).parents[2]
            try:sha=digest(root/source)
            except OSError:return None
            template=job['card_template'];legacy=copy.deepcopy(job)
            alias=f"sources/{template['paper_id']}.{template['figure_id']}.caption/v_{sha[:12]}/body.txt"
            legacy['card_template']['source']['tex_file']=alias
            for mention in legacy['context']['numbered_mentions']:
                if mention['file']==source:mention['file']=alias
            return self._lookup(legacy,job,skill)
        return None

    def _lookup(self,identity_job,delivery_job,skill):
        from .figures import validate_content
        _, signature, _ = self.identity(identity_job, skill)
        candidates=[signature]
        prior=previous_prerequisites_signature(signature)
        if prior is not None:candidates.append(prior)
        # Exact predecessor policy only: changing representation must not rerun a
        # model, but arbitrary reading-rule changes must still invalidate reuse.
        if signature['policy_sha256']=='c6cc958ed90f0e780be793dcb6ce49ba8470808001f9f4aae10e698375ca8bd4':
            _, previous, _=self.identity(identity_job,skill,legacy=True)
            candidates.extend([previous,*previous_card_signatures(previous)])
        def location(row):return (row['file'],row['line_start'],row['line_end'])
        current_ids={location(row):row['evidence_id'] for row in signature['packet']['evidence_catalog']}
        for candidate in candidates:
            key = value_hash(candidate)
            path = self.directory / candidate['pdf_sha256'] / f'{key}.json'
            try:
                entry=json.loads(path.read_text(encoding='utf-8'))
                if entry['key']!=key or entry['signature']!=candidate or value_hash(entry['raw'])!=entry['raw_sha256']:
                    continue
                if not valid_origin(entry['origin']):continue
                validate_content(entry['raw'], candidate['schema'])
                raw = {name: copy.deepcopy(entry['raw'][name]) for name in skill.MUTABLE_FIELDS}
                aliases={row['evidence_id']:current_ids[location(row)] for row in candidate['packet']['evidence_catalog']}
                for finding in raw['author_findings']:
                    finding['evidence_ids']=[aliases[e] for e in finding['evidence_ids']]
                card=checked_content(raw,delivery_job,skill)
                return {'key':key,'card':card,'raw':raw,'origin':entry['origin'],'cache_file':str(path)}
            except (OSError,ValueError,KeyError,TypeError):continue
        return None

    def save(self,job,skill,raw,origin):
        checked_content(raw,job,skill)
        if not valid_origin(origin):raise ValueError('Invalid card origin')
        key,signature,path=self.identity(job,skill)
        value={'key':key,'signature':signature,'raw':raw,'raw_sha256':value_hash(raw),'origin':origin}
        path.parent.mkdir(parents=True,exist_ok=True)
        temporary=None
        try:
            with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,delete=False) as stream:
                temporary=Path(stream.name);stream.write(canonical(value)+'\n')
            os.replace(temporary,path)
        finally:
            if temporary:temporary.unlink(missing_ok=True)
        return key


def import_cards(run_dir,*,cache_dir=None,skills_root=None):
    """Register existing CPES run evidence without executing a model."""
    from .figures import load_skill,card_prompt
    root=Path(run_dir).expanduser().resolve();skill=load_skill(skills_root);cache=FigureCache(cache_dir)
    try:
        state=json.loads((internal(root,'run.json')).read_text(encoding='utf-8'))
        if digest(state['pdf'])!=state['pdf_sha256']:raise ValueError('PDF changed')
    except (OSError,ValueError,KeyError,TypeError) as exc:
        raise CpesError('invalid_card_run','无法验证原 CPES 运行及 PDF 身份。') from exc
    if internal(root,'index.json').is_file():
        from .bundle import import_packed_cards
        return import_packed_cards(root,state,cache,skill)
    imported=[];skipped=[]
    for path in sorted((internal(root,'figure-cards/jobs')).glob('*.job.json')):
        try:
            job=load_job(path);stem=path.name.removesuffix('.job.json')
            evidence=internal(root,'figure-cards/sdk-evidence')/stem
            record=json.loads((evidence/'result.json').read_text(encoding='utf-8'))
            if record['status']!='completed':raise ValueError('Card did not complete')
            if job['pdf_locator']['pdf_sha256']!=state['pdf_sha256']:raise ValueError('PDF identity mismatch')
            card_path=Path(job['card_json']).resolve()
            if not card_path.is_relative_to(root):raise ValueError('Card path outside run')
            for image in job['image_files']:
                if not Path(image).resolve().is_relative_to(root):raise ValueError('Image path outside run')
            # Verify frozen extraction bytes, including the crop, against its original catalog.
            catalogs=list((internal(root,'conversion')).glob('*/catalog.json'))
            artifacts={}
            for catalog_path in catalogs:
                catalog=json.loads(catalog_path.read_text(encoding='utf-8'))
                if catalog['source']['sha256']!=state['pdf_sha256']:continue
                for figure in catalog['domains']['figure'].get('figures',[]):
                    for item in figure['artifacts']:
                        base=root if catalog.get('artifact_base')=='run' else catalog_path.parent
                        artifacts[(base/item['path']).resolve()]=item['sha256']
            if any(artifacts.get(Path(p).resolve())!=digest(p) for p in job['image_files']):
                raise ValueError('Image hash mismatch')
            for span in skill.model_packet(job)['evidence_catalog']:
                source=(root/span['file']).resolve()
                if not source.is_relative_to(root) or source_lines(source.read_bytes().decode('utf-8'))[span['line_start']-1]!=span['text']:
                    raise ValueError('Source line mismatch')
            prompt=card_prompt(skill,job)
            if (evidence/'prompt.txt').exists():
                if (evidence/'prompt.txt').read_text(encoding='utf-8')!=prompt:
                    raise ValueError('Reader instructions or packet changed')
            else:
                if record.get('prompt_sha256')!=hashlib.sha256(prompt.encode()).hexdigest():
                    raise ValueError('Reader instructions or packet changed')
                if record.get('card_sha256')!=digest(card_path):raise ValueError('Card hash mismatch')
                if (internal(root,'figure-cards/reader-policy.md')).read_bytes()!=(skill.SKILL_DIR/'references/model-instructions.md').read_bytes():
                    raise ValueError('Reader policy changed')
                if json.loads((internal(root,'figure-cards/content-schema.json')).read_text())!=schema_template(skill.output_schema(job)):
                    raise ValueError('Card schema changed')
            raw_path=evidence/'raw-model-card.json'
            raw=json.loads(raw_path.read_text(encoding='utf-8')) if raw_path.exists() else content_from_card(
                json.loads(card_path.read_text(encoding='utf-8')),job,skill)
            card=checked_content(raw,job,skill)
            if card!=json.loads(card_path.read_text(encoding='utf-8')):raise ValueError('Card differs from validated output')
            origin={'run_dir':str(root),'run_id':state['run_id'],'figure_id':stem,
                    'backend':state.get('figure_backend'),'model':record.get('model')}
            if record.get('reused'):origin=record.get('origin')
            key=cache.save(job,skill,raw,origin)
            imported.append({'figure':job['card_template']['caption']['number'],'key':key})
        except (OSError,ValueError,KeyError,TypeError,IndexError,AttributeError) as exc:
            skipped.append({'job':path.name,'reason':str(exc)})
    return {'status':'completed' if imported and not skipped else 'partial' if imported else 'failed',
            'imported':imported,'skipped':skipped,'cache_dir':str(cache.directory),'model_calls':0}
