#!/usr/bin/env scholarseed-skill-python
"""Parse one downloaded PDF/LaTeX archive into caption-preserving #N text."""
from pathlib import Path
import argparse
import json
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'lib'))
from paper_source_parser import parse_source

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('source')
    ap.add_argument('--output-dir',required=True)
    args=ap.parse_args()
    try:
        result=parse_source(args.source,args.output_dir)
        print(json.dumps({k:v for k,v in result.items() if k!='sentences'},ensure_ascii=False))
        return 0 if result['status']=='ok' else 2
    except Exception as exc:
        print(json.dumps({'status':'failed','error':str(exc)},ensure_ascii=False));return 1

if __name__=='__main__':raise SystemExit(main())
