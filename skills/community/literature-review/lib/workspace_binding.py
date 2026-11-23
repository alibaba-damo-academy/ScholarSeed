"""One immutable skill binding per workspace; no shell session state."""
from pathlib import Path
import shlex
import sys
import os
import json
from platform_runtime import PRODUCT_LAUNCHER_MODULE, same_interpreter, INTERPRETER_LITERAL
from task_contract import atomic_json


def bind(workspace, skill):
    workspace=Path(workspace).resolve(); skill=Path(skill).resolve()
    path=workspace/('slr.cmd' if os.name=='nt' else 'slr'); config=workspace/'.slr-binding.json'
    version=(skill/'VERSION').read_text().strip()
    legacy={'skill':str(skill),'version':version}
    expected={**legacy,'schema_version':2,'workspace':str(workspace),
              'python':sys.executable,'platform':sys.platform}
    if path.exists() or path.is_symlink() or config.exists():
        actual=json.loads(config.read_text(encoding='utf-8')) if config.exists() else None
        if isinstance(actual,dict) and 'run_id' in actual:
            if not isinstance(actual['run_id'],str) or not actual['run_id']:
                raise ValueError('workspace run identity is invalid')
            actual={key:value for key,value in actual.items() if key!='run_id'}
        matches = actual == legacy
        if isinstance(actual, dict) and actual.keys() == expected.keys():
            matches = (all(actual[key] == value for key, value in expected.items() if key != 'python')
                       and same_interpreter(actual['python'], expected['python'], mode=INTERPRETER_LITERAL))
        if not path.is_file() or not matches:
            raise ValueError('workspace launcher already exists or skill binding changed; choose a new entry location')
        return path
    atomic_json(config,expected)
    body='''#!/usr/bin/env bash
set -euo pipefail
SLR_BOUND_WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec SKILL_PYTHON SKILL_DRIVER "$SLR_BOUND_WORKSPACE" "$@"
'''.replace('SKILL_PYTHON',shlex.quote(sys.executable)+' -X utf8 -m '+PRODUCT_LAUNCHER_MODULE).replace('SKILL_DRIVER',shlex.quote(str(skill/'scripts/workspace_entry.py')))
    if os.name=='nt':
        driver=str(skill/'scripts/workspace_entry.py').replace('%','%%')
        body=('@echo off\nsetlocal DisableDelayedExpansion\n'
              'for /f "tokens=2 delims=:" %%C in (\'chcp\') do set "SLR_OLD_CP=%%C"\n'
              'chcp 65001 >nul\n'
              'set "SLR_SKILL_PYTHON=%SCHOLARSEED_SKILL_PYTHON%"\n'
              'if not defined SLR_SKILL_PYTHON set "SLR_SKILL_PYTHON=scholarseed-skill-python"\n'
              f'call "%SLR_SKILL_PYTHON%" "{driver}" "%~dp0." %*\n'
              'set "SLR_EXIT=%errorlevel%"\n'
              'if defined SLR_OLD_CP chcp %SLR_OLD_CP% >nul\nexit /b %SLR_EXIT%\n')
    with path.open('x',encoding='utf-8',newline='\r\n' if os.name=='nt' else '\n') as f: f.write(body)
    if os.name!='nt':path.chmod(0o755)
    return path
