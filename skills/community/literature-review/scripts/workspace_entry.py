"""Validate a workspace binding and dispatch through the bound launcher."""
import json
import os
from pathlib import Path
import sys
import subprocess

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
from platform_runtime import utf8_env, product_command


def main():
    ws=Path(sys.argv[1]).resolve(); args=sys.argv[2:]
    binding=json.loads((ws/'.slr-binding.json').read_text(encoding='utf-8'))
    skill=Path(__file__).resolve().parents[1]
    if binding.get('skill')!=str(skill) or binding.get('version')!=(skill/'VERSION').read_text().strip():
        raise SystemExit('skill binding changed; restore the bound version or explicitly rebind the workspace')
    if binding.get('platform',sys.platform)!=sys.platform or binding.get('workspace',str(ws))!=str(ws):
        raise SystemExit('workspace moved or platform changed; restore its binding before resuming')
    python=binding.get('python') or sys.executable
    if not Path(python).is_file():
        raise SystemExit('bound Python is missing; restore the environment')
    if sys.version_info[:2]!=(3,12):
        raise SystemExit('workspace requires Python 3.12.x')
    for i,arg in enumerate(args):
        supplied=args[i+1] if arg=='--workspace' and i+1<len(args) else arg.split('=',1)[1] if arg.startswith('--workspace=') else None
        if supplied is not None and Path(supplied).resolve()!=ws:
            raise SystemExit('explicit workspace conflicts with this bound launcher')
    if Path(python).resolve() != Path(sys.executable).resolve():
        raise SystemExit('current product Python conflicts with workspace binding')
    os.environ['SLR_WORKSPACE']=str(ws)
    raise SystemExit(subprocess.call(product_command(skill/'scripts/slr.py',*args),env=utf8_env()))


if __name__=='__main__': main()
