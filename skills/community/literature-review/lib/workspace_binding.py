"""One immutable skill binding per workspace; no shell session state."""
import json
import shlex
import uuid
from pathlib import Path

from task_contract import atomic_json


def bind(workspace, skill):
    workspace=Path(workspace).resolve(); skill=Path(skill).resolve()
    path=workspace/'slr'; config=workspace/'.slr-binding.json'
    version=(skill/'VERSION').read_text().strip()
    expected={'skill':str(skill),'version':version}
    if path.exists() or path.is_symlink() or config.exists():
        binding=json.loads(config.read_text()) if config.exists() else {}
        if (not path.is_file() or any(binding.get(key)!=value for key,value in expected.items())
                or binding.get('workspace',str(workspace))!=str(workspace)):
            raise ValueError('workspace launcher already exists or skill binding changed; choose a new entry location')
        return path
    expected['workspace']=str(workspace)
    expected['run_id']=uuid.uuid4().hex
    atomic_json(config,expected)
    body='''#!/usr/bin/env bash
set -euo pipefail
SLR_BOUND_WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${SCHOLARSEED_PYTHON:-}" ]; then
  SLR_BOUND_PYTHON="$SCHOLARSEED_PYTHON"
else
  SLR_BOUND_PYTHON=SKILL_PYTHON
fi
exec "$SLR_BOUND_PYTHON" SKILL_DRIVER "$SLR_BOUND_WORKSPACE" "$@"
'''.replace('SKILL_PYTHON',shlex.quote(str(skill/'.venv/bin/python'))).replace('SKILL_DRIVER',shlex.quote(str(skill/'scripts/workspace_entry.py')))
    with path.open('x') as f: f.write(body)
    path.chmod(0o755)
    return path
