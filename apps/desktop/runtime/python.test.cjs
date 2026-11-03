const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { WINDOWS_PYTHON_BOOTSTRAP, SKILL_PYTHON_COMMAND, pythonExecutablePath, writeSkillPythonLauncher } = require('./python.cjs')

const { consoleScriptLauncherCommand, skillPythonLauncherCommand } = require('./components.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const execFileAsync = promisify(execFile)

async function runTask(command, args, input, cwd, environment = {}) {
    const pending = execFileAsync(command, args, {
      encoding: 'utf8',
      windowsVerbatimArguments: process.platform === 'win32',
      env: {
        ...process.env, ...environment,
        SCHOLARSEED_TASK_CWD: cwd
      }
    })
    pending.child.stdin.end(input)
    return { status: 0, ...await pending }
}

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
  assert.deepEqual(result.stdout.trim().split('\n'), ['-I', '-B', '-m', 'service.cli.skill_python', '-c', 'payload', '含空格 中文'])
  const source = fs.readFileSync(launcher, 'utf8')
  assert.match(source, /\.\.\/python\/bin\/python3/)
  assert.doesNotMatch(source, /SCHOLARSEED_PYTHON/)
  assert.equal(path.basename(launcher), SKILL_PYTHON_COMMAND)
})

test('Windows Skill Python launcher forwards the complete argument vector', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-skill-python-'))
  const bin = path.join(root, 'backend', 'bin')
  const launcher = writeSkillPythonLauncher(bin, path.toNamespacedPath(productPython()), 'win32')
  const source = fs.readFileSync(launcher, 'utf8')
  assert.match(source, /%\*/)
  assert.match(source, /-m service\.cli\.skill_python %\*/)
  assert.match(source, /" -I -B -c /)
  assert.match(source, /" -B -P -s -m /)
  assert.doesNotMatch(source, /SCHOLARSEED_PYTHON/)
  if (process.platform !== 'win32') return
  const probe = path.join(root, 'probe.py')
  fs.writeFileSync(path.join(root, 'SKILL.md'), 'fixture')
  const driver = path.join(root, 'driver.cmd')
  fs.writeFileSync(probe, [
    'import json',
    'import sys',
    'print(json.dumps({"argv": sys.argv[1:], "stdin": sys.stdin.read()}, ensure_ascii=False))',
    ''
  ].join('\r\n'))
  fs.writeFileSync(driver, [
    '@echo off',
    `call "${launcher}" --task "${probe}" --query "%SS_SKILL_TEST_ARGUMENT%"`,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n'))
  const input = '{"query":"heredoc 中文 引号"}\n'
  const result = await runTask(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${driver}"`], input, root, { SS_SKILL_TEST_ARGUMENT: '含空格中文“引号”', PYTHONIOENCODING: 'utf-8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['--query', '含空格中文“引号”'],
    stdin: input
  })
})

test('Task bootstrap preserves arguments and children without exposing product packages', async () => {
  const python = productPython()
  assert.equal(fs.existsSync(python), true, `product Python is missing: ${python}`)
  const temporaryRoot = path.join(REPO_ROOT, 'tmp')
  fs.mkdirSync(temporaryRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'scholarseed-product-python-'))
  const bin = path.join(root, 'backend', 'bin')
  const launcher = writeSkillPythonLauncher(bin, python)
  const probe = path.join(root, 'probe.py')
  fs.writeFileSync(path.join(root, 'SKILL.md'), 'fixture')
  fs.writeFileSync(probe, [
    'import json',
    'import subprocess',
    'import sys',
    'import importlib.util',
    'child = subprocess.run([sys.executable, "-c", "import sys; print(sys.executable)"], check=True, capture_output=True, text=True)',
    'print(json.dumps({"argv": sys.argv[1:], "child": child.stdout.strip(), "executable": sys.executable, "stdin": sys.stdin.read(), "product_package": importlib.util.find_spec("playwright") is not None}, ensure_ascii=False))',
    ''
  ].join('\n'))
  const input = '{"query":"heredoc 中文 引号"}\n'
  const arguments = [probe, '--query', '含空格中文“引号”']
  let result
  if (process.platform === 'win32') {
    const driver = path.join(root, 'product-driver.cmd')
    fs.writeFileSync(driver, [
      '@echo off',
      `call "${launcher}" --task "${probe}" --query "含空格中文“引号”"`,
      'exit /b %errorlevel%',
      ''
    ].join('\r\n'))
    result = await runTask(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${driver}"`], input, root)
  } else {
    const poison = path.join(root, 'host-bin')
    fs.mkdirSync(poison)
    for (const name of ['python', 'python3']) {
      fs.writeFileSync(path.join(poison, name), '#!/bin/sh\nexit 91\n', { mode: 0o755 })
    }
    result = await runTask(launcher, ['--task', ...arguments], input, root, {
      PATH: `${poison}${path.delimiter}${process.env.PATH || ''}`
    })
  }
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(payload.argv, arguments.slice(1))
  const expectedPython = process.platform === 'win32'
    ? path.join(root, '.scholarseed', 'python', 'venv', 'Scripts', 'python.exe')
    : path.join(root, '.scholarseed', 'python', 'venv', 'bin', 'python')
  assert.equal(pythonExecutablePath(path.resolve(payload.executable)), pythonExecutablePath(expectedPython))
  assert.equal(pythonExecutablePath(path.resolve(payload.child)), pythonExecutablePath(expectedPython))
  assert.equal(payload.stdin, input)
  assert.equal(payload.product_package, false)
})

// These exercise cmd.exe with a real interpreter; a fake executable would miss
// quoting, environment inheritance and Python module-path behavior.
for (const mode of ['console', 'module', 'console-extended', 'module-extended', 'missing', 'unavailable']) {
  test(`Windows component command uses the owned interpreter: ${mode}`, { skip: process.platform !== 'win32' }, (t) => {
    const python = process.env.SCHOLARSEED_TEST_PYTHON || productPython()
    assert.ok(fs.existsSync(python), `real Python required: ${python}`)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss component 中文 ! & '))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const bin = path.join(root, 'backend', 'bin')
    const libraries = path.join(root, 'backend', 'pylibs')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(libraries)
    const linked = path.join(root, 'owned Python ! &')
    const interpreterDirectory = path.dirname(python)
    const parent = path.dirname(interpreterDirectory)
    const runtimeRoot = fs.existsSync(path.join(parent, 'pyvenv.cfg')) ? parent : interpreterDirectory
    fs.symlinkSync(runtimeRoot, linked, 'junction')
    const ownedPython = path.join(linked, path.relative(runtimeRoot, python))
    const probe = 'import json, os, sys; print(json.dumps(dict(executable=sys.executable, args=sys.argv[1:], libraries=os.environ.get(\'PYTHONPATH\'), bytecode=sys.dont_write_bytecode)))'
    fs.writeFileSync(path.join(libraries, 'component_probe.py'), probe)
    const command = mode.startsWith('module')
      ? skillPythonLauncherCommand('component_probe')
      : consoleScriptLauncherCommand(probe)
    fs.writeFileSync(path.join(bin, 'probe.cmd'), command)
    const env = { ...process.env, SCHOLARSEED_PYTHON: mode.endsWith('-extended') ? pythonExecutablePath(ownedPython) : ownedPython }
    // Case-insensitive Windows inheritance must not accidentally restore a real
    // value when testing the missing-context path.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'SCHOLARSEED_PYTHON' && key !== 'SCHOLARSEED_PYTHON') delete env[key]
    }
    if (mode === 'missing') delete env.SCHOLARSEED_PYTHON
    if (mode === 'unavailable') env.SCHOLARSEED_PYTHON = path.join(root, 'missing.exe')
    const result = spawnSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/v:off', '/s', '/c', 'probe.cmd "argument with spaces"'],
      { cwd: bin, env, encoding: 'utf8', timeout: 15_000, windowsVerbatimArguments: true })
    if (mode === 'missing' || mode === 'unavailable') {
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /runtime context is missing|runtime interpreter is unavailable/)
    } else {
      assert.equal(result.status, 0, result.stderr || String(result.error))
      const value = JSON.parse(result.stdout)
      assert.equal(value.executable.toLowerCase(), pythonExecutablePath(ownedPython).toLowerCase())
      assert.deepEqual(value.args, ['argument with spaces'])
      assert.equal(path.resolve(value.libraries.split(';')[0]), libraries)
      assert.equal(value.bytecode, true)
    }
  })
}

test('Python launch preserves canonical identities and uses extended Windows executable paths', () => {
  const python = 'C:\\runtime store\\中文\\python\\python.exe'
  assert.equal(pythonExecutablePath(python, 'win32'), `\\\\?\\${python}`)
  assert.equal(pythonExecutablePath(`\\\\?\\${python}`, 'win32'), `\\\\?\\${python}`)
  assert.equal(pythonExecutablePath('/runtime/python/bin/python3', 'darwin'), '/runtime/python/bin/python3')
  assert.equal(pythonExecutablePath('python', 'win32'), 'python')
})

test('Deep packaged Python loads dependent extensions and propagates its executable to children', {
  skip: process.platform !== 'win32' || !process.env.SCHOLARSEED_TEST_PYTHON
    ? 'Requires the actual archived Python component at a deep Windows path' : false,
}, () => {
  const python = process.env.SCHOLARSEED_TEST_PYTHON
  assert.ok(python.length >= 190, 'The reproduction must exercise a deep interpreter path')
  const result = spawnSync(pythonExecutablePath(python), ['-I', '-B', '-c', [
    'import json, subprocess, sys',
    'import cryptography.hazmat.bindings._rust, charset_normalizer',
    'child = subprocess.run([sys.executable, "-I", "-B", "-c", "import charset_normalizer; print(1)"], check=True, capture_output=True, text=True)',
    'print(json.dumps({"executable": sys.executable, "child": child.stdout.strip()}))',
  ].join('\n')], { encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.ok(output.executable.startsWith('\\\\?\\'))
  assert.equal(output.child, '1')
})

test('Windows Python bootstrap preserves arguments, stdin and child failure status', { skip: process.platform !== 'win32' }, () => {
  const python = process.env.SCHOLARSEED_TEST_PYTHON || productPython()
  const args = ['space 中文', 'embedded"quote', 'trailing\\', '', 'backslash\\"quote']
  const input = 'stdin forwarded\n'
  const child = 'import json,sys;print(json.dumps(dict(args=sys.argv[1:],stdin=sys.stdin.read())));sys.exit(37)'
  const result = spawnSync(python, ['-I', '-B', '-c', WINDOWS_PYTHON_BOOTSTRAP, '-I', '-B', '-c', child, ...args], { encoding: 'utf8', input, timeout: 15000 })
  assert.equal(result.status, 37, result.stderr || String(result.error))
  assert.deepEqual(JSON.parse(result.stdout), { args, stdin: input })
})
