"""One immutable skill binding per workspace; no shell session state."""
from pathlib import Path
import shlex
from task_contract import atomic_json


def bind(workspace, skill):
    workspace=Path(workspace).resolve(); skill=Path(skill).resolve()
    path=workspace/'slr'; config=workspace/'.slr-binding.json'
    version=(skill/'VERSION').read_text().strip()
    expected={'skill':str(skill),'version':version}
    if path.exists() or path.is_symlink() or config.exists():
        import json
        if not config.exists() or not path.is_file() or json.loads(config.read_text())!=expected:
            raise ValueError('workspace launcher already exists or skill binding changed; choose a new entry location')
        return path
    atomic_json(config,expected)
    body='''#!/usr/bin/env bash
set -euo pipefail
SLR_BOUND_WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec SKILL_PYTHON SKILL_DRIVER "$SLR_BOUND_WORKSPACE" "$@"
'''.replace('SKILL_PYTHON', 'scholarseed-skill-python').replace('SKILL_DRIVER',shlex.quote(str(skill/'scripts/workspace_entry.py')))
    with path.open('x') as f: f.write(body)
    path.chmod(0o755)
    return path
