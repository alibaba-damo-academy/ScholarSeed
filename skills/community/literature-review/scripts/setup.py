"""Verify the product environment without installing a private skill venv."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
from platform_runtime import PYTHON_REQUIREMENT, supports_python, utf8_env


def main():
    if not supports_python(sys.version_info):
        raise SystemExit(f'{PYTHON_REQUIREMENT} is required by the product environment.')
    product_python = Path(sys.executable)
    env = utf8_env()
    for args in (['-m', 'pip', 'check'],):
        subprocess.run([str(product_python), '-X', 'utf8', *args], check=True, env=env)
    return subprocess.call([str(product_python), '-X', 'utf8', str(ROOT / 'scripts/slr.py'),
                            'doctor', '--no-network', '--json'], env=env)


if __name__ == '__main__':
    raise SystemExit(main())
