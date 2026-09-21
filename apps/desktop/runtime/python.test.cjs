const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { SKILL_PYTHON_COMMAND, writeSkillPythonLauncher } = require('./python.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

test('Generated Skill launcher refuses managed execution without a valid bridge scope', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-skill-admission-'))
  try {
    const launcher = writeSkillPythonLauncher(path.join(root, 'bin'), productPython())
    const script = path.join(root, 'run.py')
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'skill')
    fs.writeFileSync(script, 'print("should-not-run")')
    const result = spawnSync(launcher, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCHOLARSEED_BRIDGE_SESSION: 'test-session',
        SCHOLARSEED_BRIDGE_TOKEN: '',
        SCHOLARSEED_BRIDGE_SOCKET: '',
        SCHOLARSEED_INTERNAL_BASE_URL: ''
      }
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Skill unavailable/)
    assert.equal(result.stdout, '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function productPython() {
  return process.platform === 'win32'
    ? path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(REPO_ROOT, '.venv', 'bin', 'python')
}

test('Skill Python launcher resolves a relative interpreter and preserves POSIX arguments', () => {
  if (process.platform === 'win32') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-skill-python-'))
  const backend = path.join(root, 'backend')
  const bin = path.join(backend, 'bin')
  const python = path.join(backend, 'python', 'bin', 'python3')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.writeFileSync(python, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 })
  const launcher = writeSkillPythonLauncher(bin, python)
  const result = spawnSync(launcher, ['-c', 'payload', '含空格 中文'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), ['-m', 'service.cli.skill_python', '-c', 'payload', '含空格 中文'])
  const source = fs.readFileSync(launcher, 'utf8')
  assert.match(source, /\.\.\/python\/bin\/python3/)
  assert.doesNotMatch(source, /SCHOLARSEED_PYTHON/)
  assert.equal(path.basename(launcher), SKILL_PYTHON_COMMAND)
})

test('Windows Skill Python launcher forwards the complete argument vector', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-skill-python-'))
  const bin = path.join(root, 'backend', 'bin')
  const launcher = writeSkillPythonLauncher(bin, productPython(), 'win32')
  const source = fs.readFileSync(launcher, 'utf8')
  assert.match(source, /%\*/)
  assert.match(source, /-m service\.cli\.skill_python %\*/)
  assert.doesNotMatch(source, /SCHOLARSEED_PYTHON/)
  if (process.platform !== 'win32') return
  const probe = path.join(root, 'probe.py')
  const driver = path.join(root, 'driver.cmd')
  fs.writeFileSync(probe, [
    'import json',
    'import sys',
    'print(json.dumps({"argv": sys.argv[1:], "stdin": sys.stdin.read()}, ensure_ascii=False))',
    ''
  ].join('\r\n'))
  fs.writeFileSync(driver, [
    '@echo off',
    `call "${launcher}" "${probe}" --query "含空格中文“引号”"`,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n'))
  const input = '{"query":"heredoc 中文 引号"}\n'
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${driver}"`], {
    encoding: 'utf8',
    input
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['--query', '含空格中文“引号”'],
    stdin: input
  })
})

test('Skill Python uses the product interpreter for imports and child Python', () => {
  const python = productPython()
  assert.equal(fs.existsSync(python), true, `product Python is missing: ${python}`)
  const temporaryRoot = path.join(REPO_ROOT, 'tmp')
  fs.mkdirSync(temporaryRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'scholarseed-product-python-'))
  const bin = path.join(root, 'backend', 'bin')
  const launcher = writeSkillPythonLauncher(bin, python)
  const probe = path.join(root, 'probe.py')
  fs.writeFileSync(probe, [
    'import json',
    'import subprocess',
    'import sys',
    'import playwright',
    'child = subprocess.run([sys.executable, "-c", "import sys; print(sys.executable)"], check=True, capture_output=True, text=True)',
    'print(json.dumps({"argv": sys.argv[1:], "child": child.stdout.strip(), "executable": sys.executable, "stdin": sys.stdin.read()}, ensure_ascii=False))',
    ''
  ].join('\n'))
  const input = '{"query":"heredoc 中文 引号"}\n'
  const arguments = [probe, '--query', '含空格中文“引号”']
  let result
  if (process.platform === 'win32') {
    const driver = path.join(root, 'product-driver.cmd')
    fs.writeFileSync(driver, [
      '@echo off',
      `call "${launcher}" "${probe}" --query "含空格中文“引号”"`,
      'exit /b %errorlevel%',
      ''
    ].join('\r\n'))
    result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${driver}"`], {
      encoding: 'utf8',
      input
    })
  } else {
    const poison = path.join(root, 'host-bin')
    fs.mkdirSync(poison)
    for (const name of ['python', 'python3']) {
      fs.writeFileSync(path.join(poison, name), '#!/bin/sh\nexit 91\n', { mode: 0o755 })
    }
    result = spawnSync(launcher, arguments, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${poison}${path.delimiter}${process.env.PATH || ''}` },
      input
    })
  }
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(payload.argv, arguments.slice(1))
  assert.equal(path.resolve(payload.executable), path.resolve(python))
  assert.equal(path.resolve(payload.child), path.resolve(python))
  assert.equal(payload.stdin, input)
})
