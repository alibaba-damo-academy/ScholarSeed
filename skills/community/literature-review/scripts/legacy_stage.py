"""Python dispatch for the two retained section-pipeline compatibility stages."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'lib'))
from platform_runtime import utf8_env


def main():
    stage=sys.argv[1]
    ws=Path(os.environ.get('SLR_WORKSPACE',Path.cwd()))
    gen=ws/'05_generation'
    gen.mkdir(parents=True,exist_ok=True)
    env=utf8_env()
    env.update(SLR_HOME=str(ROOT),SLR_WORKSPACE=str(ws),SLR_PROFILE='fast')
    def run(path,*args):
        return subprocess.call([sys.executable,'-X','utf8',str(ROOT/'scripts/generation'/path),*args],
                               cwd=ws,env=env)
    def read(path):
        p=gen/path
        return json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
    def finish(status,reason,**extra):
        print(json.dumps({'stage':stage,'status':status,'status_reason':reason,**extra},ensure_ascii=False))
        return int(status=='FAILED')
    if stage=='generation_prep':
        for path in ('_fast/phase00_bootstrap.py','drafting/_fast/collect_drafting_worklist.py'):
            if run(path):
                return finish('FAILED',path+' failed')
        sections=len(read('_internal/drafting_worklist.json').get('items',[]))
        if not sections:
            return finish('FAILED','drafting worklist is empty')
        tables_rc=run('tables/_fast/collect_table_specs.py')
        figures_rc=run('figures/_fast/collect_figures.py')
        tables=read('_internal/tables_worklist.json').get('items',[])
        figures=read('_internal/figures_worklist.json').get('items',[])
        return finish('PARTIAL_SUCCESS' if tables_rc or figures_rc else 'SUCCESS',
                      'Section contracts and asset worklists prepared',sections=sections,
                      tables=len(tables),figures=len(figures),table_ids=[t['table_id'] for t in tables],
                      worklist='05_generation/_internal/drafting_worklist.json')
    if stage!='generation_merge':
        return finish('FAILED','unknown compatibility stage')
    run('drafting/_fast/validate_drafts.py')
    drafts=read('_status/validate_drafts.json')
    if not drafts or drafts.get('missing') or drafts.get('invalid'):
        return finish('FAILED','section drafts incomplete',missing_sections=drafts.get('missing',[]),
                      invalid_sections=drafts.get('invalid',[]))
    run('tables/_fast/validate_tables.py')
    tables=read('_status/validate_tables.json')
    rc=run('merge/_fast/phase05_merge_full_draft.py','--stage','v1')
    merged=read('_status/phase05_merge_full_draft.json')
    if rc or not merged or merged.get('status')=='FAILED':
        return finish('FAILED','v1 merge failed')
    partial=(merged.get('status')=='PARTIAL_SUCCESS' or drafts.get('degraded')
             or tables.get('missing') or tables.get('invalid'))
    return finish('PARTIAL_SUCCESS' if partial else 'SUCCESS','full_draft_v1 merged',
                  tables_missing=len(tables.get('missing',[])),tables_invalid=len(tables.get('invalid',[])),
                  degraded_sections=len(drafts.get('degraded',[])))


if __name__=='__main__':
    raise SystemExit(main())
