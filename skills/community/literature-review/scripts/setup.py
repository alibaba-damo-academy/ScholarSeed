"""Verify the product environment without installing a private skill venv."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
from platform_runtime import utf8_env


def main():
    if sys.version_info[:2] != (3, 12):
        raise SystemExit('Python 3.12.x is required by the product environment.')
    product_python = Path(sys.executable)
    env = utf8_env()
    for args in (['-m', 'pip', 'check'],):
        subprocess.run([str(product_python), '-X', 'utf8', *args], check=True, env=env)
    return subprocess.call([str(product_python), '-X', 'utf8', str(ROOT / 'scripts/slr.py'),
                            'doctor', '--no-network', '--json'], env=env)


if __name__ == '__main__':
    raise SystemExit(main())
