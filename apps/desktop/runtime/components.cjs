// Windows component identities, independent archives and persistent runtime layout.
// The current build registers five immutable ZIPs; the manifest and preparation
// helper accept additional registered kinds. Each reviewed component version is
// expanded once under the installation root/runtime.
//
// 设计要点：
// - **组件 = 稳定依赖**。python 组件只含解释器 + uv.lock 锁定的第三方 site-packages；
//   产品代码（5 个本地 wheel）构建期解包进 `backend/pylibs`，运行期用 PYTHONPATH 注入。
//   否则每改一次后端 contentId 就变、组件永不命中（提案 §7.1 明令禁止）。
// - CI 缓存的 contentId 仍由冻结 recipe/依赖输入派生；runtime 清单的 contentId
//   使用已校验归档的实际树摘要，避免仅构建编排变化就迫使用户重新展开相同组件。
//   归档字节 SHA 独立绑定，版本不能静默切换到另一份归档。
// - win32-only：macOS 载荷与解析保持现状（提案 §10）。
// - 构建期组件解压使用 System32 的 bsdtar（`tar.exe`），绝对路径解析，避开 PATH 上
//   Git 自带 GNU tar 的 `C:` 路径歧义（AGENTS.md 跨平台硬约束）。

const { WINDOWS_PYTHON_BOOTSTRAP } = require('./python.cjs')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const COMPONENT_SCHEMA_VERSION = 1
const RUNTIME_DIRNAME = 'runtime'
const STAGING_DIRNAME = 'staging'
const MANIFESTS_DIRNAME = 'manifests'
const LOCKS_DIRNAME = 'locks'
const COMPONENTS_DIRNAME = 'components'
const PYLIBS_DIRNAME = 'pylibs'
const APP_COMPONENTS_FILENAME = 'app-components.json'
const PYTHON_KIND = 'python'
const TEXLIVE_KIND = 'texlive'
const POWERSHELL_KIND = 'powershell'
const COMPONENT_KINDS = [PYTHON_KIND, TEXLIVE_KIND, POWERSHELL_KIND]
// 组件目录内保留归档顶层树名（python/、texlive/、powershell/），entry 是相对组件根的入口路径。
const PYTHON_TREE_DIRNAME = 'python'
const TEXLIVE_TREE_DIRNAME = 'texlive'
const POWERSHELL_TREE_DIRNAME = 'powershell'
const PYTHON_ENTRY_RELATIVE = `${PYTHON_TREE_DIRNAME}/python.exe`
const TEXLIVE_BIN_PARENT_RELATIVE = TEXLIVE_TREE_DIRNAME
const POWERSHELL_ENTRY_RELATIVE = `${POWERSHELL_TREE_DIRNAME}/pwsh.exe`
const HOME_ENV = 'SCHOLARSEED_HOME'
const CONTENT_ID_PATTERN = /^[a-f0-9]{64}$/
const TARGET_PATTERN = /^[a-z0-9]+-[a-z0-9_]+$/
const SHA256_CHUNK_BYTES = 16 * 1024 * 1024
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const TEXLIVE_EXECUTABLES = ['xelatex', 'pdflatex', 'bibtex', 'kpsewhich']

function componentTarget(platform, arch) {
  if (platform !== 'win32') throw new Error(`component store is win32-only, got ${platform}`)
  if (arch !== 'x64') throw new Error(`component store supports x64 only, got ${arch}`)
  return 'win32-x86_64'
}

function componentDirectoryName(kind, target, contentId) {
  if (!COMPONENT_KINDS.includes(kind)) throw new Error(`unknown component kind: ${kind}`)
  if (!TARGET_PATTERN.test(target)) throw new Error(`invalid component target: ${target}`)
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new Error(`invalid component contentId: ${contentId}`)
  return path.join(kind, `${target}-${contentId}`)
}

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, sortedReplacer)).digest('hex')
}

function sortedReplacer(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort().reduce((accumulator, item) => {
      accumulator[item] = value[item]
      return accumulator
    }, {})
  }
  return value
}

/** python 组件内容标识：解释器归档 + 第三方依赖锁定输入的哈希。 */
function derivePythonContentId({ target, pythonArchiveSha256, requirementsSha256, lockSha256, binaryPackages, bytecodeSha256, recipe, skillWheels = [] }) {
  if (!CONTENT_ID_PATTERN.test(bytecodeSha256 || '')) throw new Error('Python component requires its bytecode compiler digest')
  return canonicalSha256({
    kind: PYTHON_KIND,
    bytecodeSha256,
    normalization: 2,
    skillWheels: [...skillWheels].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    recipe,
    target,
    pythonArchiveSha256,
    requirementsSha256,
    lockSha256,
    binaryPackages: [...binaryPackages].sort()
  })
}

/** texlive 组件内容标识：审阅过的 vendor 归档哈希 + 版本。 */
function deriveTexliveContentId({ target, archiveSha256, texlive, recipe }) {
  return canonicalSha256({ kind: TEXLIVE_KIND, target, archiveSha256, texlive, normalization: 2, recipe })
}

function derivePowerShellContentId({ target, archiveSha256, version, recipe }) {
  return canonicalSha256({ kind: POWERSHELL_KIND, target, archiveSha256, version, normalization: 2, recipe })
}

const RUNTIME_MANIFEST_FILENAME = 'runtime.json'
const COMPONENT_RECEIPT_FILENAME = '.scholarseed-component.json'
const RUNTIME_DOMAIN = 'scholarseed.runtime-components'
const RUNTIME_MANIFEST_LIMIT = 32 * 1024 * 1024
const RUNTIME_COMPONENT_KINDS = Object.freeze([...COMPONENT_KINDS, 'codex', 'office', 'electron'])
const COMPONENT_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const MAX_RUNTIME_COMPONENTS = 32
const COMPONENT_VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,62}-r[1-9][0-9]*$/
const WINDOWS_BUNDLED_RUNTIME_DIRS = Object.freeze({ python: 'python', texlive: 'texlive', powershell: 'powershell', codex: 'codex-runtime', office: 'office' })
const RUNTIME_ENTRIES = Object.freeze({ python: PYTHON_ENTRY_RELATIVE, texlive: 'texlive/bin/windows', powershell: POWERSHELL_ENTRY_RELATIVE, codex: 'bin/codex.exe', office: 'zeta-20250513/manifest.json', electron: 'ScholarSeedEngine.exe' })
function portableRuntimePath(value) {
  return typeof value === 'string' && value.length > 0 && value.split('/').every(part =>
    part && part !== '.' && part !== '..' && !/[\\:<>"|?*\x00-\x1f\x7f]/.test(part) &&
    !/[. ]$/.test(part) && part.length <= 255 &&
    !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))
}
function validateRuntimeManifest(value) {
  if (!value || value.schema !== 1 || value.domain !== RUNTIME_DOMAIN ||
      value.product_id !== 'scholarseed' || value.bundle_id !== 'com.scholarseed.desktop' ||
      value.app_id !== 'scholarseed' || value.target !== 'win32-x86_64' ||
      !Array.isArray(value.components) || !value.components.length || value.components.length > MAX_RUNTIME_COMPONENTS) return false
  const kinds = new Set()
  const archiveNames = new Set()
  for (const component of value.components) {
    if (!component || !COMPONENT_KIND_PATTERN.test(component.kind || '') || !portableRuntimePath(component.kind) || kinds.has(component.kind) ||
        !COMPONENT_VERSION_PATTERN.test(component.version || '') || !portableRuntimePath(component.version) ||
        !CONTENT_ID_PATTERN.test(component.contentId || '') || !CONTENT_ID_PATTERN.test(component.archiveSha256 || '') ||
        component.archive !== `${component.kind}.zip` || !portableRuntimePath(component.entry) ||
        !Number.isSafeInteger(component.archiveBytes) || component.archiveBytes <= 0 ||
        !Number.isSafeInteger(component.expandedBytes) || component.expandedBytes <= 0 ||
        !Array.isArray(component.files) || component.fileCount !== component.files.length || !component.fileCount) return false
    kinds.add(component.kind)
    const archiveName = `${component.kind}-${component.version}.zip`
    if (archiveNames.has(archiveName)) return false
    archiveNames.add(archiveName)
    let bytes = 0, previous = ''
    const names = new Set()
    for (const file of component.files) {
      if (!file || !portableRuntimePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 ||
          !CONTENT_ID_PATTERN.test(file.sha256 || '') || file.path.split('/')[0].toLowerCase() === COMPONENT_RECEIPT_FILENAME ||
          file.path <= previous || names.has(file.path.toLowerCase())) return false
      previous = file.path
      names.add(file.path.toLowerCase())
      bytes += file.size
      if (!Number.isSafeInteger(bytes)) return false
    }
    for (const name of names) {
      const parts = name.split('/')
      while (parts.length > 1) { parts.pop(); if (names.has(parts.join('/'))) return false }
    }
    if (bytes !== component.expandedBytes ||
        !component.files.some(file => file.path === component.entry || file.path.startsWith(`${component.entry}/`))) return false
  }
  return true
}
function parseRuntimeManifest(text) {
  try {
    const value = JSON.parse(text)
    return validateRuntimeManifest(value) ? value : null
  } catch { return null }
}
// Structural parsing only. Authentication belongs to the preparation helper.
function readRuntimeManifest(appDirectory) {
  if (!path.isAbsolute(appDirectory)) throw new Error('absolute application directory required')
  const filename = path.join(appDirectory, 'resources', COMPONENTS_DIRNAME, RUNTIME_MANIFEST_FILENAME)
  if (fs.statSync(filename).size > RUNTIME_MANIFEST_LIMIT) throw new Error('runtime manifest exceeds limit')
  const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (envelope.schema !== 1 || typeof envelope.manifest !== 'string' ||
      typeof envelope.key_id !== 'string' || typeof envelope.signature !== 'string') throw new Error('invalid runtime envelope')
  const bytes = Buffer.from(envelope.manifest, 'base64')
  if (bytes.length > RUNTIME_MANIFEST_LIMIT || bytes.toString('base64') !== envelope.manifest) throw new Error('invalid runtime envelope encoding')
  const manifest = parseRuntimeManifest(bytes.toString('utf8'))
  if (!manifest) throw new Error('invalid runtime manifest')
  return manifest
}
function bundledWindowsRuntime(appDirectory) {
  const manifest = readRuntimeManifest(appDirectory)
  return Object.fromEntries(RUNTIME_COMPONENT_KINDS.map(kind => {
    const component = manifest.components.find(item => item.kind === kind)
    if (!component) throw new Error(`required runtime component missing: ${kind}`)
    const root = path.join(path.dirname(appDirectory), RUNTIME_DIRNAME, component.kind, component.version)
    return [component.kind, component.kind === 'office' ? root : path.join(root, ...component.entry.split('/'))]
  }))
}

function componentArchiveName(kind, contentId) {
  return `${kind}-${contentId}.zip`
}

function sha256FileSync(file) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(SHA256_CHUNK_BYTES)
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

/**
 * 把本地产品 wheel 解包进 backend/pylibs（构建期，win32 组件化路径）。
 * 只接受纯 Python wheel（Tag 以 -none-any 结尾）：编译型产物属于第三方依赖，
 * 归 python 组件的 site-packages，不允许混进按应用版本变化的 pylibs。
 * zipfile 成员名先做穿越断言，再交给 Python zipfile 的既有净化。
 */
function writeProductLibraries(runner, python, wheels, pylibsDirectory) {
  fs.mkdirSync(pylibsDirectory, { recursive: true })
  const script = [
    'import json, pathlib, sys, zipfile',
    'target = pathlib.Path(sys.argv[1])',
    'summary = []',
    'for wheel in sys.argv[2:]:',
    '    with zipfile.ZipFile(wheel) as archive:',
    '        names = archive.namelist()',
    '        if any(name.startswith("/") or ".." in name.replace("\\\\", "/").split("/") for name in names):',
    '            raise SystemExit(f"unsafe member path in {wheel}")',
    '        metas = [name for name in names if name.endswith(".dist-info/WHEEL")]',
    '        if len(metas) != 1:',
    '            raise SystemExit(f"expected one dist-info in {wheel}, got {metas}")',
    '        tags = [line.split(":", 1)[1].strip() for line in archive.read(metas[0]).decode("utf-8").splitlines() if line.startswith("Tag:")]',
    '        if not tags or not all(tag.endswith("-none-any") for tag in tags):',
    '            raise SystemExit(f"product wheel is not pure-python: {wheel} {tags}")',
    '        archive.extractall(target)',
    '        summary.append(metas[0].split("/")[0])',
    'print(json.dumps(summary))'
  ].join('\n')
  runner(python, ['-I', '-B', '-c', script, pylibsDirectory, ...wheels])
}

function appComponentsManifest(target, components) {
  const manifest = { schemaVersion: COMPONENT_SCHEMA_VERSION, target, components }
  if (!validateAppComponents(manifest)) throw new Error('generated app-components manifest is invalid')
  return manifest
}

function validateAppComponents(value) {
  if (!value || typeof value !== 'object') return false
  if (value.schemaVersion !== COMPONENT_SCHEMA_VERSION) return false
  if (typeof value.target !== 'string' || !TARGET_PATTERN.test(value.target)) return false
  if (!Array.isArray(value.components) || value.components.length === 0) return false
  const kinds = new Set()
  for (const component of value.components) {
    if (!component || typeof component !== 'object') return false
    if (!COMPONENT_KINDS.includes(component.kind) || kinds.has(component.kind)) return false
    kinds.add(component.kind)
    if (!CONTENT_ID_PATTERN.test(component.contentId || '')) return false
    if (component.archive !== componentArchiveName(component.kind, component.contentId)) return false
    if (!CONTENT_ID_PATTERN.test(component.archiveSha256 || '')) return false
    if (!Number.isInteger(component.archiveBytes) || component.archiveBytes <= 0) return false
    const budgetFields = ['format', 'expandedBytes', 'fileCount']
    if (budgetFields.some(field => Object.hasOwn(component, field)) &&
      (component.format !== 'zip' || !Number.isSafeInteger(component.expandedBytes) ||
        component.expandedBytes <= 0 || !Number.isSafeInteger(component.fileCount) ||
        component.fileCount <= 0)) return false
    if (typeof component.entry !== 'string' || !component.entry || path.isAbsolute(component.entry)) return false
    if (component.kind === PYTHON_KIND && (component.entry !== PYTHON_ENTRY_RELATIVE ||
      !VERSION_PATTERN.test(component.python || '') || !VERSION_PATTERN.test(component.sqlite || ''))) return false
    if (component.kind === TEXLIVE_KIND &&
      (component.entry !== `${TEXLIVE_BIN_PARENT_RELATIVE}/bin/windows` ||
        typeof component.texlive !== 'string' || !/^20[0-9]{2}$/.test(component.texlive) ||
        !Array.isArray(component.executables) || component.executables.length !== TEXLIVE_EXECUTABLES.length ||
        new Set(component.executables).size !== component.executables.length ||
        component.executables.some(name => !TEXLIVE_EXECUTABLES.includes(name)))) return false
    if (component.kind === POWERSHELL_KIND &&
      (component.entry !== POWERSHELL_ENTRY_RELATIVE || !VERSION_PATTERN.test(component.version || ''))) return false
  }
  return kinds.size === COMPONENT_KINDS.length
}

function parseAppComponents(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return validateAppComponents(value) ? value : null
}

// ---- 组件仓库（$SCHOLARSEED_HOME/runtime）路径 ----

function storeStagingDirectory(storeRoot) {
  return path.join(storeRoot, STAGING_DIRNAME)
}

function storeManifestsDirectory(storeRoot) {
  return path.join(storeRoot, MANIFESTS_DIRNAME)
}

function storeLocksDirectory(storeRoot) {
  return path.join(storeRoot, LOCKS_DIRNAME)
}

function storeComponentDirectory(storeRoot, kind, target, contentId) {
  return path.join(storeRoot, componentDirectoryName(kind, target, contentId))
}

function storeManifestPath(storeRoot, contentId) {
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new Error(`invalid contentId: ${contentId}`)
  return path.join(storeRoot, MANIFESTS_DIRNAME, `${contentId}.json`)
}

function storeLockPath(storeRoot, contentId) {
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new Error(`invalid contentId: ${contentId}`)
  return path.join(storeRoot, LOCKS_DIRNAME, `${contentId}.lock`)
}

// ---- Windows 启动器寻址（.cmd） ----

/** Component commands inherit the exact interpreter selected by Desktop.
 * They must not independently choose a store or a different release. */
function windowsComponentPreamble() {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "PYTHONDONTWRITEBYTECODE=1"',
    'if not defined SCHOLARSEED_PYTHON (echo ScholarSeed runtime context is missing; run this command from the ScholarSeed app. 1>&2 & exit /b 1)',
    'set "SS_PY=%SCHOLARSEED_PYTHON%"',
    // cmd.exe needs the ordinary spelling; the Python bootstrap restores the
    // extended spelling for DLL loading and child processes of this same exe.
    'if /I "%SS_PY:~0,8%"=="\\\\?\\UNC\\" set "SS_PY=\\\\%SS_PY:~8%"',
    'if "%SS_PY:~0,4%"=="\\\\?\\" set "SS_PY=%SS_PY:~4%"',
    'if not exist "%SS_PY%" (echo ScholarSeed runtime interpreter is unavailable. 1>&2 & exit /b 1)',
    'set "PYTHONPATH=%~dp0..\\' + PYLIBS_DIRNAME + '"'
  ]
}

/**
 * 组件 store 根的唯一解析口：恒为 `<home>/runtime`（proposal 112 收敛掉此前独立的
 * 组件仓库覆盖轴）。仅用于旧组件存储；子命令继承 Desktop 选定的解释器，不再独立解析根。
 */
function runtimeStoreRoot(home) {
  return path.join(home, RUNTIME_DIRNAME)
}

function skillPythonLauncherCommand(module) {
  return [...windowsComponentPreamble(), `"%SS_PY%" -I -B -c "${WINDOWS_PYTHON_BOOTSTRAP}" -P -s -B -m ${module} %*`, ''].join('\r\n')
}

function consoleScriptLauncherCommand(pyLaunch) {
  return [...windowsComponentPreamble(), `"%SS_PY%" -I -B -c "${WINDOWS_PYTHON_BOOTSTRAP}" -P -s -B -c "${pyLaunch}" %*`, ''].join('\r\n')
}

module.exports = {
  RUNTIME_MANIFEST_FILENAME, COMPONENT_RECEIPT_FILENAME, RUNTIME_DOMAIN, RUNTIME_MANIFEST_LIMIT, RUNTIME_COMPONENT_KINDS,
  COMPONENT_KIND_PATTERN, MAX_RUNTIME_COMPONENTS, COMPONENT_VERSION_PATTERN, RUNTIME_ENTRIES, portableRuntimePath, validateRuntimeManifest, parseRuntimeManifest, readRuntimeManifest,
  WINDOWS_BUNDLED_RUNTIME_DIRS,
  bundledWindowsRuntime,
  APP_COMPONENTS_FILENAME,
  COMPONENTS_DIRNAME,
  COMPONENT_KINDS,
  COMPONENT_SCHEMA_VERSION,
  CONTENT_ID_PATTERN,
  HOME_ENV,
  LOCKS_DIRNAME,
  MANIFESTS_DIRNAME,
  PYLIBS_DIRNAME,
  POWERSHELL_ENTRY_RELATIVE,
  POWERSHELL_KIND,
  POWERSHELL_TREE_DIRNAME,
  PYTHON_ENTRY_RELATIVE,
  PYTHON_KIND,
  PYTHON_TREE_DIRNAME,
  RUNTIME_DIRNAME,
  STAGING_DIRNAME,
  TARGET_PATTERN,
  TEXLIVE_BIN_PARENT_RELATIVE,
  TEXLIVE_KIND,
  TEXLIVE_TREE_DIRNAME,
  appComponentsManifest,
  componentArchiveName,
  componentDirectoryName,
  componentTarget,
  consoleScriptLauncherCommand,
  derivePowerShellContentId,
  derivePythonContentId,
  deriveTexliveContentId,
  parseAppComponents,
  runtimeStoreRoot,
  sha256FileSync,
  skillPythonLauncherCommand,
  storeComponentDirectory,
  storeLockPath,
  storeLocksDirectory,
  storeManifestPath,
  storeManifestsDirectory,
  storeStagingDirectory,
  validateAppComponents,
  windowsComponentPreamble,
  writeProductLibraries
}
