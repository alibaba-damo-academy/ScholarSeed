"""Dependency-free launcher: select Python before importing the actual CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
from platform_runtime import discover_python, utf8_env, product_command


def main():
    args = sys.argv[1:]
    workspace = None
    for i, arg in enumerate(args):
        if arg == '--workspace' and i + 1 < len(args):
            workspace = args[i + 1]
        elif arg.startswith('--workspace='):
            workspace = arg.split('=', 1)[1]
    try:
        info = discover_python(ROOT, os.environ.get('SCHOLARSEED_PYTHON'), workspace)
        doctor = 'doctor' in args
        setup = args[:1] == ['setup']
        binding=Path(workspace)/'.slr-binding.json' if workspace else None
        if binding and binding.exists() and json.loads(binding.read_text(encoding='utf-8')).get('skill')!=str(ROOT):
            raise ValueError('Workspace is bound to a different skill; use its returned CLI.')
        if Path(info['python']).resolve() != Path(sys.executable).resolve():
            raise ValueError('Launch with the bound product interpreter.')
        script = 'setup.py' if setup else 'preflight.py' if doctor else 'slr.py'
        if doctor:
            return subprocess.call([sys.executable, '-X', 'utf8', str(ROOT / 'scripts' / script),
                                    *[arg for arg in args if arg != 'doctor']], env=utf8_env())
        return subprocess.call(product_command(ROOT / 'scripts' / script,
                                *(args[1:] if setup else args)), env=utf8_env())
    except (ValueError, OSError) as exc:
        print(json.dumps({'status': 'FAILED', 'code': 'RUNTIME_UNAVAILABLE', 'message': str(exc),
                          'expected_python': sys.executable}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
