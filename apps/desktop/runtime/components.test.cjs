// 组件仓库构建侧契约（proposal 108 §7）。
// 跨语言钉死：直接读 apps/serve/service/paths.py 的常量文本与本模块逐字比对 ——
// 两侧任何一方单独改名，这里先红。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const components = require('./components.cjs')
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const PATHS_PY = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'serve', 'service', 'paths.py'), 'utf8')

function pythonConstant(name) {
  const match = PATHS_PY.match(new RegExp(`^${name} = "([^"]+)"`, 'm'))
  assert.ok(match, `paths.py is missing ${name}`)
  return match[1]
}

test('runtime 布局常量与 serve paths.py 契约逐字一致', () => {
  assert.equal(components.RUNTIME_DIRNAME, pythonConstant('RUNTIME_DIRNAME'))
  assert.equal(components.STAGING_DIRNAME, pythonConstant('RUNTIME_STAGING_DIRNAME'))
  assert.equal(components.MANIFESTS_DIRNAME, pythonConstant('RUNTIME_MANIFESTS_DIRNAME'))
  assert.equal(components.LOCKS_DIRNAME, pythonConstant('RUNTIME_LOCKS_DIRNAME'))
  // kinds 元组由 Serve 与 Desktop 共同冻结。
  const kinds = PATHS_PY.match(/^RUNTIME_COMPONENT_KINDS = \((.+)\)$/m)
  assert.ok(kinds, 'paths.py is missing RUNTIME_COMPONENT_KINDS')
  const parsed = kinds[1].split(',').map(item => item.trim().replace(/"/g, '')).filter(Boolean)
  assert.deepEqual([...components.COMPONENT_KINDS], parsed)
})

test('componentTarget 只接受 win32/x64，命名是 <platform>-<arch>', () => {
  assert.equal(components.componentTarget('win32', 'x64'), 'win32-x86_64')
  assert.throws(() => components.componentTarget('darwin', 'arm64'), /win32-only/)
  assert.throws(() => components.componentTarget('win32', 'arm64'), /x64 only/)
})

test('contentId 由冻结输入派生：确定性 + 每个输入单独敏感', () => {
  const base = {
    target: 'win32-x86_64',
    pythonArchiveSha256: 'a1'.repeat(32),
    requirementsSha256: 'b2'.repeat(32),
    lockSha256: 'c3'.repeat(32),
    bytecodeSha256: 'e1'.repeat(32),
    binaryPackages: ['cryptography', 'orjson']
  }
  assert.throws(() => components.derivePythonContentId({ ...base, bytecodeSha256: undefined }), /compiler digest/)
  const id = components.derivePythonContentId(base)
  assert.notEqual(components.derivePythonContentId({ ...base, skillWheels: [{ name: 'local', sha256: '1'.repeat(64) }] }), id)
  assert.notEqual(components.derivePythonContentId({ ...base, recipe: { normalizer: 'changed' } }), id)
  assert.notEqual(components.derivePythonContentId({ ...base, bytecodeSha256: 'f1'.repeat(32) }), id)
  assert.match(id, components.CONTENT_ID_PATTERN)
  // 确定性：数组顺序不影响
  assert.equal(components.derivePythonContentId({ ...base, binaryPackages: ['orjson', 'cryptography'] }), id)
  // 每个输入都参与派生
  assert.notEqual(components.derivePythonContentId({ ...base, pythonArchiveSha256: 'd4'.repeat(32) }), id)
  assert.notEqual(components.derivePythonContentId({ ...base, requirementsSha256: 'd4'.repeat(32) }), id)
  assert.notEqual(components.derivePythonContentId({ ...base, lockSha256: 'd4'.repeat(32) }), id)
  assert.notEqual(components.derivePythonContentId({ ...base, binaryPackages: ['cryptography'] }), id)
  assert.notEqual(components.derivePythonContentId({ ...base, target: 'win32-x86' }), id)
  const texlive = components.deriveTexliveContentId({ target: 'win32-x86_64', archiveSha256: 'e5'.repeat(32), texlive: '2025' })
  assert.match(texlive, components.CONTENT_ID_PATTERN)
  assert.notEqual(texlive, components.deriveTexliveContentId({ target: 'win32-x86_64', archiveSha256: 'e5'.repeat(32), texlive: '2024' }))
  assert.notEqual(texlive, components.deriveTexliveContentId({ target: 'win32-x86_64', archiveSha256: 'f6'.repeat(32), texlive: '2025' }))
  const powershell = components.derivePowerShellContentId({
    target: 'win32-x86_64', archiveSha256: '17'.repeat(32), version: '7.6.6'
  })
  assert.match(powershell, components.CONTENT_ID_PATTERN)
  assert.notEqual(powershell, components.derivePowerShellContentId({
    target: 'win32-x86_64', archiveSha256: '17'.repeat(32), version: '7.6.5'
  }))
  assert.notEqual(powershell, components.derivePowerShellContentId({
    target: 'win32-x86_64', archiveSha256: '18'.repeat(32), version: '7.6.6'
  }))
  // 三种组件输入空间不串号
  assert.notEqual(id, texlive)
  assert.notEqual(id, powershell)
  assert.notEqual(texlive, powershell)
})

test('componentDirectoryName 拒绝穿越与非法形状', () => {
  const id = 'a1'.repeat(32)
  assert.equal(components.componentDirectoryName('python', 'win32-x86_64', id), path.join('python', `win32-x86_64-${id}`))
  assert.throws(() => components.componentDirectoryName('nodejs', 'win32-x86_64', id), /unknown component kind/)
  assert.throws(() => components.componentDirectoryName('python', '../x', id), /invalid component target/)
  assert.throws(() => components.componentDirectoryName('python', 'win32-x86_64', 'short'), /invalid component contentId/)
})

test('app-components 清单校验：完整形态通过，每类缺陷单独拒绝', () => {
  const id = 'a1'.repeat(32)
  const texId = 'b2'.repeat(32)
  const python = {
    kind: 'python', contentId: id, archive: components.componentArchiveName('python', id),
    archiveSha256: 'c3'.repeat(32), archiveBytes: 10, entry: components.PYTHON_ENTRY_RELATIVE, python: '3.12.13', sqlite: '3.53.1'
  }
  const texlive = {
    kind: 'texlive', contentId: texId, archive: components.componentArchiveName('texlive', texId),
    archiveSha256: 'd4'.repeat(32), archiveBytes: 10,
    entry: `${components.TEXLIVE_BIN_PARENT_RELATIVE}/bin/windows`, executables: ['xelatex', 'pdflatex', 'bibtex', 'kpsewhich'], texlive: '2026'
  }
  const powershellId = 'e5'.repeat(32)
  const powershell = {
    kind: 'powershell', contentId: powershellId,
    archive: components.componentArchiveName('powershell', powershellId),
    archiveSha256: 'f6'.repeat(32), archiveBytes: 10,
    entry: components.POWERSHELL_ENTRY_RELATIVE, version: '7.6.6'
  }
  const good = components.appComponentsManifest('win32-x86_64', [python, texlive, powershell])
  assert.equal(components.validateAppComponents(good), true)
  const budget = { format: 'zip', expandedBytes: 300, fileCount: 4 }
  assert.equal(components.validateAppComponents({ ...good,
    components: [{ ...python, ...budget }, texlive, powershell] }), true)
  for (const broken of [
    { expandedBytes: 300 }, { ...budget, format: 'tar.gz' },
    { ...budget, fileCount: 0 }, { ...budget, expandedBytes: -1 },
    { ...budget, fileCount: 1.5 }, { ...budget, expandedBytes: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.equal(components.validateAppComponents({ ...good,
      components: [{ ...python, ...broken }, texlive, powershell] }), false)
  }
  assert.equal(components.parseAppComponents(JSON.stringify(good)).target, 'win32-x86_64')
  assert.equal(components.parseAppComponents('{'), null)
  assert.equal(components.validateAppComponents({ ...good, schemaVersion: 2 }), false)
  assert.equal(components.validateAppComponents({ ...good, components: [python, texlive] }), false, 'powershell 缺失')
  assert.equal(components.validateAppComponents({ ...good, components: [python, texlive, python] }), false, 'kind 重复')
  assert.equal(components.validateAppComponents({ ...good, components: [python, { ...texlive, archive: 'texlive-x.zip' }, powershell] }), false)
  assert.equal(components.validateAppComponents({ ...good, components: [{ ...python, entry: '/etc/passwd' }, texlive, powershell] }), false)
  assert.equal(components.validateAppComponents({ ...good, components: [{ ...python, entry: 'python.exe' }, texlive, powershell] }), false)
  assert.equal(components.validateAppComponents({ ...good, components: [python, { ...texlive, executables: [] }, powershell] }), false)
  assert.equal(components.validateAppComponents({ ...good, components: [python, texlive, { ...powershell, version: '' }] }), false)
  for (const change of [{ python: '' }, { sqlite: '' }, { python: '3.12' }]) {
    assert.equal(components.validateAppComponents({ ...good, components: [{ ...python, ...change }, texlive, powershell] }), false)
  }
  for (const change of [{ texlive: '' }, { executables: ['../xelatex'] }, { executables: ['xelatex', 'xelatex'] }]) {
    assert.equal(components.validateAppComponents({ ...good, components: [python, { ...texlive, ...change }, powershell] }), false)
  }
  assert.equal(components.validateAppComponents(null), false)
})

test('store 路径函数拒绝非法 contentId 并给出稳定布局', () => {
  const root = '/tmp/home/runtime'
  const id = 'a1'.repeat(32)
  assert.equal(components.storeManifestPath(root, id), path.join(root, 'manifests', `${id}.json`))
  assert.equal(components.storeLockPath(root, id), path.join(root, 'locks', `${id}.lock`))
  assert.equal(components.storeStagingDirectory(root), path.join(root, 'staging'))
  assert.equal(
    components.storeComponentDirectory(root, 'texlive', 'win32-x86_64', id),
    path.join(root, 'texlive', `win32-x86_64-${id}`)
  )
  assert.throws(() => components.storeManifestPath(root, '../x'), /invalid contentId/)
})

test('.cmd commands inherit the Desktop interpreter and inject product libraries', () => {
  const preamble = components.windowsComponentPreamble().join('\r\n')
  assert.match(preamble, /if not defined SCHOLARSEED_PYTHON .*exit \/b 1/)
  assert.match(preamble, /set "SS_PY=%SCHOLARSEED_PYTHON%"/)
  assert.ok(preamble.includes('if /I "%SS_PY:~0,8%"=="\\\\?\\UNC\\" set "SS_PY=\\\\%SS_PY:~8%"'))
  assert.ok(preamble.includes('if "%SS_PY:~0,4%"=="\\\\?\\" set "SS_PY=%SS_PY:~4%"'))
  assert.doesNotMatch(preamble, /SS_RUNTIME|USERPROFILE|SCHOLARSEED_HOME|where python|py -3/)
  assert.match(preamble, /if not exist "%SS_PY%".*exit \/b 1/)
  assert.ok(preamble.includes('set "PYTHONPATH=%~dp0..\\pylibs"'))
  const skill = components.skillPythonLauncherCommand('service.cli.skill_python')
  assert.match(skill, /"%SS_PY%" -I -B -c "[^\"]+" -P -s -B -m service\.cli\.skill_python %\*/)
  const console = components.consoleScriptLauncherCommand('import sys; sys.exit(0)')
  assert.match(console, /"%SS_PY%" -I -B -c "[^\"]+" -P -s -B -c "import sys; sys\.exit\(0\)" %\*/)
})

test('runtime store 根解析：恒为 <home>/runtime（收敛掉独立覆盖轴）', () => {
  const home = path.join(os.tmpdir(), 'ss-home')
  assert.equal(components.runtimeStoreRoot(home), path.join(home, 'runtime'))
  // 收敛后不存在 env 覆盖档：组件仓库永远是 home 的子目录，仅由旧组件存储消费。
  assert.equal(components.runtimeStoreRoot(home), path.join(home, components.RUNTIME_DIRNAME))
  assert.equal(typeof components.resolveRuntimeStoreRoot, 'undefined')
  assert.equal(typeof components.isValidRuntimeStoreRoot, 'undefined')
  assert.equal(components.RUNTIME_STORE_ENV, undefined)
})

test('writeProductLibraries 只接受纯 Python wheel（真实解释器执行）', (t) => {
  const venvPython = path.join(REPO_ROOT, '.venv', 'bin', 'python')
  if (!fs.existsSync(venvPython)) {
    t.skip('worktree .venv is required for the real-interpreter purity check')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-pylibs-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const wheels = path.join(directory, 'wheels')
  const pylibs = path.join(directory, 'pylibs')
  fs.mkdirSync(wheels, { recursive: true })
  const makeWheel = (name, tag, files) => {
    const { execFileSync } = require('node:child_process')
    const stage = path.join(directory, `stage-${name}`)
    const distInfo = path.join(stage, `${name}-0.1.0.dist-info`)
    fs.mkdirSync(distInfo, { recursive: true })
    fs.writeFileSync(path.join(distInfo, 'WHEEL'), `Wheel-Version: 1.0\nTag: ${tag}\n`)
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(stage, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    const archive = path.join(wheels, `${name}-0.1.0-py3-none-any.whl`)
    execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: stage })
    return archive
  }
  const pure = makeWheel('purepkg', 'py3-none-any', { 'purepkg/__init__.py': 'VALUE = 1\n' })
  const runner = (executable, args) => {
    const { spawnSync } = require('node:child_process')
    const result = spawnSync(executable, args, { encoding: 'utf8' })
    if (result.error || result.status !== 0) {
      throw new Error(`runner failed (${result.status}): ${result.stderr || result.error}`)
    }
    return result.stdout
  }
  components.writeProductLibraries(runner, venvPython, [pure], pylibs)
  assert.ok(fs.existsSync(path.join(pylibs, 'purepkg', '__init__.py')))
  assert.ok(fs.existsSync(path.join(pylibs, 'purepkg-0.1.0.dist-info', 'WHEEL')))
  // 编译型 wheel（Tag 非 -none-any）必须被拒绝，不允许混进按应用版本变化的 pylibs
  const compiled = makeWheel('compiledpkg', 'cp312-cp312-win_amd64', { 'compiledpkg/__init__.py': '' })
  assert.throws(
    () => components.writeProductLibraries(runner, venvPython, [compiled], pylibs),
    /not pure-python/
  )
})
