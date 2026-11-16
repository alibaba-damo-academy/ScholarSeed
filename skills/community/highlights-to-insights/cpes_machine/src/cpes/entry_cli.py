"""Explicit latest reader entry. Legacy scripts/cpes.py is deliberately unchanged."""
import argparse
from pathlib import Path
import json
from . import entry
from .task_input import load_json
from .contracts import write_json


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('info',help='Report actual reader versions without calling a model')
    p=sub.add_parser('prepare-pdf',help='CPU extraction and reader preparation; no model calls')
    p.add_argument('--pdf',required=True);p.add_argument('--output',required=True)
    p.add_argument('--kind',choices=('figure','table'),required=True)
    p.add_argument('--number',action='append',default=[])
    p.add_argument('--include-appendix',action='store_true')
    p.add_argument('--figure-profile',choices=('deep','fast'),default='deep')
    p.add_argument('--converter-python');p.add_argument('--model',default='qwen3.8-max')
    p=sub.add_parser('prepare',help='Prepare an existing hydrated CPES job; no model calls')
    p.add_argument('--kind',choices=('figure','table'),required=True)
    p.add_argument('--job',required=True);p.add_argument('--source-root',required=True);p.add_argument('--output',required=True)
    p.add_argument('--model',default='qwen3.8-max')
    p=sub.add_parser('request',help='Export the exact API request for an external caller; no model calls')
    p.add_argument('--prepared',required=True);p.add_argument('--output',required=True)
    p=sub.add_parser('assemble',help='Validate a supplied response and recover source quotations; no model calls')
    p.add_argument('--prepared',required=True);p.add_argument('--response',required=True);p.add_argument('--output',required=True)
    p=sub.add_parser('run',help='Explicit model execution of a prepared PDF run; one attempt per object')
    p.add_argument('--prepared-run',required=True);p.add_argument('--backend',choices=('codex','api'),default='codex')
    p.add_argument('--concurrency',type=int,default=8);p.add_argument('--model');p.add_argument('--profile')
    args=parser.parse_args(argv)
    try:
        if args.command=='info':result=entry.describe()
        elif args.command=='prepare-pdf':
            plan=entry.prepare_pdf(args.pdf,args.output,kind=args.kind,numbers=args.number,include_appendix=args.include_appendix,
                figure_profile=args.figure_profile,converter_python=args.converter_python,model=args.model)
            result={'status':'prepared','extraction_status':plan['extraction_status'],'jobs':len(plan['jobs']),
                    'model_calls':0,'entry':plan['entry'],'run':str(Path(args.output).resolve())}
        elif args.command=='run':
            full=entry.run_plan(args.prepared_run,backend=args.backend,concurrency=args.concurrency,model=args.model,profile=args.profile)
            result={k:v for k,v in full.items() if k!='records'}
        else:
            target=Path(args.output)
            if target.exists():raise ValueError('Refusing to overwrite output')
            if args.command=='prepare':value=entry.prepare(args.kind,load_json(args.job),args.source_root,model=args.model)
            elif args.command=='request':value=entry.request_for(load_json(args.prepared))
            else:
                response=load_json(args.response)
                if response.get('status') not in (None,'completed'):raise ValueError('Provider response incomplete')
                value=entry.assemble(load_json(args.prepared),entry.response_text(response))
            write_json(target,value);result={'status':'completed','model_calls':0,'output':str(target.resolve())}
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0 if result.get('status') in (None,'completed','prepared') else 1
    except Exception as exc:
        print(json.dumps({'status':'failed','error_type':type(exc).__name__,'message':str(exc) if isinstance(exc,ValueError) else 'See local configuration and preserved run artifacts.'},ensure_ascii=False))
        return 1


if __name__=='__main__':raise SystemExit(main())
