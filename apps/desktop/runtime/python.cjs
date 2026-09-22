const fs = require('node:fs')
const path = require('node:path')

const SKILL_PYTHON_COMMAND = 'scholarseed-skill-python'
const SKILL_PYTHON_MODULE = 'service.cli.skill_python'

function skillPythonLauncherPath(directory, platform = process.platform) {
  const suffix = platform === 'win32' ? '.cmd' : ''
  return path.join(directory, `${SKILL_PYTHON_COMMAND}${suffix}`)
}

function relativePythonPath(directory, python) {
  const launcherDirectory = fs.realpathSync(directory)
  const pythonDirectory = fs.realpathSync(path.dirname(python))
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
      `"%~dp0${relative.split(path.sep).join('\\')}" -m ${SKILL_PYTHON_MODULE} %*`,
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
    `exec "$here/${relative.split(path.sep).join('/')}" -m ${SKILL_PYTHON_MODULE} "$@"`,
    ''
  ].join('\n')
  const launcher = path.join(directory, SKILL_PYTHON_COMMAND)
  fs.writeFileSync(launcher, command)
  fs.chmodSync(launcher, 0o755)
  return launcher
}

module.exports = { SKILL_PYTHON_COMMAND, SKILL_PYTHON_MODULE, skillPythonLauncherPath,
  writeSkillPythonLauncher }
