"""One immutable skill binding per workspace; no shell session state."""
from pathlib import Path
import shlex
import sys
import os
import json
from platform_runtime import PRODUCT_LAUNCHER_MODULE
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
        if not path.is_file() or actual not in (legacy,expected):
            raise ValueError('workspace launcher already exists or skill binding changed; choose a new entry location')
        return path
    atomic_json(config,expected)
    body='''#!/usr/bin/env bash
set -euo pipefail
SLR_BOUND_WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec SKILL_PYTHON SKILL_DRIVER "$SLR_BOUND_WORKSPACE" "$@"
'''.replace('SKILL_PYTHON',shlex.quote(sys.executable)+' -X utf8 -m '+PRODUCT_LAUNCHER_MODULE).replace('SKILL_DRIVER',shlex.quote(str(skill/'scripts/workspace_entry.py')))
    if os.name=='nt':
        python=sys.executable.replace('%','%%')
        driver=str(skill/'scripts/workspace_entry.py').replace('%','%%')
        body=('@echo off\nsetlocal DisableDelayedExpansion\n'
              'for /f "tokens=2 delims=:" %%C in (\'chcp\') do set "SLR_OLD_CP=%%C"\n'
              'chcp 65001 >nul\n'
              f'"{python}" -X utf8 -m {PRODUCT_LAUNCHER_MODULE} "{driver}" "%~dp0." %*\n'
              'set "SLR_EXIT=%errorlevel%"\n'
              'if defined SLR_OLD_CP chcp %SLR_OLD_CP% >nul\nexit /b %SLR_EXIT%\n')
    with path.open('x',encoding='utf-8',newline='\r\n' if os.name=='nt' else '\n') as f: f.write(body)
    if os.name!='nt':path.chmod(0o755)
    return path
