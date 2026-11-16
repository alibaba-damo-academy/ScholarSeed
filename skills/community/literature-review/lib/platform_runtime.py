"""Standard-library runtime discovery shared by launchers, doctor and binding."""
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys

PRODUCT_LAUNCHER_MODULE = 'service.cli.skill_python'
MIN_PYTHON = (3, 12)
PYTHON_REQUIREMENT = f'Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ within {MIN_PYTHON[0]}.x'


def supports_python(version):
    return (isinstance(version, (tuple, list)) and len(version) >= len(MIN_PYTHON)
            and all(type(part) is int and part >= 0 for part in version[:len(MIN_PYTHON)])
            and version[0] == MIN_PYTHON[0]
            and tuple(version[:len(MIN_PYTHON)]) >= MIN_PYTHON)


def product_command(script, *arguments):
    """Use the public launcher module without a shell or platform script suffix."""
    return [sys.executable, '-X', 'utf8', '-m', PRODUCT_LAUNCHER_MODULE,
            str(script), *map(str, arguments)]


def venv_python(root, windows=None):
    windows = os.name == 'nt' if windows is None else windows
    return Path(root) / '.venv' / ('Scripts/python.exe' if windows else 'bin/python')


def utf8_env(base=None):
    env = dict(os.environ if base is None else base)
    env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1',
               PYTHONDONTWRITEBYTECODE='1')
    return env


def probe_python(command):
    try:
        result = subprocess.run([*command, '-X', 'utf8', '-c',
            'import json,sys; print(json.dumps({"python":sys.executable,'
            '"version":list(sys.version_info[:3]),"prefix":sys.prefix}))'],
            capture_output=True, encoding='utf-8', timeout=10, env=utf8_env())
        info = json.loads(result.stdout) if result.returncode == 0 else None
        return info if isinstance(info, dict) and supports_python(info.get('version')) else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def discover_python(root, explicit=None, workspace=None):
    """A broken explicit or workspace binding never silently falls back."""
    binding = Path(workspace) / '.slr-binding.json' if workspace else None
    if binding and binding.is_file():
        value = json.loads(binding.read_text(encoding='utf-8'))
        candidate = value.get('python') or sys.executable
        info = probe_python([candidate])
        if not info:
            raise ValueError('Bound Python is unavailable; restore the workspace runtime.')
        if explicit and Path(explicit).absolute() != Path(candidate).absolute():
            raise ValueError('Explicit Python conflicts with the workspace binding.')
        return info
    if explicit:
        info = probe_python([explicit])
        if not info:
            raise ValueError(f'SCHOLARSEED_PYTHON must name an executable {PYTHON_REQUIREMENT}.')
        return info
    info = probe_python([sys.executable])
    if info:
        return info
    raise ValueError(f'The product requires {PYTHON_REQUIREMENT}; restore the ScholarSeed installation.')


def command_spec(argv):
    argv = [str(a) for a in argv]
    def cmd_quote(arg):
        escaped=re.sub(r'(\\*)"',lambda m:'\\'*(2*len(m[1])+1)+'"',arg)
        return '"' + escaped + '\\'*(len(arg)-len(arg.rstrip('\\'))) + '"'
    return {'argv': argv,
            'powershell': '& ' + ' '.join("'" + a.replace("'", "''") + "'" for a in argv),
            'cmd': None if any('%' in a or '!' in a for a in argv) else ' '.join(cmd_quote(a) for a in argv),
            'posix': shlex.join(argv)}


def runtime_info(root, workspace=None):
    root = Path(root).resolve()
    argv = product_command(root / 'scripts/slr.py')
    if workspace:
        argv = product_command(root / 'scripts/workspace_entry.py', Path(workspace).resolve())
    return {'os': platform.system(), 'architecture': platform.machine(),
            'wsl': sys.platform == 'linux' and ('microsoft' in platform.release().lower()
                                               or bool(os.environ.get('WSL_DISTRO_NAME'))),
            'shell_hint': os.environ.get('SLR_CALLER_SHELL') or os.environ.get('SHELL') or 'unknown',
            'python': sys.executable, 'python_version': platform.python_version(),
            'environment': sys.prefix, 'skill': str(root), 'cwd': str(Path.cwd()),
            'process_backend': 'windows_job' if os.name == 'nt' else 'posix_process_group',
            'cli': command_spec(argv)}
