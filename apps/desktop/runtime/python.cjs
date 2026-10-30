const fs = require('node:fs')
const path = require('node:path')

// cmd.exe cannot execute an extended path directly. A standard-library-only
// bootstrap starts the same Python via CRT, quotes argv, and returns its status.
const WINDOWS_PYTHON_BOOTSTRAP = "import os,sys,re;exe=os.path.abspath(sys.executable);q=chr(34);b=chr(92);prefix=b*2+'?'+b;exe=exe if exe.startswith(prefix) else prefix+'UNC'+exe[1:] if exe.startswith(b*2) else prefix+exe;args=[q+re.sub('('+re.escape(b)+'*)('+q+'|$)',lambda m:m[1]*2+(b+q if m[2] else ''),a)+q for a in [exe,*sys.argv[1:]]];raise SystemExit(os.spawnv(os.P_WAIT,exe,args))"

const SKILL_PYTHON_COMMAND = 'scholarseed-skill-python'
const SKILL_PYTHON_MODULE = 'service.cli.skill_python'

// Keep content identities in their canonical form. Only the process launch
// boundary needs an extended path for Python's dependent DLL loader.
function pythonExecutablePath(python, platform = process.platform) {
  return platform === 'win32' && path.win32.isAbsolute(python)
    ? path.win32.toNamespacedPath(python)
    : python
}

function skillPythonLauncherPath(directory, platform = process.platform) {
  const suffix = platform === 'win32' ? '.cmd' : ''
  return path.join(directory, `${SKILL_PYTHON_COMMAND}${suffix}`)
}

function relativePythonPath(directory, python) {
  const launcherDirectory = fs.realpathSync.native(directory)
  const pythonDirectory = fs.realpathSync.native(path.dirname(python))
  const relative = path.relative(launcherDirectory, path.join(pythonDirectory, path.basename(python)))
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`Cannot resolve product Python relative to ${directory}`)
  }
  return relative
}

function writeSkillPythonLauncher(directory, python, platform = process.platform) {
  fs.mkdirSync(directory, { recursive: true })
  const relative = relativePythonPath(directory, python)
  if (platform === 'win32') {
    const command = [
      '@echo off',
      'setlocal',
      `for %%I in ("%~dp0${relative.split(path.sep).join('\\')}") do set "SS_SKILL_PY=%%~fI"`,
      `"%SS_SKILL_PY%" -I -B -c "${WINDOWS_PYTHON_BOOTSTRAP}" -B -P -s -m ${SKILL_PYTHON_MODULE} %*`,
      ''
    ].join('\r\n')
    const launcher = skillPythonLauncherPath(directory, platform)
    fs.writeFileSync(launcher, command)
    return launcher
  }
  const command = [
    '#!/bin/sh',
    'set -eu',
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    `exec "$here/${relative.split(path.sep).join('/')}" -I -B -m ${SKILL_PYTHON_MODULE} "$@"`,
    ''
  ].join('\n')
  const launcher = path.join(directory, SKILL_PYTHON_COMMAND)
  fs.writeFileSync(launcher, command)
  fs.chmodSync(launcher, 0o755)
  return launcher
}

module.exports = { WINDOWS_PYTHON_BOOTSTRAP, SKILL_PYTHON_COMMAND, SKILL_PYTHON_MODULE, pythonExecutablePath, skillPythonLauncherPath,
  writeSkillPythonLauncher }
