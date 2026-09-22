"""Validate a workspace binding and dispatch through the bound launcher."""
import shutil
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import subprocess

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
from platform_runtime import utf8_env, product_command


BRIDGE_COMMAND = 'scholarseed-bridge'
BRIDGE_CONTEXT_KEYS = ('SCHOLARSEED_BRIDGE_TOKEN', 'SCHOLARSEED_BRIDGE_SESSION')
BRIDGE_ADDRESS_KEYS = ('SCHOLARSEED_BRIDGE_SOCKET', 'SCHOLARSEED_INTERNAL_BASE_URL')
TASK_TYPE = 'literature_review'
SKILL_NAME = 'literature-review'
DERIVED_RUN_PREFIX = 'slr-'
DERIVED_RUN_CHARS = 16


def _activate(workspace, binding, skill, version):
    workspace = Path(workspace).resolve()
    present_context = all(os.environ.get(key) for key in BRIDGE_CONTEXT_KEYS)
    present_address = any(os.environ.get(key) for key in BRIDGE_ADDRESS_KEYS)
    if not present_context and not present_address:
        return
    if not present_context or not present_address:
        raise SystemExit('incomplete ScholarSeed bridge context for task activation')
    try:
        relative = workspace.relative_to(Path.cwd().resolve())
    except ValueError as exc:
        raise SystemExit('bound workspace must be below the active ScholarSeed workdir') from exc
    if not relative.parts:
        raise SystemExit('bound workspace must be below the active ScholarSeed workdir')
    run_id = binding.get('run_id')
    if not isinstance(run_id, str) or not run_id:
        run_id = DERIVED_RUN_PREFIX + sha256(str(relative).encode()).hexdigest()[:DERIVED_RUN_CHARS]
    command = shutil.which(BRIDGE_COMMAND)
    if not command:
        raise SystemExit('scholarseed-bridge is unavailable for task activation')
    payload = {'task_type': TASK_TYPE, 'skill_name': SKILL_NAME,
               'skill_version': version, 'skill_path': str(skill),
               'workspace': str(relative), 'run_id': run_id}
    result = subprocess.run([command, 'task', 'activate', '--json', json.dumps(payload)],
                            check=False, capture_output=True, text=True)
    if result.returncode:
        detail = (result.stdout or result.stderr).strip()
        raise SystemExit(detail or 'ScholarSeed task activation failed')


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
    _activate(ws, binding, skill, binding['version'])
    raise SystemExit(subprocess.call(product_command(skill/'scripts/slr.py',*args),env=utf8_env()))


if __name__=='__main__': main()
